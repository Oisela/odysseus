"""Tests for the cached, single-round-trip /api/system/status probe.

Before v4.0 the endpoint fired six sequential `_ssh` calls — each paying a full
SSH handshake — and two of them were synchronous `git fetch origin` calls to
GitHub inside the request. Measured 2.0-2.9 s in prod logs while the Developer
page polls every 30 s. These tests pin the three properties that fixed it:
one round trip, no fetch in the request path, and a short shared cache.
"""

from types import SimpleNamespace

import pytest

from routes import system_routes


PROBE_OUTPUT = (
    "commit=cf14443\n"
    "beta_http=1\n"
    "beta_exposed=1\n"
    "beta_branch=beta-v4.0\n"
    "beta_commit=3edcd91ca\n"
    "beta_in_dev=1\n"
    "dev_version=4.0.0\n"
    "deploy_active=0\n"
    "deploy_stage=done\n"
)


@pytest.fixture(autouse=True)
def _reset_state():
    """Every test starts from a cold cache and a fetch that never ran."""
    system_routes._STATUS_CACHE.update(at=0.0, snapshot=None)
    system_routes._RELEASES_CACHE.update(at=0.0, releases=None)
    system_routes._FETCH_STATE.update(started_at=0.0, done_at=None, ok=False)
    yield
    system_routes._STATUS_CACHE.update(at=0.0, snapshot=None)
    system_routes._RELEASES_CACHE.update(at=0.0, releases=None)
    system_routes._FETCH_STATE.update(started_at=0.0, done_at=None, ok=False)


def _fake_probe(calls, output=PROBE_OUTPUT, returncode=0):
    def probe(script, *_args, **_kwargs):
        calls.append(script)
        return SimpleNamespace(returncode=returncode, stdout=output, stderr="")
    return probe


def test_kv_parser_keeps_strings_but_still_gates_key_names():
    parsed = system_routes._parse_kv_lines(
        "commit=cf14443\n"
        "beta_branch=beta-v4.0\n"
        "not a kv line\n"
        "bad-key=value\n"          # non-alnum key -> dropped
        "dev_version=4.0.0\n"
    )
    assert parsed == {
        "commit": "cf14443",
        "beta_branch": "beta-v4.0",
        "dev_version": "4.0.0",
    }


def test_metric_parser_stays_numeric_only():
    """The status probe must NOT reuse _parse_metric_lines.

    _parse_metric_lines dropping everything non-numeric is a privacy property of
    the metrics endpoint (test_developer_metrics pins `hostname=secret`). The
    status probe needs commits and branch names, hence its own parser — this
    test exists so nobody "simplifies" the two back into one.
    """
    assert system_routes._parse_metric_lines("commit=cf14443\nbeta_http=1\n") == {
        "beta_http": 1.0,
    }


def test_status_probe_is_one_round_trip_and_never_fetches(monkeypatch):
    calls = []
    monkeypatch.setattr(system_routes, "_ssh_script", _fake_probe(calls))

    snap = system_routes._host_status_snapshot()

    assert len(calls) == 1, "status must cost exactly one SSH round trip"
    # Bare "fetch", not "git fetch": the real command is `git -C <dir> fetch`,
    # so the narrower string would have passed while protecting nothing.
    assert "fetch" not in calls[0], (
        "a synchronous fetch in the request path was the 2-second floor"
    )
    assert snap == {
        "commit": "cf14443",
        "beta_active": True,
        "beta_branch": "beta-v4.0",
        "beta_commit": "3edcd91ca",
        "beta_in_dev": True,
        "beta_exposed": True,
        "deploy_active": False,
        "deploy_stage": "done",
        "dev_version": "4.0.0",
        "reachable": True,
    }


def test_a_beta_that_answers_the_host_can_still_be_unreachable(monkeypatch):
    """Container up, `tailscale serve --https=7001` off — the silent case.

    beta-stop.sh drops that serve and any abort inside downgrade-roundtrip.sh
    leaves it dropped. The host curl on 127.0.0.1:7001 stays green throughout,
    so before `beta_exposed` the UI reported a healthy beta while every browser
    got connection refused (2026-07-20, and unnoticed again on 2026-08-15).
    """
    calls = []
    monkeypatch.setattr(
        system_routes,
        "_ssh_script",
        _fake_probe(calls, output=PROBE_OUTPUT.replace("beta_exposed=1", "beta_exposed=0")),
    )

    snap = system_routes._host_status_snapshot()

    assert snap["beta_active"] is True
    assert snap["beta_exposed"] is False


def test_a_parked_beta_is_off_not_unexposed(monkeypatch):
    """No warning for a beta nobody started — only for one that lies."""
    calls = []
    monkeypatch.setattr(
        system_routes,
        "_ssh_script",
        _fake_probe(calls, output="commit=cf14443\nbeta_http=0\nbeta_exposed=0\n"),
    )

    snap = system_routes._host_status_snapshot()

    assert snap["beta_active"] is False
    assert snap["beta_exposed"] is False
    assert snap["beta_branch"] is None


def test_status_snapshot_reuses_cache_and_refresh_bypasses_it(monkeypatch):
    calls = []
    monkeypatch.setattr(system_routes, "_ssh_script", _fake_probe(calls))

    first = system_routes._host_status_snapshot()
    second = system_routes._host_status_snapshot()
    assert first is second
    assert len(calls) == 1

    system_routes._host_status_snapshot(force=True)
    assert len(calls) == 2


def test_dead_beta_hides_stale_checkout_details(monkeypatch):
    """A beta checkout on disk must not look like a running instance."""
    output = (
        "commit=cf14443\n"
        "beta_http=0\n"
        "beta_branch=beta-v4.0\n"
        "beta_commit=3edcd91ca\n"
        "beta_in_dev=1\n"
        "dev_version=4.0.0\n"
    )
    monkeypatch.setattr(system_routes, "_ssh_script", _fake_probe([], output))

    snap = system_routes._host_status_snapshot()

    assert snap["beta_active"] is False
    assert snap["beta_branch"] is None
    assert snap["beta_commit"] is None
    assert snap["beta_in_dev"] is False


def test_unreachable_host_degrades_instead_of_raising(monkeypatch):
    def boom(*_args, **_kwargs):
        raise OSError("host unreachable")

    monkeypatch.setattr(system_routes, "_ssh_script", boom)

    snap = system_routes._host_status_snapshot()

    assert snap["reachable"] is False
    assert snap["commit"] == "unknown"
    assert snap["beta_active"] is False
    assert snap["dev_version"] is None


def test_ssh_script_strips_carriage_returns(monkeypatch):
    """A CRLF checkout must not reach the remote bash.

    A multi-line script literal in a .py file is CRLF in a Windows working tree
    (`git ls-files --eol` -> i/lf w/crlf). The remote bash then reports
    `$'\\r': command not found` and every `sed` expression breaks.
    """
    seen = {}

    def fake_ssh(*args, **_kwargs):
        seen["args"] = args
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(system_routes, "_ssh", fake_ssh)
    system_routes._ssh_script("echo one\r\necho two\r\n")

    assert "\r" not in seen["args"][-1]


def test_status_script_asks_the_host_for_every_field_it_reports():
    script = system_routes._HOST_STATUS_SCRIPT
    for key in ("commit=", "beta_http=", "beta_branch=",
                "beta_commit=", "beta_in_dev=", "dev_version="):
        assert key in script
    # Paths come from the module constants, never hardcoded literals.
    assert system_routes._PROD_DIR in script
    assert system_routes._BETA_DIR in script
    assert system_routes._BETA_URL in script


def test_background_fetch_runs_once_per_interval_and_reports_age(monkeypatch):
    calls = []

    def fake_script(script, *_args, **_kwargs):
        calls.append(script)
        return SimpleNamespace(returncode=0, stdout="done", stderr="")

    monkeypatch.setattr(system_routes, "_ssh_script", fake_script)
    # Run the spawned worker inline so the test is deterministic.
    monkeypatch.setattr(
        system_routes.threading, "Thread",
        lambda target, **_kw: SimpleNamespace(start=target),
    )

    assert system_routes._fetch_age_seconds() is None

    system_routes._maybe_refresh_origin()
    assert len(calls) == 1
    assert "fetch -q origin" in calls[0]
    assert system_routes._PROD_DIR in calls[0]
    assert system_routes._BETA_DIR in calls[0]
    assert system_routes._fetch_age_seconds() == 0

    # Second call inside the interval must not fetch again.
    system_routes._maybe_refresh_origin()
    assert len(calls) == 1


def test_releases_tolerates_space_separated_and_short_lines(monkeypatch):
    ledger = (
        "v4.0.0\t3edcd91\t2026-07-30\n"
        "\n"
        "v3.10.0 cf14443 2026-07-29\n"   # spaces, not tabs
        "garbage\n"                       # single field -> skipped
        "v3.9.5\t3427f75\n"               # no date
    )
    monkeypatch.setattr(
        system_routes, "_ssh",
        lambda *_a, **_k: SimpleNamespace(returncode=0, stdout=ledger, stderr=""),
    )

    releases = system_routes._read_releases(force=True)

    assert [r["commit"] for r in releases] == ["3edcd91", "cf14443", "3427f75"]
    assert releases[1]["version"] == "v3.10.0"
    assert releases[2]["date"] == ""


def test_switch_never_serves_the_ledger_from_cache(monkeypatch):
    """The ledger is the security guard on /switch — always read it fresh."""
    calls = []
    monkeypatch.setattr(
        system_routes, "_ssh",
        lambda *_a, **_k: (calls.append(1),
                           SimpleNamespace(returncode=0, stdout="", stderr=""))[1],
    )

    system_routes._read_releases(force=True)
    system_routes._read_releases(force=True)

    assert len(calls) == 2
