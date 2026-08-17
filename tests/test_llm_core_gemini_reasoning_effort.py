"""Gemini 3 thinks at level "high" unless the request says otherwise. Odysseus
pins gemini-3-flash-preview to "low" via Google's OpenAI-compat shim, and must
not leak that parameter to other hosts, to Gemma, or over an explicit level the
caller already set."""
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from src.llm_core import _apply_gemini_reasoning_effort, _gemini_reasoning_effort

_GOOGLE = "https://generativelanguage.googleapis.com/v1beta/openai"


def test_flash_preview_gets_low():
    assert _gemini_reasoning_effort(_GOOGLE, "gemini-3-flash-preview") == "low"
    # Google's Models API prefixes ids with "models/".
    assert _gemini_reasoning_effort(_GOOGLE, "models/gemini-3-flash-preview") == "low"


def test_other_gemini_models_untouched():
    assert _gemini_reasoning_effort(_GOOGLE, "gemini-3.1-pro-preview") == ""
    assert _gemini_reasoning_effort(_GOOGLE, "gemini-2.5-flash") == ""


def test_non_gemini_model_on_google_endpoint_untouched():
    # Gemma has no thinking_level; sending one would be a 400 waiting to happen.
    assert _gemini_reasoning_effort(_GOOGLE, "gemma-4-31b-it") == ""


def test_other_hosts_untouched():
    assert _gemini_reasoning_effort("https://api.openai.com/v1", "gemini-3-flash-preview") == ""
    assert _gemini_reasoning_effort("https://openrouter.ai/api/v1", "gemini-3-flash-preview") == ""


def test_apply_sets_payload_field():
    payload = {"model": "gemini-3-flash-preview"}
    _apply_gemini_reasoning_effort(payload, _GOOGLE, "gemini-3-flash-preview")
    assert payload["reasoning_effort"] == "low"


def test_apply_does_not_override_explicit_level():
    payload = {"model": "gemini-3-flash-preview", "reasoning_effort": "none"}
    _apply_gemini_reasoning_effort(payload, _GOOGLE, "gemini-3-flash-preview")
    assert payload["reasoning_effort"] == "none"


def test_apply_is_noop_for_untargeted_models():
    payload = {"model": "gemini-3.1-pro-preview"}
    _apply_gemini_reasoning_effort(payload, _GOOGLE, "gemini-3.1-pro-preview")
    assert "reasoning_effort" not in payload
