from src.constants import APP_VERSION


def test_app_version_is_terra_smoke_target():
    assert APP_VERSION == "3.9.0"
