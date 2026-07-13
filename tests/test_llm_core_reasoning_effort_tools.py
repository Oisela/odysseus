"""OpenAI's gpt-5.6-terra family rejects function tools on /chat/completions
unless reasoning_effort='none'. llm_core must recognize that specific 400 so
the stream path can learn the model and retry instead of surfacing a broken
fallback error to the user."""
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from src.llm_core import (
    _TOOLS_NEED_REASONING_EFFORT_NONE,
    _tools_rejected_without_reasoning_effort_none,
)

_TERRA_400 = (
    '{"error": {"message": "Function tools with reasoning_effort are not '
    "supported for gpt-5.6-terra in /v1/chat/completions. To use function "
    "tools, use /v1/responses or set reasoning_effort to 'none'.\", "
    '"type": "invalid_request_error"}}'
)


def test_terra_tools_400_detected():
    assert _tools_rejected_without_reasoning_effort_none(400, _TERRA_400)


def test_other_400s_not_matched():
    assert not _tools_rejected_without_reasoning_effort_none(
        400, '{"error": {"message": "Unsupported parameter: max_tokens"}}'
    )


def test_non_400_status_not_matched():
    # Same body on a 429/500 must not trigger the retry path.
    assert not _tools_rejected_without_reasoning_effort_none(429, _TERRA_400)
    assert not _tools_rejected_without_reasoning_effort_none(500, _TERRA_400)


def test_empty_body_not_matched():
    assert not _tools_rejected_without_reasoning_effort_none(400, "")


def test_learned_set_starts_empty():
    # No models are hardcoded — the set is populated at runtime from the 400.
    assert isinstance(_TOOLS_NEED_REASONING_EFFORT_NONE, set)
