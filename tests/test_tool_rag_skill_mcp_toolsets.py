"""Regression: a skill could never hand its MCP tools to the model.

Alessio typed `/remnote` and asked (in German) for a due date to be set. Bob
answered that no RemNote write action existed and then called `remnote_status`
about twenty times in a row. The action existed the whole time — the bridge
ships `set_tag_property_value`, reachable through `remnote_call`. The model
simply never received that tool's schema.

Three independent defects stacked up, each on its own enough to lose the tools:

1. `_classify_agent_request` marks a turn `low_signal` whenever no English
   domain pattern matches, so *every* German turn was low-signal. The
   skill-aware tool include was gated on `not _low_signal_turn` and never ran.
2. `requires_toolsets` was filtered through `known_tool_names()`, which lists
   native tools only. Any MCP tool a skill declared was silently discarded.
3. The deterministic "user named the server" include compared the full server
   name as a substring. Nobody writes "RemNote Local" mid-sentence, so the
   multi-word servers never matched.

These tests pin the two mechanical pieces (2 and 3). Defect 1 is a one-token
guard change covered by test_skill_block_runs_on_non_english_turn.
"""

from src.agent_loop import _classify_agent_request, _is_casual_low_signal
from src.mcp_manager import (
    McpManager,
    mcp_server_name_tokens,
    query_names_mcp_server,
)


def _manager_with_tools(servers):
    """An McpManager with a hand-built tool table (no live connections)."""
    mgr = McpManager.__new__(McpManager)
    mgr._tools = {sid: tools for sid, (_name, tools) in servers.items()}
    mgr._connections = {sid: {"name": name} for sid, (name, _tools) in servers.items()}
    return mgr


_FORK = {
    "1b08d10e": (
        "RemNote Fork (Y Edition)",
        [
            {"name": "remnote_status", "description": "bridge status"},
            {"name": "remnote_call", "description": "passthrough action"},
        ],
    ),
    "368b9fd7": (
        "RemNote Local",
        [{"name": "read_open_documents", "description": "what is open"}],
    ),
    "aa11bb22": (
        "Spotify",
        [{"name": "search", "description": "search tracks"}],
    ),
}


def test_bare_skill_toolset_resolves_to_qualified_mcp_name():
    """A skill declares `remnote_call`; the runtime must find it behind the
    per-instance hex server id it actually landed on."""
    mgr = _manager_with_tools(_FORK)
    resolved = mgr.resolve_qualified_names({"remnote_call", "read_open_documents"})
    assert resolved == {
        "mcp__1b08d10e__remnote_call",
        "mcp__368b9fd7__read_open_documents",
    }


def test_resolution_ignores_unrelated_servers():
    mgr = _manager_with_tools(_FORK)
    assert mgr.resolve_qualified_names({"remnote_call"}) == {
        "mcp__1b08d10e__remnote_call"
    }


def test_resolution_skips_disabled_tools():
    mgr = _manager_with_tools(_FORK)
    disabled = {"1b08d10e": {"remnote_call"}}
    assert mgr.resolve_qualified_names({"remnote_call"}, disabled) == set()


def test_unknown_name_resolves_to_nothing():
    mgr = _manager_with_tools(_FORK)
    assert mgr.resolve_qualified_names({"does_not_exist"}) == set()


def test_empty_request_is_cheap():
    mgr = _manager_with_tools(_FORK)
    assert mgr.resolve_qualified_names(set()) == set()
    assert mgr.resolve_qualified_names(None) == set()


# --- defect 3: server-name matching -----------------------------------------

def test_multi_word_server_matches_on_distinctive_token():
    """The whole point: 'in RemNote' must reach 'RemNote Fork (Y Edition)'."""
    tokens = mcp_server_name_tokens("RemNote Fork (Y Edition)")
    assert "remnote" in tokens
    q = "kannst du das due date aktualisieren in remnote"
    assert any(t in q for t in tokens)


def test_flavour_words_are_not_matchable_tokens():
    """'local' / 'fork' must not pull a server in on an unrelated sentence."""
    tokens = mcp_server_name_tokens("RemNote Local")
    assert tokens == {"remnote"}
    assert not any(t in "i work on a local branch fork" for t in tokens)


def test_short_and_generic_names_fall_back_to_full_match():
    """A server with nothing distinctive yields no tokens, so the caller's
    full-name substring test stays the only path — no over-firing."""
    assert mcp_server_name_tokens("MCP API") == set()
    assert mcp_server_name_tokens("") == set()


def test_single_word_server_still_matches():
    tokens = mcp_server_name_tokens("Spotify")
    assert tokens == {"spotify"}


# --- defect 1: the low-signal guard ------------------------------------------

_GERMAN_ASK = "kannst du das due date aktualisieren in remnote"


def test_german_request_is_flagged_low_signal():
    """Documents the trap: the domain patterns are English-only, so a perfectly
    specific German request is classified as having no signal at all."""
    intent = _classify_agent_request([], _GERMAN_ASK)
    assert intent["low_signal"] is True
    assert not intent["domains"]


def test_skill_block_runs_on_non_english_turn():
    """The new guard: that same turn is NOT *casually* low-signal, so the
    skill-aware tool include now runs and a skill can unlock its tools."""
    assert _is_casual_low_signal(_GERMAN_ASK) is False


def test_casual_opener_stays_gated():
    """The guard must still keep a throwaway greeting cheap."""
    assert _is_casual_low_signal("hi") is True


# --- defect 4: the user's spelling ------------------------------------------
#
# Verbatim from the 2026-08-19 logs. The configured servers are "remnote" and
# "remnote-http"; not one message spelled the word correctly, so the exact
# match never fired and both servers' tools stayed unreachable all session.

_REAL_MISSPELLINGS = [
    "kannst du das due date akutelleisen in rmenote",
    "jetz will ich da du remntoe die aufagbelaette das richtig due date einfgst",
]


def test_real_session_typos_still_name_the_server():
    for msg in _REAL_MISSPELLINGS:
        assert query_names_mcp_server(msg, "remnote"), msg
        assert query_names_mcp_server(msg, "remnote-http"), msg


def test_correct_spelling_matches():
    assert query_names_mcp_server("schreib das in remnote", "remnote")


def test_unrelated_sentence_does_not_match():
    for msg in [
        "wie war das nochmal mit dem server",
        "mach mir eine notiz fuer morgen",
        "remote arbeiten ist anstrengend",   # 'remote' must not reach 'remnote'
    ]:
        assert not query_names_mcp_server(msg, "remnote"), msg


def test_short_tokens_are_not_fuzzy_matched():
    """Fuzzy matching applies from six characters up; below that a one-typo
    neighbour is too often a genuinely different word."""
    assert not query_names_mcp_server("i need a doce", "docs")


def test_one_typo_helper_shapes():
    from src.mcp_manager import _one_typo_apart as d
    assert d("remnote", "rmenote")      # transposition
    assert d("remnote", "remntoe")      # transposition
    assert d("remnote", "remnute")      # substitution
    assert not d("remnote", "remote")   # length differs - the 'remote' trap
    assert not d("remnote", "remnot")
    assert not d("remnote", "notizen")
