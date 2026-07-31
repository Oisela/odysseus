"""@-mention composer feature: attach an already-uploaded file without
re-uploading it (issue: "AI doesn't know which file I mean" / duplicates).

Covers two layers:
  * GET /api/upload/list — the route the popup queries (owner scoping,
    search, limit, response shape). Setup mirrors
    tests/test_upload_routes_owner_scope.py, which already pins the same
    owner-gate pattern for the sibling upload routes.
  * Static assertions against the JS so the wiring between atMention.js,
    fileHandler.js and chat.js can't silently drift apart, following the
    pattern in tests/test_roadmap_pipeline_static.py.
"""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
AT_MENTION = (ROOT / "static" / "js" / "atMention.js").read_text(encoding="utf-8")
CHAT = (ROOT / "static" / "js" / "chat.js").read_text(encoding="utf-8")
FILE_HANDLER = (ROOT / "static" / "js" / "fileHandler.js").read_text(encoding="utf-8")


# --- route tests -----------------------------------------------------------


class _AuthManager:
    is_configured = True

    def __init__(self, admins=()):
        self._admins = set(admins)

    def is_admin(self, user):
        return user in self._admins


class _Request:
    def __init__(self, user=None, auth_manager=None):
        self.state = SimpleNamespace(current_user=user)
        self.app = SimpleNamespace(state=SimpleNamespace(auth_manager=auth_manager))
        self.client = SimpleNamespace(host="127.0.0.1")


def _upload_endpoints(upload_handler, monkeypatch):
    import fastapi.dependencies.utils as dependency_utils
    from routes.upload_routes import router, setup_upload_routes

    monkeypatch.setattr(dependency_utils, "ensure_multipart_is_installed", lambda: None)
    before = len(router.routes)
    setup_upload_routes(upload_handler)
    routes = router.routes[before:]
    return {route.endpoint.__name__: route.endpoint for route in routes}


def _make_upload_store(tmp_path, monkeypatch):
    from src.upload_handler import UploadHandler
    from src import constants

    upload_dir = tmp_path / "uploads"
    dated = upload_dir / "2026" / "07" / "31"
    dated.mkdir(parents=True)

    alice_old_id = "a" * 32 + ".png"
    alice_new_id = "b" * 32 + ".txt"
    bob_id = "c" * 32 + ".png"
    for fid in (alice_old_id, alice_new_id, bob_id):
        (dated / fid).write_bytes(b"bytes")

    index = {
        "alice:old": {
            "id": alice_old_id,
            "path": str(dated / alice_old_id),
            "mime": "image/png",
            "size": 5,
            "name": alice_old_id,
            "original_name": "vacation-photo.png",
            "owner": "alice",
            "uploaded_at": "2026-07-01T10:00:00",
        },
        "alice:new": {
            "id": alice_new_id,
            "path": str(dated / alice_new_id),
            "mime": "text/plain",
            "size": 5,
            "name": alice_new_id,
            "original_name": "meeting-notes.txt",
            "owner": "alice",
            "uploaded_at": "2026-07-31T09:00:00",
        },
        "bob:one": {
            "id": bob_id,
            "path": str(dated / bob_id),
            "mime": "image/png",
            "size": 5,
            "name": bob_id,
            "original_name": "bob-private.png",
            "owner": "bob",
            "uploaded_at": "2026-07-31T08:00:00",
        },
    }
    (upload_dir / "uploads.json").write_text(json.dumps(index), encoding="utf-8")
    monkeypatch.setattr(constants, "UPLOAD_DIR", str(upload_dir))
    return UploadHandler(str(tmp_path), str(upload_dir)), alice_old_id, alice_new_id, bob_id


def test_list_uploads_hides_other_owners_files(tmp_path, monkeypatch):
    # A user must never see another user's uploads in the mention popup —
    # otherwise @-mention becomes a cross-account file-listing leak.
    handler, _old, _new, bob_id = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(
        list_uploads(_Request(user="alice", auth_manager=_AuthManager()))
    )

    ids = {f["id"] for f in result["files"]}
    assert bob_id not in ids
    assert len(ids) == 2


def test_list_uploads_denies_anonymous_when_auth_is_configured(tmp_path, monkeypatch):
    handler, *_ = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    with pytest.raises(Exception) as exc:
        asyncio.run(list_uploads(_Request(auth_manager=_AuthManager())))
    assert exc.value.status_code == 403


def test_list_uploads_allows_admin_to_see_other_owners_files(tmp_path, monkeypatch):
    # Mirrors download_file's admin bypass (test_upload_routes_owner_scope.py)
    # so the mention popup behaves consistently with direct file access.
    handler, _old, _new, bob_id = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(
        list_uploads(_Request(user="admin", auth_manager=_AuthManager(admins={"admin"})))
    )

    assert bob_id in {f["id"] for f in result["files"]}


def test_list_uploads_search_matches_original_name_case_insensitively(tmp_path, monkeypatch):
    handler, _old, new_id, _bob = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(
        list_uploads(_Request(user="alice", auth_manager=_AuthManager()), q="MEETING")
    )

    assert [f["id"] for f in result["files"]] == [new_id]


def test_list_uploads_limit_is_hard_capped_regardless_of_query_value(tmp_path, monkeypatch):
    # The client controls `limit` (it's a query param) — a raw pass-through
    # would let a crafted request dump the whole uploads.json in one call.
    handler, *_ = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(
        list_uploads(_Request(user="alice", auth_manager=_AuthManager()), limit=9999)
    )

    assert len(result["files"]) <= 50


def test_list_uploads_response_shape_matches_the_documented_contract(tmp_path, monkeypatch):
    handler, old_id, _new, _bob = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(
        list_uploads(_Request(user="alice", auth_manager=_AuthManager()), q="vacation")
    )

    assert list(result.keys()) == ["files"]
    entry = result["files"][0]
    assert entry["id"] == old_id
    assert entry["name"] == "vacation-photo.png"
    assert set(entry.keys()) == {"id", "name", "mime", "size", "uploaded_at"}


def test_list_uploads_sorts_newest_first(tmp_path, monkeypatch):
    handler, old_id, new_id, _bob = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(
        list_uploads(_Request(user="alice", auth_manager=_AuthManager()))
    )

    assert [f["id"] for f in result["files"]] == [new_id, old_id]


def test_list_uploads_single_user_mode_skips_owner_filter(tmp_path, monkeypatch):
    # No auth configured -> single-user mode, same fallback download_file uses.
    handler, old_id, new_id, bob_id = _make_upload_store(tmp_path, monkeypatch)
    list_uploads = _upload_endpoints(handler, monkeypatch)["list_uploads"]

    result = asyncio.run(list_uploads(_Request()))

    assert {f["id"] for f in result["files"]} == {old_id, new_id, bob_id}


# --- static JS wiring tests --------------------------------------------------


def test_at_mention_popup_reuses_the_slash_popup_css_family():
    """Alessio's constraint: no new CSS, style.css/index.html untouched.

    The popup must be built from the exact same classes the slash-command
    popup already uses, only the element id differs.
    """
    assert "POPUP_ID = 'at-mention-popup'" in AT_MENTION
    assert "el.className = 'slash-autocomplete-popup'" in AT_MENTION
    for cls in ("slash-ac-row", "slash-ac-row-sel", "slash-ac-token", "slash-ac-help", "slash-ac-empty"):
        assert cls in AT_MENTION


def test_at_mention_trigger_requires_word_boundary_before_at():
    """"user@host" text or a mid-word "@" must not open the popup — only a
    genuine mention start (line start or preceded by whitespace)."""
    assert "function _findTrigger(textarea)" in AT_MENTION
    assert "/\\s/.test(before)" in AT_MENTION


def test_at_mention_debounces_and_aborts_stale_requests():
    # A slow first keystroke's response must never clobber a faster later one.
    assert "DEBOUNCE_MS = 150" in AT_MENTION
    assert "new AbortController()" in AT_MENTION
    assert "signal: abortCtrl.signal" in AT_MENTION
    assert "e.name === 'AbortError'" in AT_MENTION


def test_at_mention_only_removes_its_own_fragment_not_the_whole_message():
    """Unlike slashAutocomplete's `textarea.value = token`, @-mention can
    trigger mid-message, so selecting a result must only excise the
    "@query" text via slice(start)/slice(end), never overwrite the whole
    textarea value the way the slash popup's insert() does."""
    insert_start = AT_MENTION.index("const insert = (item) => {")
    insert_end = AT_MENTION.index("\n  };", insert_start)
    insert_body = AT_MENTION[insert_start:insert_end]
    assert "textarea.value.slice(0, start) + textarea.value.slice(end)" in insert_body
    assert "textarea.value = item" not in insert_body


def test_at_mention_hits_the_list_endpoint_with_query_and_limit():
    assert "/api/upload/list?q=" in AT_MENTION
    assert "limit=${MAX_VISIBLE}" in AT_MENTION


def test_file_handler_exposes_mention_api_used_by_at_mention_and_chat():
    for symbol in ("export function addMention(", "export function getMentionIds(", "export function clearMentions("):
        assert symbol in FILE_HANDLER
    # And actually registered on the exported module object, not just defined.
    assert "addMention,\n" in FILE_HANDLER or "addMention," in FILE_HANDLER
    assert "getMentionIds," in FILE_HANDLER
    assert "clearMentions," in FILE_HANDLER


def test_file_handler_mentions_are_a_separate_list_from_pending_files():
    """Mentions reference already-uploaded files; pendingFiles holds raw File
    objects awaiting upload. Merging the two lists would make addFiles()
    try to re-upload something that's already on the server."""
    assert "let mentionedRefs = []" in FILE_HANDLER
    assert "mentionedRefs.some(r => r.id === ref.id)" in FILE_HANDLER


def test_file_handler_clear_pending_does_not_touch_mentions():
    """Deliberate per the spec: clearPending() fires on upload
    cancel/failure/retry and must not drop an unrelated @-mention."""
    start = FILE_HANDLER.index("export function clearPending()")
    end = FILE_HANDLER.index("\n}", start)
    body = FILE_HANDLER[start:end]
    assert "mentionedRefs" not in body


def test_chat_js_wires_at_mention_alongside_slash_autocomplete():
    assert "import('./atMention.js')" in CHAT
    assert "mod.initAtMention(ta)" in CHAT


def test_chat_js_sends_mention_ids_in_the_attachments_form_field():
    # ids must be folded in before the single `fd.append('attachments', ...)`
    # call, otherwise a mention-only message would send no attachments.
    mention_merge = CHAT.index("fileHandlerModule.getMentionIds")
    attachments_append = CHAT.index("fd.append('attachments', JSON.stringify(ids))")
    assert mention_merge < attachments_append
    assert "fileHandlerModule.clearMentions()" in CHAT


def test_chat_js_allows_sending_a_mention_only_message_with_no_text():
    """Guard at the top of the send handler used to only check
    getPendingCount(); a message that was ONLY an @-mention (no new upload,
    no typed text) would silently no-op instead of sending."""
    guard_start = CHAT.index("if (!msg.trim() && !fileHandlerModule.getPendingCount()")
    guard_line = CHAT[guard_start:CHAT.index("\n", guard_start)]
    assert "getMentionIds" in guard_line
