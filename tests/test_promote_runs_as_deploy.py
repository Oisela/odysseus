"""The Update button must run promote.sh as `deploy`, and say that it is running.

Two findings from one press on 2026-08-15.

1. The route started promote.sh through systemd-run WITHOUT `--uid=deploy`, so
   it ran as root and every git command inside re-owned part of /opt/odysseus.
   That is where the 2663 root-owned files came from: `.git` had belonged to
   root since 2026-08-03, the date of the last release run through this button,
   and prod was quietly un-promotable from the CLI for six weeks. Repairing the
   ownership then exposed the cause — root now trips git's dubious-ownership
   guard, the unit exited 128, `--collect` swept it away, and the browser had
   already been told 200 OK. beta-start passed the flag all along.

2. A promotion detaches itself, so a reload throws away the "Update started"
   message the browser was holding. Alessio pressed Update, reloaded, and had
   no way to tell whether it was still running or had died. The host knows.
"""

from pathlib import Path

import pytest

from routes import system_routes


ROOT = Path(__file__).resolve().parents[1]
ROUTES = (ROOT / "routes/system_routes.py").read_text(encoding="utf-8")
ADMIN = (ROOT / "static/js/admin.js").read_text(encoding="utf-8")
INDEX = (ROOT / "static/index.html").read_text(encoding="utf-8")


def test_promote_runs_as_deploy_not_root():
    promote = ROUTES[ROUTES.index("def promote_beta(request: Request):"):]
    launch = promote[promote.index("unit = \"odysseus-promote-ui"):]
    assert "--uid=deploy" in launch.split("_ssh_script")[0], (
        "without it promote.sh runs as root and re-owns the prod checkout"
    )


def test_every_deployment_launch_uses_the_deploy_user():
    """One route missing the flag is what caused six weeks of silent breakage.

    The single deliberate exception is `tailscale serve`: it is a host-level
    daemon action that the deploy user cannot perform (its sudoers grants only
    systemd-run, rsync, tar and chown), and it touches no git checkout.
    """
    launches = {
        "promote": ROUTES[ROUTES.index('unit = "odysseus-promote-ui'):][:400],
        "beta-start": ROUTES[ROUTES.index('unit = "odysseus-beta-start-'):][:400],
    }
    for name, block in launches.items():
        assert "--uid=deploy" in block, f"{name} would run as root"

    expose = system_routes._SELFCHECK_FIXES["beta-expose"]
    assert "tailscale serve" in expose and "--uid=deploy" not in expose, (
        "the one root action is the tailscale one, and it must stay named"
    )
    for name, cmd in system_routes._SELFCHECK_FIXES.items():
        if name == "beta-expose":
            continue
        assert "systemd-run" not in cmd, (
            f"{name} launches a unit — it needs the same --uid=deploy scrutiny"
        )


def test_a_running_deployment_is_visible_after_a_reload(monkeypatch):
    """Server state, not a variable the reload discarded."""
    assert "deploy_active" in system_routes._HOST_STATUS_SCRIPT
    from types import SimpleNamespace
    monkeypatch.setattr(
        system_routes, "_ssh_script",
        lambda *a, **k: SimpleNamespace(
            returncode=0,
            stdout="commit=abc\nbeta_http=0\nbeta_exposed=0\ndev_version=4.9.0\ndeploy_active=1\n",
            stderr="",
        ),
    )
    system_routes._STATUS_CACHE.update(at=0.0, snapshot=None)
    snap = system_routes._host_status_snapshot(force=True)
    assert snap["deploy_active"] is True
    system_routes._STATUS_CACHE.update(at=0.0, snapshot=None)


def test_no_deployment_reads_as_false(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(
        system_routes, "_ssh_script",
        lambda *a, **k: SimpleNamespace(
            returncode=0, stdout="commit=abc\ndeploy_active=0\n", stderr="",
        ),
    )
    system_routes._STATUS_CACHE.update(at=0.0, snapshot=None)
    assert system_routes._host_status_snapshot(force=True)["deploy_active"] is False
    system_routes._STATUS_CACHE.update(at=0.0, snapshot=None)


def test_the_banner_names_the_target_version():
    """"auf welche version" — the question Alessio actually asked."""
    assert 'id="dev-deploy-banner"' in INDEX
    fn = ADMIN[ADMIN.index("function _renderDeployBanner(d)"):
               ADMIN.index("function _renderActiveRoundBanner()")]
    assert "d.dev_version" in fn
    assert "Update running" in fn
    assert "REOPEN the app window" in fn


def test_a_running_deployment_greys_both_update_buttons():
    fn = ADMIN[ADMIN.index("function _renderDeployBanner(d)"):
               ADMIN.index("function _renderActiveRoundBanner()")]
    assert "#sys-promoteBtn, #dev-promoteBtn" in fn
    assert "b.disabled = true" in fn


def test_the_progress_bar_tracks_real_stages():
    """Not an animation on a timer: promote.sh reports each stage, and the bar
    only moves when one actually changes."""
    assert "_PROMOTE_STAGES" in ROUTES
    assert "deploy_stage" in system_routes._HOST_STATUS_SCRIPT
    fn = ADMIN[ADMIN.index("const _DEPLOY_STAGES = {"):
               ADMIN.index("function _renderActiveRoundBanner()")]
    for stage in ("start", "backup", "rebuild", "healthcheck", "done", "failed"):
        assert f"{stage}:" in fn, f"stage {stage} has no position on the bar"
    assert "deploy-progress" in fn
    assert ".deploy-progress-fill" in (ROOT / "static/style.css").read_text(encoding="utf-8")


def test_a_failed_promotion_stays_on_screen():
    """The unit is swept away by --collect; the failure must not vanish with it.

    That is exactly what happened on 2026-08-15: the run died at git, the unit
    disappeared, and the page said nothing at all.
    """
    fn = ADMIN[ADMIN.index("function _paintDeployBanner(box, d) {"):
               ADMIN.index("function _renderActiveRoundBanner()")]
    assert "stage === 'failed'" in fn
    assert "d.deploy_active) || stage === 'failed'" in fn
    assert "production was left untouched" in fn


def test_promote_records_every_stage_including_the_crash():
    promote = (ROOT.parent / "odysseus-setup" / "odysseus-entwickler" / "promote.sh")
    if not promote.exists():
        pytest.skip("setup repo not checked out next to this one")
    body = promote.read_text(encoding="utf-8")
    for stage in ("start", "backup", "rebuild", "healthcheck", "done"):
        assert f"_stage {stage}" in body, f"promote.sh never reports {stage}"
    # A crash must be recorded as a crash, not leave the last good stage up.
    assert "trap _on_exit EXIT" in body
    assert "_stage failed" in body
    # `if`, not `&&` — under set -e a false test would swallow the exit code.
    assert 'if [ "$rc" -ne 0 ]; then _stage failed' in body


def test_the_banner_appears_on_both_cards():
    """Update sits on the System card AND the Developer page. Alessio pressed
    it on the System card and saw no bar there (2026-08-15) — feedback belongs
    wherever the button is."""
    assert 'id="sys-deploy-banner"' in INDEX
    assert 'id="dev-deploy-banner"' in INDEX
    fn = ADMIN[ADMIN.index("function _renderDeployBanner(d) {"):
               ADMIN.index("function _paintDeployBanner(box, d) {")]
    assert "'dev-deploy-banner', 'sys-deploy-banner'" in fn
    # The System card has its own load path and would otherwise never paint it.
    load = ADMIN[ADMIN.index("async function _loadSystemStatus()"):]
    assert "_renderDeployBanner(d)" in load.split("btn.disabled = !d.promotable")[0]


def test_the_bar_actually_progresses():
    """A progress bar that does not progress looks like a hang.

    The status snapshot is cached for 20 s and in the measured run
    rebuild -> healthcheck took 6, so the poll has to bypass the cache.
    """
    fn = ADMIN[ADMIN.index("let _deployPollTimer = null;"):
               ADMIN.index("function _renderDeployBanner(d) {")]
    assert "/api/system/status?refresh=1" in fn
    assert "setInterval" in fn and "clearInterval" in fn
    # Only while something runs — idle costs nothing.
    assert "if (running && !_deployPollTimer)" in fn
    # The rebuild restarts this server; a failed poll is expected, not an error.
    assert "catch (_)" in fn


def test_the_status_probe_stays_one_round_trip():
    """The Developer page polls this every 30 s."""
    script = ROUTES.split('_HOST_STATUS_SCRIPT = f"""', 1)[1].split('"""', 1)[0]
    assert "deploy_active" in script
