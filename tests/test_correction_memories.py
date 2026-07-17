"""v3.5 correction memories: the extractor prompt accepts a 'correction'
category and looks_like_correction() fast-paths extraction when the user is
correcting the assistant (German and English phrasings)."""

from services.memory.memory_extractor import (
    EXTRACT_SYSTEM_PROMPT,
    looks_like_correction,
)


def test_prompt_knows_the_correction_category():
    assert "'correction'" in EXTRACT_SYSTEM_PROMPT
    assert "CORRECTIONS" in EXTRACT_SYSTEM_PROMPT


def test_german_corrections_detected():
    assert looks_like_correction("Nein das ist falsch, die Formel hat ein Minus")
    assert looks_like_correction("stimmt nicht, ich wohne in Zürich")
    assert looks_like_correction("Das habe ich nicht gesagt")
    assert looks_like_correction("doch nicht so — ich meinte eigentlich die zweite Variante")


def test_english_corrections_detected():
    assert looks_like_correction("No, that's wrong — the sign flips")
    assert looks_like_correction("that's not what I meant")
    assert looks_like_correction("Actually, no. Use the other endpoint.")
    assert looks_like_correction("This is incorrect")


def test_ordinary_messages_do_not_trigger():
    assert not looks_like_correction("Kannst du mir die Aufgabe 3 erklären?")
    assert not looks_like_correction("Please summarize this paper")
    assert not looks_like_correction("Was steht heute im Kalender?")
    assert not looks_like_correction("")
    assert not looks_like_correction(None)


def test_huge_messages_are_skipped():
    assert not looks_like_correction("falsch " * 500)
