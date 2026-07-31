"""The "Files in this chat" indicator button must show a picker, not auto-open.

Alessio's complaint (2026-07-30): switching chats after having switched away
from one that already opened its PDF/document panel would yank the panel back
open uninvited. document.js's loadSessionDocs() already fixed the auto-open
(restoreMode + !shouldRestoreOpen returns early without opening the panel or
switching docs) — that's an intentional fork deviation from upstream and must
not be silently reverted.

What was still missing was the way *back* in: #doc-indicator-btn was
referenced everywhere in JS/CSS (visibility toggling, active-state syncing,
session-switch sync) but never existed in index.html. This file locks down
the button's markup location and its click behavior: it must show a list of
this chat's documents to choose from (mirroring #export-dl-btn /
#export-dropdown-menu), not immediately reopen whatever doc was last active
by delegating to #overflow-doc-btn.
"""

from pathlib import Path

import re

import pytest

ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
DOCUMENT_JS = (ROOT / "static" / "js" / "document.js").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "static" / "style.css").read_text(encoding="utf-8")


def test_doc_indicator_btn_exists_in_markup():
    """The button was referenced everywhere but never actually defined — the
    bug this whole task exists to fix."""
    assert 'id="doc-indicator-btn"' in INDEX_HTML


def _chat_meta_overlay_html():
    # The overlay's markup is a single minified line full of nested divs
    # (dropdown menus), so the first literal "</div>" is one of those, not
    # the overlay's own close tag. A generous fixed window comfortably spans
    # both #doc-indicator-wrap and #export-dropdown-wrap (~800 chars apart)
    # without needing to actually parse the HTML.
    start = INDEX_HTML.index('class="chat-meta-overlay"')
    return INDEX_HTML[start:start + 2000]


def test_doc_indicator_btn_lives_in_chat_meta_overlay():
    """It must sit in the top-right chat bar (.chat-meta-overlay), next to
    the existing #export-dropdown-wrap — not bolted on somewhere unrelated."""
    overlay_html = _chat_meta_overlay_html()
    assert 'id="doc-indicator-btn"' in overlay_html
    assert 'id="export-dropdown-wrap"' in overlay_html, (
        "reference point for the design-consistency requirement went missing"
    )


def test_doc_indicator_menu_exists_alongside_the_button():
    """The click target is a picker list, not a bare button — the menu node
    must exist and be reachable from the same wrapper as the button."""
    assert 'id="doc-indicator-menu"' in INDEX_HTML
    assert 'id="doc-indicator-menu"' in _chat_meta_overlay_html()


def test_click_handler_does_not_delegate_to_overflow_doc_btn():
    """Regression guard for the old one-liner that just reopened the last
    active doc: `el('overflow-doc-btn').click()`. That defeats the whole
    point of a picker — instant reopen is exactly the "auto-open" behavior
    the panel-yanking fix was supposed to kill for the *second* entry point.
    """
    btn_decl = APP_JS.index("const docIndicatorBtn = el('doc-indicator-btn')")
    # Look at the block wiring this button up (through the next top-level
    # section comment) rather than the whole file, so an unrelated overflow
    # click elsewhere in app.js can't hide a regression here.
    next_section = APP_JS.index("RAG toggle (overflow + indicator)", btn_decl)
    handler_block = APP_JS[btn_decl:next_section]
    assert "overflow-doc-btn').click()" not in handler_block
    assert "overflow-doc-btn" not in handler_block


def test_click_opens_a_picker_menu_instead_of_the_panel_directly():
    """The handler must build/show doc-indicator-menu, and only open a
    specific document once the user picks a row from it."""
    btn_decl = APP_JS.index("const docIndicatorBtn = el('doc-indicator-btn')")
    next_section = APP_JS.index("RAG toggle (overflow + indicator)", btn_decl)
    handler_block = APP_JS[btn_decl:next_section]
    assert "docIndicatorMenu.classList.add('open')" in handler_block
    assert "documentModule.switchToDoc(doc.id)" in handler_block


def test_doc_indicator_visibility_mechanics_are_untouched():
    """_syncDocIndicator() must keep toggling `.visible` based on whether the
    session has any documents — the button is only ever shown, never always
    on."""
    assert "document.getElementById('doc-indicator-btn')" in DOCUMENT_JS
    sync_fn_start = DOCUMENT_JS.index("function _syncDocIndicator()")
    sync_fn_body = DOCUMENT_JS[sync_fn_start:sync_fn_start + 800]
    assert "indicator.classList.toggle('visible', hasDocs)" in sync_fn_body


def test_doc_indicator_visible_css_rules_still_exist():
    """CSS keys the button's visibility off the ID + `.visible` class — the
    button markup relies on these rules already existing rather than
    reinventing show/hide logic."""
    assert "#doc-indicator-btn { display: none !important; }" in STYLE_CSS
    assert "#doc-indicator-btn.visible { display: inline-flex !important; }" in STYLE_CSS


def test_auto_open_prevention_on_session_switch_is_intact():
    """The deliberate fork deviation: entering a chat must not auto-open its
    attached documents/PDFs. If this regresses, the picker this task adds
    becomes pointless busywork sitting next to a panel that pops open anyway.
    """
    assert "must NOT auto-open" in DOCUMENT_JS
    guard_start = DOCUMENT_JS.index("if (restoreMode && !shouldRestoreOpen)")
    guard_body = DOCUMENT_JS[guard_start:guard_start + 300]
    assert "activeDocId = null;" in guard_body
    assert "return;" in guard_body
    # And it must come before the code path that would open the panel.
    open_call = DOCUMENT_JS.index("if (!isOpen) openPanel();\n      switchToDoc(target.id);")
    assert guard_start < open_call


@pytest.mark.parametrize("selector", ["export-dl-btn", "doc-indicator-btn"])
def test_doc_indicator_btn_svg_style_matches_its_neighbor(selector):
    """Design-consistency rule: same inline-SVG stroke style as #export-dl-btn,
    not an emoji or a differently-styled icon."""
    pattern = (
        rf'id="{re.escape(selector)}"[^>]*>\s*<svg width="13" height="13" '
        r'viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        r'stroke-width="2\.5" stroke-linecap="round" stroke-linejoin="round">'
    )
    assert re.search(pattern, INDEX_HTML), (
        f"#{selector} icon markup diverged from the shared top-bar icon style"
    )
