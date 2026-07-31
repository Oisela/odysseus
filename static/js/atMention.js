// static/js/atMention.js
// Popup that lets the user @-mention a file they already uploaded earlier in
// this session (or a previous one) and attach it without re-uploading it.
// Modeled directly on slashAutocomplete.js — same popup element type
// ('.slash-autocomplete-popup' family of CSS classes, defined in
// style.css), same show/hide/position/keydown machinery — just a different
// trigger character and a server-backed (not local) match list. Unlike the
// slash popup, which only triggers when "/" starts the whole message, "@"
// can appear mid-message, so this needs a backward scan from the cursor
// instead of a whole-value check.

import { addMention } from './fileHandler.js';

const POPUP_ID = 'at-mention-popup';
const MAX_VISIBLE = 20;
const DEBOUNCE_MS = 150;

function _ensurePopup() {
  let el = document.getElementById(POPUP_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = POPUP_ID;
  el.className = 'slash-autocomplete-popup';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Uploaded files');
  document.body.appendChild(el);
  return el;
}

function _position(popup, textarea) {
  const r = textarea.getBoundingClientRect();
  const maxH = Math.min(window.innerHeight * 0.5, 360);
  popup.style.maxHeight = maxH + 'px';
  popup.style.left = Math.round(r.left) + 'px';
  popup.style.width = Math.max(280, Math.round(Math.min(r.width, 520))) + 'px';
  const aboveSpace = r.top;
  if (aboveSpace > maxH + 20) {
    popup.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    popup.style.top = '';
  } else {
    popup.style.top = (r.bottom + 6) + 'px';
    popup.style.bottom = '';
  }
}

function _formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function _render(popup, items, selectedIdx) {
  if (!items.length) {
    popup.innerHTML = '<div class="slash-ac-empty">No uploaded files match</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const sel = i === selectedIdx ? ' slash-ac-row-sel' : '';
    const detail = [_formatSize(it.size), it.mime || ''].filter(Boolean).join(' · ');
    html += `<div class="slash-ac-row${sel}" role="option" data-idx="${i}">`
         +    `<span class="slash-ac-token">${_esc(it.name)}</span>`
         +    `<span class="slash-ac-help">${_esc(detail)}</span>`
         + `</div>`;
  }
  popup.innerHTML = html;
  const selEl = popup.querySelector('.slash-ac-row-sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}

function _esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}

// Look backward from the cursor for an "@" that starts a mention: either at
// the very beginning of the textarea or preceded by whitespace/newline, with
// nothing but non-whitespace characters between it and the cursor. Returns
// null when the cursor isn't inside such a run (covers plain "user@host"
// text, multi-word prose, etc. — those must not trigger the popup).
function _findTrigger(textarea) {
  const pos = textarea.selectionStart;
  if (pos == null || pos !== textarea.selectionEnd) return null;
  const value = textarea.value;
  let i = pos;
  while (i > 0) {
    const ch = value[i - 1];
    if (ch === '@') {
      const before = i - 2 >= 0 ? value[i - 2] : '';
      if (i - 1 === 0 || /\s/.test(before)) {
        return { start: i - 1, end: pos, query: value.slice(i, pos) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

export function initAtMention(textarea) {
  if (!textarea || textarea._atMentionWired) return;
  textarea._atMentionWired = true;

  let popup = null;
  let visible = false;
  let items = [];
  let selectedIdx = 0;
  let trigger = null;
  let debounceTimer = null;
  let abortCtrl = null;

  const hide = () => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} abortCtrl = null; }
    if (!visible) return;
    visible = false;
    trigger = null;
    if (popup) popup.style.display = 'none';
  };

  const show = () => {
    if (!popup) popup = _ensurePopup();
    visible = true;
    popup.style.display = 'block';
    _position(popup, textarea);
  };

  const runFetch = (trig) => {
    if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} }
    abortCtrl = new AbortController();
    const url = `/api/upload/list?q=${encodeURIComponent(trig.query)}&limit=${MAX_VISIBLE}`;
    fetch(url, { credentials: 'same-origin', signal: abortCtrl.signal })
      .then(res => (res.ok ? res.json() : { files: [] }))
      .then(data => {
        // A slower older request can resolve after a newer one — only apply
        // results if this call's trigger is still the live one (position AND
        // query both matter: the user may have moved the cursor to a
        // different "@" while this was in flight).
        const current = _findTrigger(textarea);
        if (!current || current.start !== trig.start || current.query !== trig.query) return;
        items = (Array.isArray(data.files) ? data.files : []).slice(0, MAX_VISIBLE);
        selectedIdx = 0;
        show();
        _render(popup, items, selectedIdx);
      })
      .catch(e => {
        if (e && e.name === 'AbortError') return;  // superseded by a newer keystroke
        items = [];
        show();
        _render(popup, items, selectedIdx);
      });
  };

  const refresh = () => {
    const trig = _findTrigger(textarea);
    if (!trig) { hide(); return; }
    trigger = trig;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runFetch(trig), DEBOUNCE_MS);
  };

  const insert = (item) => {
    if (!trigger) return;
    const { start, end } = trigger;
    // Remove just the "@query" fragment — NOT the whole textarea value like
    // slashAutocomplete does, since "@" can sit anywhere in an in-progress
    // message.
    textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
    addMention({ id: item.id, name: item.name, mime: item.mime });
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(start, start);
    hide();
  };

  textarea.addEventListener('input', refresh);
  // Cursor can move into/out of an "@…" run without an input event (arrow
  // keys, click) — re-evaluate the trigger on those too so the popup tracks
  // the cursor, not just the last edit.
  textarea.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) refresh();
  });
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('blur', () => { setTimeout(hide, 120); });  // delay so click works

  textarea.addEventListener('keydown', (e) => {
    if (!visible || !items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % items.length;
      _render(popup, items, selectedIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + items.length) % items.length;
      _render(popup, items, selectedIdx);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      insert(items[selectedIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });

  window.addEventListener('resize', () => { if (visible) _position(popup, textarea); });

  document.addEventListener('mousedown', (e) => {
    if (!visible || !popup) return;
    const row = e.target.closest?.('.slash-ac-row');
    if (row && popup.contains(row)) {
      e.preventDefault();
      const idx = Number(row.dataset.idx);
      if (Number.isInteger(idx) && items[idx]) insert(items[idx]);
    }
  });
}

export default { initAtMention };
