"""Regression tests for Anthropic prompt-cache breakpoints in _build_anthropic_payload (#791)."""
from src import llm_core


def _payload(system="sys", user="hi", tools=None, extra_messages=None):
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if extra_messages:
        messages.extend(extra_messages)
    return llm_core._build_anthropic_payload("claude", messages, 0.0, 1000, stream=True, tools=tools)


def _last_block_cached(payload):
    """True if the last chat message has a cache_control breakpoint on its last block."""
    content = payload["messages"][-1].get("content")
    if isinstance(content, list) and content:
        return content[-1].get("cache_control") == {"type": "ephemeral"}
    return False


def test_agentic_caches_system_last_tool_and_history():
    tools = [
        {"type": "function", "function": {"name": "a", "description": "x", "parameters": {}}},
        {"type": "function", "function": {"name": "b", "description": "y", "parameters": {}}},
    ]
    p = _payload(system="SYS PROMPT " * 50, tools=tools)
    assert isinstance(p["system"], list)
    assert p["system"][0].get("cache_control") == {"type": "ephemeral"}
    assert "cache_control" not in p["tools"][0], "only the LAST tool is a breakpoint"
    assert p["tools"][-1].get("cache_control") == {"type": "ephemeral"}
    # History caching: the last message block is now also a breakpoint.
    assert _last_block_cached(p), "last message block should carry a cache breakpoint"
    breakpoints = (
        sum("cache_control" in b for b in p["system"])
        + sum("cache_control" in t for t in p["tools"])
        + sum(
            "cache_control" in b
            for m in p["messages"]
            if isinstance(m.get("content"), list)
            for b in m["content"]
        )
    )
    # Anthropic allows at most 4 breakpoints; we use exactly 3 here.
    assert breakpoints == 3
    assert breakpoints <= 4


def test_tiny_tool_less_prompt_not_cached():
    p = _payload(system="hi", tools=None)
    assert isinstance(p["system"], list)
    assert "cache_control" not in p["system"][0]
    # A single short user turn with no tools should NOT get a history breakpoint.
    assert not _last_block_cached(p)


def test_large_system_only_is_cached():
    p = _payload(system="z" * 5000, tools=None)
    assert p["system"][0].get("cache_control") == {"type": "ephemeral"}


def test_long_history_cached_without_tools():
    # No tools, but a multi-turn transcript (>2 chat messages) is worth caching.
    extra = [
        {"role": "assistant", "content": "answer one"},
        {"role": "user", "content": "follow up"},
        {"role": "assistant", "content": "answer two"},
    ]
    p = _payload(system="sys", tools=None, extra_messages=extra)
    assert _last_block_cached(p), "long transcript should carry a history breakpoint"


def test_string_content_normalised_to_block_for_caching():
    tools = [{"type": "function", "function": {"name": "a", "description": "x", "parameters": {}}}]
    p = _payload(system="sys", user="plain string turn", tools=tools)
    last = p["messages"][-1]["content"]
    assert isinstance(last, list), "plain-string content must be normalised to a block list"
    assert last[-1].get("cache_control") == {"type": "ephemeral"}
