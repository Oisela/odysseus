"""Static contract for the first-class Developer sidebar page."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_developer_is_an_admin_only_sidebar_page():
    html = _read("static/index.html")
    assert 'id="developer-section"' in html
    assert 'id="tool-developer-btn"' in html
    assert 'section-header-only admin-only' in html
    assert 'id="developer-section" style="display:none"' in html


def test_sidebar_opens_the_dedicated_developer_window():
    app = _read("static/app.js")
    assert "const toolDeveloperBtn = el('tool-developer-btn')" in app
    assert "import('./js/developer.js')" in app
    assert "Modals.toggle('developer-modal')" in app
    assert "developerSection.style.display = d.is_admin ? '' : 'none'" in app


def test_developer_window_reuses_the_existing_panel():
    source = _read("static/js/developer.js")
    assert 'querySelector(\'[data-settings-panel="developer"]\')' in source
    assert "appendChild(panel)" in source
    assert "cloneNode" not in source
    assert "adminModule.initDeveloperPage()" in source
    assert "Modals.register('developer-modal'" in source


def test_legacy_settings_entry_redirects_to_main_page():
    settings = _read("static/js/settings.js")
    assert "if (tab === 'developer')" in settings
    assert "import('./developer.js').then(m => m.openDeveloper())" in settings
    assert "'developer'" not in settings.split("const ADMIN_TABS", 1)[1].split(";", 1)[0]


def test_admin_exposes_focused_developer_refresh():
    admin = _read("static/js/admin.js")
    assert "export function initDeveloperPage()" in admin
    assert "initDeveloperPage," in admin


def test_developer_header_keeps_the_standard_window_inset():
    css = _read("static/style.css")
    rule = css.split(".developer-modal-content .modal-header {", 1)[1].split("}", 1)[0]
    assert "padding: 10px 14px 0;" in rule
