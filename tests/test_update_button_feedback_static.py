from pathlib import Path

ADMIN = (Path(__file__).resolve().parents[1] / "static" / "js" / "admin.js").read_text(encoding="utf-8")


def test_update_button_names_target_and_disables_when_current():
    assert "Update to v${target}" in ADMIN
    assert "btn.disabled = !available" in ADMIN
    assert "'Up to date'" in ADMIN


def test_update_feedback_blocks_repeated_clicks_and_uses_server_state():
    assert "_setPromoteButtons(d);" in ADMIN
    assert "repeated clicks are blocked" in ADMIN
    assert "if (d?.deploy_active) continue" in ADMIN
