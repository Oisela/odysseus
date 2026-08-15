"""System status + promotion routes (admin-only).

Backs the "System" card in Settings. All data that describes the *deployment*
(git commit, whether a beta is live, which branch it runs) lives on the host,
not inside this container — `/app` is the built image copy and has no `.git`.
So we reach the host over the pre-configured `odysseus-host` SSH alias, exactly
like the beta-deploy / promote scripts do.
"""
import json
import logging
import os
import re
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
from src.constants import APP_VERSION, BETA_PUBLIC_URL, DATA_DIR

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
_STORAGE_DATA_DIR = f"{_PROD_DIR}/data"
_HOST_STORAGE_SCRIPT = f"""
df -B1 / | awk 'NR == 2 {{ print "filesystem_total=" $2; print "filesystem_used=" $3; print "filesystem_available=" $4 }}'
docker system df --format '{{{{json .}}}}' 2>/dev/null | python3 -c '
import json, sys
for line in sys.stdin:
    row = json.loads(line)
    kind = row.get("Type")
    size = row.get("Size", "0B")
    if kind == "Images": print("docker_images_raw=" + size)
    if kind == "Build Cache": print("docker_build_cache_raw=" + size)
'
du -sb {_STORAGE_DATA_DIR} 2>/dev/null | awk '{{ print "odysseus_data=" $1 }}'
"""

# Everything /status needs about the deployment, in ONE round trip. This used to
# be six sequential `_ssh` calls; each one pays the full ConnectTimeout=6 SSH
# handshake, so the endpoint sat at 2-3 s (measured in prod logs 2026-07-30) and
# the Developer page polls it every 30 s. Every line is guarded so one missing
# checkout or a dead beta degrades that single key instead of the whole probe.
#
# `beta_exposed` is a SECOND question from the same round trip, and the two
# disagree in exactly the case that keeps biting: the container answers on
# 127.0.0.1:7001 while `tailscale serve --https=7001` is off, so the host looks
# healthy and the browser says "connection refused". beta-stop.sh drops that
# serve, and any abort inside downgrade-roundtrip.sh leaves it dropped
# (2026-07-20, and again unnoticed since).
#
# Deliberately NO `git fetch` here — the two fetches that used to live in the
# request path were synchronous calls to GitHub and were the 2-second floor all
# by themselves. `_maybe_refresh_origin` does that in the background now.
_HOST_STATUS_SCRIPT = f"""
git -C {_PROD_DIR} rev-parse --short HEAD 2>/dev/null | head -1 | sed 's/^/commit=/'
curl -fsS -m 3 {_BETA_URL} >/dev/null 2>&1 && echo beta_http=1 || echo beta_http=0
tailscale serve status 2>/dev/null | grep -q ':7001' \
  && echo beta_exposed=1 || echo beta_exposed=0
git -C {_BETA_DIR} rev-parse --abbrev-ref HEAD 2>/dev/null | head -1 | sed 's/^/beta_branch=/'
git -C {_BETA_DIR} rev-parse --short HEAD 2>/dev/null | head -1 | sed 's/^/beta_commit=/'
git -C {_BETA_DIR} merge-base --is-ancestor HEAD origin/dev 2>/dev/null \
  && echo beta_in_dev=1 || echo beta_in_dev=0
git -C {_PROD_DIR} show origin/dev:src/constants.py 2>/dev/null \
  | grep -m1 APP_VERSION | cut -d'"' -f2 | head -1 | sed 's/^/dev_version=/'
echo "deploy_active=$(systemctl list-units --state=active --no-legend \
  'odysseus-promote-*' 'odysseus-switch-*' 2>/dev/null | wc -l | tr -d ' ')"
"""

# Everything POST /switch must know before it fires. The switch runs detached,
# so once it is launched nothing can report back synchronously — every check
# that can be made has to be made HERE, while there is still an HTTP response to
# put the answer in. Emitted as key=value, one round trip, ~0.3 s.
#
# `wc -l` rather than `grep -c .`: grep exits 1 on zero matches, which trips the
# guard clause and appends a second line to the value.
_SWITCH_PREFLIGHT_SCRIPT = f"""
echo "head=$(git -C {_PROD_DIR} rev-parse --short HEAD 2>/dev/null)"
echo "disk_avail_kb=$(df --output=avail / | tail -1 | tr -d ' ')"
echo "build_active=$(systemctl list-units --state=active --no-legend \
  'odysseus-promote-*' 'odysseus-switch-*' 'odysseus-beta-start-*' 2>/dev/null \
  | wc -l | tr -d ' ')"
"""

# The self-check probe. Everything the Developer page's "System check" cannot
# answer from local files, in one round trip.
#
# The skill folder is the LIVE copy the agent runs from (it is bind-mounted out
# of the app container); /home/deploy holds the host-side copies the API and the
# systemd units invoke. Those two drifting apart is not theoretical: on
# 2026-08-15 dev.sh was 23 KB in the skill folder and a 15-July 7 KB copy on the
# host, and `doctor` — the command whose whole job is drift — did not check it.
_SKILL_DIR = f"{_PROD_DIR}/data/skills/werkzeuge/odysseus-entwickler"
_HOST_SCRIPT_DIR = "/home/deploy/odysseus-entwickler"
_SYNCED_SCRIPTS = (
    "dev.sh", "promote.sh", "beta-deploy.sh", "beta-stop.sh",
    "switch-version.sh", "downgrade-roundtrip.sh",
)
_CLONE_DIR = f"{_PROD_DIR}/data/dev/odysseus"

_SELFCHECK_SCRIPT = f"""
for f in {' '.join(_SYNCED_SCRIPTS)}; do
  a=$(sha256sum {_SKILL_DIR}/$f 2>/dev/null | cut -d' ' -f1)
  b=$(sha256sum {_HOST_SCRIPT_DIR}/$f 2>/dev/null | cut -d' ' -f1)
  if [ -z "$a" ] || [ -z "$b" ]; then echo "drift_missing=$f";
  elif [ "$a" != "$b" ]; then echo "drift_differs=$f"; fi
done
echo "clone_branch=$(git -C {_CLONE_DIR} branch --show-current 2>/dev/null)"
echo "clone_dirty=$(git -C {_CLONE_DIR} status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
git -C {_PROD_DIR} branch -r --merged origin/dev 2>/dev/null \
  | sed 's/^ *//' | grep '^origin/' | grep -v -e 'origin/dev$' -e 'origin/main$' -e '->' \
  | sed 's|^origin/|merged_branch=|'
echo "disk_avail_kb=$(df --output=avail / | tail -1 | tr -d ' ')"
echo "build_cache=$(docker system df --format '{{{{.Type}}}}={{{{.Size}}}}' 2>/dev/null \
  | sed -n 's/^Build Cache=//p' | head -1)"
echo "released_version=$(tail -1 {_RELEASES} 2>/dev/null | cut -f1)"
"""

# Only these may be triggered from the browser. A self-check that can run any
# command is a remote shell with a friendly name.
_SELFCHECK_FIXES = {
    "beta-expose": (
        "sudo systemd-run --collect --unit=odysseus-beta-expose-$(date +%s) "
        "tailscale serve --bg --https=7001 http://127.0.0.1:7001"
    ),
    "script-sync": (
        f"cp {_SKILL_DIR}/dev.sh {_SKILL_DIR}/promote.sh {_SKILL_DIR}/beta-deploy.sh "
        f"{_SKILL_DIR}/beta-stop.sh {_SKILL_DIR}/switch-version.sh "
        f"{_SKILL_DIR}/downgrade-roundtrip.sh {_HOST_SCRIPT_DIR}/ "
        f"&& chmod +x {_HOST_SCRIPT_DIR}/*.sh"
    ),
    "disk-prune": (
        # Deliberately NOT `docker system prune -a`: that drops the images prod
        # and beta were built from, and then the downgrade button — the one
        # thing that must stay fast — has to rebuild from scratch.
        "docker builder prune -f --filter until=168h >/dev/null "
        "&& docker image prune -f >/dev/null && echo pruned"
    ),
}

# Free space below this bricks a docker build; build cache above this is just
# uncollected layers from past deploys (7 GB measured 2026-07-31).
_SELFCHECK_MIN_FREE_KB = 5 * 1024 * 1024
_SELFCHECK_MAX_CACHE_GB = 5.0
# A round that has not moved in this long is not in flight, it is abandoned.
_SELFCHECK_CYCLE_STALE_H = 24

# A docker build needs room; below this the build bricks more than itself.
# switch-version.sh enforces the same number, but only AFTER the UI has already
# said "switch started" — by then the user is watching a rebuild that will not
# happen. Checking here turns a silent failure into a sentence.
_SWITCH_MIN_FREE_KB = 5 * 1024 * 1024

# When the host is unreachable the UI cannot switch at all — so the message has
# to carry the way out rather than just naming the failure. This is the exact
# command from the odysseus-entwickler skill's emergency section.
_CLI_FALLBACK = (
    "Cannot reach the deploy host over SSH, so the switch cannot be started. "
    "Run it from a terminal instead: "
    "ssh root@odysseus-server \"systemd-run --collect bash "
    f"{_SWITCH} {{commit}}\""
)

# Breadcrumbs written by switch-version.sh. The switch is detached, so this file
# is the only record of what actually happened after the UI lost contact.
_SWITCH_LOG = "/home/deploy/odysseus-entwickler/switch-last.log"

# Last /proc CPU counters per source. CPU utilisation is a delta, not the
# since-boot average; keeping only two aggregate numbers avoids exposing any
# process or host-identifying data through the admin endpoint.
_METRICS_CPU_SAMPLES = {}
_METRICS_LOCK = threading.Lock()
_METRICS_REFRESH_LOCK = threading.Lock()
_METRICS_CACHE = {"at": 0.0, "payload": None}
_METRICS_CACHE_SECONDS = 4.0

# Same cache discipline as the metrics probe, longer TTL: deployment state only
# changes when someone deploys. `?refresh=1` bypasses it for the manual button.
_STATUS_REFRESH_LOCK = threading.Lock()
_STATUS_CACHE = {"at": 0.0, "snapshot": None}
_STATUS_CACHE_SECONDS = 20.0
_RELEASES_CACHE = {"at": 0.0, "releases": None}
_RELEASES_CACHE_SECONDS = 20.0

# Background `git fetch` so `origin/dev` is reasonably current without any
# request ever waiting on GitHub. `done_at` is exposed as `fetch_age_seconds`:
# if the host is unreachable the fetch silently stops happening, and a stale
# `dev_version`/`beta_in_dev` must be *visible* rather than quietly wrong.
_FETCH_LOCK = threading.Lock()
_FETCH_STATE = {"started_at": 0.0, "done_at": None, "ok": False}
_FETCH_INTERVAL_SECONDS = 120.0


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


class SelfcheckFixBody(BaseModel):
    # Pattern first, whitelist second. The route rejects anything not in
    # _SELFCHECK_FIXES anyway, but a shell-metacharacter-free field means a
    # future careless `f"...{fix}"` cannot become an injection either.
    fix: str = Field(..., min_length=2, max_length=32, pattern=r"^[a-z][a-z0-9-]*$")


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

    CRs are stripped because a multi-line script literal in a .py file picks up
    CRLF on a Windows checkout (`git ls-files --eol` -> `i/lf w/crlf`), and the
    remote bash then chokes on `$'\r'` and mangles every `sed` expression. The
    image is built from a Linux checkout so prod was never affected, but it made
    local verification lie. `.gitattributes` pins `*.sh` to LF for the same class
    of bug (issues #150/#77); shell text inside Python needs the same guarantee.
    """
    return _ssh("bash", "-lc", shlex.quote(script.replace("\r", "")), timeout=timeout)


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


def _parse_kv_lines(text: str) -> dict:
    """Parse `key=value` probe output, keeping values as strings.

    Deliberately NOT `_parse_metric_lines`: that one coerces to float and drops
    everything non-numeric, which is a privacy property of the metrics endpoint
    (pinned by tests/test_developer_metrics.py) and must stay. The status probe
    returns commits and branch names, so it needs its own string-tolerant parser
    with the same allow-list on key names.
    """
    values = {}
    for line in (text or "").splitlines():
        key, sep, raw = line.partition("=")
        key = key.strip()
        if not sep or not key or not key.replace("_", "").isalnum():
            continue
        values[key] = raw.strip()
    return values


def _maybe_refresh_origin() -> None:
    """Kick off a background `git fetch` on the host at most every 2 minutes.

    Marks the attempt as started *before* spawning, so concurrent /status calls
    can never pile up threads on the same interval.
    """
    with _FETCH_LOCK:
        now = time.monotonic()
        if now - _FETCH_STATE["started_at"] < _FETCH_INTERVAL_SECONDS:
            return
        _FETCH_STATE["started_at"] = now

    def _run():
        ok = False
        try:
            r = _ssh_script(
                f"git -C {_PROD_DIR} fetch -q origin 2>/dev/null; "
                f"git -C {_BETA_DIR} fetch -q origin 2>/dev/null; "
                f"echo done",
                timeout=45,
            )
            ok = r.returncode == 0
        except Exception as exc:
            logger.debug("system/status: background fetch failed: %s", exc)
        with _FETCH_LOCK:
            _FETCH_STATE["ok"] = ok
            if ok:
                _FETCH_STATE["done_at"] = time.monotonic()

    threading.Thread(target=_run, name="odysseus-origin-fetch", daemon=True).start()


def _fetch_age_seconds():
    """Seconds since the last SUCCESSFUL background fetch, None if never."""
    with _FETCH_LOCK:
        done_at = _FETCH_STATE["done_at"]
    return None if done_at is None else int(max(0.0, time.monotonic() - done_at))


def _host_status_snapshot(force: bool = False) -> dict:
    """One cached round trip describing the deployment. Never raises."""
    with _STATUS_REFRESH_LOCK:
        now = time.monotonic()
        cached = _STATUS_CACHE["snapshot"]
        if (
            not force
            and cached is not None
            and now - _STATUS_CACHE["at"] < _STATUS_CACHE_SECONDS
        ):
            return cached
        values = {}
        try:
            r = _ssh_script(_HOST_STATUS_SCRIPT, timeout=12)
            if r.returncode == 0:
                values = _parse_kv_lines(r.stdout)
            else:
                logger.warning(
                    "system/status: host probe rc=%s err=%s",
                    r.returncode, (r.stderr or "").strip()[:200],
                )
        except Exception as exc:
            logger.debug("system/status: host probe unavailable: %s", exc)

        beta_active = values.get("beta_http") == "1"
        snapshot = {
            "commit": values.get("commit") or "unknown",
            "beta_active": beta_active,
            # Only surface beta details for a beta that actually answers — a
            # stale checkout on disk must not look like a running instance.
            "beta_branch": (values.get("beta_branch") or None) if beta_active else None,
            "beta_commit": (values.get("beta_commit") or None) if beta_active else None,
            "beta_in_dev": beta_active and values.get("beta_in_dev") == "1",
            # Reachable from a browser, not just from the host. Only meaningful
            # while the beta is up; a parked beta is not "unexposed", it is off.
            "beta_exposed": beta_active and values.get("beta_exposed") == "1",
            # A promotion detaches itself, so the browser that started it loses
            # the thread on the next reload — Alessio pressed Update, reloaded,
            # and had no way to tell whether it was still running (2026-08-15).
            # The host knows; the UI only had to ask.
            "deploy_active": (values.get("deploy_active") or "0") != "0",
            "dev_version": values.get("dev_version") or None,
            "reachable": bool(values),
        }
        _STATUS_CACHE.update(at=time.monotonic(), snapshot=snapshot)
        return snapshot


def _collect_repeated(text: str, key: str) -> list:
    """All values for a probe key that legitimately repeats.

    `_parse_kv_lines` keeps one value per key, which is right for the status
    probe and wrong here: drift and stale branches are lists, and keeping only
    the last one would report a single file while five had moved.
    """
    prefix = f"{key}="
    out = []
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith(prefix):
            value = line[len(prefix):].strip()
            if value:
                out.append(value)
    return out


def _parse_size_gb(raw: str):
    """`2.855GB` / `812.4MB` -> float GB. Docker prints for humans, not us."""
    m = re.match(r"^\s*([0-9.]+)\s*([KMGT]?)i?B\s*$", str(raw or ""), re.I)
    if not m:
        return None
    try:
        value = float(m.group(1))
    except ValueError:
        return None
    return value * {"": 1 / 1024**3, "K": 1 / 1024**2, "M": 1 / 1024, "G": 1, "T": 1024}[
        m.group(2).upper()
    ]


def _cycle_state() -> dict:
    """The developer round in flight, as dev.sh last wrote it."""
    path = os.path.join(DATA_DIR, "dev", "cycle-state.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


# Phases that mean an agent still owns the developer clone. `done` and a
# missing file are the only free states.
_ROUND_BUSY_PHASES = ("building", "awaiting-go", "promoting")


def _active_round() -> dict:
    """The round currently holding the developer clone, or {} if none.

    There is exactly ONE clone at data/dev/odysseus, one beta channel and one
    cycle-state file. Two agents in there check out different branches under
    each other, which on 2026-08-15 mixed one feature's uncommitted work into
    another's commit and stalled a third round outright. This is what the UI
    reads to stop a second build from being started at all.

    `awaiting-go` counts as busy on purpose: that round is parked mid-flight
    and expects its branch back when the go-word arrives.
    """
    cycle = _cycle_state()
    phase = (cycle.get("phase") or "").strip()
    if phase not in _ROUND_BUSY_PHASES:
        return {}
    return {
        "branch": cycle.get("branch") or "?",
        "phase": phase,
        "track": cycle.get("track") or "",
        "since": cycle.get("since") or "",
    }


def _selfcheck_findings(force: bool = False) -> list:
    """Everything the deployment can be wrong about, as one ranked list.

    Alessio 2026-08-15: "ein cleanup button der einfach schaut ob alles
    uptodate ist und da ist wo es sein sollte." Each finding either carries a
    `fix` id from the whitelist or is report-only — nothing here decides on its
    own to change the system.

    Never raises: a check that cannot run reports itself as unknown. A blank
    page would be indistinguishable from "all good".
    """
    findings = []

    def add(ident, label, state, detail, fix=None):
        findings.append({
            "id": ident, "label": label, "state": state,
            "detail": detail, "fix": fix,
        })

    snap = _host_status_snapshot(force=force)
    if not snap["reachable"]:
        add("host", "Deploy host", "fail",
            "Cannot reach odysseus-host over SSH — every host-side check below is blind.")
        return findings

    raw = ""
    try:
        r = _ssh_script(_SELFCHECK_SCRIPT, timeout=25)
        if r.returncode == 0:
            raw = r.stdout
        else:
            logger.warning("system/selfcheck: probe rc=%s err=%s",
                           r.returncode, (r.stderr or "").strip()[:200])
    except Exception:
        logger.exception("system/selfcheck: probe failed")
    values = _parse_kv_lines(raw)

    # ── Beta ────────────────────────────────────────────────────────────────
    if snap["beta_active"] and not snap["beta_exposed"]:
        add("beta-exposed", "Beta reachable", "fail",
            "The beta container answers on the host, but tailscale serve :7001 is "
            "off — no browser can open it.",
            fix="beta-expose")
    elif snap["beta_active"]:
        add("beta-exposed", "Beta reachable", "ok",
            f"{snap['beta_branch'] or '?'} @ {snap['beta_commit'] or '?'} on {BETA_PUBLIC_URL}")
    else:
        add("beta-exposed", "Beta reachable", "ok", "Parked — nothing to reach.")

    if snap["beta_active"] and not snap["beta_in_dev"]:
        add("beta-in-dev", "Beta commit in origin/dev", "warn",
            "The beta runs a commit that is not merged into dev, so promoting now "
            "would ship something else than what you tested.")

    # ── Scripts ─────────────────────────────────────────────────────────────
    differs = _collect_repeated(raw, "drift_differs")
    missing = _collect_repeated(raw, "drift_missing")
    if differs or missing:
        parts = []
        if differs:
            parts.append("differ: " + ", ".join(differs))
        if missing:
            parts.append("missing on one side: " + ", ".join(missing))
        add("script-drift", "Deploy scripts in sync", "fail",
            "Skill folder and /home/deploy disagree — " + "; ".join(parts)
            + ". The API and the systemd units run the host copies.",
            fix="script-sync" if differs and not missing else None)
    elif raw:
        add("script-drift", "Deploy scripts in sync", "ok",
            f"{len(_SYNCED_SCRIPTS)} scripts identical in both places.")

    # ── The round in flight ─────────────────────────────────────────────────
    cycle = _cycle_state()
    phase = cycle.get("phase") or ""
    if phase and phase not in ("done",):
        age_h = None
        try:
            since = datetime.fromisoformat(cycle.get("since") or "")
            age_h = (datetime.now(timezone.utc) - since).total_seconds() / 3600
        except Exception:
            pass
        if age_h is not None and age_h > _SELFCHECK_CYCLE_STALE_H:
            add("cycle-stale", "Developer round", "warn",
                f"'{cycle.get('branch') or '?'}' has been in phase '{phase}' for "
                f"{int(age_h)} h. Either it is waiting for you, or the agent is gone.",
                fix="cycle-reset")
        else:
            add("cycle-stale", "Developer round", "ok",
                f"'{cycle.get('branch') or '?'}' in phase '{phase}'.")
    else:
        add("cycle-stale", "Developer round", "ok", "None in flight.")

    dirty = values.get("clone_dirty") or "0"
    if dirty.isdigit() and int(dirty) > 0:
        add("clone-dirty", "Developer clone", "warn",
            f"{dirty} uncommitted change(s) on '{values.get('clone_branch') or '?'}'. "
            "A deploy would not include them.")
    elif "clone_dirty" in values:
        add("clone-dirty", "Developer clone", "ok",
            f"Clean on '{values.get('clone_branch') or '?'}'.")

    stale = _collect_repeated(raw, "merged_branch")
    if stale:
        add("stale-branches", "Merged branches", "warn",
            "Already merged into dev and still on the remote: " + ", ".join(stale[:8])
            + ("…" if len(stale) > 8 else ""))

    # ── Disk ────────────────────────────────────────────────────────────────
    avail = values.get("disk_avail_kb") or ""
    if avail.isdigit():
        free_gb = int(avail) / 1024 / 1024
        if int(avail) < _SELFCHECK_MIN_FREE_KB:
            add("disk", "Disk space", "fail",
                f"{free_gb:.1f} GB free — a docker build needs 5 GB and will abort.",
                fix="disk-prune")
        else:
            cache_gb = _parse_size_gb(values.get("build_cache"))
            if cache_gb and cache_gb > _SELFCHECK_MAX_CACHE_GB:
                add("disk", "Disk space", "warn",
                    f"{free_gb:.1f} GB free, but {cache_gb:.1f} GB is docker build "
                    "cache nobody collects — every beta ship and promote adds layers.",
                    fix="disk-prune")
            else:
                add("disk", "Disk space", "ok", f"{free_gb:.1f} GB free.")

    # ── Versions ────────────────────────────────────────────────────────────
    released = values.get("released_version") or ""
    if released and released != APP_VERSION:
        add("prod-version", "Prod version", "warn",
            f"Serving v{APP_VERSION}, but the release ledger ends at v{released}. "
            "A promotion probably did not finish — try `dev.sh finish`.")
    elif released:
        add("prod-version", "Prod version", "ok", f"v{APP_VERSION}, matching the ledger.")

    roadmap = _roadmap_freshness(snap["dev_version"] or APP_VERSION)
    if not roadmap.get("current"):
        add("roadmap-gap", "Roadmap", "warn",
            f"No section for {roadmap.get('expected_section') or 'the open package'} — "
            "the developer plans from this file on every start.")
    else:
        add("roadmap-gap", "Roadmap", "ok", "Has a section for the open package.")

    order = {"fail": 0, "warn": 1, "ok": 2}
    findings.sort(key=lambda f: order.get(f["state"], 3))
    return findings


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


def _size_to_bytes(raw: str) -> int:
    """Parse Docker's compact size strings without exposing arbitrary output."""
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?b)\s*", raw, re.I)
    if not match:
        return 0
    powers = {"b": 0, "kb": 1, "mb": 2, "gb": 3, "tb": 4, "pb": 5}
    return int(float(match.group(1)) * (1000 ** powers[match.group(2).lower()]))


def _storage_payload(output: str, source: str) -> dict:
    values = _parse_metric_lines(output)
    total = int(max(0, values.get("filesystem_total", 0)))
    used = int(max(0, values.get("filesystem_used", 0)))
    available = int(max(0, values.get("filesystem_available", 0)))
    build_cache = int(max(0, values.get("docker_build_cache", 0)))
    images = int(max(0, values.get("docker_images", 0)))
    data = int(max(0, values.get("odysseus_data", 0)))
    for line in output.splitlines():
        key, separator, raw = line.partition("=")
        if not separator:
            continue
        if key == "docker_build_cache_raw":
            build_cache = _size_to_bytes(raw)
        elif key == "docker_images_raw":
            images = _size_to_bytes(raw)
    return {
        "available": bool(total),
        "source": source,
        "filesystem": {
            "total_bytes": total,
            "used_bytes": used,
            "available_bytes": available,
        },
        "breakdown": {
            "docker_build_cache_bytes": build_cache,
            "docker_images_bytes": images,
            "odysseus_data_bytes": data,
            "other_bytes": max(0, used - build_cache - images - data),
        },
    }


def _server_storage_snapshot() -> dict:
    """Return the host storage categories in one bounded SSH round trip."""
    try:
        result = _ssh_script(_HOST_STORAGE_SCRIPT, timeout=20)
        if result.returncode == 0:
            return _storage_payload(result.stdout, "server")
    except Exception as exc:
        logger.debug("system/storage: host probe unavailable: %s", exc)
    return _storage_payload("", "server")


def _read_releases(force: bool = False) -> list:
    """Parse the host's release ledger (version<TAB>commit<TAB>date).

    Cached like the status probe. Callers that use the ledger as a *guard*
    (POST /switch) must pass force=True. A stale cache can only ever hold FEWER
    entries than the file — the ledger is append-only — so it could reject a
    brand-new release but never admit a commit that was never released. Forcing
    on the guard path removes even that.
    """
    if not force:
        with _STATUS_REFRESH_LOCK:
            cached = _RELEASES_CACHE["releases"]
            if (
                cached is not None
                and time.monotonic() - _RELEASES_CACHE["at"] < _RELEASES_CACHE_SECONDS
            ):
                return cached
    releases = []
    try:
        r = _ssh("cat", _RELEASES)
        if r.returncode != 0:
            return releases
        for line in r.stdout.splitlines():
            # Tolerate whitespace-separated ledgers: a hand-appended line with
            # spaces instead of tabs used to parse as one field and vanish.
            parts = [p for p in line.strip().replace("\t", " ").split(" ") if p]
            if len(parts) >= 2 and parts[0] and parts[1]:
                releases.append({
                    "version": parts[0],
                    "commit": parts[1],
                    "date": parts[2] if len(parts) > 2 else "",
                })
    except Exception:
        logger.exception("system/releases: ledger read failed")
        return releases
    with _STATUS_REFRESH_LOCK:
        _RELEASES_CACHE.update(at=time.monotonic(), releases=releases)
    return releases


def setup_system_routes() -> APIRouter:
    router = APIRouter(prefix="/api/system")

    @router.get("/status")
    def get_status(request: Request, refresh: bool = False):
        """Deployment state for the System/Developer cards.

        One cached SSH round trip (`_host_status_snapshot`) plus a local file
        read for roadmap freshness. `origin` is fetched in the background, so
        `dev_version`/`beta_in_dev` describe the last successful fetch —
        `fetch_age_seconds` says how old that is.
        """
        require_admin(request)
        _maybe_refresh_origin()
        snap = _host_status_snapshot(force=refresh)
        dev_version = snap["dev_version"]
        return {
            "version": APP_VERSION,
            "dev_version": dev_version,
            "commit": snap["commit"],
            "beta_active": snap["beta_active"],
            "beta_branch": snap["beta_branch"],
            "beta_commit": snap["beta_commit"],
            "beta_in_dev": snap["beta_in_dev"],
            "beta_exposed": snap["beta_exposed"],
            "deploy_active": snap["deploy_active"],
            # The address a human types. Only sent while a beta is actually up,
            # so the UI can render a link without first deciding whether it
            # leads anywhere.
            "beta_url": BETA_PUBLIC_URL if snap["beta_active"] else None,
            # Promote is only safe/honest when a beta is live AND its commit is
            # already merged into origin/dev (what prod will actually build).
            "promotable": bool(snap["beta_active"] and snap["beta_in_dev"]),
            # Roadmap freshness is a local file read — never cache it, or an
            # edit would not clear the banner for up to a cache TTL.
            "roadmap": _roadmap_freshness(dev_version or APP_VERSION),
            # Empty dict = the developer clone is free. Local file read, so it
            # must not be cached either: a build that just finished has to
            # unlock the buttons on the next poll, not a cache TTL later.
            "active_round": _active_round(),
            "fetch_age_seconds": _fetch_age_seconds(),
        }

    @router.get("/roadmap-freshness")
    def roadmap_freshness(request: Request):
        require_admin(request)
        return _roadmap_freshness(APP_VERSION)

    @router.get("/metrics")
    def get_metrics(request: Request, refresh: bool = False):
        """Privacy-preserving host health snapshot for every signed-in user.

        This is the deliberately reduced, role-safe system view: the fixed
        probe exposes aggregate counters only — no deployment controls,
        process names, command lines, network addresses or host identity.
        The surrounding Developer routes remain admin-only. On beta/dev,
        where host SSH is intentionally unavailable, report the app container
        and label that scope explicitly.
        """
        if os.getenv("AUTH_ENABLED", "true").lower() != "false":
            user = get_current_user(request)
            if not user:
                raise HTTPException(401, "Authentication required")
        return _server_metrics_snapshot(force=refresh)

    @router.get("/storage")
    def get_storage(request: Request):
        """Host filesystem usage split into the categories shown by dev.sh disk."""
        require_admin(request)
        return _server_storage_snapshot()

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

    @router.get("/selfcheck")
    def selfcheck(request: Request, refresh: bool = False):
        """Is everything up to date and where it should be? (Alessio, 2026-08-15)

        Read-only. Every finding either names a whitelisted fix or is
        report-only — nothing here changes the system by being looked at.
        """
        require_admin(request)
        findings = _selfcheck_findings(force=refresh)
        return {
            "findings": findings,
            "worst": next((f["state"] for f in findings if f["state"] != "ok"), "ok"),
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    @router.post("/selfcheck/fix")
    def selfcheck_fix(body: SelfcheckFixBody, request: Request):
        """Apply ONE named fix from the whitelist.

        The whitelist is the security boundary: a self-check that can run an
        arbitrary command is a remote shell with a friendly name. Anything not
        in it is a 400, including a fix id that a future finding invents.
        """
        require_admin(request)
        fix_id = body.fix

        # Local file, no host involved: reset a round nobody is running any more.
        # dev.sh reads this file to know where it stands, so a stale one sends
        # the next agent down the wrong branch of `dev.sh next`.
        if fix_id == "cycle-reset":
            path = os.path.join(DATA_DIR, "dev", "cycle-state.json")
            try:
                if os.path.exists(path):
                    os.replace(path, path + ".abandoned")
            except Exception as e:
                logger.exception("system/selfcheck/fix: cycle reset failed")
                raise HTTPException(500, f"Could not reset the round: {e}")
            return {"ok": True, "fix": fix_id, "detail": "Round cleared (kept as .abandoned)."}

        cmd = _SELFCHECK_FIXES.get(fix_id)
        if not cmd:
            raise HTTPException(400, f"Unknown fix '{fix_id}'.")
        try:
            r = _ssh_script(cmd, timeout=180)
        except Exception as e:
            logger.exception("system/selfcheck/fix: %s failed to launch", fix_id)
            raise HTTPException(500, f"Fix failed: {e}")
        if r.returncode != 0:
            detail = (r.stderr or r.stdout or "").strip()[:300] or "ssh error"
            logger.error("system/selfcheck/fix %s rc=%s err=%s", fix_id, r.returncode, detail)
            raise HTTPException(500, f"Fix failed: {detail}")
        # The next check must not answer from a cache written before the fix.
        with _STATUS_REFRESH_LOCK:
            _STATUS_CACHE.update(at=0.0, snapshot=None)
        return {"ok": True, "fix": fix_id, "detail": (r.stdout or "").strip()[:300]}

    @router.get("/releases")
    def list_releases(request: Request, refresh: bool = False):
        """Released versions from the host ledger, newest last; marks current.

        The current commit comes from the shared status snapshot instead of its
        own `git rev-parse` — this endpoint is polled next to /status, and one
        SSH handshake is the whole cost of either.
        """
        require_admin(request)
        releases = _read_releases(force=refresh)
        current = _host_status_snapshot(force=refresh)["commit"]
        for rel in releases:
            rel["current"] = rel["commit"] == current
        return {"releases": releases, "current_commit": current}

    @router.get("/switch-log")
    def switch_log(request: Request):
        """Last outcomes recorded by switch-version.sh.

        A switch detaches itself (the rebuild kills this process), so the UI
        loses the thread the moment it starts. After the window is reopened this
        is how it learns whether the target came up, whether the auto-revert
        caught it, or whether the script died before doing anything.
        """
        require_admin(request)
        entries = []
        try:
            r = _ssh("tail", "-n", "20", _SWITCH_LOG)
            if r.returncode == 0:
                for line in r.stdout.splitlines():
                    parts = line.strip().split("\t")
                    if len(parts) >= 3:
                        entries.append({
                            "at": parts[0], "event": parts[1], "commit": parts[2],
                        })
        except Exception:
            logger.exception("system/switch-log: read failed")
        return {"entries": entries}

    @router.post("/switch")
    def switch_version(body: SwitchBody, request: Request):
        """Switch prod to a RELEASED version (down- or re-upgrade).

        Only commits from the host's release ledger are accepted — this
        endpoint must never let a client check out arbitrary tree states.
        Runs detached (systemd-run) because the rebuild restarts this
        very process, exactly like promote.
        """
        require_admin(request)

        # Preflight FIRST: the switch is detached, so this response is the only
        # chance to tell the user why nothing is going to happen.
        try:
            probe = _ssh_script(_SWITCH_PREFLIGHT_SCRIPT, timeout=12)
            reachable = probe.returncode == 0
        except Exception:
            logger.exception("system/switch: preflight probe failed")
            reachable = False
        if not reachable:
            raise HTTPException(503, _CLI_FALLBACK.format(commit=body.commit))
        pre = _parse_kv_lines(probe.stdout)

        # force: the ledger is the security guard here, never serve it cached.
        releases = _read_releases(force=True)
        if not releases:
            raise HTTPException(
                503,
                "Release ledger is empty or unreadable — nothing to switch to. "
                f"Check {_RELEASES} on the host.",
            )
        target = next((rel for rel in releases if rel["commit"] == body.commit), None)
        if not target:
            raise HTTPException(400, "Commit is not a released version — refusing to switch.")

        head = pre.get("head") or ""
        if head and (head == target["commit"] or target["commit"].startswith(head)
                     or head.startswith(target["commit"])):
            raise HTTPException(
                409, f"Production already runs v{target['version']} ({head})."
            )

        try:
            avail_kb = int(float(pre.get("disk_avail_kb", 0)))
        except (TypeError, ValueError):
            avail_kb = 0
        if avail_kb and avail_kb < _SWITCH_MIN_FREE_KB:
            raise HTTPException(
                507,
                f"Only {avail_kb // 1024 // 1024} GB free on the host — a rebuild "
                "needs 5 GB. Run 'docker image prune -f' first.",
            )

        if (pre.get("build_active") or "0") != "0":
            raise HTTPException(
                409,
                "A deployment is already running on the host (promote, switch or "
                "beta start). Wait for it to finish — two builds at once corrupt "
                "the checkout.",
            )

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

        # Never two deployments at once. /switch has checked this since v4.0;
        # /promote never did, and it stopped mattering the moment Update
        # appeared on a second page (v4.9): press it here, switch panels, press
        # it there, and two promote.sh units rebuild prod over each other. The
        # client's disabled state cannot be trusted for this — only the host
        # knows what is actually running.
        try:
            pre = _parse_kv_lines(_ssh_script(_SWITCH_PREFLIGHT_SCRIPT, timeout=10).stdout)
        except Exception:
            pre = {}
        if (pre.get("build_active") or "0") != "0":
            raise HTTPException(
                409,
                "A deployment is already running — wait for it to finish before "
                "starting another.",
            )

        # systemd-run (via sudo, per sudoers) so the promotion survives the
        # prod rebuild that restarts this very process. Unique unit name.
        # --uid=deploy is NOT optional, and its absence was not harmless.
        #
        # Without it systemd-run starts promote.sh as root, and every git
        # command inside it re-owns part of /opt/odysseus. That is where the
        # 2663 root-owned files found on 2026-08-15 came from — .git had
        # belonged to root since 2026-08-03, the date of the last release run
        # through this button. Prod was quietly un-promotable from the CLI for
        # six weeks because the UI kept taking the checkout away from `deploy`.
        #
        # Repairing the ownership then exposed the cause: root now trips git's
        # dubious-ownership guard, so the Update button failed at 128 while
        # still answering 200 to the browser. beta-start has always passed the
        # flag; only this route did not.
        unit = "odysseus-promote-ui-$(date +%s)"
        cmd = (
            f"sudo systemd-run --unit={unit} --collect --uid=deploy "
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
