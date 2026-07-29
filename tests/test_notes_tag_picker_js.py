"""Regression guards for the Notes multi-select tag picker.

Notes is a browser ES module with a large DOM/import surface, so these tests
pin the integration points that must continue sharing the legacy `label`
string across drafts, create/update, quick-add, mobile and filtering.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NOTES = (ROOT / "static" / "js" / "notes.js").read_text(encoding="utf-8")
STYLE = (ROOT / "static" / "style.css").read_text(encoding="utf-8")


def _function_body(name: str, next_name: str) -> str:
    start = NOTES.index(f"function {name}")
    end = NOTES.index(f"function {next_name}", start)
    return NOTES[start:end]


def test_picker_keeps_legacy_label_value_and_multiselect_ui():
    assert 'type="hidden" class="note-form-label"' in NOTES
    assert 'class="note-tag-selected"' in NOTES
    assert 'class="note-tag-options" role="listbox" aria-multiselectable="true"' in NOTES
    assert 'type="checkbox" data-tag-option=' in NOTES
    assert 'class="note-tag-add-input" placeholder="Add tag"' in NOTES
    assert "labelInput.value = _editableNoteTags(tags.join(' ')).join(' ')" in NOTES


def test_picker_options_include_existing_note_tags_and_named_lists():
    body = _function_body("_knownNoteTags", "_wireNoteTagPicker")
    assert "_knownTagCache" in body
    assert "_visibleNoteTags(n)" in body
    assert "_prefLists" in body
    assert "localeCompare" in body


def test_known_tags_survive_switching_between_active_and_archived_fetches():
    assert "const _knownTagCache = new Set()" in NOTES
    assert NOTES.count("_rememberNoteTags(_notes)") >= 2
    remember = _function_body("_rememberNoteTags", "_ensureNoteTagOutsideClick")
    assert "_knownTagCache.add(tag)" in remember


def test_tag_only_drafts_survive_and_save_uses_normalized_label_payload():
    draft_body = _function_body("_isDraftEmpty", "_wireDraftAutosave")
    assert "_editableNoteTags(d.label).length" in draft_body
    assert "label: form.querySelector('.note-form-label')?.value || ''" in NOTES
    assert "const _tags = _editableNoteTags(_rawLabel)" in NOTES
    assert "const labelVal = _tags.length ? _tags.join(' ') : null" in NOTES
    assert "label: labelVal" in NOTES


def test_quick_add_inherits_active_tag_in_both_notes_views():
    # Master-detail creates immediately; legacy quick-add expands the editor.
    assert "label: (_activeLabel || '') || undefined" in NOTES
    assert "_buildForm({ note_type: initialType, label: _activeLabel || '' })" in NOTES


def test_mobile_relocates_whole_picker_and_filter_still_reads_label_tokens():
    mobile = _function_body("_openMobileFullscreenEdit", "_closeMobileFullscreenEdit")
    assert "const tagsPicker   = form.querySelector('.note-tag-picker')" in mobile
    assert "actionsGroup.insertBefore(tagsPicker, actionsGroup.firstChild)" in mobile
    assert "_noteTags(n).includes(_activeLabel)" in NOTES
    assert ".note-fullscreen-overlay .note-tag-picker-menu" in STYLE


def test_picker_has_chip_menu_and_mobile_styles():
    for selector in (
        ".note-tag-picker",
        ".note-tag-chip",
        ".note-tag-picker-menu",
        ".note-tag-option",
        ".note-tag-add-row",
    ):
        assert selector in STYLE


def test_picker_closes_on_outside_pointer_without_per_form_document_listeners():
    assert "let _openNoteTagPicker = null" in NOTES
    assert "if (_noteTagOutsideClickWired) return" in NOTES
    assert "document.addEventListener('pointerdown'" in NOTES
    assert "!active.picker.contains(e.target)" in NOTES
