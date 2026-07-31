"""Test points live on the roadmap card.

Alessio 2026-07-31: "bei den einzelnen Features beim Testen grad Todos machen
koennen was ich testen muss damit ich die dann abhaken kann und durchgehen —
ist uebersichtlicher als eine Datei immer." This replaces the per-round test
checklist PDF: the agent writes the points when a card reaches [!], Alessio
ticks them off on the card itself.

The tick is persisted into ROADMAP.md, which is Alessio's own file and the one
the developer agent reads on every start. These tests exist because a sloppy
change to the parser or the serializer would not throw — it would quietly drop
his ticks, or worse, rewrite the wrong lines of the file.
"""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
STYLE = (ROOT / "static" / "style.css").read_text(encoding="utf-8")


def test_a_test_point_keeps_its_tick_inside_the_roadmap_line():
    """The checkbox is part of the markdown, not side-car state.

    Anything stored outside ROADMAP.md would desync the moment the agent
    rewrites the file, and would be invisible to the agent that reads it.
    """
    assert "**Testpunkte:**" in ADMIN
    assert "`        - [${t.done ? 'x' : ' '}] ${String(t.text).trim()}`" in ADMIN
    assert "testpunkte: 'tests'" in ADMIN


def test_parser_accepts_both_tick_states_and_a_bare_line():
    """A point written by hand without a checkbox must not be lost."""
    assert "_RM_TEST_RE = /^-?\\s*\\[([ xX])\\]\\s*(.*)$/" in ADMIN
    fn = ADMIN.split("function _rmTestPoint(")[1].split("\n}")[0]
    assert "done: m[1].toLowerCase() === 'x'" in fn
    # the fallback branch turns an unmarked line into an unticked point
    assert "done: false" in fn


def test_editing_a_card_carries_the_ticks_over():
    """The edit form shows plain lines; the ticks live outside it.

    Without the merge, every Save would silently clear everything Alessio had
    already ticked off — the exact failure that makes people stop trusting a
    checklist.
    """
    assert "_mergeTestPoints" in ADMIN
    save = ADMIN.split("async function _saveItemEdit(")[1].split("\n}")[0]
    assert "_mergeTestPoints(details.tests || [], previous.tests)" in save


def test_ticks_are_matched_by_text_not_by_position():
    """Matching on the index moves a tick to a different point as soon as
    somebody reorders or inserts a line."""
    merge = ADMIN.split("function _mergeTestPoints(")[1].split("\n}")[0]
    assert "new Map((previous || []).map(t => [t.text, t.done]))" in merge


def test_ticking_rewrites_only_that_card():
    """Same discipline as _setItemStatus: touch one card's lines, not the file.

    _setTestPoint splices item.line..item.endLine, so a second person editing a
    different card does not lose their edit.
    """
    fn = ADMIN.split("async function _setTestPoint(")[1].split("\n}\n")[0]
    assert "lines.splice(item.line, item.endLine - item.line + 1, ...block)" in fn
    assert "_saveRoadmap" in fn


def test_a_failed_save_puts_the_checkbox_back():
    """A tick that never reached ROADMAP.md must not look like it did."""
    fn = ADMIN.split("function _appendTestPoints(")[1].split("\n}\n")[0]
    assert "cb.checked = !cb.checked" in fn


def test_the_progress_chip_is_built_once_for_both_views():
    """Screenshots were once lost because a card detail was built inline in the
    board only. The chip has one builder, called from the board and from Done."""
    assert ADMIN.count("function _testProgressChip(") == 1
    assert ADMIN.count("_testProgressChip(details)") >= 2
    assert "tested`" in ADMIN


def test_dragging_a_card_cannot_tick_a_test():
    """Cards are draggable between columns; the list sits inside one."""
    fn = ADMIN.split("function _appendTestPoints(")[1].split("\n}\n")[0]
    assert "dragstart" in fn


def test_the_new_item_popup_has_the_field_and_clears_it():
    assert 'id="dev-roadmap-tests"' in INDEX
    assert "'dev-roadmap-tests'" in ADMIN


def test_every_detail_field_of_the_popup_takes_a_pasted_screenshot():
    """Alessio pastes a screenshot into Description, not only into the title
    line — that is where a bug report gets typed."""
    for field in ("dev-roadmap-description", "dev-roadmap-goal",
                  "dev-roadmap-acceptance", "dev-roadmap-notes"):
        assert f"'{field}'" in ADMIN
    assert "_onRoadmapPaste" in ADMIN
    handler = ADMIN.split("const _onRoadmapPaste = ")[1].split("\n  };")[0]
    # stopPropagation, not preventDefault: app.js has a window-level paste
    # handler that would also drop the image into the chat attach strip.
    assert "e.stopPropagation()" in handler


def test_the_build_prompt_hands_the_points_to_the_agent():
    """The agent fills the points when it reaches [!]; without them in the
    prompt it has no idea they are expected."""
    prompt = ADMIN.split("function _buildPrompt(")[1].split("\n}\n")[0]
    assert "section('Testpunkte'" in prompt
    assert "roadmap-testpoints" in prompt


def test_card_styling_uses_existing_variables():
    """No new colour literals — the fork's first law is design consistency."""
    block = STYLE.split(".rm-card-tests")[1][:900]
    assert "var(--accent" in block or "var(--border)" in block
    assert "#" not in block.split(".rm-chip-tests-done")[0], "hardcoded colour"
