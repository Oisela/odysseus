"""Documents get collections, the same grouping Notes already has.

Alessio 2026-08-15: his notes live in lists ("Ritteressen", "Charaktere",
"Lernplan") while his documents were one flat pile, so a project's files were
impossible to find among everything else. Sorting existed and did not help —
A–Z over four unrelated projects is still four unrelated projects.

Deliberately `label`, the same column name and the same free-text shape Note
uses: no join table, a collection exists because a document names it. A second,
richer model for the same idea would be two things to learn and two to migrate.
"""

from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
DB = (ROOT / "core/database.py").read_text(encoding="utf-8")
ROUTES = (ROOT / "routes/document_routes.py").read_text(encoding="utf-8")
HELPERS = (ROOT / "routes/document_helpers.py").read_text(encoding="utf-8")
LIB = (ROOT / "static/js/documentLibrary.js").read_text(encoding="utf-8")
CSS = (ROOT / "static/style.css").read_text(encoding="utf-8")


def test_documents_use_the_same_shape_as_note_labels():
    doc_model = DB.split("class Document(TimestampMixin, Base):")[1].split("class ")[0]
    assert "label           = Column(String, nullable=True, index=True)" in doc_model
    note_model = DB.split("class Note(TimestampMixin, Base):")[1].split("class ")[0]
    assert "label" in note_model, "the concept being mirrored must still exist"


def test_the_column_is_migrated_and_the_migration_actually_runs():
    """A model field without a migration is a 500 on every existing install."""
    assert "def _migrate_add_document_label_column():" in DB
    fn = DB.split("def _migrate_add_document_label_column():")[1].split("\ndef ")[0]
    assert "PRAGMA table_info(documents)" in fn
    assert 'if "label" not in columns:' in fn, "must be idempotent"
    assert "ALTER TABLE documents ADD COLUMN label VARCHAR" in fn
    assert "CREATE INDEX IF NOT EXISTS ix_documents_label" in fn
    # Declared is not enough — it has to be called from init_db(), or it never
    # runs and the column exists only in the model.
    startup = DB.split("def init_db():")[1]
    assert "_migrate_add_document_label_column()" in startup


def test_serialisation_survives_a_row_read_before_the_migration():
    assert 'getattr(doc, "label", None) or ""' in HELPERS


def test_unfiled_has_a_sentinel_because_empty_means_no_filter():
    assert 'if label == "__none__":' in ROUTES
    branch = ROUTES.split('if label == "__none__":')[1].split("elif")[0]
    assert "Document.label.is_(None)" in branch
    assert 'Document.label == ""' in branch
    assert "'__none__'" in LIB


def test_one_representation_of_unfiled_is_stored():
    """`""` and NULL both meaning "unfiled" would break the facets and filter."""
    patch = ROUTES.split("if req.label is not None:")[1].split("if req.session_id")[0]
    assert "req.label.strip() or None" in patch


def test_facets_are_counted_over_everything_not_the_current_filter():
    """A sidebar that renumbers itself as you click through it cannot be used
    for navigating."""
    facet = ROUTES.split("label_q = (")[1].split("labels = [")[0]
    assert "Document.label.isnot(None)" in facet
    assert 'Document.label != ""' in facet
    assert "_owner_session_filter" in ROUTES.split("label_q = (")[1][:800]
    # Counted before the label filter is applied to the document query.
    assert ROUTES.index("label_q = (") < ROUTES.index('if label == "__none__":')


def test_the_library_sends_and_renders_collections():
    assert "params.set('label', _libraryActiveLabel)" in LIB
    assert "_libraryLabels = data.labels || []" in LIB
    assert "function libraryRenderCollectionChips()" in LIB
    assert 'id="doclib-collections"' in LIB
    # Above the language chips: collections are the primary axis.
    assert LIB.index('id="doclib-collections"') < LIB.index('id="doclib-chips"')


def test_clicking_the_active_collection_clears_the_filter():
    """Always a way back out without hunting for an 'all' chip."""
    render = LIB.split("function libraryRenderCollectionChips()")[1].split("\n  function ")[0]
    assert "_libraryActiveLabel === label ? null : label" in render
    # An empty control row teaches nothing.
    assert "if (!_libraryLabels.length)" in render


def test_filing_happens_in_bulk():
    """One at a time is the work nobody does."""
    assert "{ label: 'Move to collection…', icon: 'open', action: libraryBulkSetLabel }" in LIB
    fn = LIB.split("async function libraryBulkSetLabel()")[1].split("\n  async function ")[0]
    assert "if (answer === null) return;" in fn, "cancel must change nothing"
    assert "JSON.stringify({ label })" in fn
    assert "method: 'PATCH'" in fn
    # A new collection has to show up in the chips right away.
    assert "await libraryFetch(false)" in fn


def test_collection_styling_reuses_the_chip_component():
    assert ".doclib-collection-chips" in CSS
    block = CSS.split(".doclib-collection-chips {")[1].split("}")[0]
    assert "#" not in block, "no hardcoded colours"
    assert "var(--border)" in block
    # Same chip class as the language facets, not a parallel component.
    assert ".doclib-collection-chips .memory-cat-chip" in CSS


@pytest.mark.parametrize("field", ["label"])
def test_the_patch_endpoint_accepts_it(field):
    assert f"{field}: Optional[str] = None" in HELPERS
