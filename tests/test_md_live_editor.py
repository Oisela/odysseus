"""Markdown documents are edited live, in the rendered text.

Alessio 2026-08-15, after rejecting a side-by-side split view: "entweder wie in
note alles direkt bearbeitbar wie in obsidian oder garnicht."

So Write is now the same rich editor his notes use. The decision that matters is
that it is a REUSE, not a second editor: notesRichEditor keeps markdown as the
storage format and mirrors it back into #doc-editor-textarea on every input, and
that textarea is what save, versioning, diffing and the agent all read. A
second WYSIWYG implementation would be a second markdown round-trip to keep
honest.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOC = (ROOT / "static/js/document.js").read_text(encoding="utf-8")
RICH = (ROOT / "static/js/notesRichEditor.js").read_text(encoding="utf-8")
CSS = (ROOT / "static/style.css").read_text(encoding="utf-8")


def _sync() -> str:
    return DOC.split("function _syncRichEditor(mode")[1].split("\n  }")[0]


def test_it_reuses_the_notes_editor_rather_than_adding_a_second_one():
    assert "import notesRichEditor from './notesRichEditor.js';" in DOC
    assert "notesRichEditor.attach(textarea, {})" in DOC
    # The property the reuse depends on: markdown stays the storage format and
    # the textarea remains the single source of truth.
    assert "ta.value = htmlToMd(rich)" in RICH
    assert "ta.dispatchEvent(new Event('input'" in RICH


def test_no_split_view_survived_the_rejection():
    """"oder garnicht" — a leftover third mode is exactly what was rejected."""
    for leftover in ("md-split-active", "doc-md-split", "_scheduleSplitPreviewRender",
                     "_syncSplitScroll", 'data-mdview="split"'):
        assert leftover not in DOC, f"split-view leftover: {leftover}"
        assert leftover not in CSS, f"split-view leftover in css: {leftover}"


def test_rich_editing_is_write_mode_on_markdown_only():
    sync = _sync()
    assert "mode === 'edit'" in sync
    assert "_isMarkdownDoc()" in sync
    # An open email uses its own rich body; two rich editors would fight.
    assert "language !== 'email'" in sync


def test_a_diff_falls_back_to_the_source_view():
    """A diff is a line-by-line view of the source, which the rich layer cannot
    show — and it hides the very textarea the diff paints into."""
    assert "!_diffModeActive" in _sync()
    enter = DOC.split("function enterDiffMode(oldContent, newContent) {")[1].split("\n\n")[0]
    assert "_unmountRichEditor()" in enter
    exit_fn = DOC.split("function exitDiffMode(discard)")[1].split("\n  function ")[0]
    assert "_syncRichEditor(" in exit_fn, "the editor has to come back afterwards"


def test_unmounting_flushes_first():
    """Whatever is on screen but not yet serialised would otherwise be lost."""
    unmount = DOC.split("function _unmountRichEditor()")[1].split("\n  }")[0]
    assert "_mdRich.flush()" in unmount
    assert unmount.index("flush()") < unmount.index("destroy()")


def test_leaving_write_serialises_before_the_textarea_is_read():
    setter = DOC.split("function _setMarkdownPreviewActive(active")[1].split("\n  }")[0]
    assert "if (_mdRich && !active) { try { _mdRich.flush(); } catch (_) {} }" in setter


def test_rerendering_is_restricted_to_explicit_transitions():
    """Rebuilding the contenteditable mid-keystroke would drop the caret.

    _syncHeaderActions runs on routine state syncs, so it may mount but must
    never refresh; the transition call sites opt in explicitly.
    """
    sync = _sync()
    assert "{ refresh = false } = {}" in sync, "refresh must be opt-in"
    assert "if (refresh && wasMounted)" in sync
    header = DOC.split("function _syncHeaderActions() {")[1].split("\n    const actionBtn")[0]
    # Exact call, no options object: mount only.
    assert "_syncRichEditor('edit');" in header
    assert "refresh: true" not in header
    # The transitions do ask for it.
    assert "_syncRichEditor(active ? 'preview' : 'edit', { refresh: true })" in DOC


def test_the_handle_is_declared_before_its_first_reader():
    """_syncHeaderActions reads _mdRich and is hoisted far above the editor
    section; a `let` further down would be a temporal-dead-zone ReferenceError.
    """
    assert DOC.count("let _mdRich = null;") == 1
    assert DOC.index("let _mdRich = null;") < DOC.index("function _syncHeaderActions() {")


def test_source_view_furniture_is_hidden_under_the_rich_layer():
    """Gutter and highlight overlay are painted against the hidden textarea."""
    assert ".doc-editor-wrap.doc-rich-active .doc-line-numbers" in CSS
    assert ".doc-editor-wrap.doc-rich-active .doc-editor-highlight" in CSS
    # One formatting toolbar, not two.
    assert ".doc-md-toolbar.doc-rich-hidden" in CSS
    assert "classList.add('doc-rich-hidden')" in DOC
    assert "classList.remove('doc-rich-hidden')" in DOC


def test_the_toolbar_is_toggled_from_js_not_a_sibling_selector():
    """The document toolbar sits BEFORE the editor in the DOM, and CSS has no
    previous-sibling combinator — a `~` rule here would silently never match."""
    assert ".doc-editor-wrap.doc-rich-active ~ #doc-md-toolbar" not in CSS


def test_the_serializer_is_available_offline():
    """Turndown is vendored, not pulled from a CDN at first keystroke."""
    assert "/static/lib/turndown.min.js" in RICH
    assert (ROOT / "static/lib/turndown.min.js").exists()
    assert (ROOT / "static/lib/turndown-plugin-gfm.min.js").exists()


def test_math_and_tables_are_protected_islands():
    """A naive HTML round-trip destroys formulas and pipe tables — the exact
    content Alessio's documents are full of."""
    assert "note-rich-raw" in RICH
    assert "data-md" in RICH
    assert "contenteditable" in RICH
