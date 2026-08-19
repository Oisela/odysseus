"""Regression: the extractor's duplicate guard never fired.

`_has_duplicate_title` compared `skill["title"]`, a key the skill schema
dropped long ago — skills carry `name` and `description`. Every lookup
therefore compared against "" and returned False, so every extraction was
written to disk. Alessio ended up with six near-identical RemNote skills,
which then crowded each other out of the top-3 relevance slots and pushed the
real entry-point skill out of the prompt.

Fixing the field name alone is not enough: the extractor rewords the same
procedure each time it meets it, so exact equality would still let the pile
grow. Near-duplicates have to count.
"""

from services.memory.skill_extractor import _has_duplicate_title

_EXISTING = [
    {"name": "remnote", "description": "ALLES rund um RemNote in einem Skill"},
    {"name": "remnote-edit-later", "description": "Edit-Later-Karten ueber RemNote pruefen"},
    {"name": "odysseus", "description": "Odysseus bedienen und verbessern"},
]


def test_exact_name_is_a_duplicate():
    assert _has_duplicate_title(_EXISTING, "remnote")


def test_exact_description_is_a_duplicate():
    assert _has_duplicate_title(_EXISTING, "ALLES rund um RemNote in einem Skill")


def test_slug_variant_is_a_duplicate():
    """'RemNote Edit Later' and 'remnote-edit-later' are the same skill."""
    assert _has_duplicate_title(_EXISTING, "RemNote Edit Later")


def test_reworded_title_is_a_duplicate():
    """The actual failure mode — same procedure, fresh sentence, new file."""
    assert _has_duplicate_title(_EXISTING, "Edit-Later Karten in RemNote pruefen")


def test_genuinely_new_skill_still_gets_through():
    """The guard must not over-block, or real skills are silently dropped."""
    for title in [
        "Kalendereintraege aus Mails erstellen",
        "Odysseus Roadmap pflegen",
        "Pomodoro-Block starten",
    ]:
        assert not _has_duplicate_title(_EXISTING, title), title


def test_empty_title_is_not_a_duplicate():
    assert not _has_duplicate_title(_EXISTING, "")
    assert not _has_duplicate_title(_EXISTING, "   ")


def test_empty_skill_list_is_safe():
    assert not _has_duplicate_title([], "anything")
    assert not _has_duplicate_title(None, "anything")
