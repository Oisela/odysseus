"""Pomodoro focus-time stats: today / ISO-week sum / per-active-day average."""
import os
from datetime import date

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from routes.pomodoro_routes import compute_stats


def test_week_is_monday_based_and_average_ignores_empty_days():
    # 2026-07-13 is a Monday.
    log = {
        "2026-07-12": 3600,   # Sunday — previous ISO week, must NOT count
        "2026-07-13": 1800,   # Monday (today)
        "2026-07-15": 5400,   # Wednesday — future entries within the week count
    }
    s = compute_stats(log, date(2026, 7, 13))
    assert s["today_s"] == 1800
    assert s["week_s"] == 1800 + 5400
    assert s["active_days"] == 2
    assert s["week_avg_s"] == (1800 + 5400) // 2


def test_empty_log_yields_zeroes():
    s = compute_stats({}, date(2026, 7, 13))
    assert s == {"today_s": 0, "week_s": 0, "week_avg_s": 0, "active_days": 0}


def test_garbage_values_are_ignored_not_crashing():
    log = {"2026-07-13": "kaputt", "2026-07-14": -50, "2026-07-16": 600}
    s = compute_stats(log, date(2026, 7, 16))
    assert s["today_s"] == 600
    assert s["week_s"] == 600
    assert s["week_avg_s"] == 600


def test_normalize_preserves_drinks_and_excludes_them_from_stray_merge():
    # v3.7 water tracker: the drinks map must survive every normalize->write
    # cycle, and must NOT be treated as stray day-total keys (the v3.1
    # rollback-window merge). Invalid drink values are dropped.
    from routes.pomodoro_routes import _normalize_owner_record

    rec = {
        "entries": [{"id": "a", "date": "2026-07-22", "seconds": 60, "note": ""}],
        "drinks": {"2026-07-22": 4, "not-a-date": 9, "2026-07-21": "3"},
        "2026-07-20": 1200,  # stray rollback-window day total -> synthetic entry
    }
    out = _normalize_owner_record(rec)
    assert out["drinks"] == {"2026-07-22": 4, "2026-07-21": 3}
    notes = [e.get("note") for e in out["entries"]]
    assert any("Rollback" in (n or "") for n in notes)
    # drinks did not leak into the synthetic day-total entries
    assert all(e["date"] != "not-a-date" for e in out["entries"])


def test_normalize_legacy_record_gets_empty_drinks():
    from routes.pomodoro_routes import _normalize_owner_record

    out = _normalize_owner_record({"2026-07-19": 600})
    assert out["drinks"] == {}
    assert out["entries"] and out["entries"][0]["seconds"] == 600
