"""Header-only sidebar sections must not behave like collapsible ones.

Notes, Pomodoro, Shopping, RemNote and Developer have no body — their title
opens a tool window. `initSectionCollapse` used to wire a *second* click
handler onto those titles anyway, so every click toggled `.collapsed` as a side
effect. Two visible symptoms (Alessio, 2026-07-30):

  * Developer needed two clicks to open.
  * A chevron appeared next to sections with nothing to expand, because
    `.section.collapsed .section-collapse-btn` carries `!important` and beat the
    rule that hides chevrons for header-only sections.

Alessio's rule: an arrow only where there is something to expand.
"""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SECTION_JS = (ROOT / "static" / "js" / "section-management.js").read_text(encoding="utf-8")
APP_JS = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "static" / "style.css").read_text(encoding="utf-8")

HEADER_ONLY_SECTIONS = [
    "notes-section",
    "pomodoro-section",
    "shopping-section",
    "remnote-section",
    "developer-section",
]


@pytest.mark.parametrize("section_id", HEADER_ONLY_SECTIONS)
def test_section_is_still_marked_header_only(section_id):
    """The JS keys off this class — if markup drops it, the fix silently dies."""
    marker = f'class="section section-header-only'
    blocks = [ln for ln in INDEX_HTML.splitlines() if f'id="{section_id}"' in ln]
    assert blocks, f"{section_id} missing from index.html"
    assert any(marker in ln for ln in blocks), (
        f"{section_id} lost its section-header-only class"
    )


def test_collapse_init_returns_early_for_header_only_sections():
    assert "section.classList.contains('section-header-only')" in SECTION_JS
    early_return = SECTION_JS.split("section-header-only')")[1]
    # The early return must come before any listener is attached.
    body = early_return.split("return;")[0]
    assert "addEventListener" not in body, (
        "header-only sections must not get a collapse click handler"
    )


def test_collapse_init_purges_persisted_header_only_state():
    """Without the purge a previously-collapsed section can never reopen.

    Nothing wires a handler to it any more, so `.collapsed` from localStorage
    would be permanent — the highest-blast-radius part of this change.
    """
    assert "section.classList.remove('collapsed')" in SECTION_JS
    assert "delete savedState[section.id]" in SECTION_JS
    assert "purgedHeaderOnly" in SECTION_JS
    assert "Storage.setJSON('section-collapsed', savedState)" in SECTION_JS


def test_collapsed_chevron_rule_excludes_header_only():
    assert (
        ".section.collapsed:not(.section-header-only) .section-collapse-btn"
        in STYLE_CSS
    ), "the !important chevron rule must not apply to header-only sections"
    assert ".section.collapsed .section-collapse-btn { display: inline-flex !important; }" \
        not in STYLE_CSS, "the unscoped rule is what put an arrow on Developer"


def test_developer_button_ignores_clicks_while_its_module_loads():
    """A second click during the dynamic import used to close the window again."""
    start = APP_JS.index("const toolDeveloperBtn")
    handler = APP_JS[start:start + 1200]
    assert "developerBusy" in handler
    assert "if (developerBusy) return;" in handler
    assert "finally" in handler, "the guard must clear even when the import throws"
