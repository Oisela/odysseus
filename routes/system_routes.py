"""System status + promotion routes (admin-only).

Backs the "System" card in Settings. All data that describes the *deployment*
(git commit, whether a beta is live, which branch it runs) lives on the host,
not inside this container — `/app` is the built image copy and has no `.git`.
So we reach the host over the pre-configured `odysseus-host` SSH alias, exactly
like the beta-deploy / promote scripts do.
"""
import logging
import os
import shlex
import subprocess

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.middleware import require_admin
from src.constants import APP_VERSION, DATA_DIR

logger = logging.getLogger(__name__)

# SSH alias to the deploy host (configured in ~/.ssh/config).
_HOST = "odysseus-host"
# Prod/beta checkouts live on the host; beta serves on :7001.
_PROD_DIR = "/opt/odysseus"
_BETA_DIR = "/opt/odysseus-beta"
_BETA_URL = "http://127.0.0.1:7001/api/version"
_PROMOTE = "/home/deploy/odysseus-entwickler/promote.sh"
_SWITCH = "/home/deploy/odysseus-entwickler/switch-version.sh"
_RELEASES = "/home/deploy/odysseus-entwickler/releases.log"


# Living work queue — same file the developer skill reads on every start.
_ROADMAP = os.path.join(DATA_DIR, "dev", "ROADMAP.md")


class RoadmapBody(BaseModel):
    content: str = Field(..., max_length=200_000)


class SwitchBody(BaseModel):
    commit: str = Field(..., min_length=6, max_length=40, pattern=r"^[0-9a-f]+$")


def _ssh(*args: str, timeout: int = 8) -> subprocess.CompletedProcess:
    """Run a command on the deploy host. Never raises; caller inspects rc."""
    return subprocess.run(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", _HOST, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _ssh_script(script: str, timeout: int = 8) -> subprocess.CompletedProcess:
    """Run a multi-word shell script on the host.

    ssh joins its argv with SPACES and no quoting — `ssh bash -lc <script>`
    hands the remote `bash -c` only the FIRST word of the script (the rest
    become positional params). Every multi-word command must therefore be
    shlex-quoted into a single remote word. (Found 2026-07-16: the beta-start
    button ran a bare `sudo`, and the update-ready/dev-version checks were
    silently broken the same way.)
    """
    return _ssh("bash", "-lc", shlex.quote(script), timeout=timeout)


def _read_releases() -> list:
    """Parse the host's release ledger (version<TAB>commit<TAB>date)."""
    releases = []
    try:
        r = _ssh("cat", _RELEASES)
        if r.returncode != 0:
            return releases
        for line in r.stdout.splitlines():
            parts = line.strip().split("\t")
            if len(parts) >= 2 and parts[0] and parts[1]:
                releases.append({
                    "version": parts[0],
                    "commit": parts[1],
                    "date": parts[2] if len(parts) > 2 else "",
                })
    except Exception:
        logger.exception("system/releases: ledger read failed")
    return releases


def setup_system_routes() -> APIRouter:
    router = APIRouter(prefix="/api/system")

    @router.get("/status")
    def get_status(request: Request):
        require_admin(request)

        # Current prod commit (host repo; safe.directory set host-side for deploy).
        commit = "unknown"
        try:
            r = _ssh("git", "-C", _PROD_DIR, "rev-parse", "--short", "HEAD")
            if r.returncode == 0 and r.stdout.strip():
                commit = r.stdout.strip()
        except Exception:
            logger.exception("system/status: prod commit lookup failed")

        # Is a beta actually serving on :7001?
        beta_active = False
        try:
            r = _ssh("curl", "-fsS", "-m", "3", _BETA_URL)
            beta_active = r.returncode == 0
        except Exception:
            logger.exception("system/status: beta liveness check failed")

        # Which branch/commit is the beta checkout on, and would promoting it be
        # honest? Promotion builds prod from origin/dev, so a beta commit that
        # isn't an ancestor of origin/dev would NOT be what ships — surface that.
        beta_branch = None
        beta_commit = None
        beta_in_dev = False
        if beta_active:
            try:
                r = _ssh("git", "-C", _BETA_DIR, "rev-parse", "--abbrev-ref", "HEAD")
                if r.returncode == 0:
                    beta_branch = r.stdout.strip() or None
                r = _ssh("git", "-C", _BETA_DIR, "rev-parse", "--short", "HEAD")
                if r.returncode == 0:
                    beta_commit = r.stdout.strip() or None
                r = _ssh_script(
                    f"git -C {_BETA_DIR} fetch -q origin 2>/dev/null; "
                    f"git -C {_BETA_DIR} merge-base --is-ancestor HEAD origin/dev "
                    f"&& echo yes || echo no"
                )
                beta_in_dev = r.returncode == 0 and r.stdout.strip() == "yes"
            except Exception:
                logger.exception("system/status: beta branch inspection failed")

        # Promote is only safe/honest when a beta is live AND its commit is
        # already merged into origin/dev (what prod will actually build).
        promotable = bool(beta_active and beta_in_dev)

        # The open package = APP_VERSION on origin/dev's tip (may be ahead of
        # this running instance). Read it from the host checkout's remote ref.
        dev_version = None
        try:
            r = _ssh_script(
                f"git -C {_PROD_DIR} fetch -q origin 2>/dev/null; "
                f"git -C {_PROD_DIR} show origin/dev:src/constants.py 2>/dev/null "
                f"| grep -m1 'APP_VERSION'"
            )
            if r.returncode == 0 and '"' in r.stdout:
                dev_version = r.stdout.split('"')[1] or None
        except Exception:
            logger.exception("system/status: dev version lookup failed")

        return {
            "version": APP_VERSION,
            "dev_version": dev_version,
            "commit": commit,
            "beta_active": beta_active,
            "beta_branch": beta_branch,
            "beta_commit": beta_commit,
            "beta_in_dev": beta_in_dev,
            "promotable": promotable,
        }

    @router.get("/roadmap")
    def get_roadmap(request: Request):
        require_admin(request)
        try:
            with open(_ROADMAP, encoding="utf-8") as fh:
                return {"content": fh.read(), "missing": False}
        except FileNotFoundError:
            return {"content": "", "missing": True}
        except OSError as e:
            raise HTTPException(500, f"Roadmap read failed: {e}")

    @router.post("/roadmap")
    def save_roadmap(body: RoadmapBody, request: Request):
        require_admin(request)
        try:
            os.makedirs(os.path.dirname(_ROADMAP), exist_ok=True)
            # Atomic replace so a crash mid-write can't truncate the queue the
            # developer skill works from.
            tmp = _ROADMAP + ".tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(body.content)
            os.replace(tmp, _ROADMAP)
        except OSError as e:
            raise HTTPException(500, f"Roadmap write failed: {e}")
        return {"ok": True}

    @router.post("/beta-start")
    def start_beta(request: Request):
        """Boot the beta channel on origin/dev — no AI involved, one click.

        Runs beta-deploy.sh detached (systemd-run as the deploy user, the same
        way the developer skill does) because the compose build takes minutes.
        """
        require_admin(request)
        try:
            if _ssh("curl", "-fsS", "-m", "3", _BETA_URL).returncode == 0:
                return {"status": "already_running"}
        except Exception:
            pass
        unit = "odysseus-beta-start-$(date +%s)"
        cmd = (
            f"sudo systemd-run --unit={unit} --collect --uid=deploy "
            f"bash /home/deploy/odysseus-entwickler/beta-deploy.sh dev"
        )
        try:
            r = _ssh_script(cmd, timeout=15)
        except Exception as e:
            logger.exception("system/beta-start: failed to launch")
            raise HTTPException(500, f"Beta start failed: {e}")
        if r.returncode != 0:
            logger.error("system/beta-start rc=%s err=%s", r.returncode, r.stderr.strip())
            raise HTTPException(500, f"Beta start failed: {r.stderr.strip() or 'ssh error'}")
        return {"status": "beta_start_requested"}

    @router.post("/beta-stop")
    def stop_beta(request: Request):
        """Park the beta channel (compose down + free the :7001 serve)."""
        require_admin(request)
        cmd = (
            "cd /opt/odysseus-beta && docker compose -p odysseus-beta down; "
            "tailscale serve --https=7001 off"
        )
        try:
            r = _ssh_script(cmd, timeout=90)
        except Exception as e:
            logger.exception("system/beta-stop: failed")
            raise HTTPException(500, f"Beta stop failed: {e}")
        if r.returncode != 0:
            logger.error("system/beta-stop rc=%s err=%s", r.returncode, r.stderr.strip())
            raise HTTPException(500, f"Beta stop failed: {r.stderr.strip() or 'ssh error'}")
        return {"status": "beta_stopped"}

    @router.get("/releases")
    def list_releases(request: Request):
        """Released versions from the host ledger, newest last; marks current."""
        require_admin(request)
        releases = _read_releases()
        current = "unknown"
        try:
            r = _ssh("git", "-C", _PROD_DIR, "rev-parse", "--short", "HEAD")
            if r.returncode == 0:
                current = r.stdout.strip()
        except Exception:
            logger.exception("system/releases: current commit lookup failed")
        for rel in releases:
            rel["current"] = rel["commit"] == current
        return {"releases": releases, "current_commit": current}

    @router.post("/switch")
    def switch_version(body: SwitchBody, request: Request):
        """Switch prod to a RELEASED version (down- or re-upgrade).

        Only commits from the host's release ledger are accepted — this
        endpoint must never let a client check out arbitrary tree states.
        Runs detached (systemd-run) because the rebuild restarts this
        very process, exactly like promote.
        """
        require_admin(request)
        releases = _read_releases()
        target = next((rel for rel in releases if rel["commit"] == body.commit), None)
        if not target:
            raise HTTPException(400, "Commit is not a released version — refusing to switch.")
        unit = "odysseus-switch-$(date +%s)"
        cmd = (
            f"sudo systemd-run --unit={unit} --collect "
            f"bash {_SWITCH} {target['commit']}"
        )
        try:
            r = _ssh_script(cmd, timeout=15)
        except Exception as e:
            logger.exception("system/switch: failed to launch")
            raise HTTPException(500, f"Version switch failed to start: {e}")
        if r.returncode != 0:
            logger.error("system/switch rc=%s err=%s", r.returncode, r.stderr.strip())
            raise HTTPException(500, f"Version switch failed to start: {r.stderr.strip() or 'ssh error'}")
        return {"status": "switch_started", "version": target["version"], "commit": target["commit"]}

    @router.post("/promote")
    def promote_beta(request: Request):
        require_admin(request)

        # Re-check server-side; never trust the client's disabled state.
        try:
            live = _ssh("curl", "-fsS", "-m", "3", _BETA_URL).returncode == 0
        except Exception:
            live = False
        if not live:
            raise HTTPException(409, "No beta is running on :7001 — nothing to promote.")

        # systemd-run (via sudo, per sudoers) so the promotion survives the
        # prod rebuild that restarts this very process. Unique unit name.
        unit = "odysseus-promote-ui-$(date +%s)"
        cmd = (
            f"sudo systemd-run --unit={unit} --collect "
            f"bash {_PROMOTE}"
        )
        try:
            r = _ssh_script(cmd, timeout=15)
        except Exception as e:
            logger.exception("system/promote: failed to launch")
            raise HTTPException(500, f"Promotion failed to start: {e}")
        if r.returncode != 0:
            logger.error("system/promote rc=%s err=%s", r.returncode, r.stderr.strip())
            raise HTTPException(500, f"Promotion failed to start: {r.stderr.strip() or 'ssh error'}")
        return {"status": "promotion_started"}

    return router
