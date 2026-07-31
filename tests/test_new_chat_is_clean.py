"""A free "New chat" must start clean — no leftover project, persona, workspace,
or attachments from whatever chat was open before.

Alessio's bug report (Prod, 2026-07-30/31): "Behaelt das Projekt bei wenn ich
einen freien (kein Projekt) Chat starte, der sollte immer clean sein — keine
Persona, kein Projekt usw."

Root cause: three different "start a new chat" entry points lived in two
different JS closures inside static/app.js.

  * `_startFreshChat()` and `_handleNewChatAction()` (rail/logo/sidebar "New
    chat" buttons) both live inside `initializeEventListeners()` and already
    cleared persona/workspace/project — each with its own inline copy of the
    same three calls.
  * The composer's own "+New" send-button mode (the send button morphs into
    "+New" once the composer is empty on an existing chat) is wired up later,
    inside `startOdysseusApp()` — a *separate* closure that cannot call
    `_handleNewChatAction` by name. That branch reimplemented a third, partial
    version which called `sessionModule.createDirectChat()` directly and never
    touched the project pill, the persona/preset, or the workspace — so a
    project chat with a model attached still looked like the old project
    after clicking the button every user reaches for first.

Fix: a single `_resetNewChatContext()` helper now owns every piece of state
that must not survive into a fresh chat (incognito, persona/preset, workspace,
queued attachments/@-mentions, the project pill). `_startFreshChat()` and
`_handleNewChatAction()` call it instead of duplicating it, and
`_handleNewChatAction` is exposed as `window.__odysseusHandleNewChatAction` so
the composer's "+New" button — in the other closure — can route through the
exact same reset instead of reimplementing a subset of it.

A chat opened deliberately *inside* a project (projects.js: `_newChatInProject`,
`prepareCurrentProjectChat`) never calls `createDirectChat()` at all — it POSTs
straight to `/api/session`, attaches the project server-side, and calls
`selectSession(id, projectId)`, which re-applies the project pill on purpose.
That path is untouched by this fix and is asserted here to stay that way.
"""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_JS = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
PROJECTS_JS = (ROOT / "static" / "js" / "projects.js").read_text(encoding="utf-8")


def _function_body(source: str, signature: str, max_len: int = 4000) -> str:
    """Grab a generous slice of source starting at a function signature.

    Good enough for these string-presence checks — the functions under test
    are all well under max_len before the next top-level declaration.
    """
    start = source.index(signature)
    return source[start:start + max_len]


# ---------------------------------------------------------------------------
# The reset function exists and resets every piece of state Alessio named.
# ---------------------------------------------------------------------------

def test_reset_new_chat_context_function_exists():
    assert "function _resetNewChatContext()" in APP_JS, (
        "the single named new-chat reset function is missing — state resets "
        "must not go back to being duplicated per button"
    )


@pytest.mark.parametrize(
    "state_piece,needle",
    [
        ("incognito", "_deactivateIncognito();"),
        ("persona/preset", "presetsModule.deactivateCharacter();"),
        ("workspace pill", "workspaceModule.setWorkspace('');"),
        ("queued attachments", "fileHandlerModule.clearPending();"),
        ("queued @-mentions", "fileHandlerModule.clearMentions();"),
        ("project pill", "m.onSessionSwitch(null, null);"),
    ],
)
def test_reset_function_clears_every_known_state_piece(state_piece, needle):
    body = _function_body(APP_JS, "function _resetNewChatContext()")
    # Stop at the closing brace of this function so a match doesn't
    # accidentally come from some other function further down the file.
    body = body[: body.index("\n  }\n")]
    assert needle in body, (
        f"_resetNewChatContext() no longer clears {state_piece} — a free new "
        f"chat would inherit it from the previous chat again"
    )


# ---------------------------------------------------------------------------
# Every free "New chat" entry point actually calls the reset — including the
# composer's own "+New" send-button mode, which is the one that shipped
# without it.
# ---------------------------------------------------------------------------

def test_start_fresh_chat_calls_the_reset():
    body = _function_body(APP_JS, "function _startFreshChat()")
    body = body[: body.index("\n  }\n")]
    assert "_resetNewChatContext();" in body


def test_handle_new_chat_action_calls_the_reset():
    body = _function_body(APP_JS, "async function _handleNewChatAction(")
    body = body[: body.index("\n  }\n")]
    assert "_resetNewChatContext();" in body, (
        "_handleNewChatAction must reset BEFORE branching into "
        "_createDirectChatFromPreferredModel(), since that branch returns "
        "early and would otherwise skip the reset entirely"
    )


def test_handle_new_chat_action_is_exposed_for_the_other_closure():
    """The composer's "+New" send-button handler lives inside
    startOdysseusApp(), a different closure than _handleNewChatAction — it can
    only reach it via a window global, the same pattern already used for
    __odysseusSetChatMode.
    """
    assert "window.__odysseusHandleNewChatAction = _handleNewChatAction;" in APP_JS


def test_composer_new_chat_button_routes_through_the_shared_reset():
    """This is the exact branch that used to call createDirectChat() directly
    and skip persona/workspace/project — the concrete cause of Alessio's bug.
    """
    marker = "sendBtn.dataset.mode === 'newchat'"
    start = APP_JS.index(marker)
    # The click handler is short; a generous window comfortably covers it
    # without spilling into unrelated code.
    branch = APP_JS[start:start + 900]
    assert "window.__odysseusHandleNewChatAction()" in branch, (
        "the composer's +New button must route through the shared reset, not "
        "call sessionModule.createDirectChat() directly again"
    )
    assert "sessionModule.createDirectChat(current.endpoint_url" not in branch, (
        "regression: this branch went back to bypassing the reset"
    )


# ---------------------------------------------------------------------------
# The boundary: a chat started deliberately INSIDE a project must keep its
# project. That path never touches createDirectChat()/_resetNewChatContext —
# assert it still doesn't, so a future refactor can't accidentally merge the
# two flows and break intentional project chats instead.
# ---------------------------------------------------------------------------

def test_project_chat_creation_does_not_use_the_free_chat_reset():
    body = _function_body(PROJECTS_JS, "async function _newChatInProject(project)")
    body = body[: body.index("\n}\n")]
    assert "_resetNewChatContext" not in body
    assert "createDirectChat" not in body
    # It POSTs the session directly and re-selects it — selectSession() is
    # what applies the project pill on purpose (sessions.js reads
    # meta.project_id and calls presetsModule/projectsModule.onSessionSwitch).
    assert "/api/session" in body
    assert "selectSession(sid" in body
