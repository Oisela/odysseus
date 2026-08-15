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
    # Ends at the next function, not at initSystemStatus: anything inserted
    # between them would silently be judged as part of the switcher.
    end = ADMIN_JS.index("function _initPromoteButton")
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


def test_two_update_buttons_cannot_start_two_promotions():
    """Was: "the promote button stays on the System card only".

    Alessio asked for Update on the Developer page too (2026-08-15) — that is
    where he decides a round is done, and since the rebuild became his call it
    is the button he reaches for most. The old test forbade the second button
    because two of them let one promotion be started twice. That danger is
    real, so it is now closed where it actually lives instead of by leaving
    the button out:

      - the server refuses a second concurrent deployment (409), the same
        guard /switch has had since v4.0, and
      - pressing either button disables both.
    """
    assert INDEX_HTML.count('id="sys-promoteBtn"') == 1
    assert INDEX_HTML.count('id="dev-promoteBtn"') == 1

    routes = (ROOT / "routes" / "system_routes.py").read_text(encoding="utf-8")
    promote = routes[routes.index("def promote_beta(request: Request):"):]
    assert "_SWITCH_PREFLIGHT_SCRIPT" in promote
    assert "A deployment is already running" in promote

    assert "#sys-promoteBtn, #dev-promoteBtn" in ADMIN_JS


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


def test_developer_page_init_does_not_skip_its_own_loads():
    """Regression, v4.0.1 — found by Alessio on prod within minutes.

    initDeveloperPage() used to `return` after initAll() on the first call, so
    everything below it — including the version-switcher mount — was skipped.
    Opening Developer is usually the first admin action of a session, so the
    dropdown sat on its "versions…" placeholder until you happened to open the
    page a second time. That dropdown IS the downgrade button.

    Every call below is safe to repeat, which is what makes falling through
    the right fix rather than reordering.
    """
    start = ADMIN_JS.index("export function initDeveloperPage()")
    body = ADMIN_JS[start:ADMIN_JS.index("export function open(", start)]
    assert "if (!initialized) initAll();" in body
    assert "return;" not in body, "an early return here silently skips the loads"
    for call in ("_loadDevStatus()", "_loadRoadmap()", "_initVersionSwitcher('dev-')"):
        assert call in body


def test_index_html_has_no_orphaned_markup():
    """Regression, v4.0.1 — raw HTML was rendering as text on the page.

    Moving the new-item form into its modal left a truncated <textarea> tag
    behind, so `s="2" placeholder="…">` showed up as visible text under the
    toolbar. A structural parse catches this class of damage; counting <div>s
    does not.
    """
    from html.parser import HTMLParser

    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr"}

    class Checker(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.stack, self.errors = [], []

        def handle_starttag(self, tag, attrs):
            if tag not in VOID:
                self.stack.append((tag, self.getpos()[0]))

        def handle_endtag(self, tag):
            if tag in VOID:
                return
            if not self.stack:
                self.errors.append(f"line {self.getpos()[0]}: stray </{tag}>")
                return
            if self.stack[-1][0] == tag:
                self.stack.pop()
                return
            for k in range(len(self.stack) - 1, -1, -1):
                if self.stack[k][0] == tag:
                    for open_tag, line in self.stack[k + 1:]:
                        self.errors.append(f"line {line}: <{open_tag}> never closed")
                    del self.stack[k:]
                    return
            self.errors.append(f"line {self.getpos()[0]}: </{tag}> matches nothing")

    checker = Checker()
    checker.feed(INDEX_HTML)
    for tag, line in checker.stack:
        checker.errors.append(f"line {line}: <{tag}> left open")
    assert not checker.errors, "index.html is structurally broken:\n" + "\n".join(checker.errors[:10])


def test_roadmap_reload_button_says_what_it_does():
    """It re-reads ROADMAP.md; "Refresh status" read as deployment status.

    Alessio had to ask what the button did — that is the evidence the label
    failed, and the package card next to it has its own status refresh.
    """
    assert ">Reload roadmap<" in INDEX_HTML
    assert ">Refresh status<" not in INDEX_HTML


def test_roadmap_paste_does_not_leak_the_image_into_the_chat():
    """Regression, v4.0.2 — pasting a screenshot "did nothing".

    It actually did two things: uploaded to the roadmap AND, because app.js
    has a window-level paste handler, dropped the same file into the chat
    attach strip. preventDefault alone does not stop that; stopPropagation
    does.

    v4.1 lifted the handler out of the title-line listener so every detail
    field of the popup takes a screenshot too; the rule is unchanged, so this
    test follows the handler to its new name rather than being relaxed.
    """
    start = ADMIN_JS.index("const _onRoadmapPaste = ")
    handler = ADMIN_JS[start:start + 900]
    assert "e.preventDefault();" in handler
    assert "e.stopPropagation();" in handler
    # and it is actually wired to the fields, not just defined
    assert "input.addEventListener('paste', _onRoadmapPaste)" in ADMIN_JS
    assert "el(id)?.addEventListener('paste', _onRoadmapPaste)" in ADMIN_JS


def test_roadmap_feedback_is_visible_while_the_popup_is_open():
    """#dev-roadmap-msg sits below the board, i.e. behind the popup."""
    assert "const _roadmapNote = (text, cls = '') =>" in ADMIN_JS
    assert "el('dev-roadmap-new-msg')" in ADMIN_JS
    assert 'id="dev-roadmap-new-msg"' in INDEX_HTML
    # The in-popup line must be inside the modal, not next to the board.
    assert INDEX_HTML.index('id="dev-roadmap-new-msg"') > INDEX_HTML.index('id="roadmap-new-modal"')


def test_sidebar_dots_keep_clear_of_the_border():
    """Regression, v4.0.2.

    The dots use margin-left:auto to line up in one column. Header-only
    sections used to carry an invisible chevron that kept them off the edge;
    dropping it in v4.0 glued them to the border.
    """
    css = (ROOT / "static" / "style.css").read_text(encoding="utf-8")
    block = css[css.index(".sidebar-notif-dot {"):]
    block = block[:block.index("}")]
    assert "margin-left: auto;" in block
    assert "margin-right: 6px;" in block
