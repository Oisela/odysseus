from pathlib import Path


MODAL_MANAGER = Path("static/js/modalManager.js").read_text(encoding="utf-8")
APP_JS = Path("static/app.js").read_text(encoding="utf-8")
CSS = Path("static/style.css").read_text(encoding="utf-8")


def test_registered_modal_adopts_an_existing_legacy_minimize_button():
    """Dynamic modals must not be minimized by both the old and new docks."""
    assert "if (_modalEl) injectMinimizeButton(_modalEl, id);" in MODAL_MANAGER
    assert (
        "header.querySelector('.modal-minimize-btn, .minimize-btn, [data-minimize]')"
        in MODAL_MANAGER
    )
    assert "btn.dataset._modalsBound = '1';" in MODAL_MANAGER
    assert "e.stopImmediatePropagation();" in MODAL_MANAGER


def test_auto_wire_uses_dom_changes_instead_of_permanent_polling():
    """Idle pages should not rescan every known modal once per second."""
    assert "const _autoWireSelector = Object.keys(_AUTO_WIRE)" in MODAL_MANAGER
    assert "node.querySelectorAll?.(_autoWireSelector)" in MODAL_MANAGER
    assert "const _autoWireObserver = new MutationObserver" in MODAL_MANAGER
    assert "_autoWireObserver.observe(root, { childList: true, subtree: true });" in MODAL_MANAGER
    assert "setInterval(_scanAndWire" not in MODAL_MANAGER


def test_minimize_reuses_one_layout_measurement():
    minimize_body = MODAL_MANAGER.split(
        "export function minimize(id) {", 1
    )[1].split("export function restore(id) {", 1)[0]
    assert minimize_body.count("getBoundingClientRect()") == 1


def test_empty_dock_forgets_the_last_rendered_chip_ids():
    empty_branch = MODAL_MANAGER.split("if (!renderIds.length) {", 1)[1].split(
        "return;", 1
    )[0]
    assert "_renderedChipIds.clear();" in empty_branch


def test_minimized_chips_are_owned_by_the_chat_surface():
    assert "(chat || document.body).appendChild(dock);" in MODAL_MANAGER
    assert "#chat-container > .minimized-dock-chip" in MODAL_MANAGER
    assert "document.body.appendChild(chip)" not in MODAL_MANAGER
    assert "body > .minimized-dock-chip" not in MODAL_MANAGER
    assert "position: absolute; bottom: var(--composer-clearance, 12px);" in CSS


def test_free_dock_positions_are_clamped_and_reflow_is_throttled():
    assert "function _clampChatPosition(" in MODAL_MANAGER
    assert "maxLeft: Math.max(minLeft, chatRect.width - width - pad)" in MODAL_MANAGER
    assert "bottom = Math.min(bottom, composerRect.top - 6);" in MODAL_MANAGER
    assert "if (_dockLayoutRaf) return;" in MODAL_MANAGER
    assert "_dockLayoutRaf = requestAnimationFrame(_syncDockLayout);" in MODAL_MANAGER
    assert "new ResizeObserver(_scheduleDockLayout)" in MODAL_MANAGER
    assert "new MutationObserver(_scheduleDockLayout).observe(sidebar" in MODAL_MANAGER


def test_free_dock_coordinates_are_not_shifted_by_the_center_transform():
    """A clamped left value must not be translated under the sidebar again."""
    apply_position = MODAL_MANAGER[
        MODAL_MANAGER.index("function _applyDockPos"):
        MODAL_MANAGER.index("function _floatDockInsideChat")
    ]
    float_position = MODAL_MANAGER[
        MODAL_MANAGER.index("function _floatDockInsideChat"):
        MODAL_MANAGER.index("function _nearDock")
    ]
    assert "dock.style.transform = 'none';" in apply_position
    assert "dock.style.transform = 'none';" in float_position
    assert "dock.style.transform = '';" in apply_position
    assert "max-width: calc(100% - 8px);" in CSS
    assert "text-overflow: ellipsis;" in CSS


def test_single_chip_move_promotes_inflow_dock_before_setting_coordinates():
    assert "function _floatDockInsideChat(dock)" in MODAL_MANAGER
    move_start = MODAL_MANAGER.index("if (!dragging) {")
    move_body = MODAL_MANAGER[move_start:MODAL_MANAGER.index(
        "// Desktop: dragging a chip into a screen snap zone", move_start
    )]
    assert "dock.classList.add('dock-dragging');" in move_body
    assert "_floatDockInsideChat(dock);" in move_body


def test_composer_boundary_is_kept_even_when_dock_is_taller_than_free_space():
    bounds = MODAL_MANAGER[MODAL_MANAGER.index("function _chatDockBounds"):
                           MODAL_MANAGER.index("function _clampChatPosition")]
    assert "composerRect.top > chatRect.top" in bounds
    assert "composerRect.top - chatRect.top > height" not in bounds


def test_mobile_drawer_temporarily_hides_chat_dock_controls():
    assert "const drawerOpen = window.innerWidth <= 768" in MODAL_MANAGER
    assert "dock-mobile-drawer-hidden" in MODAL_MANAGER
    assert "#minimized-dock.dock-mobile-drawer-hidden" in CSS


def test_legacy_fallback_dock_is_also_chat_scoped_without_sidebar_polling():
    legacy = APP_JS.split("(function initModalMinimize() {", 1)[1].split(
        "function modalTitle(modal)", 1
    )[0]
    assert "(chat || document.body).appendChild(dock);" in legacy
    assert "dock.style.left = '0px';" in legacy
    assert "new ResizeObserver(updateDockOffset)" not in legacy
    assert "#modal-dock {\n      position:absolute;" in CSS
