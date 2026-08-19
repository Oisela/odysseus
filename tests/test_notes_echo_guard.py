"""Regression: every manage_notes lookup dumped the whole note list into chat.

`_looks_like_notes_list_request` exists precisely to tell "show me my notes"
apart from a background lookup — and was never called anywhere. So when the
coach persona listed notes to orient itself, the formatted note list was
appended to the assistant's reply, once per tool call. Alessio saw his whole
note list (including unrelated roleplay character notes) three times ahead of
a single coaching answer on 2026-08-19.

The guard was also English-only, which would have answered "no" to every real
request he makes, since he writes German.
"""

from src.agent_loop import _looks_like_notes_list_request as asks_for_notes


def test_german_requests_to_see_notes():
    for t in [
        "zeig mir meine notizen",
        "welche notizen habe ich",
        "liste alle notizen auf",
        "was steht in meinen notizen",
        "nenne mir alle offene notizen",
    ]:
        assert asks_for_notes(t), t


def test_english_requests_still_work():
    for t in ["show me my notes", "what notes do I have", "list all notes"]:
        assert asks_for_notes(t), t


def test_background_lookups_do_not_count():
    """The actual bug: these must NOT trigger a note dump."""
    for t in [
        "wie stehe ich gerade da und was soll ich als naechstes machen",
        "setz mir die due dates fuer die uebungsblaetter",
        "erklaer mir den drehimpulsoperator",
        "was soll ich heute lernen",
    ]:
        assert not asks_for_notes(t), t


def test_creating_a_note_is_not_a_listing_request():
    for t in ["mach mir eine notiz fuer morgen", "schreib das in eine notiz"]:
        assert not asks_for_notes(t), t


def test_empty_input_is_safe():
    assert not asks_for_notes("")
    assert not asks_for_notes(None)
