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
import threading
import time
from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.database import SessionLocal, RoadmapBuild
from core.middleware import require_admin
from src.auth_helpers import get_current_user
from src.constants import APP_VERSION, DATA_DIR

logger = logging.getLogger(__name__)

# SSH alias to the deploy host (configured in ~/.ssh/config).
_HOST = "odysseus-host"
# Prod/beta checkouts live on the host; beta serves on :7001.
_PROD_DIR = "/opt/odysseus"
_BETA_DIR = "/opt/odysseus-beta"
_BETA_URL = "http://127.0.0.1:7001/api/version"
_PROMOTE = "/home/deploy/odysseus-entwickler/promote.sh"
_BETA_STOP = "/home/deploy/odysseus-entwickler/beta-stop.sh"
_SWITCH = "/home/deploy/odysseus-entwickler/switch-version.sh"
_RELEASES = "/home/deploy/odysseus-entwickler/releases.log"
_HOST_METRICS_SCRIPT = r"""
awk '/^cpu / { total=0; for (i=2; i<=NF; i++) total += $i;
  print "cpu_total=" total; print "cpu_idle=" ($5 + $6) }' /proc/stat
awk '/^processor[[:space:]]*:/ { cores++ } END { print "cpu_cores=" cores }' /proc/cpuinfo
awk '{ print "load_1=" $1; print "load_5=" $2; print "load_15=" $3 }' /proc/loadavg
awk '/^MemTotal:/ { total=$2 } /^MemAvailable:/ { available=$2 }
  END { print "mem_total_kb=" total; print "mem_available_kb=" available }' /proc/meminfo
awk '{ print "uptime_seconds=" $1 }' /proc/uptime
df -Pk / | awk 'NR == 2 { print "disk_total_kb=" $2; print "disk_used_kb=" $3 }'
"""

# Last /proc CPU counters per source. CPU utilisation is a delta, not the
# since-boot average; keeping only two aggregate numbers avoids exposing any
# process or host-identifying data through the admin endpoint.
_METRICS_CPU_SAMPLES = {}
_METRICS_LOCK = threading.Lock()
_METRICS_REFRESH_LOCK = threading.Lock()
_METRICS_CACHE = {"at": 0.0, "payload": None}
_METRICS_CACHE_SECONDS = 4.0


# Living work queue — same file the developer skill reads on every start.
_ROADMAP = os.path.join(DATA_DIR, "dev", "ROADMAP.md")


def _roadmap_freshness(version: str) -> dict:
    """Does the roadmap have a section for the version being built?

    Found 2026-07-27: the last documented section was v3.7 while the code had
    moved on to 3.9.5 — two whole rounds undocumented, and the developer skill
    reads this file on every start, so it was planning from a stale picture.
    Surfacing the gap is what keeps it honest; the Developer page shows a
    banner and the status payload carries the same flag.
    """
    want = ".".join(str(version or "").split(".")[:2])   # "3.9.5" -> "3.9"
    out = {"expected_section": f"v{want}" if want else None, "current": True,
           "sections": [], "missing": False}
    if not want:
        return out
    try:
        with open(_ROADMAP, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        out.update(current=False, missing=True)
        return out
    heads = [ln[3:].strip() for ln in text.split("\n") if ln.startswith("## ")]
    out["sections"] = heads[-6:]
    # A matching head is any "## v3.9…" — released, open package, whatever the
    # round is called, as long as the version appears.
    out["current"] = any(h.lower().startswith(f"v{want}") for h in heads)
    return out


class RoadmapBody(BaseModel):
    content: str = Field(..., max_length=200_000)


class RoadmapBuildBody(BaseModel):
    item_key: str = Field(..., min_length=1, max_length=64)
    item_title: str = Field("", max_length=2000)
    session_id: str = Field(..., min_length=1, max_length=80)
    endpoint_id: str = Field("", max_length=80)
    model: str = Field("", max_length=200)
    model_label: str = Field("", max_length=200)


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


def _parse_metric_lines(text: str) -> dict:
    """Parse the fixed key=value output produced by the metrics probe."""
    values = {}
    for line in (text or "").splitlines():
        key, sep, raw = line.partition("=")
        if not sep or not key.replace("_", "").isalnum():
            continue
        try:
            values[key] = float(raw.strip())
        except (TypeError, ValueError):
            continue
    return values


def _cpu_percent(source: str, total: float, idle: float):
    """Return aggregate CPU use since the previous sample for this source."""
    with _METRICS_LOCK:
        previous = _METRICS_CPU_SAMPLES.get(source)
        _METRICS_CPU_SAMPLES[source] = (total, idle)
    if not previous:
        return None
    total_delta = total - previous[0]
    idle_delta = idle - previous[1]
    if total_delta <= 0:
        return None
    return round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 1)


def _metrics_payload(values: dict, source: str) -> dict:
    total_kb = max(0.0, values.get("mem_total_kb", 0.0))
    available_kb = max(0.0, values.get("mem_available_kb", 0.0))
    used_kb = max(0.0, total_kb - available_kb)
    disk_total_kb = max(0.0, values.get("disk_total_kb", 0.0))
    disk_used_kb = max(0.0, values.get("disk_used_kb", 0.0))
    cpu_total = values.get("cpu_total")
    cpu_idle = values.get("cpu_idle")
    cpu = (
        _cpu_percent(source, cpu_total, cpu_idle)
        if cpu_total is not None and cpu_idle is not None else None
    )
    return {
        "available": bool(total_kb or disk_total_kb or cpu_total is not None),
        "source": source,
        "sampled_at": datetime.now(timezone.utc).isoformat(),
        "cpu": {
            "percent": cpu,
            "cores": int(values.get("cpu_cores", 0.0)),
            "load_1": values.get("load_1"),
            "load_5": values.get("load_5"),
            "load_15": values.get("load_15"),
        },
        "memory": {
            "used_bytes": int(used_kb * 1024),
            "total_bytes": int(total_kb * 1024),
            "percent": round(used_kb / total_kb * 100.0, 1) if total_kb else None,
        },
        "disk": {
            "used_bytes": int(disk_used_kb * 1024),
            "total_bytes": int(disk_total_kb * 1024),
            "percent": round(disk_used_kb / disk_total_kb * 100.0, 1) if disk_total_kb else None,
        },
        "uptime_seconds": int(max(0.0, values.get("uptime_seconds", 0.0))),
    }


def _local_linux_metrics() -> dict:
    """Best-effort fallback for beta/dev where host SSH is unavailable."""
    values = {}
    try:
        with open("/proc/stat", encoding="ascii") as fh:
            cpu = fh.readline().split()[1:]
        counters = [float(value) for value in cpu]
        values["cpu_total"] = sum(counters)
        values["cpu_idle"] = sum(counters[3:5])
        values["cpu_cores"] = float(os.cpu_count() or 0)
        load = os.getloadavg()
        values.update(load_1=load[0], load_5=load[1], load_15=load[2])
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                name, _, raw = line.partition(":")
                if name in {"MemTotal", "MemAvailable"}:
                    values[f"mem_{name[3:].lower()}_kb"] = float(raw.split()[0])
        with open("/proc/uptime", encoding="ascii") as fh:
            values["uptime_seconds"] = float(fh.read().split()[0])
        stat = os.statvfs("/")
        values["disk_total_kb"] = stat.f_blocks * stat.f_frsize / 1024
        values["disk_used_kb"] = (
            (stat.f_blocks - stat.f_bfree) * stat.f_frsize / 1024
        )
    except (OSError, ValueError, IndexError) as exc:
        logger.debug("system/metrics: local fallback unavailable: %s", exc)
    return _metrics_payload(values, "app-container")


def _server_metrics_snapshot(force: bool = False) -> dict:
    """Return one cached aggregate snapshot without spawning parallel SSH probes."""
    with _METRICS_REFRESH_LOCK:
        now = time.monotonic()
        cached = _METRICS_CACHE["payload"]
        if (
            not force
            and cached is not None
            and now - _METRICS_CACHE["at"] < _METRICS_CACHE_SECONDS
        ):
            return cached
        try:
            result = _ssh_script(_HOST_METRICS_SCRIPT, timeout=5)
            if result.returncode == 0:
                payload = _metrics_payload(
                    _parse_metric_lines(result.stdout), "server"
                )
                if payload["available"]:
                    _METRICS_CACHE.update(at=time.monotonic(), payload=payload)
                    return payload
        except Exception as exc:
            logger.debug("system/metrics: host probe unavailable: %s", exc)
        payload = _local_linux_metrics()
        _METRICS_CACHE.update(at=time.monotonic(), payload=payload)
        return payload


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
            "roadmap": _roadmap_freshness(dev_version or APP_VERSION),
        }

    @router.get("/roadmap-freshness")
    def roadmap_freshness(request: Request):
        require_admin(request)
        return _roadmap_freshness(APP_VERSION)

    @router.get("/metrics")
    def get_metrics(request: Request, refresh: bool = False):
        """Small, admin-only host health snapshot for the Developer page.

        The fixed probe returns aggregate counters only: no process names,
        command lines, network addresses or host identity. On beta/dev, where
        host SSH is intentionally unavailable, report the app container and
        label that scope explicitly.
        """
        require_admin(request)
        return _server_metrics_snapshot(force=refresh)

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

    @router.get("/roadmap/builds")
    def list_roadmap_builds(request: Request):
        """Latest build (if any) per roadmap item, for the board's chips."""
        require_admin(request)
        me = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(RoadmapBuild)
            if me is not None:
                q = q.filter(RoadmapBuild.owner == me)
            rows = q.order_by(RoadmapBuild.created_at.desc()).all()
            latest = {}
            for r in rows:
                if r.item_key in latest:
                    continue  # already have a newer one (rows are DESC)
                latest[r.item_key] = {
                    "item_key": r.item_key,
                    "item_title": r.item_title,
                    "session_id": r.session_id,
                    "endpoint_id": r.endpoint_id,
                    "model": r.model,
                    "model_label": r.model_label,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
            return {"builds": list(latest.values())}
        finally:
            db.close()

    @router.post("/roadmap/builds")
    def record_roadmap_build(body: RoadmapBuildBody, request: Request):
        """Remember which chat is building a roadmap item.

        Called after chat creation but before prompt send, so the link exists
        before an agent turn can detach into the background. This endpoint
        does not itself talk to the model. If setup/send fails, the client
        removes the link again. A repeat build for the same item adds a row;
        list_roadmap_builds always returns the newest one.
        """
        require_admin(request)
        me = get_current_user(request)
        db = SessionLocal()
        try:
            row = RoadmapBuild(
                id=uuid.uuid4().hex[:12],
                owner=me,
                item_key=body.item_key,
                item_title=body.item_title,
                session_id=body.session_id,
                endpoint_id=body.endpoint_id,
                model=body.model,
                model_label=body.model_label,
            )
            db.add(row)
            db.commit()
            return {"ok": True}
        finally:
            db.close()

    @router.delete("/roadmap/builds/{session_id}")
    def delete_roadmap_build(session_id: str, request: Request):
        """Remove a build link when setup fails before the agent turn starts."""
        require_admin(request)
        me = get_current_user(request)
        db = SessionLocal()
        try:
            q = db.query(RoadmapBuild).filter(RoadmapBuild.session_id == session_id)
            if me is not None:
                q = q.filter(RoadmapBuild.owner == me)
            deleted = q.delete(synchronize_session=False)
            db.commit()
            return {"ok": True, "deleted": deleted}
        finally:
            db.close()

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
        cmd = f"bash {_BETA_STOP}"
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
