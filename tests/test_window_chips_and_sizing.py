"""A dragged chip must not be able to escape its clipped dock, and a
restored window must stay resizable afterwards.

Two bugs Alessio reported together (2026-07-30), both in the tool-window
plumbing (static/js/modalManager.js):

  (a) "Diese Bubbles verbessern — wenn ich sie nach oben schiebe hauen sie
      ab." The minimized-modal dock (desktop, 2+ chips) lets you reorder
      chips by dragging: `_wireChipDrag`'s 'reorder' branch used to build
      `chip.style.transform` from the RAW, unclamped pointer delta on both
      axes (`translate(${dx}px, ${dy}px) scale(1.05)`), even though
      reordering only ever needs the horizontal position to detect which
      sibling the pointer is over. Both `.chat-container` (style.css) and
      the dock's own home row (`#minimized-dock.dock-inflow`) clip
      overflowing children with `overflow: hidden` — so a stray upward drag
      carried the chip straight past that clipped edge and it visually
      vanished until the pointer was released and the transform reset.
      Fix: clamp the vertical component of the drag transform to a small
      band (±24px) so the chip can never visually leave the row, while the
      horizontal delta — the actual reorder gesture — stays unclamped.
      This is the minimal fix that keeps every other piece of the existing
      dock (free-floating chips on mobile, the whole-dock grip-drag, the
      chain-follow gesture, the magnetic trash zone, `--composer-clearance`
      positioning, …) exactly as before — an earlier version of this fix
      tried removing the whole drag system in favor of a fixed row, but
      that broke a large pre-existing test suite
      (test_modal_manager_minimize_static.py, test_modal_dock_composer_
      clearance.py) that pins that architecture down. The reported bug was
      one unclamped line, not the design.

      One pre-analysis suspicion did NOT hold up: that the × close button
      sits "im Ziehweg" (in the drag path) and gets hit while dragging.
      `onPointerDown` returns immediately when the pointer lands on
      `.minimized-dock-x`, before any drag state is armed — so starting a
      drag from the × is impossible by construction; a click there always
      just closes the chip. That suspicion is refuted below, not fixed.

  (b) "Pomodoro bleibt einfach lang ... ich versuch ihn dann kleiner zu
      machen aber das Fenster bleibt gleich lang, sehr lang." Restoring a
      minimized window applied a floor (`content.style.minHeight`) to stop
      it flashing to near-zero height while layout settled — but nothing
      ever cleared that floor again. A user shrinking the window afterwards
      set an explicit `height` smaller than the still-present `min-height`,
      which the browser resolves in favor of the (larger) min-height — so
      the window visually refused to shrink, and windowResize.js then
      persisted that still-inflated rect back into `localStorage`
      (`winsize-pomodoro-modal`), making the bloat permanent across
      reloads too. The fix makes the floor a one-shot (cleared two frames
      after it's applied, and explicitly on minimize/close), and heals any
      `winsize-*` entry an existing browser (Alessio's) already poisoned.

Static checks only — read the source as text, no browser/DOM involved.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODAL_MANAGER_JS = (ROOT / "static" / "js" / "modalManager.js").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "static" / "style.css").read_text(encoding="utf-8")


# ── (a) chip dock: reorder-drag can no longer escape the clipped row ──────

def test_chat_surface_and_dock_home_row_both_clip_overflow():
    """Confirms the suspected clipping culprit is real, not a guess.

    Both `.chat-container` and the dock's own default row clip overflowing
    children. A chip dragged past that edge with no clamp doesn't just look
    wrong — it visually disappears until the drag ends. This is *why* the
    reorder transform needs a clamp rather than being left to follow the
    raw pointer delta.
    """
    chat_block = STYLE_CSS.split(".chat-container {")[1].split("}")[0]
    assert "overflow:hidden" in chat_block.replace(" ", "")
    dock_home_block = STYLE_CSS.split("#minimized-dock.dock-inflow {")[1].split("}")[0]
    assert "overflow: hidden" in dock_home_block


def test_reorder_drag_clamps_the_vertical_offset():
    """The actual fix: reordering only needs the horizontal pointer
    position to detect which sibling to swap with, so the vertical offset
    in the live drag transform must be capped — otherwise a stray upward
    (or downward) mouse movement carries the chip past the clipping edge
    documented above and it appears to run away.
    """
    reorder_branch = MODAL_MANAGER_JS.split("if (dragMode === 'reorder') {", 1)[1]
    reorder_branch = reorder_branch.split("// Find sibling under cursor and swap")[0]
    assert "Math.max(-24, Math.min(24, dy))" in reorder_branch, (
        "the vertical drag delta must be clamped to a small band"
    )
    assert "clampedDy" in reorder_branch
    # The horizontal delta drives the actual reorder gesture and must stay
    # unclamped, or dragging sideways to swap chips would stop working.
    assert "translate(${dx}px, ${clampedDy}px)" in reorder_branch


def test_close_x_can_never_arm_a_drag():
    """Refutes a pre-analysis suspicion: that the × sits in the drag path
    and gets caught mid-gesture. It doesn't — a pointerdown that starts on
    `.minimized-dock-x` bails out before any drag state (dragMode, start
    coordinates, listeners) is set up, so the only thing a press there can
    ever do is fire a plain click that closes the chip.
    """
    pointer_down = MODAL_MANAGER_JS.split("const onPointerDown = (e) => {", 1)[1]
    pointer_down = pointer_down.split("const onPointerMove = (e) => {", 1)[0]
    first_check = pointer_down.strip().splitlines()[0]
    assert "minimized-dock-x" in first_check
    assert "return" in first_check


def test_chain_drag_mode_already_clamps_against_the_chat_bounds():
    """The touch "chain" gesture (2+ chips) is a separate code path from
    desktop reorder and was already bounding every link's position against
    the chat surface before this fix — confirms it did not need the same
    patch (only the desktop reorder transform was unclamped).
    """
    step_chain = MODAL_MANAGER_JS.split("function _stepChain(", 1)[1]
    step_chain = step_chain.split("\nfunction ", 1)[0]
    assert "chatBounds.minTop" in step_chain
    assert "chatBounds.maxTop" in step_chain


# ── (b) restore-height floor must not ratchet ───────────────────────────────

def test_restore_height_floor_is_cleared_after_it_paints():
    """`_applyRestoreHeight` may set `content.style.minHeight` as a one-frame
    floor against the restore flashing to near-zero height — but it must
    schedule clearing that floor again. Left in place, it permanently wins
    over any smaller explicit height windowResize.js sets afterwards, which
    is exactly the ratchet that pinned Pomodoro's window open.
    """
    fn = MODAL_MANAGER_JS.split("function _applyRestoreHeight(modal, state) {")[1]
    fn = fn.split("\nfunction ")[0]
    assert "content.style.minHeight = `${height}px`;" in fn
    assert "requestAnimationFrame(() => requestAnimationFrame(() => {" in fn
    assert "content.style.minHeight = '';" in fn


def test_minimize_clears_leftover_floor_before_measuring():
    """If minimize() measures the window's height while an old restore
    floor is still applied, it captures the inflated height as the new
    "real" size and re-applies it forever — the ratchet, one step earlier.
    """
    fn = MODAL_MANAGER_JS.split("export function minimize(id) {")[1]
    fn = fn.split("\nexport function restore(id) {")[0]
    before_measure = fn.split("getBoundingClientRect()")[0]
    assert "content.style.minHeight = '';" in before_measure


def test_close_resets_min_height_for_persistent_single_instance_modals():
    """Pomodoro keeps one modal element alive for the whole page session
    (close() just hides it, never rebuilds the DOM) — so a floor set by
    _applyRestoreHeight would otherwise survive a full close+reopen
    forever, with no fresh element to reset it.
    """
    fn = MODAL_MANAGER_JS.split("export function close(id) {")[1]
    fn = fn.split("\nexport function ")[0]
    assert "content.style.minHeight = '';" in fn


def test_existing_poisoned_winsize_entries_get_healed_once():
    """The code fix alone only stops the ratchet from happening again — it
    can't undo a height already sitting in an existing user's browser
    (Alessio's `winsize-pomodoro-modal`). A one-time migration must sweep
    and drop any suspiciously-maxed-out persisted window size.
    """
    assert "_healWinsizeRatchet" in MODAL_MANAGER_JS
    heal_fn = MODAL_MANAGER_JS.split("function _healWinsizeRatchet()")[1]
    heal_fn = heal_fn.split("})();")[0]
    assert "winsize-" in heal_fn
    assert "localStorage.removeItem(key)" in heal_fn
    # Runs once per browser, not on every load.
    assert "odysseus.winsizeRatchetHealed" in heal_fn
