from pathlib import Path


def test_builtin_mcp_servers_stay_on_compatible_major_version():
    requirements = (
        Path(__file__).resolve().parents[1] / "requirements.txt"
    ).read_text(encoding="utf-8").splitlines()

    assert "mcp<2" in requirements
    assert "mcp" not in requirements
