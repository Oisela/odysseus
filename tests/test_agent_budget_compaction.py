"""v3.5: agent-budget-aware compaction.

Two halves of one fix:
  (a) resolve_agent_input_budget — the shared settings+window resolver used by
      both the agent soft-trim (agent_loop) and the compaction trigger
      (chat_helpers), so both key off the SAME budget.
  (b) maybe_compact(budget_tokens=...) — the compaction threshold keys off the
      caller-imposed budget instead of the (much larger) model window, so old
      turns are summarized before the trim silently front-drops them.

Uses mock imports to avoid loading the full app stack (same harness as
test_compaction_summary_failure.py)."""

import asyncio
import sys
from unittest.mock import MagicMock

# Mock heavy dependencies before importing
for mod in [
    'sqlalchemy', 'sqlalchemy.orm', 'sqlalchemy.ext', 'sqlalchemy.ext.declarative',
    'sqlalchemy.ext.hybrid', 'sqlalchemy.sql', 'sqlalchemy.sql.expression',
    'src.database',
    'core.models', 'core.database',
]:
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()

import src.context_compactor as cc
from src.context_compactor import maybe_compact
from src.context_budget import (
    DEFAULT_BUDGET,
    DEFAULT_HARD_MAX,
    resolve_agent_input_budget,
)
from src.model_context import _lookup_known


# ---------------------------------------------------------------------------
# (a) resolve_agent_input_budget
# ---------------------------------------------------------------------------

def _settings(values):
    def get_setting(key, default=None):
        return values.get(key, default)
    return get_setting


def test_resolver_scales_to_known_window(monkeypatch):
    import src.model_context as mc
    monkeypatch.setattr(mc, "budget_context_for_model", lambda u, m, fallback=0: 1_000_000)
    budget = resolve_agent_input_budget("https://api.anthropic.com", "claude-sonnet-5",
                                        get_setting=_settings({}))
    # auto budget = 0.85 * window, capped at the hard max
    assert budget == DEFAULT_HARD_MAX


def test_resolver_conservative_when_window_unknown(monkeypatch):
    import src.model_context as mc
    monkeypatch.setattr(mc, "budget_context_for_model", lambda u, m, fallback=0: 0)
    budget = resolve_agent_input_budget("http://local", "mystery-model",
                                        get_setting=_settings({}))
    assert budget == DEFAULT_BUDGET


def test_resolver_honours_explicit_budget(monkeypatch):
    import src.model_context as mc
    monkeypatch.setattr(mc, "budget_context_for_model", lambda u, m, fallback=0: 1_000_000)
    budget = resolve_agent_input_budget("u", "m",
                                        get_setting=_settings({"agent_input_token_budget": 30_000}))
    assert budget == 30_000


def test_resolver_disabled_budget_returns_zero():
    budget = resolve_agent_input_budget("u", "m",
                                        get_setting=_settings({"agent_input_token_budget": 0}))
    assert budget == 0


def test_claude5_windows_are_known():
    # The whole fix rests on current Anthropic models being in the known table —
    # an unknown window collapses the auto budget to the 6k default.
    assert _lookup_known("claude-sonnet-5") == 1_000_000
    assert _lookup_known("claude-fable-5") == 1_000_000
    assert _lookup_known("claude-opus-4-8") == 1_000_000
    assert _lookup_known("claude-haiku-4-5") == 200_000


# ---------------------------------------------------------------------------
# (b) maybe_compact with budget_tokens
# ---------------------------------------------------------------------------

def _history(n=8):
    msgs = [{"role": "system", "content": "sys"}]
    for i in range(n):
        msgs.append({"role": "user", "content": f"frage {i}"})
        msgs.append({"role": "assistant", "content": f"antwort {i}"})
    return msgs


def _run_compact(messages, *, window, used, budget_tokens=None):
    orig = (cc.get_context_length, cc.estimate_tokens, cc.llm_call_async,
            cc.resolve_endpoint, cc._update_session_history)

    async def _summary(*a, **k):
        return "kompakte zusammenfassung"

    cc.get_context_length = lambda url, model: window
    cc.estimate_tokens = lambda msgs: used
    cc.llm_call_async = _summary
    cc.resolve_endpoint = lambda *a, **k: (None, None, None)
    cc._update_session_history = lambda *a, **k: None
    try:
        return asyncio.run(maybe_compact(
            session=None, endpoint_url="http://x", model="m",
            messages=list(messages), headers={}, budget_tokens=budget_tokens,
        ))
    finally:
        (cc.get_context_length, cc.estimate_tokens, cc.llm_call_async,
         cc.resolve_endpoint, cc._update_session_history) = orig


def test_budget_triggers_compaction_below_model_window():
    # 90k tokens: far below 85% of a 1M window, but over 85% of a 100k budget.
    msgs, ctx, compacted = _run_compact(_history(), window=1_000_000, used=90_000,
                                        budget_tokens=100_000)
    assert compacted is True
    assert any("Conversation summary" in (m.get("content") or "") for m in msgs)


def test_without_budget_same_usage_does_not_compact():
    msgs_in = _history()
    msgs, ctx, compacted = _run_compact(msgs_in, window=1_000_000, used=90_000)
    assert compacted is False
    assert msgs == msgs_in


def test_budget_below_threshold_does_not_compact():
    msgs_in = _history()
    msgs, ctx, compacted = _run_compact(msgs_in, window=1_000_000, used=50_000,
                                        budget_tokens=100_000)
    assert compacted is False
    assert msgs == msgs_in


def test_budget_never_raises_threshold_above_window():
    # A budget LARGER than the window must not delay compaction past the
    # window-based threshold (min() semantics).
    msgs, ctx, compacted = _run_compact(_history(), window=100_000, used=90_000,
                                        budget_tokens=500_000)
    assert compacted is True
