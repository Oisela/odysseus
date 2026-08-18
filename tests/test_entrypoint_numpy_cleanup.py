from pathlib import Path
import subprocess


ENTRYPOINT = Path(__file__).parents[1] / "docker" / "entrypoint.sh"


def test_entrypoint_removes_only_user_site_numpy_distributions():
    script = ENTRYPOINT.read_text(encoding="utf-8")

    assert "/app/.local/lib/python*/site-packages" in script
    assert "-name 'numpy'" in script
    assert "-name 'numpy-*.dist-info'" in script
    assert "-name 'numpy.libs'" in script
    assert "-exec rm -rf -- {} +" in script
    assert "rm -rf /app/.local" not in script


def test_entrypoint_shell_syntax():
    subprocess.run(["sh", "-n", str(ENTRYPOINT)], check=True)
