"""Pin the structured Roadmap -> Builder workflow in the Developer page."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")


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


def test_build_form_does_not_repeat_dom_ids_per_card():
    assert 'id="rm-build-ep-logo"' not in ADMIN
    assert 'id="rm-build-model-logo"' not in ADMIN
