from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_composer_has_independent_microphone_button():
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    app = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    assert 'id="composer-mic-btn"' in html
    assert "const micBtn = el('composer-mic-btn')" in app
    assert "micBtn.addEventListener('click'" in app


def test_streaming_send_button_does_not_hide_microphone():
    app = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    assert "if (micBtn) micBtn.hidden = !_isSttEnabled();" in app
    assert "if (sendBtn.dataset.mode === 'streaming')" in app
