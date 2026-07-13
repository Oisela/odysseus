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
