"""User preferences API — HTTP layer over core.prefs_store.

The storage implementation lives in core/prefs_store.py (public helpers —
import from there, not from this routes module). The underscore aliases
below keep this module's historic importers working until they migrate.
"""
from fastapi import APIRouter, HTTPException, Request
from src.auth_helpers import get_current_user
from core.prefs_store import (
    PREFS_FILE,
    load_all_prefs as _load,
    save_all_prefs as _save,
    load_prefs_for_user as _load_for_user,
    save_prefs_for_user as _save_for_user,
)


def setup_prefs_routes():
    router = APIRouter(prefix="/api/prefs", tags=["preferences"])

    @router.get("")
    async def get_all_prefs(request: Request):
        user = get_current_user(request)
        return _load_for_user(user)

    @router.get("/{key}")
    async def get_pref(request: Request, key: str):
        user = get_current_user(request)
        prefs = _load_for_user(user)
        return {"key": key, "value": prefs.get(key)}

    @router.put("/{key}")
    async def set_pref(request: Request, key: str, body: dict):
        user = get_current_user(request)
        prefs = _load_for_user(user)
        prefs[key] = body.get("value")
        _save_for_user(user, prefs)
        return {"key": key, "value": prefs[key]}

    @router.put("/admin/{username}/{key}")
    async def admin_set_pref(request: Request, username: str, key: str, body: dict):
        """Admin writes a pref for another account (e.g. the Simple-UI preset)."""
        user = get_current_user(request)
        auth_manager = getattr(request.app.state, "auth_manager", None)
        if not user or auth_manager is None or not auth_manager.is_admin(user):
            raise HTTPException(403, "Admin only")
        if username not in auth_manager.users:
            raise HTTPException(404, "User not found")
        prefs = _load_for_user(username)
        prefs[key] = body.get("value")
        _save_for_user(username, prefs)
        return {"user": username, "key": key, "value": prefs[key]}

    return router
