"""Regression coverage for the Developer page's one-click chat setup."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_developer_panel_exposes_prepare_current_chat_action():
    html = _read("static/index.html")
    assert 'id="dev-prepare-btn"' in html
    assert "Prepare current chat" in html
    assert 'id="dev-chat-msg"' in html


def test_prepare_action_configures_project_and_client_tool_mode():
    admin = _read("static/js/admin.js")
    projects = _read("static/js/projects.js")
    app = _read("static/app.js")

    assert "m.prepareCurrentProjectChat(builder.id)" in admin
    assert "window.__odysseusPrepareDeveloperMode()" in admin
    assert "export async function prepareCurrentProjectChat(projectId)" in projects
    assert "`/api/projects/${proj.id}/sessions/${sid}`" in projects
    assert "await selectSession(sid, { keepSidebar: true, showLoading: false })" in projects
    assert "throw e;" in projects
    assert "window.__odysseusPrepareDeveloperMode = () =>" in app
    assert "saveToolPref('bash', 'agent', true)" in app
    assert "applyModeToToggles('agent')" in app


def test_fresh_developer_chat_also_enables_agent_shell_mode():
    admin = _read("static/js/admin.js")
    start_call = admin.index("await m.startProjectChat(builder.id)")
    prepare_call = admin.index("prepareMode()", start_call)
    assert prepare_call > start_call
