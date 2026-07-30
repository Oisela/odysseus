"""Skill retrieval must fire on a topical question, not only on a literal name.

Alessio's complaint: "Keine skills richtig geladen oder nicht gefunden, erst bei
explizitem Erwähnen verstanden." That was arithmetic, not model behaviour.

Scoring used Jaccard — |Q ∩ S| / |Q ∪ S| — against a 0.3 threshold. A SKILL.md
contributes 200-400 tokens, a question 5-15, so even a perfect topical match
peaked around 0.04. Measured against the ten real skills on the server, the best
score across six realistic German questions was 0.103: retrieval was dead, and
skills only ever appeared through the two special paths (an exact tag token, or
the whole query verbatim inside the description).

Replacement: IDF-weighted asymmetric coverage — how much of the QUERY this skill
accounts for, weighted by how distinctive each term is.
"""

import sys
from unittest.mock import MagicMock

for _mod in ("sqlalchemy", "sqlalchemy.orm", "sqlalchemy.ext", "sqlalchemy.ext.declarative"):
    if _mod not in sys.modules:
        try:
            __import__(_mod)
        except ImportError:
            sys.modules[_mod] = MagicMock()

import pytest  # noqa: E402

from services.memory.skills import (  # noqa: E402
    SKILL_RELEVANCE_THRESHOLD,
    SkillsManager,
    _coverage,
    _query_term_weights,
    _idf_map,
    _tokenize,
)


LONG_DESC = (
    "Alles rund um RemNote in einem Skill. Nutzen wenn Alessio RemNote nennt, "
    "Karten/Flashcards will, Journal, oder /remnote tippt. Enthaelt "
    "Anzeige-Regeln, Karten-Regeln, Bridge-Bedienung, Portale, Loeschmodi und "
    "den Offline-Puffer. " + "Zusatzliche Erlaeuterung zum Verfahren. " * 40
)


def _skill(name, description, tags=None, **kw):
    return {
        "name": name, "description": description, "when_to_use": kw.get("when_to_use", ""),
        "tags": tags or [], "procedure": kw.get("procedure", []), "status": "published",
    }


def _mgr(tmp_path):
    return SkillsManager(str(tmp_path))


# ── the case Jaccard could never reach ────────────────────────────────────

def test_topical_question_finds_a_long_skill(tmp_path):
    skills = [
        _skill("remnote", LONG_DESC),
        _skill("shopping", "Einkaufsliste und Rezepte verwalten, Zutaten als Todos."),
    ]
    out = _mgr(tmp_path).get_relevant_skills("was steht in meinem RemNote zu Thermodynamik", skills=skills)
    assert [s["name"] for s in out][:1] == ["remnote"]


def test_long_skill_no_longer_dilutes_itself(tmp_path):
    """Same skill, padded to 4x the length, must not lose its match."""
    short = _skill("remnote", "RemNote Karten und Journal verwalten.")
    long_ = _skill("remnote", "RemNote Karten und Journal verwalten. " + "Fuelltext dazu. " * 200)
    q = "leg mir eine RemNote Karte an"
    mgr = _mgr(tmp_path)
    assert mgr.get_relevant_skills(q, skills=[short])
    assert mgr.get_relevant_skills(q, skills=[long_])


# ── it still has to say no ────────────────────────────────────────────────

@pytest.mark.parametrize("query", [
    "wie ist das Wetter morgen",
    "erzähl mir einen Witz",
    "was gibt es heute zu essen",
])
def test_unrelated_questions_return_nothing(tmp_path, query):
    skills = [_skill("remnote", LONG_DESC), _skill("odysseus", "Notizen, Todos, Kalender, Tasks.")]
    assert _mgr(tmp_path).get_relevant_skills(query, skills=skills) == []


def test_stopwords_alone_never_match(tmp_path):
    skills = [_skill("remnote", LONG_DESC)]
    assert _mgr(tmp_path).get_relevant_skills("und dann bitte das mit dem", skills=skills) == []


# ── the two mechanics that make German work ───────────────────────────────

def test_tokenizer_splits_on_separators():
    """"Karten/Flashcards" used to be ONE token, unmatchable by "Flashcard"."""
    tokens = _tokenize("Karten/Flashcards, Notizen-Todos (Kalender)")
    assert {"karten", "flashcards", "notizen", "todos", "kalender"} <= tokens
    assert "karten/flashcards" not in tokens


def test_german_inflection_is_matched_by_stem(tmp_path):
    """"Notiz" in the question vs "Notizen" in the description."""
    skills = [_skill("odysseus", "Notizen, Todos, Kalender und Erinnerungen verwalten.")]
    assert _mgr(tmp_path).get_relevant_skills("wie lege ich eine neue Notiz an", skills=skills)


def test_short_words_still_need_an_exact_match(tmp_path):
    """The stem rule must not let "git" match "github" — 3 chars is below it."""
    skills = [_skill("gh", "github pull requests und issues verwalten")]
    assert _mgr(tmp_path).get_relevant_skills("git rebase erklaeren", skills=skills) == []


# ── scoring properties, checked directly ──────────────────────────────────

def test_coverage_is_relative_to_the_query_not_the_union():
    q = _tokenize("remnote karte anlegen")
    small = _tokenize("remnote karte anlegen")
    big = _tokenize("remnote karte anlegen " + "fuelltext " * 300)
    idf = _idf_map([small, big])
    weights = _query_term_weights(q, idf)
    # Full coverage either way — the length of the skill is irrelevant.
    assert _coverage(weights, small) == pytest.approx(1.0)
    assert _coverage(weights, big) == pytest.approx(1.0)


def test_terms_absent_from_every_skill_are_ignored_entirely():
    """Subject matter must not outweigh the routing word.

    "Thermodynamik" appears in no skill, so it says nothing about which skill
    to pick — but as the rarest term IDF gave it the highest weight, and it
    alone pushed a correct match below the threshold.
    """
    vocab = [_tokenize("remnote karten journal"), _tokenize("shopping rezepte")]
    idf = _idf_map(vocab)
    weights = _query_term_weights(_tokenize("was steht in meinem remnote zu thermodynamik"), idf)
    assert "thermodynamik" not in weights
    assert "remnote" in weights
    assert _coverage(weights, vocab[0]) == pytest.approx(1.0)


def test_distinctive_terms_outweigh_shared_ones():
    """A word every skill uses must not count as much as a rare one."""
    a = _tokenize("odysseus deployment beta promotion")
    b = _tokenize("odysseus notizen kalender shopping")
    c = _tokenize("odysseus remnote karten journal")
    idf = _idf_map([a, b, c])
    assert idf["deployment"] > idf["odysseus"], "shared term must score lower"


def test_threshold_constant_is_the_single_knob(tmp_path):
    """One place to tune, and unchanged in value for this round."""
    assert SKILL_RELEVANCE_THRESHOLD == 0.3
    import inspect
    sig = inspect.signature(SkillsManager.get_relevant_skills)
    assert sig.parameters["threshold"].default == SKILL_RELEVANCE_THRESHOLD


# ── the two special paths must survive untouched ──────────────────────────

def test_tag_substring_still_does_not_boost(tmp_path):
    """Restated from test_skills_tag_token_match so a refactor can't drop it."""
    skills = [_skill("ml-helper", "machine learning helper", ["ai"])]
    assert _mgr(tmp_path).get_relevant_skills("send me an email about lunch tomorrow", skills=skills) == []


def test_tag_whole_token_still_boosts(tmp_path):
    skills = [_skill("git-helper", "version control stuff", ["git"])]
    out = _mgr(tmp_path).get_relevant_skills("help me with git rebase", skills=skills)
    assert any(s["name"] == "git-helper" for s in out)


def test_max_items_is_respected_and_order_is_by_score(tmp_path):
    skills = [
        _skill("remnote", "RemNote Karten Flashcards Journal Portale"),
        _skill("odysseus", "Notizen Todos Kalender RemNote gelegentlich"),
        _skill("shopping", "Einkauf Rezepte Zutaten"),
    ]
    out = _mgr(tmp_path).get_relevant_skills(
        "RemNote Karten anlegen", skills=skills, max_items=2,
    )
    assert len(out) <= 2
    assert out[0]["name"] == "remnote"
