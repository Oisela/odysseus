"""Tests for the Developer storage breakdown endpoint."""

from types import SimpleNamespace

from routes import system_routes


STORAGE_OUTPUT = (
    "filesystem_total=22000000000\n"
    "filesystem_used=21000000000\n"
    "filesystem_available=1000000000\n"
    "docker_build_cache=7000000000\n"
    "docker_images=5300000000\n"
    "odysseus_data=1400000000\n"
)


def test_storage_parser_returns_bytes_and_derived_other_space():
    payload = system_routes._storage_payload(STORAGE_OUTPUT, "server")

    assert payload == {
        "available": True,
        "source": "server",
        "filesystem": {
            "total_bytes": 22_000_000_000,
            "used_bytes": 21_000_000_000,
            "available_bytes": 1_000_000_000,
        },
        "breakdown": {
            "docker_build_cache_bytes": 7_000_000_000,
            "docker_images_bytes": 5_300_000_000,
            "odysseus_data_bytes": 1_400_000_000,
            "other_bytes": 7_300_000_000,
        },
    }


def test_storage_parser_ignores_non_numeric_output():
    payload = system_routes._storage_payload(
        "filesystem_total=100\nhostname=secret\ndocker_images=oops\n", "server"
    )

    assert payload["filesystem"]["total_bytes"] == 100
    assert payload["breakdown"]["docker_images_bytes"] == 0


def test_storage_snapshot_uses_one_host_probe(monkeypatch):
    calls = []

    def fake_probe(script, *_args, **_kwargs):
        calls.append(script)
        return SimpleNamespace(returncode=0, stdout=STORAGE_OUTPUT, stderr="")

    monkeypatch.setattr(system_routes, "_ssh_script", fake_probe)

    payload = system_routes._server_storage_snapshot()

    assert payload["available"] is True
    assert payload["source"] == "server"
    assert len(calls) == 1
    assert system_routes._STORAGE_DATA_DIR in calls[0]
