"""Focused tests for RemNote route ownership and bridge reuse."""

from types import SimpleNamespace
from pathlib import Path

import routes.remnote_routes as remnote


def test_non_journal_send_reuses_the_known_active_bridge(monkeypatch):
    calls = []

    def bridge_call(action, payload, active_url=None):
        calls.append((action, payload, active_url))
        if action == "find_or_create_path":
            return {"remId": "parent-1"}
        return {"remId": "card-1"}

    monkeypatch.setattr(remnote, "_bridge_call", bridge_call)
    row = SimpleNamespace(
        target="Physik/TIII",
        card_type="basic",
        front="Frage",
        back="Antwort",
    )

    result = remnote._send_one(row, "http://bridge.local")

    assert result == {"remId": "card-1"}
    assert [call[0] for call in calls] == [
        "find_or_create_path",
        "create_flashcard",
    ]
    assert all(call[2] == "http://bridge.local" for call in calls)


def test_single_send_probes_health_only_once(monkeypatch):
    health_calls = []
    bridge_calls = []

    def bridge_health():
        health_calls.append(True)
        return {"ok": True, "active_url": "http://bridge.local"}

    def bridge_call(action, payload, active_url=None):
        bridge_calls.append((action, active_url))
        return {"remId": "parent-1" if action == "find_or_create_path" else "card-1"}

    monkeypatch.setattr(remnote, "_bridge_health", bridge_health)
    monkeypatch.setattr(remnote, "_bridge_call", bridge_call)
    row = SimpleNamespace(
        target="Physik/TIII",
        card_type="basic",
        front="Frage",
        back="Antwort",
    )

    remnote._send_one(row)

    assert len(health_calls) == 1
    assert bridge_calls == [
        ("find_or_create_path", "http://bridge.local"),
        ("create_flashcard", "http://bridge.local"),
    ]


def test_all_remnote_handlers_use_route_level_authentication():
    source = Path(remnote.__file__).read_text(encoding="utf-8")
    assert "get_current_user(request)" not in source
    assert source.count("require_user(request)") == 8
    assert "if owner:" in source
    assert "RemnotePending.owner == owner" in source
