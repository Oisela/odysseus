"""Static HTTP headers for url-based MCP transports.

Some MCP servers (RemNote's desktop bridge, most self-hosted ones) authenticate
with a fixed bearer token and speak no OAuth. These cover that the token is
parsed strictly, survives a reconnect, and suppresses the OAuth flow.
"""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from src.mcp_manager import McpManager, decode_server_headers
from routes.mcp_routes import _parse_header_form_field


# --- decode_server_headers ---------------------------------------------------

def test_decode_returns_dict_for_stored_json():
    srv = SimpleNamespace(name="s", headers=json.dumps({"Authorization": "Bearer abc"}))
    assert decode_server_headers(srv) == {"Authorization": "Bearer abc"}


def test_decode_returns_none_when_absent_or_empty():
    assert decode_server_headers(SimpleNamespace(name="s", headers=None)) is None
    assert decode_server_headers(SimpleNamespace(name="s", headers="{}")) is None
    assert decode_server_headers(SimpleNamespace(name="s")) is None


def test_decode_returns_none_on_malformed_json():
    # Must fall back to None (→ OAuth path) rather than connecting with a
    # half-built header set.
    srv = SimpleNamespace(name="s", headers="{not json")
    assert decode_server_headers(srv) is None


def test_decode_coerces_values_to_str():
    srv = SimpleNamespace(name="s", headers=json.dumps({"X-Version": 2}))
    assert decode_server_headers(srv) == {"X-Version": "2"}


# --- _parse_header_form_field ------------------------------------------------

def test_parse_accepts_json_object():
    assert _parse_header_form_field('{"Authorization": "Bearer x"}') == {"Authorization": "Bearer x"}


def test_parse_returns_none_for_blank():
    assert _parse_header_form_field(None) is None
    assert _parse_header_form_field("   ") is None


def test_parse_rejects_malformed_json():
    # Loud 400 instead of a silent drop: a missing auth header would otherwise
    # surface as an opaque 401 from the MCP server.
    with pytest.raises(HTTPException) as exc:
        _parse_header_form_field("{nope")
    assert exc.value.status_code == 400


def test_parse_rejects_non_object():
    with pytest.raises(HTTPException):
        _parse_header_form_field('["a", "b"]')


def test_parse_rejects_line_breaks():
    # Header injection: a newline in the value could append further headers.
    with pytest.raises(HTTPException):
        _parse_header_form_field('{"X": "a\\r\\nX-Evil: 1"}')


# --- routing -----------------------------------------------------------------

def test_headers_are_passed_through_to_http_connect():
    mgr = McpManager()
    seen = {}

    async def fake_start(server_id, name, url, headers=None):
        seen["headers"] = headers
        return True

    with patch.object(McpManager, "_start_http_connect", side_effect=fake_start):
        asyncio.run(mgr.connect_server(
            "id1", "n", "http", url="https://x/mcp",
            headers={"Authorization": "Bearer t"},
        ))
    assert seen["headers"] == {"Authorization": "Bearer t"}


def test_sse_transport_receives_headers():
    mgr = McpManager()
    seen = {}

    async def fake_sse(server_id, name, url, headers=None):
        seen["headers"] = headers
        return True

    with patch.object(McpManager, "_connect_sse", side_effect=fake_sse):
        asyncio.run(mgr.connect_server(
            "id1", "n", "sse", url="https://x/sse",
            headers={"Authorization": "Bearer t"},
        ))
    assert seen["headers"] == {"Authorization": "Bearer t"}


def test_no_headers_keeps_oauth_path():
    mgr = McpManager()
    seen = {}

    async def fake_start(server_id, name, url, headers=None):
        seen["headers"] = headers
        return True

    with patch.object(McpManager, "_start_http_connect", side_effect=fake_start):
        asyncio.run(mgr.connect_server("id1", "n", "http", url="https://x/mcp"))
    assert seen["headers"] is None
