"""The beta channel has to be reachable from a browser, not just from the host.

Until v4.6 the beta address existed in no file: the host probe curled
127.0.0.1:7001 and the UI printed `branch @ commit`, so the only way in was to
remember the URL. On 2026-08-15 a running beta looked dead because the guess
(`odysseus-beta:7001`) named a host that does not exist.

The second half is `beta_exposed`. `tailscale serve --https=7001` and the
container are independent: beta-stop.sh drops the serve, and an abort inside
downgrade-roundtrip.sh leaves it dropped. In that state the host probe is green
and every browser gets connection refused, which is the 2026-07-20 stumble.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_beta_url_is_a_constant_not_hardcoded_in_the_ui():
    constants = _read("src/constants.py")
    assert "BETA_PUBLIC_URL" in constants
    assert "ODYSSEUS_BETA_PUBLIC_URL" in constants, "must stay overridable per install"
    # https and the full MagicDNS name are not decoration: tailscale serve
    # publishes 7001 only in that form, unlike 7000.
    assert "https://" in constants.split("BETA_PUBLIC_URL", 1)[1].split("\n\n", 1)[0]

    # The JS must take the address from the API, never carry its own copy.
    admin = _read("static/js/admin.js")
    assert "tailec54cf" not in admin
    assert "d.beta_url" in admin


def test_status_reports_exposure_separately_from_liveness():
    routes = _read("routes/system_routes.py")
    assert "tailscale serve status" in routes
    assert "beta_exposed" in routes
    # Exposure is only meaningful while the beta is up — a parked beta is off,
    # not unexposed, and must not raise a warning of its own.
    assert 'beta_active and values.get("beta_exposed") == "1"' in routes
    # The URL is only handed out for a beta that answers, so the UI never
    # renders a link into nothing.
    assert 'BETA_PUBLIC_URL if snap["beta_active"] else None' in routes


def test_the_probe_still_costs_one_round_trip():
    """The exposure check belongs in the existing script, not a second SSH call.

    /api/system/status is polled every 30 s by the Developer page; it was cut
    from 4.22 s to 0.66 s by collapsing six SSH calls into one, and that has to
    survive additions.
    """
    routes = _read("routes/system_routes.py")
    script = routes.split("_HOST_STATUS_SCRIPT = f\"\"\"", 1)[1].split('"""', 1)[0]
    assert "tailscale serve status" in script


def test_beta_row_renders_all_three_states():
    admin = _read("static/js/admin.js")
    row = admin.split("function _renderBetaRow", 1)[1].split("\nasync function", 1)[0]
    assert "'not running'" in row
    assert "dev-beta-link" in row
    assert "running, not shared on :7001" in row
    # A link that cannot be reached is worse than no link.
    assert "d.beta_exposed && d.beta_url" in row


def test_starting_the_beta_hands_over_the_address():
    admin = _read("static/js/admin.js")
    assert "sayWithLink" in admin
    beta_buttons = admin.split("function _initBetaButtons", 1)[1]
    assert "already_running" in beta_buttons
    assert "sayWithLink('Beta is up —')" in beta_buttons
