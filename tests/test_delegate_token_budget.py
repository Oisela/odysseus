"""Token-efficient delegation: bounded compact hand-offs to worker models."""

from src.agent_tools.model_interaction_tools import (
    DEFAULT_DELEGATE_RESPONSE_TOKEN_BUDGET,
    DEFAULT_DELEGATE_TASK_TOKEN_BUDGET,
    _bounded_delegate_budget,
    _truncate_delegate_task,
)


def test_delegate_budget_defaults_and_bounds():
    assert _bounded_delegate_budget(None, DEFAULT_DELEGATE_TASK_TOKEN_BUDGET) == 6000
    assert _bounded_delegate_budget(0, DEFAULT_DELEGATE_RESPONSE_TOKEN_BUDGET) == 4000
    assert _bounded_delegate_budget(1, 6000) == 256
    assert _bounded_delegate_budget(999_999, 6000) == 32_000


def test_delegate_task_is_unchanged_within_budget():
    task, truncated = _truncate_delegate_task("Summarize this.", 6000)
    assert task == "Summarize this."
    assert truncated is False


def test_delegate_task_keeps_instruction_and_tail_when_truncated():
    original = "BEGIN " + ("middle " * 20_000) + "END"
    task, truncated = _truncate_delegate_task(original, 256)
    assert truncated is True
    assert task.startswith("BEGIN ")
    assert task.endswith("END")
    assert "truncated by Odysseus token budget" in task
    assert len(task) < len(original)


def test_delegate_settings_have_compact_defaults():
    from src.settings import DEFAULT_SETTINGS

    assert DEFAULT_SETTINGS["delegate_task_token_budget"] == 6000
    assert DEFAULT_SETTINGS["delegate_response_token_budget"] == 4000
