"""Tests for the v3.5 parallel tool rounds (fork feature): the
_parallel_safe_round gate that decides whether an agent round's tool blocks
may execute concurrently. Uses the same mock-import harness as
test_agent_loop.py to avoid loading the full app stack."""

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

_MOCKED_IMPORTS = [
    'sqlalchemy', 'sqlalchemy.orm', 'sqlalchemy.ext', 'sqlalchemy.ext.declarative',
    'sqlalchemy.ext.hybrid', 'sqlalchemy.sql', 'sqlalchemy.sql.expression',
    'src.database',
    'src.agent_tools',
    'core.models', 'core.database',
]
_INJECTED_IMPORT_STUBS = {}
_PREEXISTING_AGENT_LOOP = sys.modules.get("src.agent_loop")


def _drop_module_if_same(name, expected):
    if sys.modules.get(name) is expected:
        sys.modules.pop(name, None)
    parent_name, _, attr = name.rpartition(".")
    parent = sys.modules.get(parent_name)
    if parent is not None and getattr(parent, "__dict__", {}).get(attr) is expected:
        delattr(parent, attr)


for mod in _MOCKED_IMPORTS:
    if mod not in sys.modules:
        stub = MagicMock()
        sys.modules[mod] = stub
        _INJECTED_IMPORT_STUBS[mod] = stub

_IMPORTED_AGENT_LOOP = None
try:
    from src.agent_loop import _parallel_safe_round
    from src.tool_execution import PARALLEL_SAFE_TOOLS
    _IMPORTED_AGENT_LOOP = sys.modules.get("src.agent_loop")
finally:
    if _PREEXISTING_AGENT_LOOP is None and _IMPORTED_AGENT_LOOP is not None:
        _drop_module_if_same("src.agent_loop", _IMPORTED_AGENT_LOOP)
    for _mod, _stub in _INJECTED_IMPORT_STUBS.items():
        _drop_module_if_same(_mod, _stub)


def _blocks(*types):
    return [SimpleNamespace(tool_type=t) for t in types]


class _DenyPolicy:
    def __init__(self, denied):
        self._denied = set(denied)

    def blocks(self, tool_type):
        return tool_type in self._denied


def test_read_only_round_is_parallel_safe():
    assert _parallel_safe_round(_blocks("read_file", "grep", "glob"), None, 0, 0)


def test_single_block_stays_sequential():
    assert not _parallel_safe_round(_blocks("read_file"), None, 0, 0)


def test_mutating_or_stateful_tool_disables_parallelism():
    # bash carries cwd/side-effect semantics; one non-read block is enough.
    assert not _parallel_safe_round(_blocks("read_file", "bash"), None, 0, 0)
    assert not _parallel_safe_round(_blocks("write_file", "read_file"), None, 0, 0)


def test_policy_blocked_tool_disables_parallelism():
    policy = _DenyPolicy({"web_search"})
    assert not _parallel_safe_round(_blocks("read_file", "web_search"), policy, 0, 0)
    assert _parallel_safe_round(_blocks("read_file", "grep"), policy, 0, 0)


def test_budget_that_would_interrupt_the_round_disables_parallelism():
    # 3 blocks, budget leaves room for only 2 → sequential (loop must stop midway).
    assert not _parallel_safe_round(_blocks("ls", "grep", "glob"), None, 5, 3)
    # Exactly enough room → parallel.
    assert _parallel_safe_round(_blocks("ls", "grep", "glob"), None, 6, 3)
    # max_tool_calls <= 0 means "no budget".
    assert _parallel_safe_round(_blocks("ls", "grep"), None, 0, 999)


def test_parallel_safe_set_contains_only_stateless_reads():
    # Guard against someone adding a mutating tool to the set by accident.
    assert "bash" not in PARALLEL_SAFE_TOOLS
    assert "python" not in PARALLEL_SAFE_TOOLS
    assert "write_file" not in PARALLEL_SAFE_TOOLS
    assert "edit_file" not in PARALLEL_SAFE_TOOLS
    assert "ask_user" not in PARALLEL_SAFE_TOOLS
