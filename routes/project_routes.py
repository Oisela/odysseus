# routes/project_routes.py
"""REST API for Projects — bundles of chats around one topic (a lecture, an
exam prep, a build), each with a workspace folder (its files), extra
instructions layered on top of the selected template, and optionally a few
pinned skills. See core.database.Project. Chats link in via
sessions.project_id; the chat route applies the project's workspace/template
server-side on every turn."""

import logging
import os
import re
import uuid
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from core.database import Project, Session as DbSession, SessionLocal
from src.auth_helpers import effective_user
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

# Project folders live here unless an explicit folder inside DATA_DIR is given
# (e.g. a pre-existing lecture folder like data/vorlesungen/tiii).
PROJECTS_BASE = os.path.join(DATA_DIR, "projekte")

_MAX_PROJECT_FILE_BYTES = 100 * 1024 * 1024  # 100 MB per file is plenty here

# Living context file — created with every project, injected into the system
# prompt each turn (chat_routes._project_context_for_session) and kept
# up to date by the agent. German headers: it's user-facing project data.
PROJECT_CONTEXT_FILENAME = "PROJEKT.md"
_PROJECT_CONTEXT_TEMPLATE = """# {name} — Projekt-Kontext

> Lebendes Gedächtnis dieses Projekts: Odysseus liest diese Datei in jedem
> Projekt-Chat und hält sie am Ende relevanter Chats aktuell.

## Ziel

## Stand
- Projekt angelegt am {date}

## Offene Punkte

## Wichtige Dateien
"""


def _seed_project_context(workspace: str, name: str) -> None:
    """Create PROJEKT.md from the template — never overwrite an existing one
    (adopted folders may already carry a curated context file)."""
    try:
        path = os.path.join(workspace, PROJECT_CONTEXT_FILENAME)
        if os.path.exists(path):
            return
        from datetime import date
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(_PROJECT_CONTEXT_TEMPLATE.format(name=name, date=date.today().isoformat()))
    except OSError:
        logger.warning("PROJEKT.md seeding failed for %r", workspace, exc_info=True)


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:60] or "projekt"


def _vet_project_dir(path: str) -> str:
    """Confine a project folder to DATA_DIR (same spirit as vet_workspace,
    but simpler: projects are a data-dir concept by definition)."""
    resolved = os.path.realpath(path)
    data_root = os.path.realpath(DATA_DIR)
    if os.path.commonpath([resolved, data_root]) != data_root:
        raise HTTPException(400, "Projekt-Ordner muss unter dem Daten-Verzeichnis liegen")
    return resolved


def _project_to_dict(p: Project) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "workspace": p.workspace,
        "instructions": p.instructions or "",
        "template_id": p.template_id or "",
        "pinned_skills": p.pinned_skills or [],
        "default_model": p.default_model or "",
        "sort_order": p.sort_order or 0,
        "archived": bool(p.archived),
    }


class ProjectRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    instructions: str = Field("", max_length=20000)
    template_id: str = Field("", max_length=80)
    pinned_skills: List[str] = Field(default_factory=list, max_length=4)
    # "endpoint_url::model" (same encoding as tasks) — model new project
    # chats start with; empty = clone from the most recent session.
    default_model: str = Field("", max_length=400)
    # Optional explicit folder (relative to DATA_DIR or absolute inside it),
    # e.g. "vorlesungen/tiii" to adopt an existing lecture folder.
    workspace: Optional[str] = Field(None, max_length=500)


def setup_project_routes():
    router = APIRouter(prefix="/api/projects", tags=["projects"])

    def _get_owned(db, project_id: str, owner: Optional[str]) -> Project:
        p = db.query(Project).filter(Project.id == project_id).first()
        if not p or (p.owner and owner and p.owner != owner):
            raise HTTPException(404, "Projekt nicht gefunden")
        return p

    @router.get("")
    def list_projects(request: Request):
        """All projects of the current user, each with its sessions (id+name),
        so the sidebar can render the full tree in one call."""
        owner = effective_user(request)
        db = SessionLocal()
        try:
            q = db.query(Project).filter(Project.archived == False)  # noqa: E712
            if owner:
                q = q.filter(Project.owner == owner)
            projects = q.order_by(Project.sort_order, Project.name).all()
            ids = [p.id for p in projects]
            sess_map: dict = {pid: [] for pid in ids}
            if ids:
                rows = (
                    db.query(DbSession.id, DbSession.name, DbSession.project_id,
                             DbSession.last_message_at)
                    .filter(DbSession.project_id.in_(ids),
                            DbSession.archived == False)  # noqa: E712
                    .order_by(DbSession.last_message_at.desc())
                    .all()
                )
                for r in rows:
                    sess_map[r.project_id].append({"id": r.id, "name": r.name})
            return {
                "projects": [
                    {**_project_to_dict(p), "sessions": sess_map.get(p.id, [])}
                    for p in projects
                ]
            }
        finally:
            db.close()

    @router.post("")
    def create_project(req: ProjectRequest, request: Request):
        owner = effective_user(request)
        if req.workspace:
            raw = req.workspace
            folder = raw if os.path.isabs(raw) else os.path.join(DATA_DIR, raw)
        else:
            folder = os.path.join(PROJECTS_BASE, _slugify(req.name))
        folder = _vet_project_dir(folder)
        os.makedirs(folder, exist_ok=True)
        db = SessionLocal()
        try:
            p = Project(
                id=str(uuid.uuid4())[:8],
                owner=owner,
                name=req.name.strip(),
                workspace=folder,
                instructions=req.instructions.strip(),
                template_id=req.template_id.strip(),
                pinned_skills=req.pinned_skills,
                default_model=req.default_model.strip(),
            )
            db.add(p)
            db.commit()
            db.refresh(p)
            _seed_project_context(folder, p.name)
            logger.info(f"Project created: {p.id} '{p.name}' -> {folder}")
            return _project_to_dict(p)
        finally:
            db.close()

    @router.put("/{project_id}")
    def update_project(project_id: str, req: ProjectRequest, request: Request):
        owner = effective_user(request)
        db = SessionLocal()
        try:
            p = _get_owned(db, project_id, owner)
            p.name = req.name.strip()
            p.instructions = req.instructions.strip()
            p.template_id = req.template_id.strip()
            p.pinned_skills = req.pinned_skills
            p.default_model = req.default_model.strip()
            if req.workspace:
                raw = req.workspace
                folder = raw if os.path.isabs(raw) else os.path.join(DATA_DIR, raw)
                folder = _vet_project_dir(folder)
                os.makedirs(folder, exist_ok=True)
                p.workspace = folder
            db.commit()
            return _project_to_dict(p)
        finally:
            db.close()

    @router.delete("/{project_id}")
    def delete_project(project_id: str, request: Request):
        """Archive the project and detach its sessions. The folder and its
        files stay on disk — deleting a grouping must never delete work."""
        owner = effective_user(request)
        db = SessionLocal()
        try:
            p = _get_owned(db, project_id, owner)
            p.archived = True
            db.query(DbSession).filter(DbSession.project_id == project_id).update(
                {DbSession.project_id: None}
            )
            db.commit()
            return {"ok": True, "note": "Ordner + Dateien bleiben erhalten"}
        finally:
            db.close()

    @router.post("/{project_id}/sessions/{session_id}")
    def assign_session(project_id: str, session_id: str, request: Request):
        """Attach an existing chat to the project (or move it here)."""
        owner = effective_user(request)
        db = SessionLocal()
        try:
            _get_owned(db, project_id, owner)
            sess = db.query(DbSession).filter(DbSession.id == session_id).first()
            if not sess or (sess.owner and owner and sess.owner != owner):
                raise HTTPException(404, "Session nicht gefunden")
            sess.project_id = project_id
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.delete("/sessions/{session_id}")
    def detach_session(session_id: str, request: Request):
        """Remove a chat from its project (chat itself stays)."""
        owner = effective_user(request)
        db = SessionLocal()
        try:
            sess = db.query(DbSession).filter(DbSession.id == session_id).first()
            if not sess or (sess.owner and owner and sess.owner != owner):
                raise HTTPException(404, "Session nicht gefunden")
            sess.project_id = None
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    # ------------------------------------------------------------------
    # Project files (the folder IS the file list — transparent on disk)
    # ------------------------------------------------------------------

    def _vet_member_path(p: Project, rel: str) -> str:
        base = os.path.realpath(p.workspace or "")
        if not base:
            raise HTTPException(400, "Projekt hat keinen Ordner")
        target = os.path.realpath(os.path.join(base, rel))
        if os.path.commonpath([target, base]) != base:
            raise HTTPException(400, "Pfad liegt außerhalb des Projekt-Ordners")
        return target

    @router.get("/{project_id}/files")
    def list_files(project_id: str, request: Request):
        owner = effective_user(request)
        db = SessionLocal()
        try:
            p = _get_owned(db, project_id, owner)
        finally:
            db.close()
        files = []
        base = p.workspace
        if base and os.path.isdir(base):
            for root, dirs, names in os.walk(base):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for n in sorted(names):
                    if n.startswith("."):
                        continue
                    full = os.path.join(root, n)
                    rel = os.path.relpath(full, base)
                    try:
                        size = os.path.getsize(full)
                    except OSError:
                        size = 0
                    files.append({"path": rel.replace(os.sep, "/"), "size": size})
                if len(files) > 500:
                    break
        return {"files": files[:500], "workspace": base}

    @router.post("/{project_id}/files")
    async def upload_file(project_id: str, request: Request,
                          file: UploadFile = File(...), subdir: str = ""):
        owner = effective_user(request)
        db = SessionLocal()
        try:
            p = _get_owned(db, project_id, owner)
        finally:
            db.close()
        from src.upload_handler import secure_filename
        name = secure_filename(os.path.basename(file.filename or "upload"))
        if not name:
            raise HTTPException(400, "Ungültiger Dateiname")
        rel = os.path.join(subdir, name) if subdir else name
        target = _vet_member_path(p, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        written = 0
        with open(target, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_PROJECT_FILE_BYTES:
                    out.close()
                    os.unlink(target)
                    raise HTTPException(413, "Datei zu groß (max. 100 MB)")
                out.write(chunk)
        return {"ok": True, "path": os.path.relpath(target, p.workspace).replace(os.sep, "/"),
                "size": written}

    @router.get("/{project_id}/files/{rel_path:path}")
    def download_file(project_id: str, rel_path: str, request: Request):
        owner = effective_user(request)
        db = SessionLocal()
        try:
            p = _get_owned(db, project_id, owner)
        finally:
            db.close()
        target = _vet_member_path(p, rel_path)
        if not os.path.isfile(target):
            raise HTTPException(404, "Datei nicht gefunden")
        return FileResponse(target, filename=os.path.basename(target))

    @router.delete("/{project_id}/files/{rel_path:path}")
    def delete_file(project_id: str, rel_path: str, request: Request):
        owner = effective_user(request)
        db = SessionLocal()
        try:
            p = _get_owned(db, project_id, owner)
        finally:
            db.close()
        target = _vet_member_path(p, rel_path)
        if not os.path.isfile(target):
            raise HTTPException(404, "Datei nicht gefunden")
        os.unlink(target)
        return {"ok": True}

    return router
