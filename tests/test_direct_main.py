"""Guard the Developer page's direct-to-main bugfix shortcut."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")


def test_developer_page_marks_direct_bugfix_as_an_urgent_exception():
    assert 'id="developer-direct-main-card"' in INDEX
    assert 'id="dev-direct-main-summary"' in INDEX
    assert 'id="dev-direct-main-btn"' in INDEX
    assert "Urgent single bugfix" in INDEX
    assert "Normal bugs belong in the Build queue" in INDEX
    assert "Send urgent bugfix to dev" in INDEX


def test_direct_bugfix_reuses_the_builder_chat_and_stops_on_dev():
    start = ADMIN.index("function _initDirectMainButton()")
    workflow = ADMIN[start:ADMIN.index("function initDeveloper()", start)]
    assert "ensureDeveloperProject" in workflow
    assert "startProjectChat" in workflow
    assert "window.__odysseusPrepareDeveloperMode()" in workflow
    assert "chatMod.handleChatSubmit()" in workflow
    assert "dringenden Einzel-Bug" in workflow
    assert "dev.sh bugfix fix/<slug>" in workflow
    assert "STOPPE, sobald der Fix auf dev liegt" in workflow
    assert "dev.sh finish" in workflow
    assert "Kein eigener Prod-Rebuild" in workflow
    assert "/api/system/direct-main" not in workflow


def test_normal_roadmap_bugs_default_to_the_bundled_feature_track():
    track = ADMIN[ADMIN.index("function _rmTrackForKind"):
                  ADMIN.index("function _itemBrief")]
    assert "return 'feature'" in track

    batch = ADMIN[ADMIN.index("function _buildBatchPrompt"):
                  ADMIN.index("async function _startRoadmapBuild")]
    assert "auch für Bugs und Polish" in batch
    assert "dev.sh bugfix" in batch
    assert "Zwischenstand nach dev" in batch

    form = ADMIN[ADMIN.index("function _cardBuildFormHtml"):
                 ADMIN.index("function _cardEditFormHtml")]
    assert "Add to the next bundled beta" in form
    assert "Urgent single bugfix to dev" in form
