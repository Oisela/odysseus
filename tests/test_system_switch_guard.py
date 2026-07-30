"""Preflight guards on POST /api/system/switch — the downgrade button.

The whole "debug live on main" workflow rests on this button: if a release
breaks, Alessio presses it and prod goes back one version. Before v4.0 the
endpoint checked only that the commit was in the release ledger and then fired a
detached systemd unit — every other failure (host unreachable, disk full, a
build already running, already on that version) surfaced as
`Switch failed (status 500)` or, worse, as a cheerful "switch started" followed
by nothing happening at all.

The switch detaches itself, so the HTTP response is the ONLY chance to tell the
user why nothing will happen. These tests pin each guard and its status code.
"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from routes import system_routes


LEDGER = (
    "v3.9.5\t3427f75\t2026-07-28\n"
    "v3.10.0\tcf14443\t2026-07-29\n"
    "v4.0.0\t3edcd91\t2026-07-30\n"
)

# Healthy host: on v4.0.0, 11 GB free, nothing building.
PREFLIGHT_OK = "head=3edcd91\ndisk_avail_kb=12164188\nbuild_active=0\n"


@pytest.fixture
def switch(monkeypatch):
    """POST /switch handler with auth stubbed out and caches cleared."""
    monkeypatch.setattr(system_routes, "require_admin", lambda r: None)
    system_routes._RELEASES_CACHE.update(at=0.0, releases=None)
    router = system_routes.setup_system_routes()
    route = next(r for r in router.routes if r.path == "/api/system/switch")
    return route.endpoint


def _wire(monkeypatch, preflight=PREFLIGHT_OK, ledger=LEDGER,
          preflight_rc=0, launched=None):
    """Stub the two SSH paths: _ssh_script (probe + launch), _ssh (ledger)."""
    def fake_script(script, *_a, **_k):
        if "systemd-run" in script:
            if launched is not None:
                launched.append(script)
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=preflight_rc, stdout=preflight, stderr="")

    monkeypatch.setattr(system_routes, "_ssh_script", fake_script)
    monkeypatch.setattr(
        system_routes, "_ssh",
        lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=ledger, stderr=""),
    )


def _body(commit):
    return SimpleNamespace(commit=commit)


def test_unreachable_host_returns_503_with_the_cli_way_out(switch, monkeypatch):
    def boom(*_a, **_k):
        raise OSError("no route to host")

    monkeypatch.setattr(system_routes, "_ssh_script", boom)

    with pytest.raises(HTTPException) as exc:
        switch(_body("cf14443"), request=None)

    assert exc.value.status_code == 503
    # The message must carry the escape hatch, not just name the failure.
    assert "switch-version.sh" in exc.value.detail
    assert "cf14443" in exc.value.detail
    assert "ssh root@odysseus-server" in exc.value.detail


def test_probe_failure_is_treated_as_unreachable(switch, monkeypatch):
    _wire(monkeypatch, preflight_rc=255)

    with pytest.raises(HTTPException) as exc:
        switch(_body("cf14443"), request=None)

    assert exc.value.status_code == 503


def test_empty_ledger_returns_503_not_a_confusing_400(switch, monkeypatch):
    _wire(monkeypatch, ledger="")

    with pytest.raises(HTTPException) as exc:
        switch(_body("cf14443"), request=None)

    assert exc.value.status_code == 503
    assert "ledger" in exc.value.detail.lower()


def test_commit_outside_the_ledger_is_refused(switch, monkeypatch):
    """The ledger is the security boundary: never check out an arbitrary tree."""
    _wire(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        switch(_body("deadbee"), request=None)

    assert exc.value.status_code == 400
    assert "not a released version" in exc.value.detail


def test_switching_to_the_running_version_returns_409(switch, monkeypatch):
    _wire(monkeypatch)  # head=3edcd91, which is v4.0.0

    with pytest.raises(HTTPException) as exc:
        switch(_body("3edcd91"), request=None)

    assert exc.value.status_code == 409
    assert "already runs" in exc.value.detail.lower()


def test_full_disk_returns_507_before_anything_is_launched(switch, monkeypatch):
    """switch-version.sh has the same guard, but only AFTER the UI said 'started'."""
    launched = []
    _wire(monkeypatch, preflight="head=3edcd91\ndisk_avail_kb=2097152\nbuild_active=0\n",
          launched=launched)

    with pytest.raises(HTTPException) as exc:
        switch(_body("cf14443"), request=None)

    assert exc.value.status_code == 507
    assert "prune" in exc.value.detail
    assert launched == [], "nothing may be launched once a guard trips"


def test_concurrent_build_returns_409(switch, monkeypatch):
    launched = []
    _wire(monkeypatch, preflight="head=3edcd91\ndisk_avail_kb=12164188\nbuild_active=1\n",
          launched=launched)

    with pytest.raises(HTTPException) as exc:
        switch(_body("cf14443"), request=None)

    assert exc.value.status_code == 409
    assert launched == []


def test_happy_path_launches_exactly_one_detached_switch(switch, monkeypatch):
    launched = []
    _wire(monkeypatch, launched=launched)

    result = switch(_body("cf14443"), request=None)

    assert result["status"] == "switch_started"
    assert result["version"] == "v3.10.0"
    assert result["commit"] == "cf14443"
    assert len(launched) == 1
    cmd = launched[0]
    assert "sudo systemd-run" in cmd
    assert "--collect" in cmd, "without --collect the unit lingers and blocks the next switch"
    assert system_routes._SWITCH in cmd
    assert cmd.rstrip().endswith("cf14443")


def test_switch_reads_the_ledger_uncached(switch, monkeypatch):
    """A cached ledger on the guard path is a stale security decision."""
    reads = []
    monkeypatch.setattr(
        system_routes, "_ssh",
        lambda *_a, **_k: (reads.append(1),
                           SimpleNamespace(returncode=0, stdout=LEDGER, stderr=""))[1],
    )
    monkeypatch.setattr(
        system_routes, "_ssh_script",
        lambda script, *_a, **_k: SimpleNamespace(
            returncode=0, stdout="" if "systemd-run" in script else PREFLIGHT_OK,
            stderr="",
        ),
    )

    switch(_body("cf14443"), request=None)
    switch(_body("cf14443"), request=None)

    assert len(reads) == 2, "the ledger must be re-read on every switch attempt"


def test_preflight_probe_asks_only_for_what_it_needs():
    script = system_routes._SWITCH_PREFLIGHT_SCRIPT
    for key in ("head=", "disk_avail_kb=", "build_active="):
        assert key in script
    assert system_routes._PROD_DIR in script
    # grep -c exits 1 on zero matches, which trips `set -e`-style guards and
    # appends a stray second line to the value. wc -l always exits 0.
    assert "wc -l" in script
    assert "grep -c" not in script


def test_switch_log_endpoint_parses_the_breadcrumb_file(monkeypatch):
    monkeypatch.setattr(system_routes, "require_admin", lambda r: None)
    monkeypatch.setattr(
        system_routes, "_ssh",
        lambda *_a, **_k: SimpleNamespace(
            returncode=0,
            stdout=(
                "2026-07-30T15:00:00+02:00\tstart\tcf14443\n"
                "2026-07-30T15:04:12+02:00\thealthy\tcf14443\n"
                "malformed line\n"
            ),
            stderr="",
        ),
    )
    router = system_routes.setup_system_routes()
    handler = next(
        r for r in router.routes if r.path == "/api/system/switch-log"
    ).endpoint

    entries = handler(request=None)["entries"]

    assert [e["event"] for e in entries] == ["start", "healthy"]
    assert entries[1]["commit"] == "cf14443"
