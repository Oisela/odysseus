"""Regression pins for the markdown-backed rich note editor."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RICH = (ROOT / "static" / "js" / "notesRichEditor.js").read_text(encoding="utf-8")
NOTES = (ROOT / "static" / "js" / "notes.js").read_text(encoding="utf-8")
MARKDOWN = (ROOT / "static" / "js" / "markdown.js").read_text(encoding="utf-8")


def test_save_and_type_switch_flush_rich_text_before_reading_textarea():
    assert "flush: syncToTextarea" not in RICH
    assert "const flush = async () =>" in RICH
    assert "await form._richEditor?.flush?.();" in NOTES
    assert NOTES.count("await form._richEditor?.flush?.();") == 2


def test_raw_mode_waits_for_markdown_serialization():
    raw_click = RICH.index("rawBtn.addEventListener('click', async () =>")
    flush = RICH.index("await flush();", raw_click)
    switch = RICH.index("setMode(true);", flush)
    assert raw_click < flush < switch


def test_currency_safe_inline_math_rule_is_shared():
    assert "export const INLINE_MATH_MD_SOURCE" in MARKDOWN
    assert "new RegExp(INLINE_MATH_MD_SOURCE, 'g')" in MARKDOWN
    assert "import markdownModule, { INLINE_MATH_MD_SOURCE }" in RICH
    assert RICH.count("new RegExp(INLINE_MATH_MD_SOURCE") == 2
    assert r"(?<![$\d])\$(?![$\s])" in MARKDOWN
    assert r"\$(?![$\d])" in MARKDOWN


def test_rich_editor_rejects_active_link_schemes():
    assert "/^(?:https?:|mailto:|tel:)/i.test(url)" in RICH
    assert "blocked unsafe link scheme" in RICH
