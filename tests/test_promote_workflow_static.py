"""The promotion must not bump the version before prod has pulled.

Incident 2026-07-31: `dev.sh promote-main` started the prod rebuild detached
and bumped the minor immediately afterwards. promote.sh on the host does its
own `git pull origin dev` whenever it gets there — and it got there after the
bump had landed. The 4.3.0 package therefore came up wearing **4.4.0**, and the
newly opened package then carried the same number as the released one, which is
exactly what "open the next package immediately" exists to prevent.

The rebuild restarts the very container dev.sh runs in, so the bump cannot
simply be moved after a wait — it moved into a second command, `dev.sh finish`,
which runs once the agent is back and only bumps after prod verifies.

These tests read the scripts as text. They live in the app repo because that is
what CI runs; the scripts themselves live in the setup repo, so a drift between
the two is the failure this file is meant to catch.
"""

from pathlib import Path

import pytest

SETUP = Path(__file__).resolve().parents[2] / "odysseus-setup" / "odysseus-entwickler"

pytestmark = pytest.mark.skipif(
    not (SETUP / "dev.sh").is_file(),
    reason="setup repo not checked out next to the app repo",
)


def _dev_sh() -> str:
    return (SETUP / "dev.sh").read_text(encoding="utf-8")


def _block(name: str) -> str:
    """The body of one case arm of dev.sh."""
    src = _dev_sh()
    start = src.index(f"\n  {name})\n")
    return src[start:src.index("\n    ;;", start)]


def test_promote_main_does_not_bump():
    """The bug in one line: a bump here races promote.sh's pull on the host."""
    # The literal invocation, not the word: the arm's comment explains the
    # incident and legitimately contains "bump".
    assert 'bash "$0" bump' not in _block("promote-main"), (
        "promote-main must hand the bump to `finish`, which runs after prod is verified"
    )


def test_promote_records_the_version_it_ships():
    """finish can only check prod against the promised version if it is stored."""
    body = _block("promote")
    assert 'ver=$(sed -n' in body and "APP_VERSION" in body
    assert '_write_cycle "$branch"' in body and '"$ver"' in body
    # captured before the push, so a later commit cannot change what was promised
    assert body.index("ver=") < body.index("git push origin dev")


def test_finish_refuses_unless_a_promotion_is_in_flight():
    body = _block("finish")
    assert 'phase' in body and '"promoting"' in body
    assert "nothing to finish" in body


def test_finish_bumps_only_after_prod_verifies():
    """Without the gate, a failed promotion silently opens a new package."""
    body = _block("finish")
    verify_at = body.index('verify prod "$ver"')
    assert verify_at < body.index("bump minor"), "the gate must come first"
    assert verify_at < body.index("dev:main"), "main must not move before verification"
    assert "exit 1" in body


def test_finish_does_not_skip_a_version_on_the_bug_track():
    """bugfix already bumped its patch; a minor bump here would skip a release."""
    body = _block("finish")
    assert 'track' in body and '"bug"' in body


def test_main_branch_is_moved_by_the_workflow():
    """Prod tracks dev. Alessio says "push to main", so main has to follow —
    before this it drifted behind by whole releases."""
    assert "dev:main" in _block("finish")


def test_the_tool_is_reachable_where_an_agent_looks():
    """An agent lost a turn to `./dev.sh: not found`. The shim answers at the
    obvious path next to the clone; it must stay a shim, not a second copy."""
    shim = (SETUP / "dev-shim.sh").read_text(encoding="utf-8")
    assert "exec bash /app/data/skills/werkzeuge/odysseus-entwickler/dev.sh" in shim
    skill = (SETUP / "SKILL.md").read_text(encoding="utf-8")
    assert "bash /app/data/dev/dev.sh" in skill, "the RULES block must name a real path"


def test_the_skill_sends_the_agent_to_finish():
    """Both tracks end in `finish`, and on the feature track it must come after
    the promotion — an agent following the block top to bottom has to hit the
    verification, not stop at the detach."""
    skill = (SETUP / "SKILL.md").read_text(encoding="utf-8")
    feature = skill[skill.index("TRACK FEATURE"):]
    feature = feature[:feature.index("GO-WORDS")]
    assert "dev.sh finish" in feature
    assert feature.index("promote-main") < feature.index("dev.sh finish")
    bug = skill[skill.index("TRACK BUG"):skill.index("TRACK FEATURE")]
    assert "dev.sh finish" in bug, "a bugfix needs the same verification"
