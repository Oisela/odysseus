"""Ticking the last test point is the go-word.

Alessio 2026-08-15, when asked how autonomous the developer loop should be:
ticking every test point on a card IS the approval, and bugs need no question
at all. Before this, an agent that had finished a beta round sat waiting for a
chat message that Alessio had to remember to type — and the agent could not
tell "not approved" from "not read yet".

The important design choice is that the go-word travels as a normal chat
message into the build chat the agent is already watching. A separate promotion
endpoint would be a second path to production that skips every check living in
the agent's own workflow.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
CHAT = (ROOT / "static/js/chat.js").read_text(encoding="utf-8")


def _signal() -> str:
    return ADMIN[ADMIN.index("function _maybeSignalGoWord"):
                 ADMIN.index("async function _saveRoadmap")]


def test_the_go_word_is_a_chat_message_not_a_second_promotion_path():
    assert "export async function sendToSession" in CHAT
    assert "sendToSession," in CHAT, "must be on the public chatModule API"
    # It reuses the existing background turn — same streaming, same tools.
    send = CHAT[CHAT.index("export async function sendToSession"):
                CHAT.index("export async function getBetterFrom")]
    assert "_runBackgroundAgentTurn(sessionId, text)" in send
    assert "chatMod.sendToSession(" in ADMIN
    # No new server route for promoting.
    routes = (ROOT / "routes/system_routes.py").read_text(encoding="utf-8")
    assert "promote-signal" not in routes


def test_it_fires_only_after_the_tick_actually_reached_the_file():
    setter = ADMIN[ADMIN.index("async function _setTestPoint"):
                   ADMIN.index("function _maybeSignalGoWord")]
    save = setter.index("await _saveRoadmap")
    signal = setter.index("_maybeSignalGoWord(item, details)")
    assert save < signal, "a promotion must not start from a tick that failed to save"
    assert "if (done) _maybeSignalGoWord" in setter, "unticking is not a go-word"


def test_it_needs_every_point_a_waiting_card_and_a_build_chat():
    signal = _signal()
    assert "tests.every(t => t.done)" in signal
    # [!] is the state `dev.sh ready` leaves behind. Any other column has no
    # agent standing by, so there is nothing to say a go-word to.
    assert "item.status !== 'review'" in signal
    assert "build?.session_id" in signal


def test_there_is_an_undo_window_but_not_a_question():
    """Alessio asked for fewer questions, not more — but the far end of this
    is a production rebuild, so a mis-click needs a way back."""
    signal = _signal()
    assert "_GO_WORD_DELAY_MS" in signal
    assert "action: 'Undo'" in signal
    assert "clearTimeout(_goWordTimer)" in signal
    # The button has to outlive the timer it cancels.
    assert "duration: _GO_WORD_DELAY_MS" in signal
    assert "confirm(" not in signal, "no dialog — that is the thing being removed"


def test_only_one_promotion_can_be_armed_at_a_time():
    assert "if (_goWordTimer) return;" in _signal()


def test_a_failed_send_is_reported_loudly():
    """Silence is indistinguishable from an agent choosing not to promote."""
    signal = _signal()
    assert "showError('Could not send the go-word: '" in signal
