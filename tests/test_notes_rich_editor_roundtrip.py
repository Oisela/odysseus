"""Data-loss regressions for the notes rich-editor conversion seam."""

from pathlib import Path


_REPO = Path(__file__).resolve().parent.parent
_EDITOR = _REPO / "static" / "js" / "notesRichEditor.js"


def test_conversion_seam_is_exported_and_used_by_editor():
    source = _EDITOR.read_text(encoding="utf-8")

    assert "function mdToEditorHtml(md)" in source
    assert "function htmlToMd(rootEl)" in source
    assert "export { mdToEditorHtml, htmlToMd };" in source
    assert "rich.innerHTML = mdToEditorHtml(ta.value || '');" in source
    assert "ta.value = htmlToMd(rich);" in source


def test_loss_sensitive_markdown_has_explicit_roundtrip_rules():
    source = _EDITOR.read_text(encoding="utf-8")

    # Math, Mermaid and pipe tables are atomic islands that return data-md
    # verbatim instead of relying on lossy HTML conversion.
    assert "kind: 'mermaid'" in source
    assert "kind: 'math'" in source
    assert "kind: 'table'" in source
    assert "decodeURIComponent(raw)" in source

    # Fences preserve language and text, and task-list spacing is normalized
    # back to syntax the markdown renderer recognizes.
    assert "'nreFencedCode'" in source
    assert "code.getAttribute('data-lang')" in source
    assert "- \\[[ xX]\\]" in source


def test_pasted_images_use_normal_markdown_roundtrip_not_a_side_channel():
    source = _EDITOR.read_text(encoding="utf-8")

    assert "_pasteImage(rich, file, syncToTextarea)" in source
    assert "img.src = url" in source
    assert "syncToTextarea();" in source
    assert "Default <img> handling" in source
