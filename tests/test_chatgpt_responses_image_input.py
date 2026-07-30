"""Images must survive into the ChatGPT-subscription (Codex Responses) payload.

Alessio reported repeatedly that gpt-5.6-sol/terra "cannot read screenshots".
It was true, and it had two independent causes:

  1. `is_vision_model()` did not know `gpt-5`, so `chat_handler` swapped the
     image for a text caption before the request was ever built.
  2. Even with that fixed, `build_responses_input` dropped it: `_message_text`
     reads only `text`/`content` from each part, and an image part carries
     neither, so it flattened to "". The item type `input_image` did not appear
     anywhere in the codebase.

Both legs are pinned here — fixing one without the other changes nothing.
"""

import json

from src.chat_helpers import is_vision_model
from src.chatgpt_subscription import build_responses_input, _message_text


IMG = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}


def _parts(items, role):
    for item in items:
        if item.get("role") == role:
            return item.get("content") or []
    return []


def test_vision_detection_covers_the_chatgpt_subscription_slugs():
    for model in ("gpt-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5-codex"):
        assert is_vision_model(model), f"{model} must be treated as vision-capable"


def test_vision_detection_did_not_get_greedy():
    for model in ("text-embedding-3-large", "whisper-1", "tts-1"):
        assert not is_vision_model(model)


def test_user_image_becomes_an_input_image_item():
    items = build_responses_input([
        {"role": "user", "content": [{"type": "text", "text": "Was ist das?"}, IMG]},
    ])
    parts = _parts(items, "user")
    assert {"type": "input_image", "image_url": IMG["image_url"]["url"]} in parts
    assert {"type": "input_text", "text": "Was ist das?"} in parts


def test_image_only_message_is_not_dropped():
    """The old code produced an empty text and skipped the message entirely."""
    items = build_responses_input([{"role": "user", "content": [IMG]}])
    assert len(items) == 1
    assert items[0]["content"] == [
        {"type": "input_image", "image_url": IMG["image_url"]["url"]}
    ]


def test_assistant_turns_stay_text_only():
    """`output_image` is not an input item type — sending one is a 400."""
    items = build_responses_input([
        {"role": "assistant", "content": [{"type": "text", "text": "Da steht X."}, IMG]},
    ])
    parts = _parts(items, "assistant")
    assert parts == [{"type": "output_text", "text": "Da steht X."}]


def test_tool_results_stay_plain_strings():
    """function_call_output takes a string; a list here is a 400 from the API."""
    items = build_responses_input([
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "function": {"name": "bash", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call_1",
         "content": [{"type": "text", "text": "uid=1000"}]},
    ])
    out = next(i for i in items if i.get("type") == "function_call_output")
    assert isinstance(out["output"], str)
    assert out["output"] == "uid=1000"
    assert out["call_id"] == "call_1"


def test_message_text_helper_is_unchanged_for_plain_content():
    """Kept as the string-only path — tool output still routes through it."""
    assert _message_text("hallo") == "hallo"
    assert _message_text([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]) == "a\nb"
    assert _message_text(None) == ""


def test_multi_round_tool_use_still_round_trips():
    """The image work must not disturb the call_id pairing."""
    items = build_responses_input([
        {"role": "user", "content": [{"type": "text", "text": "wer bin ich"}, IMG]},
        {"role": "assistant", "content": "Ich schaue nach.", "tool_calls": [
            {"id": "call_9", "function": {"name": "bash", "arguments": '{"cmd":"whoami"}'}}]},
        {"role": "tool", "tool_call_id": "call_9", "content": "odysseus"},
        {"role": "user", "content": "danke"},
    ])
    kinds = [i.get("type") or f"msg:{i.get('role')}" for i in items]
    assert kinds == [
        "msg:user", "msg:assistant", "function_call", "function_call_output", "msg:user",
    ]
    call = next(i for i in items if i.get("type") == "function_call")
    out = next(i for i in items if i.get("type") == "function_call_output")
    assert call["call_id"] == out["call_id"] == "call_9"
    assert json.loads(call["arguments"])["cmd"] == "whoami"
