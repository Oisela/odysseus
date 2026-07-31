"""The downgrade button must be reachable from the Developer page.

It used to live only in Settings → System, which Alessio could not find — and if
Settings is what a bad release broke, that is also the one place he cannot get
to. v4.0 mounts the same switcher a second time on the Developer page, one
sidebar click away.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADMIN_JS = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "static" / "index.html").read_text(encoding="utf-8")


def _switcher_source():
    start = ADMIN_JS.index("async function _initVersionSwitcher")
    end = ADMIN_JS.index("function initSystemStatus")
    return ADMIN_JS[start:end]


def test_switcher_is_parameterised_by_id_prefix():
    body = _switcher_source()
    assert "async function _initVersionSwitcher(prefix = 'sys-')" in body
    for element in ("versionSel", "switchBtn", "statusMsg"):
        assert f"el(prefix + '{element}')" in body


def test_both_mounts_are_initialised():
    assert "_initVersionSwitcher();" in ADMIN_JS, "Settings → System mount"
    assert "_initVersionSwitcher('dev-');" in ADMIN_JS, "Developer page mount"


def test_developer_page_has_the_switcher_markup():
    assert 'id="developer-version-card"' in INDEX_HTML
    assert 'id="dev-versionSel"' in INDEX_HTML
    assert 'id="dev-switchBtn"' in INDEX_HTML
    assert 'id="dev-statusMsg"' in INDEX_HTML
    # The card sits inside the developer panel, not somewhere else.
    panel = INDEX_HTML.index('data-settings-panel="developer"')
    card = INDEX_HTML.index('id="developer-version-card"')
    assert card > panel


def test_promote_button_stays_on_the_system_card_only():
    """Two Update buttons would let one promotion be started twice."""
    assert INDEX_HTML.count('id="sys-promoteBtn"') == 1
    assert 'id="dev-promoteBtn"' not in INDEX_HTML


def test_listeners_are_attached_once_per_mount():
    """initDeveloperPage() re-runs on every visit to the page.

    Without the guard, opening the Developer page three times would attach three
    click listeners, and one press of Switch would fire three confirms and three
    POSTs. Found by review before this ever shipped.
    """
    body = _switcher_source()
    assert "if (btn._switcherWired) return;" in body
    assert "btn._switcherWired = true;" in body
    wired_at = body.index("btn._switcherWired = true;")
    for listener in ("sel.addEventListener('change'", "btn.addEventListener('click'"):
        assert body.index(listener) > wired_at, (
            f"{listener} must sit behind the once-only guard"
        )


def test_release_list_is_refreshed_on_every_open_but_read_through_the_map():
    """Fresh list each open; listeners must not close over the first fetch.

    The guard means the click handler is created once. If it read `releases`
    from that first closure, a version released later would be rejected as
    "not a release" until a full page reload.
    """
    body = _switcher_source()
    assert "_switcherReleases[prefix] = releases;" in body
    assert body.count("(_switcherReleases[prefix] || []).find") == 2, (
        "both sync() and the click handler must read through the map"
    )
    # The fetch itself stays outside the guard so re-opens repopulate.
    assert body.index("/api/system/releases") < body.index("btn._switcherWired")


def test_status_message_access_is_null_safe():
    """The element is optional per mount — a missing one must not throw."""
    body = _switcher_source()
    click_handler = body[body.index("btn.addEventListener('click'"):]
    for line in click_handler.splitlines():
        stripped = line.strip()
        if "msg.textContent" in stripped or "msg.className" in stripped:
            assert stripped.startswith("if (msg)"), f"unguarded msg access: {stripped}"
