"""Every /api/system route must be admin-gated.

These routes redeploy production, stop the beta and switch versions. Until v4.0
not one of them had a test — the gate was correct, but nothing stopped a future
endpoint from being added without `require_admin`. This iterates the router
instead of listing endpoints by hand, so a new route is covered the moment it
exists.
"""

import inspect

import pytest
from fastapi import HTTPException

from routes import system_routes


def _handlers():
    router = system_routes.setup_system_routes()
    return [(r.path, r.endpoint) for r in router.routes]


def test_router_exposes_the_expected_surface():
    """A canary: if a route appears or vanishes, this test says so out loud."""
    paths = {path for path, _ in _handlers()}
    assert paths == {
        "/api/system/status",
        "/api/system/roadmap-freshness",
        "/api/system/metrics",
        "/api/system/roadmap",
        "/api/system/roadmap/builds",
        "/api/system/roadmap/builds/{session_id}",
        "/api/system/beta-start",
        "/api/system/beta-stop",
        "/api/system/releases",
        "/api/system/switch",
        "/api/system/switch-log",
        "/api/system/promote",
        "/api/system/selfcheck",
        "/api/system/selfcheck/fix",
    }


@pytest.mark.parametrize("path,handler", _handlers(), ids=lambda v: getattr(v, "__name__", v))
def test_every_system_route_calls_require_admin(path, handler):
    """Source-level check: the gate must be the first thing the handler does."""
    source = inspect.getsource(handler)
    assert "require_admin(request)" in source, f"{path} is not admin-gated"


def test_non_admin_request_is_refused_by_every_route(monkeypatch):
    """Behavioural counterpart: with the gate raising, no handler swallows it."""
    def deny(_request):
        raise HTTPException(403, "Admin only")

    monkeypatch.setattr(system_routes, "require_admin", deny)
    # Any SSH must be impossible to reach — if a handler runs past the gate,
    # this raises a distinctive error rather than quietly touching the host.
    def unreachable(*_a, **_k):
        raise AssertionError("handler ran past require_admin")

    monkeypatch.setattr(system_routes, "_ssh", unreachable)
    monkeypatch.setattr(system_routes, "_ssh_script", unreachable)

    for path, handler in _handlers():
        params = inspect.signature(handler).parameters
        kwargs = {}
        for name in params:
            if name == "request":
                kwargs["request"] = None
            elif name == "body":
                kwargs["body"] = object()
            elif name == "session_id":
                kwargs["session_id"] = "s1"
        with pytest.raises(HTTPException) as exc:
            handler(**kwargs)
        assert exc.value.status_code == 403, f"{path} did not refuse a non-admin"
