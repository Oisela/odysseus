// quoteAsk.js — select text in a chat message, click "Ask" and the excerpt
// lands in the composer as a markdown blockquote (v3.5, Alessios Wunsch:
// "Text markieren und genau danach fragen", ChatGPT-style).
//
// Deliberately stateless: the quote is inserted straight into #message, so it
// is visible, editable, and rides every send path (normal / agent / group /
// compare) without touching their submit handlers.

let _btn = null;
let _pendingText = '';

// Rebuild markdown source from a selected DOM range.
//
// selection.toString() is unusable on rendered answers: KaTeX emits the math
// TWICE (a hidden .katex-mathml twin next to the visible .katex-html), so a
// quoted formula came out duplicated and shredded across lines — "> ψ / > † /
// > ψ=⟨ψ|ψ⟩=‖ψ‖ / > 2" instead of "> $\psi^\dagger\psi = \langle\psi|\psi\rangle
// = \|\psi\|^2 = 1$" (Alessio 2026-07-27). So: clone the range, swap every
// rendered formula for its original TeX (KaTeX keeps it in an <annotation>),
// turn block elements back into line breaks, and read the text off that.
const _QA_BLOCKS = 'p,div,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr,hr';

function _rangeToMarkdown(range) {
  const host = document.createElement('div');
  host.appendChild(range.cloneContents());

  host.querySelectorAll('.katex').forEach((k) => {
    const ann = k.querySelector('annotation[encoding="application/x-tex"]');
    const tex = ann ? ann.textContent.trim() : '';
    // .katex-display wraps display math — replace the whole wrapper so the
    // $$ ends up on its own line.
    const wrap = k.closest('.katex-display') || k;
    const display = wrap !== k;
    const src = tex
      ? (display ? `\n$$${tex}$$\n` : `$${tex}$`)
      : (k.querySelector('.katex-html')?.textContent || k.textContent || '');
    wrap.replaceWith(document.createTextNode(src));
  });
  // Any half-selected formula can leave the hidden MathML twin behind.
  host.querySelectorAll('.katex-mathml, annotation').forEach((e) => e.remove());
  // Chrome's copy/paste chrome inside code blocks isn't part of the quote.
  host.querySelectorAll('.copy-code, .run-code, .edit-code').forEach((e) => e.remove());

  host.querySelectorAll('br').forEach((b) => b.replaceWith(document.createTextNode('\n')));
  host.querySelectorAll('strong,b').forEach((e) => e.replaceWith(document.createTextNode(`**${e.textContent}**`)));
  host.querySelectorAll('em,i').forEach((e) => e.replaceWith(document.createTextNode(`*${e.textContent}*`)));
  host.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const lang = code ? (code.getAttribute('data-lang') || '') : '';
    pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${(code || pre).textContent.replace(/\n$/, '')}\n\`\`\`\n`));
  });
  host.querySelectorAll('code').forEach((c) => c.replaceWith(document.createTextNode('`' + c.textContent + '`')));
  host.querySelectorAll('li').forEach((li) => li.insertBefore(document.createTextNode('- '), li.firstChild));
  host.querySelectorAll('hr').forEach((h) => h.replaceWith(document.createTextNode('\n---\n')));
  host.querySelectorAll(_QA_BLOCKS).forEach((el) => el.appendChild(document.createTextNode('\n')));

  return (host.textContent || '')
    .replace(/\u00A0/g, ' ')  // NBSP from the rendered markup
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

  // Quote the markdown SOURCE, not the rendered glyphs (see _rangeToMarkdown).
  // Fall back to the plain string if reconstruction yields nothing usable.
  let src = '';
  try { src = _rangeToMarkdown(range); } catch (_) { src = ''; }
  _pendingText = src || text;
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
