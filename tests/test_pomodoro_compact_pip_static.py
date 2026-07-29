"""Regression checks for the compact TickTick-style Pomodoro popout."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POMODORO_JS = (ROOT / "static" / "js" / "pomodoro.js").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "static" / "style.css").read_text(encoding="utf-8")


def test_pomodoro_pip_is_compact_and_can_collapse():
    assert "requestWindow({ width: 300, height: 168 })" in POMODORO_JS
    assert 'id="pip-collapse"' in POMODORO_JS
    assert "shell.classList.toggle('is-collapsed', _pipCollapsed)" in POMODORO_JS
    assert "win.resizeTo(_pipCollapsed ? 174 : 300" in POMODORO_JS
    assert ".pomo-pip-body.is-collapsed" in STYLE_CSS
    assert "justify-content: center;" in STYLE_CSS


def test_pomodoro_pip_keeps_controls_progress_and_focus_stats():
    assert 'id="pip-primary"' in POMODORO_JS
    assert 'id="pip-ring-fg"' in POMODORO_JS
    assert 'id="pip-today"' in POMODORO_JS
    assert 'id="pip-week"' in POMODORO_JS
    assert "_pipPrimaryAction()" in POMODORO_JS
    assert "_focusStats.today_s" in POMODORO_JS
    assert "_focusStats.week_s" in POMODORO_JS


def test_pip_stats_refresh_even_when_main_modal_stats_are_unavailable():
    refresh = POMODORO_JS.split("async function _refreshStats()", 1)[1].split(
        "// ── Focus record", 1
    )[0]
    assert "if (!box) return" not in refresh
    assert "_renderPiP();" in refresh
