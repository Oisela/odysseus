"""The Build queue: several roadmap cards, one agent chat.

Alessio 2026-08-15 — "ein kopf bei developer wo alle im progress gestarteten
änderungen gemacht werden, also mehrere auf einmal statt immer einzeln." Each
card starting its own chat paid for the same context build-up every time.

Two properties carry the design and are pinned here:

1. The queue has NO membership of its own. It is the roadmap's In progress
   column, in board order. A separate selection would be a second source of
   truth about what is being worked on, and the board would stop meaning what
   it says.
2. A batch is all-or-nothing at hand-off, and best-effort during the build. If
   the setup fails, every row it wrote is deleted — cards claiming a chat that
   never received a prompt are the state nobody can reason about. But once the
   agent is running, one hard item must not strand the other four as "in
   progress" forever.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static/index.html").read_text(encoding="utf-8")
CSS = (ROOT / "static/style.css").read_text(encoding="utf-8")


def _batch_prompt() -> str:
    return ADMIN[ADMIN.index("function _buildBatchPrompt"):
                 ADMIN.index("async function _startRoadmapBuild")]


def _batch_workflow() -> str:
    return ADMIN[ADMIN.index("async function _startBatchBuild"):
                 ADMIN.index("function _cardBuildFormHtml")]


def test_queue_card_sits_above_package_status():
    """First card on the page: it is the thing you came to press."""
    assert 'id="settings-dev-queue-card"' in INDEX
    assert INDEX.index('id="settings-dev-queue-card"') < INDEX.index('id="settings-dev-status-card"')
    for field in ("dev-queue-list", "dev-queue-ep", "dev-queue-model",
                  "dev-queue-mode", "dev-queue-start"):
        assert f'id="{field}"' in INDEX
    # UI strings stay English (CONTRIBUTING).
    assert "In progress</em> column" in INDEX


def test_queue_membership_is_the_in_progress_column():
    assert "function _queueItems(sections)" in ADMIN
    picker = ADMIN[ADMIN.index("function _queueItems(sections)"):
                   ADMIN.index("function _renderBuildQueue")]
    assert "item.status === 'wip'" in picker
    # Released sections are history, not work in flight.
    assert "RELEASED" in picker


def test_unticking_parks_an_item_without_moving_the_card():
    """The checkbox is about this run only.

    Moving the card back to Planned to skip one round would lose its place in
    the column, which is the order the batch runs in.
    """
    assert "_queueSkipped" in ADMIN
    assert "_queueSkipped.delete(key)" in ADMIN
    assert "_queueSkipped.add(key)" in ADMIN
    # A fresh batch starts from a clean slate.
    assert "_queueSkipped = new Set();" in ADMIN


def test_batch_prompt_forces_a_strict_sequence_and_one_bundle():
    prompt = _batch_prompt()
    assert "STRIKT nacheinander" in prompt
    assert "ein eigener Branch pro Item" in prompt
    # Every card's full brief, numbered, so the order is unambiguous.
    assert "_itemBrief(it)" in prompt
    assert "Item ${i + 1} von ${items.length}" in prompt
    # Deploy only at the end, once.
    assert "dev.sh bundle" in prompt
    assert "NICHT deployen" in prompt
    assert "Kein Promote ohne Go-Wort" in prompt


def test_a_failing_item_does_not_stop_the_batch():
    prompt = _batch_prompt()
    assert "Wenn ein Item scheitert" in prompt
    assert "zurück auf planned" in prompt
    assert "stoppt den Stapel nicht" in prompt


def test_batch_writes_one_row_per_item_sharing_one_session():
    workflow = _batch_workflow()
    create = workflow.index("await fetch('/api/session'")
    loop = workflow.index("for (const it of items)")
    send = workflow.index("await chatMod.handleChatSubmit")
    assert create < loop < send, "rows must exist before the prompt is sent"
    assert "session_id: sess.id" in workflow
    # The batch must NOT touch statuses: the items are already [~] by virtue of
    # being in the queue, so there is nothing to set and nothing to roll back.
    assert "_setItemStatus" not in workflow


def test_failed_setup_leaves_no_half_batch():
    workflow = _batch_workflow()
    cleanup = workflow[workflow.index("} catch (error) {"):]
    assert "roadmap/builds/${encodeURIComponent(buildSessionId)}" in cleanup
    assert "method: 'DELETE'" in cleanup
    assert "_roadmapBuilds.delete(key)" in cleanup


def test_queue_is_disabled_on_beta_like_the_single_build_button():
    sync = ADMIN[ADMIN.index("function _syncQueueStartButton"):
                 ADMIN.index("async function _initBuildQueue")]
    assert "_channelIsBeta" in sync
    assert "Start on Prod only" in sync


def test_queue_reuses_the_existing_build_form_styling():
    """Design consistency: the queue must not invent a second form language."""
    assert 'class="rm-buildform" id="dev-queue-form"' in INDEX
    assert 'class="rm-field"' in INDEX.split('id="settings-dev-queue-card"', 1)[1][:2000]
    assert ".dev-queue-row" in CSS
    # Only existing tokens, no hardcoded colours.
    queue_css = CSS[CSS.index(".dev-queue-list"):CSS.index(".dev-queue-text")]
    assert "#" not in queue_css, "use CSS variables, not hex colours"
