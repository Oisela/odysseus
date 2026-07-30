"""Parity gaps that made ChatGPT and Gemini look less capable than they are.

Alessio's recurring complaints, each traced to a specific line:

  "kein Shell-Zugriff obwohl er Zugriff hatte"  -> _API_HOSTS
  "sagt er tut es, tut es aber nicht"          -> English-only intent nudge,
                                                  and that nudge losing its
                                                  position in the payload
  tools the model claims not to have           -> schemas sent, prose silent
"""

import re

import pytest

from src import agent_loop, llm_core


ROOT_INTENT = re.compile(r"_INTENT_RE = re\.compile\((.*?)\n        re\.IGNORECASE", re.S)


def _intent_re():
    src = (agent_loop.__file__ and open(agent_loop.__file__, encoding="utf-8").read())
    body = ROOT_INTENT.search(src).group(1).strip().rstrip(",")
    return re.compile(eval("(" + body + ")"), re.IGNORECASE)


# ── tools actually reaching the model ──────────────────────────────────────

def test_api_hosts_cover_chatgpt_and_gemini():
    """Missing here, _is_api_model falls back to a model-name keyword list.

    When that misses too — an endpoint whose DB supports_tools is NULL and a
    slug the keywords do not cover — all_tool_schemas comes out empty and the
    model is handed no tools at all. It then says, correctly, that it has no
    shell access.
    """
    assert "chatgpt.com" in agent_loop._API_HOSTS
    assert "generativelanguage.googleapis.com" in agent_loop._API_HOSTS


def test_gemini_shim_is_still_classified_as_openai_on_purpose():
    """Gemini talks to us through Google's OpenAI-compatible shim.

    Introducing a separate provider id would mean auditing every
    `if provider ==` branch in llm_core; the shim classification is
    behaviourally correct. Pinned so nobody "fixes" it by accident.
    """
    url = "https://generativelanguage.googleapis.com/v1beta/openai"
    assert llm_core._detect_provider(url) == "openai"


def test_gemini_supports_thinking():
    """"gemma" was in the pattern list and "gemini" was not — a near-miss that
    left the thinking panel empty for every Gemini model."""
    assert llm_core._supports_thinking("gemini-3-pro")
    assert llm_core._supports_thinking("gemini-2.5-flash")
    assert llm_core._supports_thinking("gemma-3-4b")  # unchanged


# ── the prompt must name every tool whose schema is sent ───────────────────

def test_every_tool_schema_has_a_prompt_entry():
    """The compact prompt lists names from TOOL_SECTIONS only.

    A tool with a schema but no entry is invisible to a model that trusts the
    prompt over the schema list — which GPT and Gemini do more than Claude.
    ls/grep/glob are in ALWAYS_AVAILABLE, so they shipped on every turn while
    the prompt never mentioned them.
    """
    from src import tool_schemas
    src = open(tool_schemas.__file__, encoding="utf-8").read()
    schema_names = set(re.findall(r'["\']name["\']\s*:\s*["\']([a-z_]+)["\']', src))
    missing = sorted(schema_names - set(agent_loop.TOOL_SECTIONS))
    assert not missing, f"schemas with no prompt entry: {missing}"


def test_always_available_tools_are_all_described():
    described = set(agent_loop.TOOL_SECTIONS)
    from src.tool_index import ALWAYS_AVAILABLE
    missing = sorted(set(ALWAYS_AVAILABLE) - described)
    assert not missing, f"always-available but undocumented: {missing}"


def test_compact_prompt_lists_the_selected_tools():
    prompt = agent_loop._assemble_prompt({"bash", "ls", "grep", "glob"}, compact=True)
    section = prompt.split("## Available tools")[1]
    for name in ("bash", "ls", "grep", "glob"):
        assert f"- `{name}`" in section


# ── the "said it, didn't do it" detector ──────────────────────────────────

@pytest.mark.parametrize("text", [
    "Ich schaue mir die Logs an.",
    "Ich prüfe kurz die Datei.",
    "Ich lese die Datei jetzt.",
    "Ich führe den Test aus.",
    "Lass mich das nachsehen.",
    "Ich werde das Skript starten.",
    "Wir müssen die Konfiguration prüfen.",
    "Ich sollte mir den Code ansehen.",
    "Let me tail the output.",
    "I'll check the logs.",
])
def test_intent_detector_fires_on_announced_actions(text):
    assert _intent_re().search("\n" + text), f"missed: {text}"


@pytest.mark.parametrize("text", [
    "Let me know what you think.",
    "Ich freue mich, dass es klappt.",
    "Das ist jetzt fertig.",
    "Ich habe die Datei gelesen.",      # perfect tense = a report, not intent
    "Ich habe alles angeschaut.",
    "Wir haben das getestet.",
    "Danke für die Rückmeldung.",
    "Das Ergebnis liegt vor.",
])
def test_intent_detector_ignores_reports_and_pleasantries(text):
    assert not _intent_re().search("\n" + text), f"false positive: {text}"


# ── where mid-conversation system messages land ───────────────────────────

def test_only_the_first_system_message_becomes_instructions():
    """Later system messages are corrections that must arrive LAST.

    Hoisting all of them into the global preamble put the "you announced an
    action and never ran it" nudge above the conversation it was correcting,
    where it reads as background policy rather than "do it now".
    """
    payload = llm_core._build_chatgpt_responses_payload(
        "gpt-5.6-terra",
        [
            {"role": "system", "content": "Du bist Bob."},
            {"role": "user", "content": "starte den test"},
            {"role": "assistant", "content": "Ich schaue mir das an."},
            {"role": "system", "content": "Du hast nichts ausgeführt. Tu es JETZT."},
        ],
        0.2, 0, stream=True, tools=None,
    )

    assert payload["instructions"] == "Du bist Bob."
    # The persona is not duplicated into the conversation…
    flat = str(payload["input"])
    assert "Du bist Bob" not in flat
    # …and the nudge is the final input item, marked as system-origin.
    last = payload["input"][-1]
    assert last["role"] == "user"
    assert "[system]" in last["content"][0]["text"]
    assert "JETZT" in last["content"][0]["text"]


def test_single_system_message_behaves_exactly_as_before():
    payload = llm_core._build_chatgpt_responses_payload(
        "gpt-5.6-sol",
        [{"role": "system", "content": "sei knapp"}, {"role": "user", "content": "hi"}],
        0.2, 0, stream=True, tools=None,
    )
    assert payload["instructions"] == "sei knapp"
    assert len(payload["input"]) == 1
    assert payload["input"][0]["role"] == "user"


def test_document_mode_subtraction_is_skipped_when_a_workspace_is_set():
    """Guards the developer workflow without needing a code change.

    With a document open, bash/grep/glob/ls are dropped from the selection —
    but only when there is no workspace, no upload and no files intent. The
    Builder project always sets a workspace, so the developer agent keeps its
    shell. Pinned because it looks like a bug until you read the condition.
    """
    src = open(agent_loop.__file__, encoding="utf-8").read()
    block = src[src.index("_doc_irrelevant_file_tools = {") - 400:
                src.index("_doc_irrelevant_file_tools = {")]
    assert "not workspace" in block
    assert "not uploaded_files" in block
    assert '"files" not in _intent_domains' in block
