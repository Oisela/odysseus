"""Settings module toggles — Alessio v4.2, verbatim: "Dann Developer nur für
Admins, und RemNote und alle anderen Sachen ausschaltbar machen in
Settings."

Two rules bundled in one request:

  1. Developer must be invisible to non-admins — not just gated on the
     backend (tests/test_system_routes_admin_gate.py locks that down), the
     sidebar entry itself must never render for a non-admin account. This
     turned out to already be true (built in v4.0, see
     tests/test_developer_main_page_static.py) — this file re-asserts the
     same contract from the "module toggle" angle so a future refactor of
     the Sidebar-visibility card can't accidentally sweep Developer into it.
  2. Every tool-like sidebar section (Notes, Pomodoro, Shopping, RemNote, …)
     must be individually switchable in Settings → Appearance → Sidebar,
     through the *existing* `.vis-row` / `data-ui-key` mechanism — not a
     second, parallel visibility system.

RemNote was already wired into app.js's UI_VIS_MAP (`tool-remnote` →
`#remnote-section`) before this change — the JS half of the toggle worked,
but index.html had no checkbox to drive it, so it was silently
unreachable. This file locks in the completed wiring plus the constraints
Alessio called out: state survives reload, and disabling everything must
never strand him outside Settings.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
APP_JS = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
SETTINGS_JS = (ROOT / "static" / "js" / "settings.js").read_text(encoding="utf-8")
SLASH_JS = (ROOT / "static" / "js" / "slashCommands.js").read_text(encoding="utf-8")

# Sidebar sections a user should be able to turn off individually via
# Settings. Developer is deliberately excluded from this list — it is not a
# preference, it is a permission (see test_developer_* below).
SWITCHABLE_TOOL_KEYS = ["tool-notes", "tool-pomodoro", "tool-shopping", "tool-remnote"]


# ─── Rule 1: Developer is a permission, not a preference ───

def test_developer_sidebar_entry_is_admin_gated():
    """Fail-closed by default: the inline style hides it before any JS runs,
    and the fetch of /api/auth/status is what's allowed to reveal it."""
    assert (
        'class="section section-header-only admin-only" id="developer-section" '
        'style="display:none"' in INDEX_HTML
    )
    assert "developerSection.style.display = d.is_admin ? '' : 'none';" in APP_JS


def test_developer_settings_nav_entry_is_admin_gated_too():
    """The legacy Settings → Developer nav button (redirects to the sidebar
    page) must carry the same .admin-only gate as Tools/Users/System."""
    assert 'class="settings-nav-item admin-only" data-settings-tab="developer"' in INDEX_HTML


def test_developer_is_not_a_sidebar_visibility_switch():
    """Developer must never appear as a data-ui-key in the Sidebar card — if
    it did, flipping it back on for a non-admin would just produce a wall of
    403s instead of doing nothing, and an admin could accidentally hide
    their own only way into the developer tools."""
    assert 'data-ui-key="tool-developer"' not in INDEX_HTML
    assert "'tool-developer':" not in APP_JS


# ─── Rule 2: tool sections are switchable through the existing mechanism ───

def test_every_switchable_tool_has_a_vis_row_switch():
    for key in SWITCHABLE_TOOL_KEYS:
        assert f'data-ui-key="{key}"' in INDEX_HTML, f"{key} has no Settings switch"


def test_every_switchable_tool_key_is_wired_to_its_sidebar_section():
    """A checkbox with no matching UI_VIS_MAP entry does nothing when
    clicked — the switch is only real once app.js maps the key to the DOM
    node that actually gets hidden."""
    expected = {
        "tool-notes": "#notes-section",
        "tool-pomodoro": "#pomodoro-section",
        "tool-shopping": "#shopping-section",
        "tool-remnote": "#remnote-section",
    }
    for key, selector in expected.items():
        matches = [ln for ln in APP_JS.splitlines() if f"'{key}':" in ln]
        assert matches, f"{key} missing from UI_VIS_MAP"
        assert selector in matches[0], f"{key} not wired to {selector}"


def test_no_second_visibility_mechanism_was_introduced():
    """Alessio's instruction: extend the existing .vis-row pattern, don't
    build a parallel one. Every switch lives under the same class and reads
    through the same data attribute."""
    assert INDEX_HTML.count('data-ui-key="tool-remnote"') == 1
    # No RemNote-specific storage key, toggle class, or bespoke element.
    assert "remnote-visibility" not in APP_JS
    assert "remnote-enabled" not in APP_JS


def test_toggled_off_module_removes_both_entry_and_open_path():
    """The map targets the whole <div class="section-header-only"> (title +
    click handler together), not just a label — so hiding it also removes
    the only way to open the tool, per Alessio's "wirklich weg" rule."""
    assert "el.style.display = visible ? '' : 'none';" in APP_JS
    # The header-only sections are single-node sections (title IS the open
    # button, see section-management.js) — hiding the section id hides both.
    for section_id in ("notes-section", "pomodoro-section", "shopping-section", "remnote-section"):
        block = [
            ln for ln in INDEX_HTML.splitlines()
            if f'id="{section_id}"' in ln and "section-header-only" in ln
        ]
        assert block, f"{section_id} is no longer a header-only (title-is-the-button) section"


# ─── State must survive reload, via the existing store ───

def test_visibility_state_persists_across_reload():
    """Same storage the existing Sidebar switches already use — a
    localStorage boot cache plus a per-account server mirror — not a
    second, RemNote-only store."""
    assert "Storage.setJSON(UI_VIS_KEY, state);" in APP_JS
    assert "Storage.getJSON(UI_VIS_KEY, {});" in APP_JS
    assert "fetch('/api/prefs/ui_visibility'" in APP_JS


def test_simple_mode_turns_remnote_off_like_its_sibling_tools():
    """Simple mode's documented contract is "chat, notes, calendar and
    shopping" only. RemNote is none of those, so — like Pomodoro, Compare
    and Cookbook already do — it belongs in the off-list."""
    start = APP_JS.index("const UI_SIMPLE_OFF")
    block = APP_JS[start:APP_JS.index("];", start)]
    assert "'tool-remnote'" in block


# ─── Settings itself must stay reachable, however things are configured ───

def test_settings_as_a_whole_has_no_visibility_switch():
    """Only the sidebar cog *shortcut* (`sidebar-settings-btn`) is
    switchable — there is no key that hides the Settings panel itself, so
    it can never be switched off wholesale."""
    ui_keys = set()
    for line in INDEX_HTML.splitlines():
        if "data-ui-key=" not in line:
            continue
        value = line.split('data-ui-key="', 1)[1].split('"', 1)[0]
        ui_keys.add(value)
    assert "settings" not in ui_keys
    assert "settings-section" not in ui_keys
    assert "sidebar-settings-btn" in ui_keys  # the shortcut, not the panel


def test_hiding_the_settings_cog_is_guarded_against_self_lockout():
    """The one existing self-lockout guard: hiding the cog asks for
    confirmation first and reminds the user that /settings still opens the
    panel — and the slash command genuinely exists."""
    assert "key === 'sidebar-settings-btn' && !chk.checked" in SETTINGS_JS
    assert "/settings" in SETTINGS_JS
    assert "settings:" in SLASH_JS


def test_disabling_every_module_still_leaves_settings_reachable():
    """Even the "hide everything" Simple preset must not touch the settings
    shortcut key — Simple is meant to declutter, not lock Alessio out."""
    start = APP_JS.index("const UI_SIMPLE_OFF")
    block = APP_JS[start:APP_JS.index("];", start)]
    assert "'sidebar-settings-btn'" not in block
