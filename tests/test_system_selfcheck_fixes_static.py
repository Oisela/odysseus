from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / "routes" / "system_routes.py").read_text(encoding="utf-8")


def test_clone_and_merged_branch_findings_have_real_whitelisted_fixes():
    assert '"clone-reset": (' in SOURCE
    assert 'fix="clone-reset"' in SOURCE
    assert '"branches-prune": (' in SOURCE
    assert 'fix="branches-prune"' in SOURCE


def test_clone_fix_is_bounded_to_the_developer_clone():
    assert 'git -C {_CLONE_DIR} reset --hard HEAD' in SOURCE
    assert 'git -C {_CLONE_DIR} clean -fd' in SOURCE
