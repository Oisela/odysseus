"""The board points at the Build queue, because the queue is off-screen.

Alessio 2026-08-15, looking at the roadmap board: "ich brauch ein butten für
build all also keine pro bug oder feature sondern wirklich einen mit modell
auswählen alle in progress bearbeiten."

That button already existed — the Build queue, shipped in v4.6 and live on
prod. But the queue card sits at the top of the Developer page and the board is
four cards below it, so the control in front of him was the per-card Build
button. He pressed several of those, which is how three rounds collided in one
developer clone.

So this is a pointer, deliberately not a second Start: duplicating the batch
logic would mean two places to keep the model picker and the round lock honest.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static/index.html").read_text(encoding="utf-8")
CSS = (ROOT / "static/style.css").read_text(encoding="utf-8")


def _shortcut() -> str:
    return ADMIN[ADMIN.index("function _syncBuildAllShortcut(items)"):
                 ADMIN.index("function _syncQueueStartButton(items)")]


def test_the_button_lives_in_the_roadmap_toolbar():
    """Next to "+ New item" and "Done" — where the eye already is."""
    assert 'id="dev-roadmap-build-all"' in INDEX
    toolbar = INDEX[INDEX.index('id="dev-roadmap-new-btn"'):
                    INDEX.index('id="dev-roadmap-refresh"')]
    assert 'id="dev-roadmap-build-all"' in toolbar


def test_it_carries_the_count_so_it_says_what_it_will_do():
    assert "Build all in progress (${n})" in _shortcut()


def test_it_hides_when_there_is_nothing_to_build():
    """An always-visible button that does nothing teaches you to ignore it."""
    fn = _shortcut()
    assert "if (!n || _channelIsBeta)" in fn
    assert "btn.style.display = 'none'" in fn


def _runner() -> str:
    return ADMIN[ADMIN.index("async function _runBuildAllShortcut(btn)"):
                 ADMIN.index("function _syncQueueStartButton(items)")]


def test_the_button_builds_instead_of_scrolling():
    """Was: it only scrolled to the Build queue.

    Alessio pressed "Build all in progress (9)" twice and reported "passiert
    nichts, geht nur nach oben" (2026-08-15). A label that promises an action
    has to perform it — jumping to a second button is indirection, not a
    feature.
    """
    runner = _runner()
    assert "_startBatchBuild(" in runner, "the button must actually build"
    # Still ONE batch implementation, reused rather than copied.
    assert ADMIN.count("async function _startBatchBuild") == 1


def test_it_reuses_the_queues_model_choice():
    runner = _runner()
    assert "el('dev-queue-ep')" in runner
    assert "el('dev-queue-model')" in runner
    assert "confirm(" in runner, "N agent turns on a paid model deserve one ask"


def test_scrolling_survives_only_where_it_is_the_honest_answer():
    """A missing model choice is the one case where the queue really is where
    you have to go."""
    runner = _runner()
    assert "jumpToQueue('Pick an endpoint and a model first.')" in runner
    assert "dev-card-flash" in runner
    assert ".dev-card-flash" in CSS
    block = CSS[CSS.index("@keyframes dev-card-flash"):CSS.index(".dev-queue-list")]
    assert "#" not in block, "no hardcoded colours"


def test_it_respects_the_round_lock():
    """Otherwise this button would be the hole in the lock built hours earlier."""
    runner = _runner()
    assert "if (_activeRound)" in runner
    assert "_roundBlockReason()" in runner


def test_the_handler_is_wired_once():
    """_syncBuildAllShortcut runs on every roadmap render."""
    fn = _shortcut()
    assert "if (!btn._wired)" in fn
    assert ADMIN.count("_syncBuildAllShortcut(items);") == 1
