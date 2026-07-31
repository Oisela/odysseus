"""Guard the Developer page's direct-to-main bugfix shortcut."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static" / "js" / "admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static" / "index.html").read_text(encoding="utf-8")


def test_developer_page_exposes_direct_bugfix_action():
    assert 'id="developer-direct-main-card"' in INDEX
    assert 'id="dev-direct-main-summary"' in INDEX
    assert 'id="dev-direct-main-btn"' in INDEX
    assert "Push bugfix to main" in INDEX


def test_direct_bugfix_reuses_the_builder_chat_and_bug_track():
    start = ADMIN.index("function _initDirectMainButton()")
    workflow = ADMIN[start:ADMIN.index("function initDeveloper()", start)]
    assert "ensureDeveloperProject" in workflow
    assert "startProjectChat" in workflow
    assert "window.__odysseusPrepareDeveloperMode()" in workflow
    assert "chatMod.handleChatSubmit()" in workflow
    assert "BUG-Track direkt auf main" in workflow
    assert "dev.sh bugfix fix/<slug>" in workflow
    assert "dev.sh finish" in workflow
    assert "Keine Beta" in workflow
    assert "/api/system/direct-main" not in workflow
