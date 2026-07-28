"""RemNote module API — bridge status and the offline card buffer.

Alessios RemNote lives on his PC; Odysseus reaches it through the bridge
(REMNOTE_BRIDGE_URL, registered with the `remnote` MCP server). When the PC is
off, cards had nowhere to go: the buffer was only a convention in the remnote
skill and the promised flush task never existed (found 2026-07-27). This module
gives the buffer a real home plus a page that answers "is it connected, what is
waiting, and why did it fail".

The bridge contract (see data/remnote-mcp/mcp-server/tools.js):
  GET  /health                     -> reachability, which PC answered
  POST /call {action, payload}     -> {ok, result} | {ok: false, error}
Actions used here: find_or_create_path, create_flashcard,
create_cloze_flashcard, create_note, append_journal.
"""
import json
import logging
import time
import uuid
from typing import List, Optional

import requests
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.database import SessionLocal, RemnotePending, McpServer, utcnow_naive
from src.auth_helpers import require_user

logger = logging.getLogger(__name__)

# The bridge is a LAN/tailnet hop to Alessios PC — a couple of seconds is
# plenty, and a hung request must never block the page.
_HEALTH_TIMEOUT = 6
_CALL_TIMEOUT = 25
_CARD_TYPES = ("basic", "cloze", "concept", "note")


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _bridge_urls() -> list[str]:
    """Bridge addresses from the `remnote` MCP server's env.

    Deliberately NOT a hardcoded URL (CONTRIBUTING): the MCP entry is the
    single place Alessio configures the bridge, and it accepts a comma list
    so a second PC can answer.
    """
    db = SessionLocal()
    try:
        rows = db.query(McpServer).all()
    except Exception:
        rows = []
    finally:
        db.close()
    raw = ""
    for r in rows:
        name = (getattr(r, "name", "") or "").lower()
        env = getattr(r, "env", None)
        if "remnote" not in name:
            continue
        if isinstance(env, str):
            try:
                env = json.loads(env or "{}")
            except Exception:
                env = {}
        if isinstance(env, dict):
            raw = str(env.get("REMNOTE_BRIDGE_URL") or "")
            if raw:
                break
    return [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]


def _bridge_health() -> dict:
    """First reachable bridge wins; report every failure for the debug pane."""
    urls = _bridge_urls()
    if not urls:
        return {
            "ok": False,
            "configured": False,
            "urls": [],
            "error": "No remnote MCP server with REMNOTE_BRIDGE_URL configured "
                     "(Settings -> Integrations).",
        }
    attempts = []
    for url in urls:
        started = time.monotonic()
        try:
            res = requests.get(f"{url}/health", timeout=_HEALTH_TIMEOUT)
            ms = int((time.monotonic() - started) * 1000)
            body = {}
            try:
                body = res.json()
            except Exception:
                body = {"raw": res.text[:400]}
            if res.ok:
                return {"ok": True, "configured": True, "urls": urls,
                        "active_url": url, "ms": ms, "health": body,
                        "attempts": attempts}
            attempts.append({"url": url, "ms": ms, "error": f"HTTP {res.status_code}"})
        except Exception as e:
            attempts.append({
                "url": url,
                "ms": int((time.monotonic() - started) * 1000),
                "error": str(e)[:300],
            })
    return {
        "ok": False, "configured": True, "urls": urls, "attempts": attempts,
        "error": "No bridge answered — is RemNote plus the bridge host running "
                 "on one of the PCs?",
    }


def _bridge_call(action: str, payload: dict, active_url: Optional[str] = None) -> dict:
    """POST /call against the first reachable bridge. Raises on failure."""
    if active_url:
        url = active_url.rstrip("/")
    else:
        health = _bridge_health()
        if not health.get("ok"):
            raise RuntimeError(health.get("error") or "Bridge unreachable")
        url = health["active_url"]
    res = requests.post(
        f"{url}/call",
        json={"action": action, "payload": payload},
        timeout=_CALL_TIMEOUT,
    )
    try:
        body = res.json() if res.text else {}
    except Exception:
        raise RuntimeError(f"Bridge returned non-JSON (HTTP {res.status_code}): "
                           f"{res.text[:300]}")
    if not res.ok or body.get("ok") is False:
        raise RuntimeError(body.get("error") or f"Bridge error HTTP {res.status_code}")
    return body.get("result") or {}


class PendingBody(BaseModel):
    target: str = Field("Journal", max_length=500)
    card_type: str = Field("basic", max_length=20)
    front: str = Field("", max_length=20000)
    back: Optional[str] = Field(None, max_length=20000)
    source: Optional[str] = Field(None, max_length=20)
    session_id: Optional[str] = Field(None, max_length=80)


class PendingPatch(BaseModel):
    target: Optional[str] = Field(None, max_length=500)
    card_type: Optional[str] = Field(None, max_length=20)
    front: Optional[str] = Field(None, max_length=20000)
    back: Optional[str] = Field(None, max_length=20000)


def _row_dict(r: RemnotePending) -> dict:
    return {
        "id": r.id,
        "target": r.target or "Journal",
        "card_type": r.card_type or "basic",
        "front": r.front or "",
        "back": r.back or "",
        "status": r.status or "pending",
        "attempts": int(r.attempts or 0),
        "last_error": r.last_error,
        "last_try_at": r.last_try_at.isoformat() if r.last_try_at else None,
        "sent_at": r.sent_at.isoformat() if r.sent_at else None,
        "rem_id": r.rem_id,
        "source": r.source or "agent",
        "session_id": r.session_id,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _send_one(r: RemnotePending, active_url: Optional[str] = None) -> dict:
    """Push one parked card to RemNote. Returns the bridge result."""
    if not active_url:
        health = _bridge_health()
        if not health.get("ok"):
            raise RuntimeError(health.get("error") or "Bridge unreachable")
        active_url = health["active_url"]

    target = (r.target or "Journal").strip()
    ctype = (r.card_type or "basic").lower()
    front = (r.front or "").strip()
    back = (r.back or "").strip()
    if not front:
        raise RuntimeError("Card has no front text")

    # Journal target needs no parent lookup.
    if target.lower() in ("journal", "daily", ""):
        if ctype == "cloze":
            content = front
        elif ctype == "note":
            content = front + (f"\n{back}" if back else "")
        else:
            content = f"{front} >> {back}" if back else front
        return _bridge_call("append_journal", {"content": content}, active_url)

    segments = [s.strip() for s in target.replace("\\", "/").split("/") if s.strip()]
    parent = _bridge_call("find_or_create_path",
                          {"pathSegments": segments, "asFolders": True},
                          active_url)
    parent_id = parent.get("remId") or parent.get("id") if isinstance(parent, dict) else None
    if not parent_id:
        raise RuntimeError(f"Could not resolve target path '{target}'")

    if ctype == "cloze":
        return _bridge_call("create_cloze_flashcard",
                            {"parentId": parent_id, "text": front},
                            active_url)
    if ctype == "note":
        return _bridge_call("create_note", {"title": front, "content": back or "",
                                            "parentId": parent_id},
                            active_url)
    # basic + concept both map to a forward flashcard.
    return _bridge_call("create_flashcard", {"parentId": parent_id, "front": front,
                                            "back": back, "type": "forward"},
                        active_url)


def _attempt(db, r: RemnotePending, active_url: Optional[str] = None) -> dict:
    """Try to send, recording the outcome either way."""
    r.attempts = int(r.attempts or 0) + 1
    r.last_try_at = utcnow_naive()
    try:
        result = _send_one(r, active_url)
        r.status = "sent"
        r.sent_at = utcnow_naive()
        r.last_error = None
        if isinstance(result, dict):
            r.rem_id = result.get("remId") or result.get("id") or r.rem_id
        db.commit()
        return {"ok": True, "id": r.id, "rem_id": r.rem_id}
    except Exception as e:
        r.status = "failed"
        r.last_error = str(e)[:2000]
        db.commit()
        logger.warning("RemNote send failed for %s: %s", r.id, e)
        return {"ok": False, "id": r.id, "error": r.last_error}


def setup_remnote_routes():
    router = APIRouter(prefix="/api/remnote", tags=["remnote"])

    def owned_pending(db, item_id: str, owner: str) -> RemnotePending:
        q = db.query(RemnotePending).filter(RemnotePending.id == item_id)
        if owner:
            q = q.filter(RemnotePending.owner == owner)
        row = q.first()
        if not row:
            raise HTTPException(404, "Not found")
        return row

    @router.get("/status")
    def status(request: Request):
        me = require_user(request)
        health = _bridge_health()
        db = SessionLocal()
        try:
            q = db.query(RemnotePending)
            if me:
                q = q.filter(RemnotePending.owner == me)
            rows = q.all()
        finally:
            db.close()
        counts = {"pending": 0, "failed": 0, "sent": 0}
        for r in rows:
            counts[r.status or "pending"] = counts.get(r.status or "pending", 0) + 1
        return {"bridge": health, "counts": counts}

    @router.get("/pending")
    def list_pending(request: Request, include_sent: bool = False):
        me = require_user(request)
        db = SessionLocal()
        try:
            q = db.query(RemnotePending)
            if me:
                q = q.filter(RemnotePending.owner == me)
            if not include_sent:
                q = q.filter(RemnotePending.status != "sent")
            rows = q.order_by(RemnotePending.created_at.desc()).all()
            return {"items": [_row_dict(r) for r in rows]}
        finally:
            db.close()

    @router.post("/pending")
    def add_pending(body: PendingBody, request: Request):
        me = require_user(request)
        ctype = (body.card_type or "basic").lower()
        if ctype not in _CARD_TYPES:
            raise HTTPException(400, f"card_type must be one of {_CARD_TYPES}")
        if not (body.front or "").strip():
            raise HTTPException(400, "front is required")
        db = SessionLocal()
        try:
            r = RemnotePending(
                id=_uid(), owner=me or None,
                target=(body.target or "Journal").strip() or "Journal",
                card_type=ctype,
                front=body.front, back=body.back,
                status="pending",
                source=(body.source or "agent"),
                session_id=body.session_id,
            )
            db.add(r)
            db.commit()
            return _row_dict(r)
        finally:
            db.close()

    @router.patch("/pending/{item_id}")
    def patch_pending(item_id: str, body: PendingPatch, request: Request):
        me = require_user(request)
        db = SessionLocal()
        try:
            r = owned_pending(db, item_id, me)
            if body.target is not None:
                r.target = body.target.strip() or "Journal"
            if body.card_type is not None:
                ct = body.card_type.lower()
                if ct not in _CARD_TYPES:
                    raise HTTPException(400, f"card_type must be one of {_CARD_TYPES}")
                r.card_type = ct
            if body.front is not None:
                r.front = body.front
            if body.back is not None:
                r.back = body.back
            # An edit is a fresh chance — clear the failure so the row leaves
            # the "failed" bucket instead of looking permanently broken.
            if r.status == "failed":
                r.status = "pending"
                r.last_error = None
            db.commit()
            return _row_dict(r)
        finally:
            db.close()

    @router.delete("/pending/{item_id}")
    def delete_pending(item_id: str, request: Request):
        me = require_user(request)
        db = SessionLocal()
        try:
            r = owned_pending(db, item_id, me)
            db.delete(r)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.post("/pending/{item_id}/send")
    def send_pending(item_id: str, request: Request):
        me = require_user(request)
        db = SessionLocal()
        try:
            r = owned_pending(db, item_id, me)
            out = _attempt(db, r)
            out["item"] = _row_dict(r)
            return out
        finally:
            db.close()

    @router.post("/pending/send-all")
    def send_all(request: Request):
        me = require_user(request)
        # Check once up front: with the PC off, N cards would mean N timeouts.
        health = _bridge_health()
        if not health.get("ok"):
            return {"ok": False, "sent": 0, "failed": 0,
                    "error": health.get("error") or "Bridge unreachable"}
        db = SessionLocal()
        try:
            q = db.query(RemnotePending).filter(RemnotePending.status != "sent")
            if me:
                q = q.filter(RemnotePending.owner == me)
            rows = q.order_by(RemnotePending.created_at.asc()).all()
            sent = failed = 0
            results = []
            for r in rows:
                out = _attempt(db, r, health["active_url"])
                results.append(out)
                if out.get("ok"):
                    sent += 1
                else:
                    failed += 1
                    # The bridge died mid-run — stop instead of hammering it.
                    if "unreachable" in (out.get("error") or "").lower():
                        break
            return {"ok": failed == 0, "sent": sent, "failed": failed,
                    "results": results}
        finally:
            db.close()

    @router.post("/test")
    def test_bridge(request: Request):
        """Explicit connection test for the page's Test button."""
        require_user(request)
        return _bridge_health()

    return router
