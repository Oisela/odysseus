"""Copy-paste of images into the notes rich editor.

Alessio (2026-07-31): "grundsätzlich überall, besonders in Notizen,
Copy-Paste von Bildern zulassen." The rich editor's paste handler used to
accept only `text/plain` and silently drop any pasted file — copying a
screenshot into a note just did nothing. This adds an image branch modeled
on the roadmap's image paste (static/js/admin.js) and the chat composer's
upload (static/js/fileHandler.js): upload to /api/upload, then insert the
result as an <img> at the caret so it round-trips through markdown as
`![](...)`.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NRE_JS = (ROOT / "static" / "js" / "notesRichEditor.js").read_text(encoding="utf-8")


def _paste_handler_body():
    """Slice out just the `rich.addEventListener('paste', ...)` callback body."""
    start = NRE_JS.index("rich.addEventListener('paste'")
    end = NRE_JS.index("\n  });", start)
    return NRE_JS[start:end]


def test_paste_handler_inspects_clipboard_items_for_images():
    """Must walk clipboardData.items looking for a file/image entry BEFORE
    falling back to the text/plain path — otherwise a pasted image is
    silently lost, which is the bug Alessio reported."""
    body = _paste_handler_body()
    assert "e.clipboardData.items" in body
    assert "item.kind === 'file'" in body
    assert "item.type.startsWith('image/')" in body


def test_paste_handler_stops_propagation_for_pasted_images():
    """app.js installs a window-level paste listener that drops any pasted
    file into the CHAT attach strip. Without stopPropagation here, an image
    pasted into a note would land in the note AND the chat attachments —
    admin.js hit the identical trap with the roadmap's image paste and fixed
    it the same way, so notes must carry the same guard."""
    body = _paste_handler_body()
    assert "e.stopPropagation()" in body
    # The fix must stay documented, not just present — a bare call with no
    # explanation is exactly the kind of thing a future refactor deletes.
    assert "attach strip" in body


def test_text_plain_fallback_survives_the_image_branch():
    """The original behaviour — paste as plain text, since pasted HTML from
    chat/web would otherwise leak formatting into the serialized markdown —
    must still run whenever the clipboard has no image."""
    body = _paste_handler_body()
    assert "getData('text/plain')" in body
    assert "document.execCommand('insertText', false, text)" in body


def test_image_upload_posts_to_upload_endpoint_with_files_field():
    """Same upload contract as the chat composer and the roadmap: POST
    multipart field "files" to /api/upload."""
    assert "/api/upload`" in NRE_JS
    assert "fd.append('files', file" in NRE_JS


def test_image_upload_reads_server_error_detail_instead_of_swallowing_it():
    """A failed upload (429 rate limit, 413 too large, ...) must surface the
    server's reason rather than vanish silently — the same fix already
    applied to fileHandler.js's uploadPending (issue #1346)."""
    assert "errBody.detail || errBody.error" in NRE_JS
    assert "throw new Error(detail || `Upload failed (HTTP ${res.status})`)" in NRE_JS


def test_failed_upload_leaves_no_broken_placeholder_behind():
    """Spec point 6: on failure, the pending placeholder must be removed —
    never left dangling as broken text in the note."""
    assert "if (placeholder.isConnected) placeholder.remove();" in NRE_JS


def test_pending_placeholder_is_stripped_from_saved_markdown():
    """The "Uploading image…" placeholder is UI feedback only. If a sync
    fires while the upload is still in flight (the user kept typing
    elsewhere), Turndown must drop the placeholder entirely rather than
    writing its literal text into the saved note."""
    assert "note-rich-img-pending" in NRE_JS
    assert "nreImgPending" in NRE_JS
    assert "replacement: () => ''" in NRE_JS
