"""Pin the message-level Get better developer workflow."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHAT = (ROOT / "static" / "js" / "chat.js").read_text(encoding="utf-8")
RENDERER = (ROOT / "static" / "js" / "chatRenderer.js").read_text(encoding="utf-8")


def _slice(source: str, start: str, end: str) -> str:
    return source[source.index(start):source.index(end, source.index(start))]


def test_get_better_is_a_prominent_message_action():
    assert "{ id: 'get-better'" in RENDERER
    assert "title: 'Get better'" in RENDERER
    assert "window.chatModule?.getBetterFrom" in RENDERER
    assert "const defaults = ['copy', 'get-better', 'delete', 'fork'];" in RENDERER
    assert "const order = ['get-better', ...baseOrder.filter" in RENDERER


def test_get_better_forks_by_stable_message_id_and_never_opens_the_fork():
    workflow = _slice(
        CHAT,
        "export async function getBetterFrom",
        "/**\n   * Check for pending/completed research",
    )
    assert "ensureDeveloperProject()" in workflow
    assert "_forkAtMessage(sessionId, aiMsgElement)" in workflow
    assert "/api/projects/${builder.id}/sessions/${data.id}" in workflow
    assert "Get better: ${source?.name" in workflow
    assert "_runBackgroundAgentTurn(data.id, GET_BETTER_PROMPT)" in workflow
    assert "selectSession(" not in workflow
    assert "version.channel === 'beta'" in workflow
    assert "Beta cannot access or deploy the developer clone" in workflow

    fork_helper = _slice(CHAT, "async function _forkAtMessage", "export async function forkFrom")
    assert "through_message_id" in fork_helper
    assert "aiMsgElement.dataset.dbId" in CHAT


def test_background_turn_forces_agent_shell_and_tracks_completion():
    runner = _slice(
        CHAT,
        "async function _runBackgroundAgentTurn",
        "export async function getBetterFrom",
    )
    assert "fd.append('mode', 'agent')" in runner
    assert "fd.append('allow_bash', 'true')" in runner
    assert "fd.append('use_rag', 'false')" in runner
    assert "/api/chat_stream" in runner
    assert "sessionModule.markStreaming(sessionId)" in runner
    assert "sessionModule.markStreamComplete(sessionId)" in runner
    assert "sessionModule.clearStreaming(sessionId)" in runner


def test_improvement_prompt_requires_evidence_durable_fixes_and_review():
    prompt = _slice(CHAT, "const GET_BETTER_PROMPT", "async function _runBackgroundAgentTurn")
    for required in (
        "complete forked conversation",
        "pinned odysseus-entwickler skill",
        "hallucinated, unverified",
        "unnecessary tool calls",
        "autonomously implement",
        "regression tests",
        "bug/duplication/clean-code review",
        "developer Beta workflow",
    ):
        assert required in prompt
