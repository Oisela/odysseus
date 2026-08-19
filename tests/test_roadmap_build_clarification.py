"""Roadmap builds must clarify incomplete cards before touching code."""
from pathlib import Path


ADMIN = (Path(__file__).resolve().parents[1] / "static/js/admin.js").read_text()


def test_single_build_prompt_requires_clear_acceptance_before_coding():
    block = ADMIN.split("function _buildPrompt", 1)[1].split("function _buildBatchPrompt", 1)[0]
    assert "Ziel, erwartetes Verhalten und Abnahmekriterium eindeutig" in block
    assert "Konkretisierungsfragen gebündelt, bevor du Dateien änderst" in block


def test_batch_prompt_checks_each_item_before_coding():
    block = ADMIN.split("function _buildBatchPrompt", 1)[1].split("async function _startRoadmapBuild", 1)[0]
    assert "Prüfe vor jedem Item" in block
    assert "Konkretisierungsfragen gebündelt" in block
