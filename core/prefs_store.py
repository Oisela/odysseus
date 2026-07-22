"""Persistence for per-user preferences — the PUBLIC way to read/write prefs.

Extracted from routes/prefs_routes.py (v3.7): non-route modules kept
underscore-importing the storage helpers from a routes module. The
implementation lives here now; prefs_routes re-exports the old names for
its historic importers and owns only the HTTP layer.

Storage format: one JSON file. Multi-user stores nest per-user dicts under
"_users"; the legacy flat format (pre-auth) is still read as-is.
"""
import json
import os
from typing import Optional

from src.constants import USER_PREFS_FILE

PREFS_FILE = USER_PREFS_FILE


def load_all_prefs() -> dict:
    """Load the raw prefs file (all users)."""
    try:
        with open(PREFS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_all_prefs(prefs: dict) -> None:
    os.makedirs(os.path.dirname(PREFS_FILE) or ".", exist_ok=True)
    tmp = f"{PREFS_FILE}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(prefs, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, PREFS_FILE)


def load_prefs_for_user(user: Optional[str] = None) -> dict:
    """Load preferences for a specific user."""
    all_prefs = load_all_prefs()
    if "_users" in all_prefs:
        if user is None:
            # Auth disabled — return first user's prefs for backward compat
            users = all_prefs["_users"]
            return dict(next(iter(users.values()), {}))
        return dict(all_prefs["_users"].get(user, {}))
    # Legacy flat format — return as-is
    return dict(all_prefs)


def save_prefs_for_user(user: Optional[str], prefs: dict) -> None:
    """Save preferences for a specific user."""
    all_prefs = load_all_prefs()
    if user is None:
        # Auth disabled. If the store is already multi-user (e.g. auth was
        # turned off on a deployment that previously ran multi-user), writing
        # `prefs` flat would overwrite the whole `_users` map and destroy every
        # other user's preferences. Instead write back into the same (first)
        # slot load_prefs_for_user(None) reads from, preserving the others.
        if "_users" in all_prefs:
            users = all_prefs["_users"]
            first_key = next(iter(users), None)
            if first_key is not None:
                users[first_key] = prefs
                save_all_prefs(all_prefs)
                return
        save_all_prefs(prefs)
        return
    if "_users" not in all_prefs:
        all_prefs = {"_users": {}}
    all_prefs["_users"][user] = prefs
    save_all_prefs(all_prefs)
