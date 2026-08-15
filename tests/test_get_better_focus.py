"""Get better asks what should get better.

The prompt is a standing checklist over the whole forked transcript. On a long
conversation that means the agent picks what to work on, and Alessio had no way
to say "no, THIS part" (2026-08-15). An optional focus line steers it without
replacing the checklist — an empty answer is the old behaviour exactly.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT = (ROOT / "static/js/chat.js").read_text(encoding="utf-8")


def test_focus_is_asked_before_the_run_starts():
    assert "function _askGetBetterFocus()" in CHAT
    fn = CHAT[CHAT.index("export async function getBetterFrom"):]
    ask = fn.index("await _askGetBetterFocus()")
    guard = fn.index("dataset.getBetterStarting = 'true'")
    # Cancelling must leave the button usable, so the in-flight flag is set
    # only after the dialog resolves.
    assert ask < guard
    assert "if (focusText === null) return;" in fn


def test_empty_focus_keeps_the_original_prompt_byte_for_byte():
    builder = CHAT[CHAT.index("function _getBetterPrompt"):
                   CHAT.index("async function _runBackgroundAgentTurn")]
    assert "if (!focusText) return GET_BETTER_PROMPT;" in builder


def test_focus_is_appended_not_substituted():
    builder = CHAT[CHAT.index("function _getBetterPrompt"):
                   CHAT.index("async function _runBackgroundAgentTurn")]
    assert "${GET_BETTER_PROMPT}" in builder
    assert "Alessios Fokus für diese Analyse" in builder
    # Steering must not turn into inventing: if the transcript has no evidence
    # for the focus, saying so beats quietly building something else.
    assert "sag das ehrlich" in builder


def test_the_run_actually_uses_the_built_prompt():
    assert "_runBackgroundAgentTurn(data.id, _getBetterPrompt(focusText))" in CHAT


def test_the_dialog_can_be_dismissed_and_reuses_the_house_modal():
    dialog = CHAT[CHAT.index("function _askGetBetterFocus()"):
                  CHAT.index("function _getBetterPrompt")]
    # Same construction as the recurring-delete chooser in calendar.js.
    assert "overlay.className = 'modal'" in dialog
    assert "styled-confirm-box" in dialog
    assert "e.key === 'Escape'" in dialog
    assert "if (e.target === overlay) return close(null);" in dialog
    assert "overlay.remove()" in dialog
    # UI text stays English.
    assert "What exactly should improve?" in dialog


def test_the_focus_names_the_run():
    """Several "Get better: Conversation" chats are indistinguishable later."""
    assert "const runLabel = focusText || source?.name || 'Conversation';" in CHAT
