"""Pin the structured Roadmap -> Builder workflow in the Developer page."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
SYSTEM_ROUTES = (ROOT / "routes" / "system_routes.py").read_text(encoding="utf-8")


def test_roadmap_has_full_delivery_pipeline():
    assert "mark === '!' ? 'review'" in ADMIN
    assert "{ key: 'review', label: 'Testbereit', mark: '!' }" in ADMIN
    assert "nach erfolgreichem Gate 1 auf Beta [!]" in ADMIN
    assert "erst nach Alessios Beta-Freigabe/Gate 2 [x]" in ADMIN


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
    for label in (
        "Beschreibung",
        "Ziel / Problem",
        "Akzeptanzkriterien",
        "Priorität",
        "Abhängigkeiten",
        "Technische Notizen / Grenzen",
    ):
        assert label in ADMIN
    assert 'option value="build">Autonom bis Beta bauen' in ADMIN
    assert 'option value="plan">Erst Plan und Rückfragen' in ADMIN
    assert "model, modelLabel, buildMode" in ADMIN
    assert "Auf Beta kannst du Modell und Ablauf prüfen" in ADMIN
    assert "Start nur auf Prod" in ADMIN


def test_build_is_recorded_before_prompt_send_and_http_errors_are_not_ignored():
    workflow = ADMIN[ADMIN.index("async function _startRoadmapBuild"):
                     ADMIN.index("function _cardBuildFormHtml")]
    attach = workflow.index("if (!attachRes.ok)")
    record = workflow.index("const recordRes = await fetch('/api/system/roadmap/builds'")
    send = workflow.index("await chatMod.handleChatSubmit")
    assert attach < record < send
    assert "if (!recordRes.ok)" in workflow
    assert "JSON.stringify(buildRecord)" in workflow
    assert workflow.count("await fetch('/api/system/roadmap/builds'") == 1


def test_build_marks_item_in_progress_before_creating_the_project_chat():
    workflow = ADMIN[ADMIN.index("async function _startRoadmapBuild"):
                     ADMIN.index("function _cardBuildFormHtml")]
    mark_wip = workflow.index("await _setItemStatus(it, 'wip')")
    prepare_project = workflow.index("ensureDeveloperProject")
    create_session = workflow.index("fetch('/api/session'")
    assert mark_wip < prepare_project < create_session


def test_failed_build_setup_rolls_back_status_and_persisted_build_link():
    workflow = ADMIN[ADMIN.index("async function _startRoadmapBuild"):
                     ADMIN.index("function _cardBuildFormHtml")]
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


def test_done_column_is_limited_to_latest_ten_cards():
    assert "if (col.key === 'done')" in ADMIN
    assert "items = items.slice(-10).reverse()" in ADMIN
    assert "Letzte ${items.length} von ${totalItems}" in ADMIN


def test_server_metrics_card_has_manual_and_five_second_refresh():
    assert 'id="dev-server-metrics"' in INDEX
    assert 'id="dev-server-refresh"' in INDEX
    assert "fetch(`/api/system/metrics${force ? '?refresh=1' : ''}`" in ADMIN
    assert "() => _loadServerMetrics(true)" in ADMIN
    assert "}, 5000);" in ADMIN


def test_build_form_does_not_repeat_dom_ids_per_card():
    assert 'id="rm-build-ep-logo"' not in ADMIN
    assert 'id="rm-build-model-logo"' not in ADMIN
