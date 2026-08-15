"""Update sits on the Developer page too, not only in Settings → System.

Alessio 2026-08-15, right after making the production rebuild his own call:
"der update knopf sollte natürlich auf beim developer auch sein sonst muss ich
immer wechseln." He decides a round is finished on the Developer page; the
button that acts on that decision was one panel away — and the Package status
card literally told him to go there ("press Update on the System card").

Same reasoning and same prefix mechanism as the version switcher, which was
mirrored onto this page in v4.0 for exactly this reason.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static/index.html").read_text(encoding="utf-8")


def _promote_fn() -> str:
    return ADMIN[ADMIN.index("function _initPromoteButton("):
                 ADMIN.index("function initSystemStatus()")]


def test_the_button_exists_on_both_pages():
    assert 'id="sys-promoteBtn"' in INDEX
    assert 'id="dev-promoteBtn"' in INDEX
    # On the Developer page it sits in the Package status card, next to the
    # beta controls — where the round is judged finished.
    card = INDEX[INDEX.index('id="settings-dev-status-card"'):
                 INDEX.index('id="settings-dev-selfcheck-card"')]
    assert 'id="dev-promoteBtn"' in card


def test_one_handler_serves_both():
    """A second copy of a button that rebuilds production is a second place to
    get the confirm, the gating and the wording wrong."""
    assert ADMIN.count("function _initPromoteButton(") == 1
    assert "_initPromoteButton('sys-', 'sys-statusMsg')" in ADMIN
    assert "_initPromoteButton('dev-', 'dev-chat-msg')" in ADMIN
    # Only one place still posts the promotion.
    assert ADMIN.count("fetch(`/api/system/promote`") == 1


def test_the_message_lands_in_the_card_you_pressed():
    """`prefix + statusMsg` would put the Developer page's answer into the
    Version control card, a card away from the button."""
    fn = _promote_fn()
    assert "msgId = null" in fn
    assert "el(msgId || (prefix + 'statusMsg'))" in fn


def test_wiring_happens_once_per_button():
    fn = _promote_fn()
    assert "btn._promoteWired" in fn


def test_the_developer_button_uses_the_same_gate_as_the_system_card():
    """Prod builds from dev: promoting a beta whose commit is not in dev would
    ship a different tree than the one that was tested."""
    block = ADMIN[ADMIN.index("const promoteBtn = el('dev-promoteBtn');"):
                  ADMIN.index("_renderRoadmapFreshness(d.roadmap);")]
    assert "!d.promotable" in block
    assert "channel === 'beta'" in block, "the beta instance cannot promote itself"
    assert "not in origin/dev" in block


def test_the_status_line_no_longer_sends_him_away():
    assert "press Update on the System card" not in ADMIN
    assert "'ready — press Update'" in ADMIN


def test_the_confirm_still_names_the_consequence():
    """The rebuild restarts the server and every agent running on it."""
    fn = _promote_fn()
    assert "rebuilds prod from dev and restarts the server" in fn
    assert "close and REOPEN the app window" in fn
