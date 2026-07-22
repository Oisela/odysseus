"""Sticky session tools: tools that already ran in a session stay selectable.

Regression (2026-07-22): the embedding tool selector is per-turn stateless —
a terse follow-up ("okey dann die fc") lost the remnote MCP tools the same
session had just used to create cards, and the model fell back to the
offline buffer although the bridge was fine.
"""
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from src import agent_loop


class _Msg:
    def __init__(self, metadata):
        self.metadata = metadata


class _Sess:
    def __init__(self, history):
        self.history = history


def _patch_manager(monkeypatch, sess):
    import src.ai_interaction as ai

    class _Mgr:
        def get_session(self, _sid):
            return sess

    monkeypatch.setattr(ai, "get_session_manager", lambda: _Mgr())


def test_reads_tool_names_from_tool_events(monkeypatch):
    sess = _Sess([
        _Msg({"tool_events": [{"tool": "mcp__abc__remnote_call"}, {"tool": "bash"}]}),
        _Msg(None),
        _Msg({"tool_events": [{"tool": "manage_notes"}, {}]}),
    ])
    _patch_manager(monkeypatch, sess)
    assert agent_loop._session_tools_used("sid") == {
        "mcp__abc__remnote_call", "bash", "manage_notes",
    }


def test_missing_session_or_id_is_empty(monkeypatch):
    _patch_manager(monkeypatch, None)
    assert agent_loop._session_tools_used("sid") == set()
    assert agent_loop._session_tools_used("") == set()


def test_only_newest_limit_messages_count(monkeypatch):
    old = _Msg({"tool_events": [{"tool": "ancient_tool"}]})
    new = [_Msg({"tool_events": [{"tool": f"t{i}"}]}) for i in range(40)]
    _patch_manager(monkeypatch, _Sess([old] + new))
    used = agent_loop._session_tools_used("sid", limit=40)
    assert "ancient_tool" not in used
    assert "t0" in used and "t39" in used
