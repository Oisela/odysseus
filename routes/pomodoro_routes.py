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


def _load_log() -> Dict[str, Dict[str, Any]]:
    try:
        import json
        with open(POMODORO_LOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return {k: _normalize_owner_record(v) for k, v in data.items()}
    except FileNotFoundError:
        return {}
    except Exception as e:
        logger.warning(f"pomodoro log unreadable, starting fresh: {e}")
        return {}


def _normalize_owner_record(rec: Any) -> Dict[str, Any]:
    """Upgrade an owner's record to the entries format.

    v1 stored only day totals ({iso-date: seconds}); v2 keeps individual
    sessions ({"entries": [{id, date, start, end, seconds, note}]}) so the UI
    can show and delete single pomodoros (TickTick-style focus record). Old
    day totals become one synthetic entry per day — totals stay identical.
    """
    def _day_total_entries(source: dict, note: str, prefix: str) -> list:
        out = []
        for day in sorted(source):
            try:
                seconds = max(0, int(source[day]))
                date.fromisoformat(str(day))
            except (TypeError, ValueError):
                continue
            if seconds:
                out.append({
                    # Deterministic id: normalization runs on every LOAD but
                    # only persists on the next write — random ids would break
                    # delete-by-id in between (fetched id != regenerated id).
                    "id": f"{prefix}-{day}",
                    "date": str(day),
                    "start": None,
                    "end": None,
                    "seconds": seconds,
                    "note": note,
                })
        return out

    def _drinks(rec: Any) -> Dict[str, int]:
        # v3.7: water tracker — {iso-date: glasses}. Must survive every
        # normalize→write cycle, so it is carried through explicitly here.
        raw = rec.get("drinks") if isinstance(rec, dict) else None
        out: Dict[str, int] = {}
        if isinstance(raw, dict):
            for day, n in raw.items():
                try:
                    date.fromisoformat(str(day))
                    out[str(day)] = max(0, int(n))
                except (TypeError, ValueError):
                    continue
        return out

    if isinstance(rec, dict) and isinstance(rec.get("entries"), list):
        entries = [e for e in rec["entries"] if isinstance(e, dict)]
        # A v3.1-era instance (rollback window) logs day totals NEXT TO the
        # entries key — merge those stray day keys instead of dropping the
        # focus time silently on the next upgrade.
        stray = {k: v for k, v in rec.items() if k not in ("entries", "drinks")}
        entries += _day_total_entries(stray, "Tagessumme (Rollback-Fenster)", "rb")
        return {"entries": entries, "drinks": _drinks(rec)}
    entries = _day_total_entries(rec if isinstance(rec, dict) else {}, "Tagessumme (vor v3.2)", "legacy")
    return {"entries": entries, "drinks": _drinks(rec)}


def _day_seconds(rec: Dict[str, Any]) -> Dict[str, int]:
    """Collapse an owner's entries into the {iso-date: seconds} map the
    stats math works on."""
    days: Dict[str, int] = {}
    for e in rec.get("entries", []):
        try:
            days[e["date"]] = days.get(e["date"], 0) + max(0, int(e.get("seconds", 0)))
        except (KeyError, TypeError, ValueError):
            continue
    return days


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

    def _create_focus_event(owner, entry, seconds: int) -> None:
        from datetime import timezone
        from core.database import SessionLocal, CalendarCal, CalendarEvent
        db = SessionLocal()
        try:
            cal = (
                db.query(CalendarCal)
                .filter(CalendarCal.owner == owner, CalendarCal.name == "Focus")
                .first()
            )
            if not cal:
                cal = CalendarCal(
                    id=uuid.uuid4().hex[:12], owner=owner, name="Focus",
                    color="#e06c75", source="local",
                )
                db.add(cal)
                db.flush()

            def _naive_utc(s: str):
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                if dt.tzinfo:
                    dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
                return dt

            mins = max(1, round(seconds / 60))
            note = entry.get("note") or "Focus"
            db.add(CalendarEvent(
                uid=uuid.uuid4().hex,
                calendar_id=cal.id,
                summary=f"{note} · {mins} min",
                description="Pomodoro",
                dtstart=_naive_utc(entry["start"]),
                dtend=_naive_utc(entry["end"]),
                all_day=False,
                is_utc=True,
                rrule="",
            ))
            db.commit()
        finally:
            db.close()

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

        def _iso_ts(field: str) -> Optional[str]:
            raw = str(body.get(field) or "").strip()
            if not raw:
                return None
            try:
                datetime.fromisoformat(raw.replace("Z", "+00:00"))
                return raw
            except ValueError:
                return None

        log = _load_log()
        mine = log.setdefault(key, {"entries": []})
        entry = {
            "id": uuid.uuid4().hex[:12],
            "date": day,
            "start": _iso_ts("start"),
            "end": _iso_ts("end"),
            "seconds": seconds,
            "note": str(body.get("note") or "").strip()[:120],
        }
        mine["entries"].append(entry)
        atomic_write_json(POMODORO_LOG_FILE, log, indent=2)

        # v3.6: every booked focus block also lands in the calendar (local
        # "Focus" calendar, auto-created per owner) — the day plan then
        # shows real learn time. Manual back-fills without start/end skip
        # this; a calendar failure must never lose the log entry.
        if entry["start"] and entry["end"]:
            try:
                from src.settings import get_setting
                if get_setting("pomodoro_calendar_log", True):
                    _create_focus_event(_owner(request), entry, seconds)
            except Exception:
                logger.debug("focus calendar log skipped", exc_info=True)

        days = _day_seconds(mine)
        stats = compute_stats(days, datetime.now().date())
        return {"ok": True, "id": entry["id"], "date": day,
                "day_total_s": days.get(day, 0), **stats}

    @router.get("/stats")
    async def pomodoro_stats(request: Request) -> Dict[str, Any]:
        """Today / this-week / per-day-average focus time for the caller,
        plus all-time totals for the statistics view."""
        key = _owner_key(request)
        mine = _load_log().get(key, {"entries": []})
        days = _day_seconds(mine)
        today = datetime.now().date()
        stats = compute_stats(days, today)
        entries = mine.get("entries", [])
        stats["total_s"] = sum(days.values())
        stats["total_sessions"] = len(entries)
        stats["today_sessions"] = sum(1 for e in entries if e.get("date") == today.isoformat())
        stats["today_drinks"] = int((mine.get("drinks") or {}).get(today.isoformat(), 0))
        return stats

    @router.post("/drink")
    async def pomodoro_drink(request: Request) -> Dict[str, Any]:
        """Water tracker: bump today's glass count (delta may be negative
        for a mis-click). Lives in the pomodoro ledger so every device
        shows the same count."""
        key = _owner_key(request)
        body = await request.json()
        try:
            delta = int(body.get("delta", 1))
        except (TypeError, ValueError):
            raise HTTPException(400, "delta must be an integer")
        if not -50 <= delta <= 50:
            raise HTTPException(400, "delta out of range")
        today = datetime.now().date().isoformat()
        log = _load_log()
        mine = log.setdefault(key, {"entries": [], "drinks": {}})
        drinks = mine.setdefault("drinks", {})
        drinks[today] = max(0, int(drinks.get(today, 0)) + delta)
        atomic_write_json(POMODORO_LOG_FILE, log, indent=2)
        return {"ok": True, "date": today, "today_drinks": drinks[today]}

    @router.get("/records")
    async def pomodoro_records(request: Request, limit: int = 200) -> Dict[str, Any]:
        """Individual focus sessions, newest first (TickTick's focus record)."""
        key = _owner_key(request)
        mine = _load_log().get(key, {"entries": []})
        entries = sorted(
            mine.get("entries", []),
            key=lambda e: (str(e.get("date") or ""), str(e.get("end") or e.get("start") or "")),
            reverse=True,
        )
        return {"records": entries[: max(1, min(limit, 1000))]}

    @router.delete("/records/{entry_id}")
    async def pomodoro_delete_record(entry_id: str, request: Request) -> Dict[str, Any]:
        """Remove a single logged session (mis-click, double log)."""
        key = _owner_key(request)
        log = _load_log()
        mine = log.setdefault(key, {"entries": []})
        before = len(mine["entries"])
        mine["entries"] = [e for e in mine["entries"] if e.get("id") != entry_id]
        if len(mine["entries"]) == before:
            raise HTTPException(404, "Eintrag nicht gefunden")
        atomic_write_json(POMODORO_LOG_FILE, log, indent=2)
        stats = compute_stats(_day_seconds(mine), datetime.now().date())
        return {"ok": True, **stats}

    return router
