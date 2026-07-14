"""System status + promotion routes (admin-only).

Backs the "System" card in Settings. All data that describes the *deployment*
(git commit, whether a beta is live, which branch it runs) lives on the host,
not inside this container — `/app` is the built image copy and has no `.git`.
So we reach the host over the pre-configured `odysseus-host` SSH alias, exactly
like the beta-deploy / promote scripts do.
"""
import logging
import subprocess

from fastapi import APIRouter, HTTPException, Request

from core.middleware import require_admin
from src.constants import APP_VERSION

logger = logging.getLogger(__name__)

# SSH alias to the deploy host (configured in ~/.ssh/config).
_HOST = "odysseus-host"
# Prod/beta checkouts live on the host; beta serves on :7001.
_PROD_DIR = "/opt/odysseus"
_BETA_DIR = "/opt/odysseus-beta"
_BETA_URL = "http://127.0.0.1:7001/api/version"
_PROMOTE = "/home/deploy/odysseus-entwickler/promote.sh"


def _ssh(*args: str, timeout: int = 8) -> subprocess.CompletedProcess:
    """Run a command on the deploy host. Never raises; caller inspects rc."""
    return subprocess.run(
        ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", _HOST, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


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
                r = _ssh(
                    "bash", "-lc",
                    f"git -C {_BETA_DIR} fetch -q origin 2>/dev/null; "
                    f"git -C {_BETA_DIR} merge-base --is-ancestor HEAD origin/dev "
                    f"&& echo yes || echo no",
                )
                beta_in_dev = r.returncode == 0 and r.stdout.strip() == "yes"
            except Exception:
                logger.exception("system/status: beta branch inspection failed")

        # Promote is only safe/honest when a beta is live AND its commit is
        # already merged into origin/dev (what prod will actually build).
        promotable = bool(beta_active and beta_in_dev)

        return {
            "version": APP_VERSION,
            "commit": commit,
            "beta_active": beta_active,
            "beta_branch": beta_branch,
            "beta_commit": beta_commit,
            "beta_in_dev": beta_in_dev,
            "promotable": promotable,
        }

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
            r = _ssh("bash", "-lc", cmd, timeout=15)
        except Exception as e:
            logger.exception("system/promote: failed to launch")
            raise HTTPException(500, f"Promotion failed to start: {e}")
        if r.returncode != 0:
            logger.error("system/promote rc=%s err=%s", r.returncode, r.stderr.strip())
            raise HTTPException(500, f"Promotion failed to start: {r.stderr.strip() or 'ssh error'}")
        return {"status": "promotion_started"}

    return router
