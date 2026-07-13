# routes/pomodoro_routes.py
"""Pomodoro focus-timer API: phone pings (ntfy) + persistent focus-time log.

The timer itself runs client-side (static/js/pomodoro.js). The server keeps
the learned-time ledger so every device (desktop PWA, phone) sees the same
today/week statistics, and relays phase-change notifications to ntfy.
"""

import os
import uuid
import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request

from core.atomic_io import atomic_write_json
from src.auth_helpers import require_user
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

POMODORO_LOG_FILE = os.path.join(DATA_DIR, "pomodoro_log.json")

# Manual entries and overtime can be long, but a single log call claiming more
# than a day of focus is garbage input, not enthusiasm.
_MAX_SECONDS_PER_LOG = 24 * 3600


def _load_log() -> Dict[str, Dict[str, int]]:
    try:
        import json
        with open(POMODORO_LOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"pomodoro log unreadable, starting fresh: {e}")
        return {}


def compute_stats(day_seconds: Dict[str, Any], today: date) -> Dict[str, int]:
    """Pure stats over one owner's {iso-date: seconds} map.

    Week = ISO week (Monday-based) containing `today`. The per-day average
    counts only days with logged time, so a lazy Sunday doesn't dilute it.
    """
    monday = today - timedelta(days=today.weekday())
    week_days = [(monday + timedelta(days=i)).isoformat() for i in range(7)]

    def _sec(v: Any) -> int:
        try:
            return max(0, int(v))
        except (TypeError, ValueError):
            return 0

    today_s = _sec(day_seconds.get(today.isoformat()))
    week_vals = [_sec(day_seconds.get(d)) for d in week_days]
    week_s = sum(week_vals)
    active_days = sum(1 for v in week_vals if v > 0)
    return {
        "today_s": today_s,
        "week_s": week_s,
        "week_avg_s": week_s // active_days if active_days else 0,
        "active_days": active_days,
    }


def setup_pomodoro_routes():
    router = APIRouter(prefix="/api/pomodoro", tags=["pomodoro"])

    def _owner(request: Request) -> Optional[str]:
        # Fail closed when auth is configured (see note_routes._owner for the
        # full rationale); documented anonymous modes resolve to None.
        return require_user(request) or None

    def _owner_key(request: Request) -> str:
        return str(_owner(request) or "")

    @router.post("/notify")
    async def pomodoro_notify(request: Request):
        """Push a pomodoro phase-change ping to the phone via ntfy.

        The browser notification fires client-side in pomodoro.js; this
        endpoint only covers the ntfy channel and forces it, independent of
        the user's default reminder channel. Synthesis is disabled — a timer
        ping has nothing to synthesize and must never burn tokens.
        """
        from routes.note_routes import dispatch_reminder

        _owner(request)
        body = await request.json()
        title = (str(body.get("title") or "").strip() or "Pomodoro")[:100]
        text = str(body.get("body") or "").strip()[:300]
        return await dispatch_reminder(
            title=title,
            note_body=text,
            note_id=f"pomodoro-{uuid.uuid4().hex[:8]}",
            owner=_owner(request) or "",
            queue_browser=False,
            settings_override={
                "reminder_channel": "ntfy",
                "reminder_llm_synthesis": False,
            },
        )

    @router.post("/log")
    async def pomodoro_log(request: Request) -> Dict[str, Any]:
        """Add focus seconds to the ledger.

        Body: {"seconds": int, "date": "YYYY-MM-DD"?}. The date defaults to
        today (server-local — the container runs in the user's timezone) and
        also serves manual back-filling ("forgot to stop the timer").
        """
        key = _owner_key(request)
        body = await request.json()
        try:
            seconds = int(body.get("seconds"))
        except (TypeError, ValueError):
            raise HTTPException(400, "seconds must be an integer")
        if seconds <= 0 or seconds > _MAX_SECONDS_PER_LOG:
            raise HTTPException(400, "seconds out of range")

        raw_date = str(body.get("date") or "").strip()
        if raw_date:
            try:
                day = date.fromisoformat(raw_date).isoformat()
            except ValueError:
                raise HTTPException(400, "date must be YYYY-MM-DD")
        else:
            day = datetime.now().date().isoformat()

        log = _load_log()
        mine = log.setdefault(key, {})
        try:
            current = max(0, int(mine.get(day, 0)))
        except (TypeError, ValueError):
            current = 0
        mine[day] = current + seconds
        atomic_write_json(POMODORO_LOG_FILE, log, indent=2)

        stats = compute_stats(mine, datetime.now().date())
        return {"ok": True, "date": day, "day_total_s": mine[day], **stats}

    @router.get("/stats")
    async def pomodoro_stats(request: Request) -> Dict[str, Any]:
        """Today / this-week / per-day-average focus time for the caller."""
        key = _owner_key(request)
        mine = _load_log().get(key, {})
        return compute_stats(mine, datetime.now().date())

    return router
