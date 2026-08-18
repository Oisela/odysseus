"""Regression contract for the bundled RemNote Edit-Later workflow.

The RemNote SDK exposes Edit Later as a built-in powerup.  Treating its
localized powerup Rem like a normal tag can return a false zero, so the skill
must never claim that the inbox is empty from ``list_tagged_rems`` alone.
"""
from pathlib import Path


SKILL = Path(__file__).parents[1] / "config" / "skills" / "remnote-edit-later.md"


def test_edit_later_skill_requires_real_tool_evidence():
    text = SKILL.read_text(encoding="utf-8")

    assert "inspect_powerup_registry" in text
    assert "powerups.e.remId" in text
    assert "Never copy a sample ID" in text
    assert "Do not report a count before the tool returns it" in text


def test_edit_later_skill_guards_builtin_powerup_false_zero():
    text = SKILL.read_text(encoding="utf-8")

    assert "built-in powerup" in text
    assert "A zero from `list_tagged_rems` is not sufficient evidence" in text
    assert "report the mismatch" in text
    assert "do not call the inbox empty" in text


def test_edit_later_skill_does_not_prescribe_unavailable_actions():
    text = SKILL.read_text(encoding="utf-8")

    # These guessed actions caused noisy retries in the incident and are not
    # part of the currently exposed bridge contract.
    for action in (
        "list_available_actions",
        "list_rems_with_powerup",
        "search_by_powerup",
        "query_rems_by_active_powerup",
    ):
        assert action not in text
