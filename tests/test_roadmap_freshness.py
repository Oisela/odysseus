"""Roadmap freshness status must agree with its missing flag."""

from pathlib import Path

from routes import system_routes


def test_missing_version_section_sets_both_status_flags(monkeypatch, tmp_path: Path):
    roadmap = tmp_path / "ROADMAP.md"
    roadmap.write_text("# Roadmap\n\n## v4.3 (open package)\n", encoding="utf-8")
    monkeypatch.setattr(system_routes, "_ROADMAP", str(roadmap))

    result = system_routes._roadmap_freshness("4.8.0")

    assert result["expected_section"] == "v4.8"
    assert result["current"] is False
    assert result["missing"] is True


def test_matching_version_section_is_current(monkeypatch, tmp_path: Path):
    roadmap = tmp_path / "ROADMAP.md"
    roadmap.write_text("# Roadmap\n\n## v4.8 (open package)\n", encoding="utf-8")
    monkeypatch.setattr(system_routes, "_ROADMAP", str(roadmap))

    result = system_routes._roadmap_freshness("4.8.2")

    assert result["current"] is True
    assert result["missing"] is False
