"""Pin the structured Roadmap -> Builder workflow in the Developer page."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
SYSTEM_ROUTES = (ROOT / "routes" / "system_routes.py").read_text(encoding="utf-8")


def test_roadmap_has_full_delivery_pipeline():
    assert "mark === '!' ? 'review'" in ADMIN
    assert "mark === '?' ? 'consideration'" in ADMIN
    # Five states, in pipeline order, with the marks that land in ROADMAP.md.
    for entry in (
        "{ key: 'consideration', label: 'Under consideration', mark: '?' }",
        "{ key: 'planned', label: 'Planned', mark: ' ' }",
        "{ key: 'wip', label: 'In progress', mark: '~' }",
        "{ key: 'review', label: 'Ready to test', mark: '!' }",
        "{ key: 'done', label: 'Done', mark: 'x' }",
    ):
        assert entry in ADMIN
    # One definition of the item-line shape. It used to be spelled out in four
    # places, so adding a state meant finding all four.
    assert r"_RM_MARK_RE = /^- \[[ xX~!?]\] /" in ADMIN
    assert r"_RM_MARK_SET_RE = /^- \[[ xX~!?]\]/" in ADMIN
    assert "[ xX~!]" not in ADMIN, "an old four-state marker regex survived"


def test_build_prompt_routes_bugs_and_features_to_different_tracks():
    """Since v4.0 the type of an item decides how it ships.

    Bugs and polish go straight to main so Alessio can keep debugging live;
    features get a short beta pass and then wait for an explicit go-word. The
    old prompt sent everything down one "Gate 1 / Gate 2" path, wording that
    also did not survive translation into a non-Claude model's head.
    """
    assert "function _rmItemKind(item)" in ADMIN
    assert "function _rmTrackForKind(kind)" in ADMIN
    assert "(kind === 'bug' || kind === 'polish') ? 'bug' : 'feature'" in ADMIN

    # Starts at the shared status rule: _buildPrompt and _buildBatchPrompt both
    # end by appending it, so the assembled prompt only exists across both.
    start = ADMIN.index("const _RM_STATUS_RULE")
    prompt = ADMIN[start:ADMIN.index("async function _startRoadmapBuild")]

    # Bug track: no beta, no question, verified afterwards. The question was
    # dropped 2026-08-15 (Alessio) — it came before every bugfix and the answer
    # was always yes, so `dev.sh preflight` inside the command is the check now.
    assert "Track BUG" in prompt
    assert "dev.sh bugfix fix/" in prompt
    assert "ohne Beta" in prompt
    assert "KEINE Rückfrage" in prompt
    assert 'direkt auf main?"' not in prompt
    # Feature track: beta, then a hard stop until a go-word arrives.
    assert "Track FEATURE" in prompt
    assert "dev.sh ready feat/" in prompt
    assert "dev.sh promote-main feat/" in prompt
    assert "STOPP" in prompt
    assert "Go-Wort" in prompt
    # Both tracks must prove the result rather than assume it.
    assert prompt.count("dev.sh verify prod") >= 2
    # And never hand-edit the file the agent plans from.
    assert "dev.sh roadmap-status" in prompt
    assert "nie von" in prompt and "Hand editieren" in prompt


def test_roadmap_cards_have_stable_ids_and_structured_requirements():
    assert "<!-- ody:id=${id} -->" in ADMIN
    assert "_itemKey(item)" in ADMIN
    for field in (
        "dev-roadmap-description",
        "dev-roadmap-goal",
        "dev-roadmap-acceptance",
        "dev-roadmap-version",
        "dev-roadmap-priority",
        "dev-roadmap-dependencies",
        "dev-roadmap-notes",
    ):
        assert f'id="{field}"' in INDEX


def test_build_prompt_uses_definition_and_selected_workflow():
    # These stay German on purpose: they are the field labels WRITTEN INTO
    # ROADMAP.md and parsed back out of it, so they are a data format, not UI
    # copy. Translating them would silently orphan every existing entry.
    for label in (
        "Beschreibung",
        "Ziel / Problem",
        "Akzeptanzkriterien",
        "Priorität",
        "Abhängigkeiten",
        "Technische Notizen / Grenzen",
    ):
        assert label in ADMIN
    # The surrounding controls ARE ui and follow the English rule.
    assert 'option value="build">Build autonomously up to beta' in ADMIN
    assert 'option value="plan">Plan and ask first' in ADMIN
    assert "model, modelLabel, buildMode" in ADMIN
    assert "on beta you can check the model and workflow" in ADMIN
    assert "Start on Prod only" in ADMIN


def test_build_is_recorded_before_prompt_send_and_http_errors_are_not_ignored():
    # Ends at the batch variant, not at the form: _startBatchBuild is the same
    # sequence for N items and would otherwise be counted as a second copy of
    # every call this test pins.
    workflow = ADMIN[ADMIN.index("async function _startRoadmapBuild"):
                     ADMIN.index("async function _startBatchBuild")]
    attach = workflow.index("if (!attachRes.ok)")
    record = workflow.index("const recordRes = await fetch('/api/system/roadmap/builds'")
    send = workflow.index("await chatMod.handleChatSubmit")
    assert attach < record < send
    assert "if (!recordRes.ok)" in workflow
    assert "JSON.stringify(buildRecord)" in workflow
    assert workflow.count("await fetch('/api/system/roadmap/builds'") == 1


def test_build_marks_item_in_progress_before_creating_the_project_chat():
    # Ends at the batch variant, not at the form: _startBatchBuild is the same
    # sequence for N items and would otherwise be counted as a second copy of
    # every call this test pins.
    workflow = ADMIN[ADMIN.index("async function _startRoadmapBuild"):
                     ADMIN.index("async function _startBatchBuild")]
    mark_wip = workflow.index("await _setItemStatus(it, 'wip')")
    prepare_project = workflow.index("ensureDeveloperProject")
    create_session = workflow.index("fetch('/api/session'")
    assert mark_wip < prepare_project < create_session


def test_failed_build_setup_rolls_back_status_and_persisted_build_link():
    # Ends at the batch variant, not at the form: _startBatchBuild is the same
    # sequence for N items and would otherwise be counted as a second copy of
    # every call this test pins.
    workflow = ADMIN[ADMIN.index("async function _startRoadmapBuild"):
                     ADMIN.index("async function _startBatchBuild")]
    assert "await _setItemStatus(it, 'planned')" in workflow
    assert "method: 'DELETE'" in workflow
    assert "_roadmapBuilds.delete(itemKey)" in workflow
    assert '@router.delete("/roadmap/builds/{session_id}")' in SYSTEM_ROUTES


def test_planned_versions_are_editable_and_can_be_applied_in_bulk():
    assert "version: 'version'" in ADMIN
    assert "details.version = version" in ADMIN
    assert ".filter(section => !/RELEASED/i.test(section.title))" in ADMIN
    assert ".filter(item => item.status === 'planned')" in ADMIN
    assert 'id="dev-roadmap-bulk-version"' in INDEX
    assert 'id="dev-roadmap-bulk-version-apply"' in INDEX


def test_done_lives_behind_a_button_not_in_a_column():
    """Was: a Done column capped at ten cards.

    Finished work is history. As a column it grew without bound and pushed the
    live states off the screen, and the ten-item cap meant the board was lying
    about what existed. Behind a button there is room for a real history and
    the count stays honest.
    """
    assert "_RM_BOARD_COLS = _RM_COLS.filter(c => c.key !== 'done')" in ADMIN
    assert "for (const col of _RM_BOARD_COLS)" in ADMIN
    assert "_RM_DONE_LIMIT = 50" in ADMIN
    assert "function _openDoneView(sections)" in ADMIN
    assert "_doneModalEl.id = 'roadmap-done-modal'" in ADMIN
    assert 'id="dev-roadmap-done-btn"' in INDEX
    # Built fresh, never cloned — a clone duplicates every id on the page.
    done_view = ADMIN[ADMIN.index("function _ensureDoneModal"):ADMIN.index("function _renderRoadmapBoard")]
    assert "cloneNode" not in done_view
    # The count must not silently hide the remainder.
    assert "latest ${shown.length} of ${all.length}" in ADMIN


def test_done_view_can_send_an_item_back_to_planned():
    assert "'Move to planned'" in ADMIN
    assert "_setItemStatus(it, 'planned')" in ADMIN


def test_list_view_is_gone_and_leaves_no_dead_state():
    """One rendering of the roadmap, not two with separate write paths."""
    for leftover in ("_roadmapViewMode", "rm-view-opt", "data-rmview"):
        assert leftover not in ADMIN, f"list-view leftover in admin.js: {leftover}"
        assert leftover not in INDEX, f"list-view leftover in index.html: {leftover}"
    assert "localStorage.removeItem('ody-roadmap-view')" in ADMIN


def test_screenshots_survived_the_list_view_removal():
    """They only ever rendered in the list view.

    Without moving them, pasting a screenshot into a roadmap entry would still
    upload and still be stored — and show up nowhere.
    """
    assert "function _appendScreenshots(card, details)" in ADMIN
    assert ADMIN.count("_appendScreenshots(card, details)") >= 2, (
        "board cards and the Done view must both render screenshots"
    )


def test_roadmap_screenshot_parser_accepts_cache_busting_query_strings():
    """Uploaded-image URLs may carry cache-busting query parameters.

    The roadmap parser must keep the complete URL; otherwise the Markdown
    remains in the card title and no screenshot thumbnail is extracted.
    """
    markdown = (ROOT / "static" / "js" / "markdown.js").read_text()
    source = markdown.split("export const UPLOAD_IMAGE_MD_SOURCE = ", 1)[1].split(";", 1)[0]
    assert "(?:\\\\?[^\\\\s)]*)?" in source


def test_server_metrics_card_has_manual_and_five_second_refresh():
    assert 'id="dev-server-metrics"' in INDEX
    assert 'id="dev-server-refresh"' in INDEX
    assert "fetch(`/api/system/metrics${force ? '?refresh=1' : ''}`" in ADMIN
    assert "() => _loadServerMetrics(true)" in ADMIN
    assert "}, 5000);" in ADMIN


def test_build_form_does_not_repeat_dom_ids_per_card():
    assert 'id="rm-build-ep-logo"' not in ADMIN
    assert 'id="rm-build-model-logo"' not in ADMIN


def test_new_items_are_created_from_a_popup_not_an_inline_row():
    """Alessio: "das sollte ein Button sein, der ein Popup öffnet".

    The inline row sat above the board and its detail panel pushed the whole
    board down when opened. The markup MOVED into the modal rather than being
    rewritten, so every id the parser and these tests rely on is unchanged.
    """
    assert 'id="dev-roadmap-new-btn"' in INDEX
    assert 'id="roadmap-new-modal"' in INDEX
    modal_at = INDEX.index('id="roadmap-new-modal"')
    for field in ('id="dev-roadmap-new"', 'id="dev-roadmap-type"',
                  'id="dev-roadmap-new-details"', 'id="dev-roadmap-add"'):
        assert INDEX.index(field) > modal_at, f"{field} must live inside the modal"
    # Opens, closes, and closes itself once the entry is saved.
    assert "_closeNewItemModal" in ADMIN
    assert "newModal.style.display = 'flex'" in ADMIN


def test_new_items_start_under_consideration():
    """A fresh thought is not yet a commitment to build it."""
    assert 'id="dev-roadmap-column"' in INDEX
    assert '<option value="consideration" selected>' in INDEX
    assert "el('dev-roadmap-column')?.value || 'consideration'" in ADMIN
    # The marker comes from the column table, never hardcoded.
    assert "_roadmapItemBlock(colMark, title, details, pendingImgs)" in ADMIN
    assert "_roadmapItemBlock(' ', title" not in ADMIN


def test_inbox_section_accepts_both_spellings():
    """Existing files say "Eingang"; new ones are written in English."""
    assert "/^(Eingang|Inbox)/i" in ADMIN
    assert "ls.push('## Inbox', ...entryBlock)" in ADMIN
