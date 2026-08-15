"""Tests for the privacy-preserving Developer server metrics payload."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from routes import system_routes


def test_metric_parser_ignores_non_numeric_and_unstructured_output():
    parsed = system_routes._parse_metric_lines(
        "cpu_total=100\n"
        "cpu_idle=40\n"
        "hostname=secret\n"
        "process list\n"
        "mem_total_kb=2048\n"
    )

    assert parsed == {
        "cpu_total": 100.0,
        "cpu_idle": 40.0,
        "mem_total_kb": 2048.0,
    }


def test_metrics_payload_uses_cpu_delta_and_aggregate_values_only():
    source = "test-server"
    system_routes._METRICS_CPU_SAMPLES.pop(source, None)
    first = system_routes._metrics_payload(
        {
            "cpu_total": 100,
            "cpu_idle": 50,
            "cpu_cores": 4,
            "mem_total_kb": 1000,
            "mem_available_kb": 400,
            "disk_total_kb": 2000,
            "disk_used_kb": 500,
            "uptime_seconds": 3661,
            "load_1": 0.5,
        },
        source,
    )
    second = system_routes._metrics_payload(
        {
            "cpu_total": 200,
            "cpu_idle": 70,
            "cpu_cores": 4,
            "mem_total_kb": 1000,
            "mem_available_kb": 400,
            "disk_total_kb": 2000,
            "disk_used_kb": 500,
            "uptime_seconds": 3666,
            "load_1": 0.6,
        },
        source,
    )

    assert first["cpu"]["percent"] is None
    assert second["cpu"]["percent"] == 80.0
    assert second["memory"]["percent"] == 60.0
    assert second["disk"]["percent"] == 25.0
    assert second["uptime_seconds"] == 3666
    assert set(second) == {
        "available",
        "source",
        "sampled_at",
        "cpu",
        "memory",
        "disk",
        "uptime_seconds",
    }


def _metrics_handler():
    router = system_routes.setup_system_routes()
    return next(route.endpoint for route in router.routes if route.path == "/api/system/metrics")


def test_metrics_route_allows_authenticated_non_admin(monkeypatch):
    expected = {"available": True}
    monkeypatch.setattr(system_routes, "get_current_user", lambda _request: "member")
    monkeypatch.setattr(system_routes, "_server_metrics_snapshot", lambda force=False: expected)

    assert _metrics_handler()(request=object()) is expected


def test_metrics_route_rejects_anonymous_user(monkeypatch):
    monkeypatch.setattr(system_routes, "get_current_user", lambda _request: None)

    with pytest.raises(HTTPException) as exc:
        _metrics_handler()(request=object())

    assert exc.value.status_code == 401


def test_server_snapshot_reuses_short_cache(monkeypatch):
    calls = []
    output = (
        "cpu_total=100\ncpu_idle=50\ncpu_cores=4\n"
        "mem_total_kb=1000\nmem_available_kb=500\n"
        "disk_total_kb=2000\ndisk_used_kb=500\nuptime_seconds=60\n"
    )

    def fake_probe(*_args, **_kwargs):
        calls.append(1)
        return SimpleNamespace(returncode=0, stdout=output)

    monkeypatch.setattr(system_routes, "_ssh_script", fake_probe)
    system_routes._METRICS_CACHE.update(at=0.0, payload=None)
    first = system_routes._server_metrics_snapshot()
    second = system_routes._server_metrics_snapshot()

    assert first is second
    assert first["source"] == "server"
    assert len(calls) == 1

    system_routes._server_metrics_snapshot(force=True)
    assert len(calls) == 2
