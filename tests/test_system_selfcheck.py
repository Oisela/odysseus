"""The System check: is everything up to date and where it should be?

Alessio 2026-08-15. The findings that made it necessary were all live on the
day it was written: dev.sh differing between the skill folder and /home/deploy,
a merged `origin/feature/projekte` still on the remote, and 7.2 GB of docker
build cache nobody collects.

The security property is the fix whitelist. A self-check that can run an
arbitrary command is a remote shell with a friendly name.
"""

from pathlib import Path
from types import SimpleNamespace

import pytest

from routes import system_routes


ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static/index.html").read_text(encoding="utf-8")

PROBE = (
    "drift_differs=dev.sh\n"
    "clone_branch=feat/x\n"
    "clone_dirty=0\n"
    "merged_branch=feature/projekte\n"
    "disk_avail_kb=16269040\n"
    "build_cache=7.238GB\n"
    f"released_version={system_routes.APP_VERSION}\n"
)

SNAPSHOT = {
    "commit": "abc1234",
    "beta_active": True,
    "beta_branch": "feat/x",
    "beta_commit": "def5678",
    "beta_in_dev": True,
    "beta_exposed": True,
    "dev_version": system_routes.APP_VERSION,
    "reachable": True,
}


@pytest.fixture
def probed(monkeypatch):
    """Run the checks against a fixed probe and snapshot."""
    def run(probe=PROBE, snapshot=None, cycle=None):
        snap = dict(SNAPSHOT)
        snap.update(snapshot or {})
        monkeypatch.setattr(system_routes, "_host_status_snapshot", lambda force=False: snap)
        monkeypatch.setattr(
            system_routes, "_ssh_script",
            lambda *a, **k: SimpleNamespace(returncode=0, stdout=probe, stderr=""),
        )
        monkeypatch.setattr(system_routes, "_cycle_state", lambda: cycle or {})
        monkeypatch.setattr(
            system_routes, "_roadmap_freshness", lambda v: {"current": True, "expected_section": "v4.6"}
        )
        return {f["id"]: f for f in system_routes._selfcheck_findings()}
    return run


def test_repeated_probe_keys_are_all_kept():
    """Drift and stale branches are lists.

    _parse_kv_lines keeps one value per key, which is right for the status
    probe and wrong here — it would report one drifted file while five moved.
    """
    text = "drift_differs=a.sh\ndrift_differs=b.sh\nclone_dirty=0\n"
    assert system_routes._collect_repeated(text, "drift_differs") == ["a.sh", "b.sh"]
    assert system_routes._collect_repeated(text, "nothing") == []


@pytest.mark.parametrize("raw,gb", [
    ("2.855GB", 2.855),
    ("7.238GB", 7.238),
    ("512MB", 0.5),
    ("", None),
    ("lots", None),
])
def test_docker_sizes_are_parsed_not_trusted(raw, gb):
    got = system_routes._parse_size_gb(raw)
    if gb is None:
        assert got is None
    else:
        assert got == pytest.approx(gb, rel=1e-3)


def test_script_drift_is_reported_with_a_fix(probed):
    found = probed()
    drift = found["script-drift"]
    assert drift["state"] == "fail"
    assert "dev.sh" in drift["detail"]
    assert drift["fix"] == "script-sync"


def test_a_missing_script_is_reported_but_not_auto_fixed(probed):
    """Copying over a gap is a guess about which side is right."""
    found = probed(probe="drift_missing=promote.sh\nclone_dirty=0\n")
    assert found["script-drift"]["state"] == "fail"
    assert found["script-drift"]["fix"] is None


def test_a_live_but_unshared_beta_is_a_failure_with_a_fix(probed):
    found = probed(snapshot={"beta_exposed": False})
    beta = found["beta-exposed"]
    assert beta["state"] == "fail"
    assert beta["fix"] == "beta-expose"
    assert "tailscale serve" in beta["detail"]


def test_a_parked_beta_is_fine(probed):
    found = probed(snapshot={"beta_active": False, "beta_exposed": False})
    assert found["beta-exposed"]["state"] == "ok"
    assert "beta-in-dev" not in found, "a parked beta cannot be on the wrong commit"


def test_uncollected_build_cache_warns_while_space_is_still_fine(probed):
    """7 GB of cache with 15 GB free is not urgent, but it is not nothing."""
    disk = probed()["disk"]
    assert disk["state"] == "warn"
    assert disk["fix"] == "disk-prune"
    assert "7.2 GB" in disk["detail"]


def test_low_disk_outranks_the_cache_warning(probed):
    disk = probed(probe=PROBE.replace("disk_avail_kb=16269040", "disk_avail_kb=2000000"))["disk"]
    assert disk["state"] == "fail"
    assert "needs 5 GB" in disk["detail"]


def test_an_abandoned_round_is_flagged_but_a_live_one_is_not(probed):
    stale = probed(cycle={
        "branch": "feat/old", "phase": "awaiting-go", "since": "2020-01-01T00:00:00+00:00",
    })["cycle-stale"]
    assert stale["state"] == "warn"
    assert stale["fix"] == "cycle-reset"

    from datetime import datetime, timezone
    fresh = probed(cycle={
        "branch": "feat/new", "phase": "awaiting-go",
        "since": datetime.now(timezone.utc).isoformat(),
    })["cycle-stale"]
    assert fresh["state"] == "ok"
    assert fresh["fix"] is None


def test_an_unreachable_host_says_so_instead_of_reporting_green(monkeypatch):
    monkeypatch.setattr(
        system_routes, "_host_status_snapshot",
        lambda force=False: dict(SNAPSHOT, reachable=False),
    )
    findings = system_routes._selfcheck_findings()
    assert [f["id"] for f in findings] == ["host"]
    assert findings[0]["state"] == "fail"


def test_findings_are_ranked_worst_first(probed):
    probed()  # installs the monkeypatched probe
    states = [f["state"] for f in system_routes._selfcheck_findings()]
    assert states == sorted(states, key=lambda s: {"fail": 0, "warn": 1, "ok": 2}[s])
    assert "fail" in states and "ok" in states, "fixture should produce a mix"


def test_only_whitelisted_fixes_exist():
    """The whitelist is the boundary; keep it small and readable."""
    assert set(system_routes._SELFCHECK_FIXES) == {
        "beta-expose", "script-sync", "disk-prune",
    }
    # cycle-reset is deliberately NOT here: it is a local file move, no host
    # command at all, and is handled separately in the route.
    routes_src = (ROOT / "routes/system_routes.py").read_text(encoding="utf-8")
    assert 'if fix_id == "cycle-reset"' in routes_src
    assert 'raise HTTPException(400, f"Unknown fix' in routes_src
    # Never the sledgehammer: that would drop the images prod and beta were
    # built from and make the downgrade button slow. (Checked against the
    # commands themselves — the comment above them names it on purpose.)
    for cmd in system_routes._SELFCHECK_FIXES.values():
        assert "system prune" not in cmd


def test_fix_id_field_cannot_carry_shell_metacharacters():
    from routes.system_routes import SelfcheckFixBody
    assert SelfcheckFixBody(fix="disk-prune").fix == "disk-prune"
    for bad in ("disk prune", "a;rm -rf /", "$(id)", "Disk-Prune", ""):
        with pytest.raises(Exception):
            SelfcheckFixBody(fix=bad)


def test_the_card_offers_per_finding_repair_not_fix_everything():
    assert 'id="settings-dev-selfcheck-card"' in INDEX
    assert 'id="dev-selfcheck-run"' in INDEX
    assert 'id="dev-selfcheck-list"' in INDEX
    assert "each finding that can be repaired offers its own button" in INDEX
    # No blanket action anywhere.
    assert "Fix all" not in INDEX and "Fix all" not in ADMIN
    render = ADMIN[ADMIN.index("function _renderSelfcheck"):ADMIN.index("async function _loadSelfcheck")]
    assert "if (f.fix)" in render, "buttons only on findings that name a fix"


def test_a_fix_rechecks_with_a_forced_refresh():
    """The cached snapshot predates the fix and would still show the problem."""
    fix = ADMIN[ADMIN.index("async function _runSelfcheckFix"):ADMIN.index("function _initSelfcheck")]
    assert "_loadSelfcheck(true)" in fix
    routes_src = (ROOT / "routes/system_routes.py").read_text(encoding="utf-8")
    assert "_STATUS_CACHE.update(at=0.0, snapshot=None)" in routes_src


def test_the_probe_does_not_run_on_page_load():
    """25 s of SSH budget is not what opening the Developer page is for."""
    init = ADMIN[ADMIN.index("function _initSelfcheck"):ADMIN.index("function _initBetaButtons")]
    assert "_loadSelfcheck" in init
    assert "addEventListener('click'" in init
    for entry in ("_initSelfcheck();\n  _initBuilderLink();", "_initSelfcheck();\n  _initVersionSwitcher"):
        assert entry in ADMIN
