"""The synchronous llm_call() must handle the ChatGPT subscription provider.

It never did. The generic branch built a chat-completions body and POSTed it to
`<base>/codex/chat/completions`, which does not exist — a 404 on every call.
Silent in practice, because all three callers degrade quietly:

  * src/document_processor.py — the vision-model fallback caption
  * routes/session_routes.py  — session auto-titles
  * src/chat_processor.py     — the web-search query builder

llm_call_async had the branch since the Codex work; the sync twin was missed.
Codex also rejects non-streaming requests, so "return a string" means "stream
and join" here too.
"""

from types import SimpleNamespace

import pytest

from src import llm_core


CODEX_URL = "https://chatgpt.com/backend-api/codex"


def _sse(*events):
    return [f"data: {e}" for e in events]


class _FakeStream:
    def __init__(self, lines, status=200):
        self._lines = lines
        self.status_code = status
        self.is_success = status < 400

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def iter_lines(self):
        return iter(self._lines)

    def read(self):
        return b'{"error":{"message":"nope"}}'


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch):
    """The response cache would mask a second call in these tests."""
    monkeypatch.setattr(llm_core, "_get_cached_response", lambda _k: None)
    monkeypatch.setattr(llm_core, "_set_cached_response", lambda _k, _v: None)
    monkeypatch.setattr(llm_core, "note_model_activity", lambda *_a, **_k: None)


def test_provider_is_detected_for_the_codex_host():
    assert llm_core._detect_provider(CODEX_URL) == "chatgpt-subscription"


def test_llm_call_streams_and_joins_deltas(monkeypatch):
    captured = {}

    def fake_stream(method, url, **kwargs):
        captured["method"] = method
        captured["url"] = url
        captured["payload"] = kwargs.get("json")
        return _FakeStream(_sse(
            '{"type":"response.output_text.delta","delta":"Hallo "}',
            '{"type":"response.output_text.delta","delta":"Alessio"}',
            '{"type":"response.completed"}',
        ))

    monkeypatch.setattr(llm_core.httpx, "stream", fake_stream)

    out = llm_core.llm_call(CODEX_URL, "gpt-5.6-terra", [{"role": "user", "content": "hi"}])

    assert out == "Hallo Alessio"
    assert captured["method"] == "POST"
    # Never the chat-completions path — that 404s.
    assert "chat/completions" not in captured["url"]
    # Codex rejects non-streaming requests even for string callers.
    assert captured["payload"]["stream"] is True
    # Responses shape, not chat-completions shape.
    assert "input" in captured["payload"]
    assert "messages" not in captured["payload"]


def test_system_messages_become_instructions(monkeypatch):
    captured = {}

    def fake_stream(_method, _url, **kwargs):
        captured["payload"] = kwargs.get("json")
        return _FakeStream(_sse('{"type":"response.output_text.delta","delta":"ok"}'))

    monkeypatch.setattr(llm_core.httpx, "stream", fake_stream)

    llm_core.llm_call(CODEX_URL, "gpt-5.6-sol", [
        {"role": "system", "content": "du bist bob"},
        {"role": "user", "content": "hi"},
    ])

    payload = captured["payload"]
    assert "du bist bob" in (payload.get("instructions") or "")
    assert all(item.get("role") != "system" for item in payload["input"])


def test_upstream_error_is_reported_not_swallowed(monkeypatch):
    monkeypatch.setattr(
        llm_core.httpx, "stream",
        lambda *_a, **_k: _FakeStream([], status=401),
    )

    with pytest.raises(llm_core.HTTPException) as exc:
        llm_core.llm_call(CODEX_URL, "gpt-5.6-terra", [{"role": "user", "content": "hi"}])

    assert exc.value.status_code == 502
    # The friendly reconnect hint, not a raw JSON blob.
    assert "Reconnect" in exc.value.detail or "credentials" in exc.value.detail


def test_malformed_sse_lines_are_skipped(monkeypatch):
    monkeypatch.setattr(
        llm_core.httpx, "stream",
        lambda *_a, **_k: _FakeStream([
            "event: response.output_text.delta",
            "data: not json at all",
            "",
            'data: {"type":"response.output_text.delta","delta":"gut"}',
            "data: [DONE]",
        ]),
    )

    assert llm_core.llm_call(CODEX_URL, "gpt-5.6-sol", [{"role": "user", "content": "x"}]) == "gut"


def test_other_providers_keep_the_chat_completions_path(monkeypatch):
    """Guard against the new branch swallowing everything else."""
    captured = {}

    def fake_post(url, headers=None, **kwargs):
        captured["url"] = url
        captured["payload"] = kwargs.get("json")
        return SimpleNamespace(
            is_success=True,
            status_code=200,
            json=lambda: {"choices": [{"message": {"content": "pong"}}]},
        )

    monkeypatch.setattr(llm_core, "httpx_post_kimi_aware", fake_post)

    out = llm_core.llm_call(
        "https://api.openai.com/v1", "gpt-4o", [{"role": "user", "content": "ping"}]
    )

    assert out == "pong"
    assert "chat/completions" in captured["url"]
    assert "messages" in captured["payload"]
