"""Only one developer round may hold the clone.

Alessio 2026-08-15 started several Build buttons expecting them to run in
parallel. They cannot: there is exactly ONE clone at data/dev/odysseus, ONE
beta channel and ONE cycle-state file. The agents checked out different
branches under each other — one feature's uncommitted work ended up committed
inside another feature's branch, and a third round stopped outright rather than
overwrite what it found. Nothing in the UI said no.

The Build queue was already the answer for several cards (one chat, one after
another); what was missing was preventing the other path.
"""

from pathlib import Path

import pytest

from routes import system_routes


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static/index.html").read_text(encoding="utf-8")
CSS = (ROOT / "static/style.css").read_text(encoding="utf-8")


@pytest.mark.parametrize("phase", ["building", "awaiting-go", "promoting"])
def test_a_round_in_flight_holds_the_clone(monkeypatch, phase):
    monkeypatch.setattr(
        system_routes, "_cycle_state",
        lambda: {"branch": "feat/x", "phase": phase, "track": "feature", "since": "n"},
    )
    active = system_routes._active_round()
    assert active["branch"] == "feat/x"
    assert active["phase"] == phase


def test_awaiting_go_counts_as_busy(monkeypatch):
    """That round is parked mid-flight and expects its branch back when the
    go-word arrives — which is exactly what today's collision destroyed."""
    monkeypatch.setattr(
        system_routes, "_cycle_state",
        lambda: {"branch": "feat/parked", "phase": "awaiting-go"},
    )
    assert system_routes._active_round()["branch"] == "feat/parked"


@pytest.mark.parametrize("cycle", [
    {},
    {"phase": "done", "branch": "feat/finished"},
    {"branch": "feat/x"},
    {"phase": "", "branch": "feat/x"},
])
def test_a_finished_or_missing_round_leaves_the_clone_free(monkeypatch, cycle):
    monkeypatch.setattr(system_routes, "_cycle_state", lambda: cycle)
    assert system_routes._active_round() == {}


def test_status_carries_it_and_is_not_cached(monkeypatch):
    routes = (ROOT / "routes/system_routes.py").read_text(encoding="utf-8")
    assert '"active_round": _active_round(),' in routes
    # _active_round reads a local file every call; a cached one would leave the
    # buttons locked for a TTL after the round finished.
    assert "_ROUND_BUSY_PHASES" in routes


def test_the_card_build_button_is_blocked_while_a_round_runs():
    assert "const blockedByRound = !!_activeRound && !build;" in ADMIN
    assert "buildBtn.disabled = blockedByRound;" in ADMIN
    assert "rm-build-blocked" in ADMIN and ".rm-build-btn.rm-build-blocked" in CSS


def test_a_cards_own_build_stays_reachable():
    """Reopening the build that IS the round in flight is the same agent, not
    a second one — locking it would strand the round."""
    assert "!!_activeRound && !build" in ADMIN


def test_the_queue_waits_too():
    """The queue is the sanctioned path for several cards, but it still runs
    one agent in the one clone."""
    sync = ADMIN[ADMIN.index("function _syncQueueStartButton"):
                 ADMIN.index("async function _initBuildQueue")]
    assert "if (_activeRound)" in sync
    assert 'Waiting for "${_activeRound.branch}"' in sync


def test_the_block_explains_itself():
    """A disabled button with no reason is indistinguishable from a bug."""
    assert 'id="dev-active-round"' in INDEX
    assert "function _renderActiveRoundBanner()" in ADMIN
    reason = ADMIN[ADMIN.index("function _roundBlockReason()"):
                   ADMIN.index("async function _loadActiveRound")]
    assert "only one round can hold the developer clone" in reason.lower()
    assert "Build queue" in reason


def test_a_status_hiccup_does_not_lock_everything(monkeypatch):
    """Unknown is not the same as busy; blocking every build because one fetch
    failed would be worse than the race it prevents."""
    loader = ADMIN[ADMIN.index("async function _loadActiveRound()"):
                   ADMIN.index("async function _loadRoadmapBuilds()")]
    assert "_activeRound = null;" in loader.split("catch")[1]


def test_the_board_reacts_when_the_round_ends():
    """Otherwise the buttons stay disabled until a full reload."""
    assert "if (wasBlocked !== !!_activeRound && _roadmapText) _renderRoadmap();" in ADMIN
