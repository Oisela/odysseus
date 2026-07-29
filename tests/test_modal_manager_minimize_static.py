from pathlib import Path


MODAL_MANAGER = Path("static/js/modalManager.js").read_text(encoding="utf-8")


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
