from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT_JS = (ROOT / "static/js/chat.js").read_text()
CHAT_RENDERER_JS = (ROOT / "static/js/chatRenderer.js").read_text()
STYLE_CSS = (ROOT / "static/style.css").read_text()


def test_completed_tool_runs_are_compacted_in_live_chat():
    assert "function _refreshCompactThread(thread)" in CHAT_JS
    assert "completed.length >= 2 && failures.length === 0 && active.length === 0" in CHAT_JS
    assert "_refreshCompactThread(currentToolBubble.closest('.agent-thread'))" in CHAT_JS
    assert "${completed.length} actions completed" in CHAT_JS


def test_compact_activity_group_can_be_expanded_and_keeps_errors_visible():
    assert "const summary = e.target.closest('.agent-thread-summary');" in CHAT_JS
    assert "thread.classList.toggle('compact-open')" in CHAT_JS
    assert ".agent-thread.compact:not(.compact-open) .agent-thread-node" in STYLE_CSS
    assert "display: none;" in STYLE_CSS
    assert "failures.length === 0" in CHAT_JS


def test_completed_activity_group_is_restored_after_reload():
    assert "Compact successful multi-action runs after a reload" in CHAT_RENDERER_JS
    assert "completedCount >= 2 && failureCount === 0" in CHAT_RENDERER_JS
    assert "${completedCount} actions completed" in CHAT_RENDERER_JS
