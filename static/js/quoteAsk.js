// quoteAsk.js — select text in a chat message, click "Ask" and the excerpt
// lands in the composer as a markdown blockquote (v3.5, Alessios Wunsch:
// "Text markieren und genau danach fragen", ChatGPT-style).
//
// Deliberately stateless: the quote is inserted straight into #message, so it
// is visible, editable, and rides every send path (normal / agent / group /
// compare) without touching their submit handlers.

let _btn = null;
let _pendingText = '';

function _ensureBtn() {
  if (_btn) return _btn;
  _btn = document.createElement('button');
  _btn.type = 'button';
  _btn.id = 'quote-ask-btn';
  _btn.className = 'quote-ask-btn';
  _btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Ask';
  // mousedown (not click): fires before the browser collapses the selection.
  _btn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    _insertQuote(_pendingText);
    _hide();
  });
  document.body.appendChild(_btn);
  return _btn;
}

function _hide() {
  if (_btn) _btn.style.display = 'none';
  _pendingText = '';
}

function _insertQuote(text) {
  const input = document.getElementById('message');
  if (!input || !text) return;
  const quote = text.trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
  const existing = input.value;
  // Prepend the quote, keep whatever the user already typed after it.
  input.value = quote + existing.replace(/^\s+/, '');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  // Composer auto-grow listens on input events — poke it.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  try { window.getSelection()?.removeAllRanges(); } catch (_) {}
}

function _maybeShow() {
  const sel = window.getSelection();
  const history = document.getElementById('chat-history');
  if (!sel || sel.isCollapsed || !history) { _hide(); return; }
  const text = sel.toString().trim();
  if (!text || text.length < 2 || text.length > 8000) { _hide(); return; }
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !history.contains(range.commonAncestorContainer)) { _hide(); return; }
  // Don't offer inside editable areas (message edit boxes etc.).
  const anchorEl = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (anchorEl && anchorEl.closest('textarea, input, [contenteditable="true"]')) { _hide(); return; }

  _pendingText = text;
  const btn = _ensureBtn();
  const rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { _hide(); return; }
  btn.style.display = 'inline-flex';
  // Above the selection, clamped to the viewport.
  const bw = btn.offsetWidth || 60;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - 8));
  const top = Math.max(8, rect.top - 34);
  btn.style.left = `${left}px`;
  btn.style.top = `${top}px`;
}

function init() {
  // mouseup covers mouse selection; selectionchange catches keyboard and
  // touch selection (debounced — it fires per caret move).
  let t = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(t);
    t = setTimeout(_maybeShow, 180);
  });
  document.addEventListener('mousedown', (ev) => {
    if (_btn && ev.target !== _btn && !_btn.contains(ev.target)) _hide();
  });
  window.addEventListener('scroll', _hide, true);
  window.addEventListener('resize', _hide);
}

export default { init };
