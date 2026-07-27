/**
 * Notes Rich Editor — WYSIWYG editing for plain-text notes.
 *
 * Markdown stays the storage format: the editor renders the note's markdown
 * into a contenteditable (via markdown.js), and serializes the edited HTML
 * back to markdown with Turndown (+ GFM) on every input. The caller keeps a
 * hidden <textarea class="note-form-content"> as the single source of truth —
 * this module mirrors markdown into it, so every existing save path keeps
 * working untouched.
 *
 * Segments that can't survive an HTML round-trip (math, mermaid, pipe
 * tables) are protected: shown as atomic contenteditable="false" islands
 * whose original markdown is carried in data-md and emitted verbatim on
 * serialize. Editing those goes through the raw-markdown toggle.
 */

import markdownModule from './markdown.js';

// ── Lazy-load Turndown (same pattern as document.js ensureDocx) ──
let _turndownReady = null;
function ensureTurndown() {
  if (_turndownReady) return _turndownReady;
  if (window.TurndownService && window.turndownPluginGfm) return (_turndownReady = Promise.resolve());
  _turndownReady = new Promise((resolve, reject) => {
    const load = (src) => new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
    load('/static/lib/turndown.min.js')
      .then(() => load('/static/lib/turndown-plugin-gfm.min.js'))
      .then(resolve, reject);
  });
  return _turndownReady;
}

let _td = null;
function _turndown() {
  if (_td) return _td;
  const td = new window.TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  td.use(window.turndownPluginGfm.gfm);
  // markdown.js has no concept of backslash-escapes: anything Turndown
  // escapes (\* \_ \# …) renders literally INCLUDING the backslash, and the
  // next serialize escapes that backslash again — every open/save cycle
  // doubled the garbage (found live on the beta, 2026-07-27). Serialize
  // verbatim instead: literal markdown syntax typed into the rich editor
  // simply renders on the next open, exactly like the old raw textarea.
  td.escape = (s) => s;
  // Protected islands (math/mermaid/tables) → their original markdown.
  td.addRule('nreProtectedRaw', {
    filter: (node) => node.nodeType === 1 && node.classList && node.classList.contains('note-rich-raw'),
    replacement: (_content, node) => {
      const raw = node.getAttribute('data-md') || '';
      try { return decodeURIComponent(raw); } catch (_) { return raw; }
    },
  });
  // Keep the fence language from our renderer's data-lang attribute
  // (mdToHtml emits <code data-lang="py" class="language-py">).
  td.addRule('nreFencedCode', {
    filter: (node) => node.nodeName === 'PRE' && node.querySelector && node.querySelector('code'),
    replacement: (_content, node) => {
      const code = node.querySelector('code');
      const lang = (code.getAttribute('data-lang') || (code.className.match(/language-(\S+)/) || [])[1] || '');
      const text = code.textContent.replace(/\n$/, '');
      return '\n\n```' + lang + '\n' + text + '\n```\n\n';
    },
  });
  return (_td = td);
}

// ── Markdown → editor HTML ──
// Mirrors mdToHtml's own extraction order: fenced code first (so math inside
// code stays literal), then math, then hand the rest to mdToHtml.
const _RAW_TOKEN = (i) => `___NRE_RAW_${i}___`;

function _protectSegments(md) {
  const raws = []; // { md, display: 'inline'|'block', kind }
  let s = md;

  // Fenced code out of the way first; mermaid fences stay protected.
  const fences = [];
  s = s.replace(/```(\w+)?\n[\s\S]*?```/g, (m, lang) => {
    if (lang && lang.toLowerCase() === 'mermaid') {
      raws.push({ md: m, display: 'block', kind: 'mermaid' });
      return _RAW_TOKEN(raws.length - 1);
    }
    fences.push(m);
    return `___NRE_FENCE_${fences.length - 1}___`;
  });

  // Math — same four delimiters (and constraints) as markdown.js.
  s = s.replace(/\\\[[\s\S]*?\\\]/g, (m) => { raws.push({ md: m, display: 'block', kind: 'math' }); return _RAW_TOKEN(raws.length - 1); });
  s = s.replace(/\\\([^\n]*?\\\)/g, (m) => { raws.push({ md: m, display: 'inline', kind: 'math' }); return _RAW_TOKEN(raws.length - 1); });
  s = s.replace(/\$\$[\s\S]*?\$\$/g, (m) => { raws.push({ md: m, display: 'block', kind: 'math' }); return _RAW_TOKEN(raws.length - 1); });
  s = s.replace(/(?<!\$)\$(?!\$)[^$\n]+?\$(?!\$)/g, (m) => { raws.push({ md: m, display: 'inline', kind: 'math' }); return _RAW_TOKEN(raws.length - 1); });

  // Pipe tables (mdToHtml's table HTML doesn't round-trip through Turndown's
  // GFM rule cleanly, so treat the whole block as atomic).
  s = s.replace(/(?:^|\n)((?:[^\n]*\|[^\n]*\|[^\n]*)(?:\n[^\n]*\|[^\n]*\|[^\n]*)+)/g, (m, table) => {
    if (m.includes('___NRE_')) return m;
    raws.push({ md: table, display: 'block', kind: 'table' });
    return m.slice(0, m.length - table.length) + _RAW_TOKEN(raws.length - 1);
  });

  s = s.replace(/___NRE_FENCE_(\d+)___/g, (_, i) => fences[Number(i)]);
  return { s, raws };
}

// Rendered look for a protected island: math via KaTeX, tables via mdToHtml,
// mermaid as literal source. Falls back to escaped source on any hiccup.
function _rawIslandInner(raw) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    if (raw.kind === 'math' && window.katex) {
      const src = raw.md
        .replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '').replace(/^\$\$|\$\$$/g, '').replace(/^\$|\$$/g, '');
      return katex.renderToString(src.trim(), { displayMode: raw.display === 'block', throwOnError: false });
    }
    if (raw.kind === 'table') return markdownModule.mdToHtml(raw.md, { shortcodes: false });
  } catch (_) { /* fall through to literal */ }
  return `<code>${esc(raw.md)}</code>`;
}

function mdToEditorHtml(md) {
  const { s, raws } = _protectSegments(md || '');
  let html;
  try {
    html = markdownModule.mdToHtml(s, { shortcodes: false });
  } catch (_) {
    html = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }
  html = html.replace(/___NRE_RAW_(\d+)___/g, (_, i) => {
    const raw = raws[Number(i)];
    if (!raw) return '';
    const blockCls = raw.display === 'block' ? ' note-rich-raw-block' : '';
    return `<span class="note-rich-raw${blockCls}" contenteditable="false" data-md="${encodeURIComponent(raw.md)}" title="Edit via raw markdown (toolbar toggle)">${_rawIslandInner(raw)}</span>`;
  });

  const host = document.createElement('div');
  host.innerHTML = html;
  // Code-block chrome (run/edit/copy) makes no sense while editing.
  host.querySelectorAll('.run-code, .edit-code, .copy-code').forEach((b) => b.remove());
  // Task items → real checkboxes so they're clickable in the editor and
  // Turndown's GFM taskListItems rule serializes them back to "- [ ]".
  host.querySelectorAll('li.task-item').forEach((li) => {
    const done = li.classList.contains('task-done');
    const text = li.querySelector('.task-text');
    const inner = text ? text.innerHTML : li.innerHTML;
    li.classList.remove('task-item', 'task-done');
    li.classList.add('note-rich-task');
    // contenteditable="false" keeps the checkbox clickable — inside an
    // editable region Chrome otherwise treats the click as caret placement.
    li.innerHTML = `<input type="checkbox" contenteditable="false"${done ? ' checked' : ''}> ${inner}`;
  });
  return host.innerHTML;
}

function htmlToMd(rootEl) {
  // Checked state lives on the DOM property, not the attribute — sync it
  // before Turndown reads the tree.
  rootEl.querySelectorAll('li input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) cb.setAttribute('checked', ''); else cb.removeAttribute('checked');
  });
  let md = _turndown().turndown(rootEl.innerHTML).trim();
  // Turndown pads list markers ("-   x", "1.  x") — markdown.js's task-list
  // regex only matches exactly "- [ ]", so checkboxes would render as
  // literal brackets after one save. Normalize marker padding to one space.
  md = md.replace(/^([ \t]*)- {2,}/gm, '$1- ').replace(/^([ \t]*)(\d+)\. {2,}/gm, '$1$2. ');
  // The task checkbox carries an NBSP spacer — collapse "[ ]  text".
  md = md.replace(/^([ \t]*- \[[ xX]\]) +/gm, '$1 ');
  // Zero-width spaces are caret parking spots from the inline input rules —
  // never part of the note.
  md = md.replace(/​/g, '');
  return md;
}

// ── Toolbar (compact reuse of the documents md-toolbar visual language) ──
const _TB_BUTTONS = [
  { action: 'bold', title: 'Bold (Ctrl+B)', html: '<b>B</b>' },
  { action: 'italic', title: 'Italic (Ctrl+I)', html: '<i>I</i>' },
  { action: 'strike', title: 'Strikethrough', html: '<s>S</s>' },
  { sep: true },
  { action: 'h1', title: 'Heading 1', html: '<b>H1</b>' },
  { action: 'h2', title: 'Heading 2', html: '<b>H2</b>' },
  { action: 'h3', title: 'Heading 3', html: '<b>H3</b>' },
  { sep: true },
  { action: 'ul', title: 'Bullet list', html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/></svg>' },
  { action: 'ol', title: 'Numbered list', html: '<span style="font-variant-numeric:tabular-nums;">1.</span>' },
  { action: 'check', title: 'Checklist item', html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' },
  { sep: true },
  { action: 'quote', title: 'Quote', html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>' },
  { action: 'link', title: 'Link', html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  { action: 'code', title: 'Code block', html: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
];

function _currentBlockTag(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return '';
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== root) {
    const tag = node.tagName && node.tagName.toLowerCase();
    if (tag && /^(h1|h2|h3|h4|h5|h6|p|div|pre|blockquote|li)$/.test(tag)) return tag;
    node = node.parentNode;
  }
  return '';
}

function _promptLink(defaultText) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML =
      '<div class="modal-content styled-confirm-box styled-prompt-box">' +
        '<div class="modal-header"><h4>Insert link</h4></div>' +
        '<div class="modal-body">' +
          '<input type="text" class="styled-prompt-input note-rich-link-text" placeholder="Link text (optional)" maxlength="500" />' +
          '<input type="url" class="styled-prompt-input note-rich-link-url" placeholder="https://example.com" maxlength="2048" style="margin-top:8px;" />' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="confirm-btn confirm-btn-secondary note-rich-link-cancel">Cancel</button>' +
          '<button class="confirm-btn confirm-btn-primary note-rich-link-ok">Insert</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    const textEl = overlay.querySelector('.note-rich-link-text');
    const urlEl = overlay.querySelector('.note-rich-link-url');
    textEl.value = defaultText || '';
    const done = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const submit = () => {
      const url = (urlEl.value || '').trim();
      if (!url) { urlEl.focus(); return; }
      done({ url, text: (textEl.value || '').trim() });
    };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } }
    overlay.querySelector('.note-rich-link-ok').addEventListener('click', submit);
    overlay.querySelector('.note-rich-link-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    urlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); urlEl.focus(); } });
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => { (defaultText ? urlEl : textEl).focus(); });
  });
}

async function _insertLink(rich) {
  const selObj = window.getSelection();
  let savedRange = null;
  if (selObj && selObj.rangeCount) {
    const r = selObj.getRangeAt(0);
    if (rich.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
  }
  const selText = savedRange ? savedRange.toString() : '';
  let res;
  try { res = await _promptLink(selText); } catch (_) { res = null; }
  if (!res) { rich.focus(); return; }
  let url = (res.url || '').trim();
  if (!url) { rich.focus(); return; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) url = 'https://' + url;
  const linkText = (res.text || '').trim() || selText || url;
  if (!savedRange) {
    savedRange = document.createRange();
    savedRange.selectNodeContents(rich);
    savedRange.collapse(false);
  }
  const a = document.createElement('a');
  a.href = url;
  if (selText && linkText === selText) {
    a.appendChild(savedRange.extractContents());
  } else {
    savedRange.deleteContents();
    a.textContent = linkText;
  }
  savedRange.insertNode(a);
  rich.focus();
}

function _toggleChecklist(rich) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentNode;
  const li = node.closest ? node.closest('li') : null;
  if (li && rich.contains(li)) {
    const cb = li.querySelector(':scope > input[type="checkbox"]');
    if (cb) { cb.remove(); li.classList.remove('note-rich-task'); }
    else {
      li.classList.add('note-rich-task');
      li.insertAdjacentHTML('afterbegin', '<input type="checkbox" contenteditable="false"> ');
    }
  } else {
    document.execCommand('insertUnorderedList');
    const sel2 = window.getSelection();
    let n2 = sel2 && sel2.rangeCount ? sel2.getRangeAt(0).startContainer : null;
    if (n2 && n2.nodeType === 3) n2 = n2.parentNode;
    const li2 = n2 && n2.closest ? n2.closest('li') : null;
    if (li2 && rich.contains(li2)) {
      li2.classList.add('note-rich-task');
      li2.insertAdjacentHTML('afterbegin', '<input type="checkbox" contenteditable="false"> ');
    }
  }
}

function _applyAction(rich, action, sync) {
  rich.focus();
  if (action === 'link') { _insertLink(rich).then(sync); return; }
  if (action === 'check') { _toggleChecklist(rich); sync(); return; }
  const cmd = { bold: 'bold', italic: 'italic', strike: 'strikeThrough',
                ul: 'insertUnorderedList', ol: 'insertOrderedList' };
  try {
    if (cmd[action]) document.execCommand(cmd[action]);
    else if (action === 'h1' || action === 'h2' || action === 'h3') {
      const cur = _currentBlockTag(rich);
      document.execCommand('formatBlock', false, (cur === action) ? 'p' : action);
    } else if (action === 'quote') {
      const cur = _currentBlockTag(rich);
      document.execCommand('formatBlock', false, (cur === 'blockquote') ? 'p' : 'blockquote');
    } else if (action === 'code') {
      const cur = _currentBlockTag(rich);
      document.execCommand('formatBlock', false, (cur === 'pre') ? 'p' : 'pre');
    }
  } catch (_) {}
  sync();
}

// ── Live input rules: typing markdown converts as you go ──
// Block rules fire on Space when the marker is the entire text before the
// caret; inline rules fire when the closing character completes a pair.
// Conversions are pure DOM (no execCommand): Chrome's editing commands
// depend on the live selection, which is unreliable right after our own
// DOM edits — formatBlock silently no-opped or ate the typed text.
const _BLOCK_RULES = [
  { re: /^# $/, kind: 'h1' },
  { re: /^## $/, kind: 'h2' },
  { re: /^### $/, kind: 'h3' },
  { re: /^(?:-|\*) $/, kind: 'ul' },
  { re: /^\d+\. $/, kind: 'ol' },
  { re: /^> $/, kind: 'blockquote' },
];

// Atomic KaTeX island for live-typed math — same shape the initial render
// produces, so serialization (data-md) and styling are identical.
function _mathIslandEl(fullMd, inner, display) {
  const span = document.createElement('span');
  span.className = 'note-rich-raw' + (display ? ' note-rich-raw-block' : '');
  span.contentEditable = 'false';
  span.setAttribute('data-md', encodeURIComponent(fullMd));
  span.title = 'Edit via raw markdown (toolbar toggle)';
  try {
    if (window.katex) {
      span.innerHTML = katex.renderToString(inner.trim(), { displayMode: display, throwOnError: false });
      return span;
    }
  } catch (_) { /* fall through to literal */ }
  const code = document.createElement('code');
  code.textContent = fullMd;
  span.appendChild(code);
  return span;
}

function _caretBlock(rich) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  let n = sel.getRangeAt(0).startContainer;
  if (n.nodeType === 3) n = n.parentNode;
  while (n && n !== rich) {
    if (n.tagName && /^(P|DIV|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(n.tagName)) return n;
    n = n.parentNode;
  }
  return n === rich ? rich : null;
}

function _makeTaskLi(rich) {
  const sel = window.getSelection();
  let n = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  if (n && n.nodeType === 3) n = n.parentNode;
  const li = n && n.closest ? n.closest('li') : null;
  if (li && rich.contains(li) && !li.querySelector(':scope > input[type="checkbox"]')) {
    li.classList.add('note-rich-task');
    li.insertAdjacentHTML('afterbegin', '<input type="checkbox" contenteditable="false"> ');
  }
}

function _wireInputRules(rich, sync) {
  let applying = false;

  // Block rules run DEFERRED off the input event (not keydown): Android
  // IMEs don't deliver a usable keydown for space (key 229), and running
  // editing commands inside an input handler makes Chrome misplace edits.
  // The just-typed space is part of the marker match and gets removed
  // together with it.
  const applyBlock = () => {
    if (applying) return;
    const block = _caretBlock(rich);
    if (!block) return;
    if (block !== rich && block.closest && block.closest('.note-rich-raw, pre')) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(r.startContainer, r.startOffset);
    // contenteditable often inserts NBSP ( ) for a typed space - normalize.
    const marker = pre.toString().replace(/ /g, ' ');
    const inLi = block.tagName === 'LI';
    const isCheck = marker === '[] ' || marker === '-[] ';
    if (inLi && !isCheck) return; // inside a list only the checkbox rule applies
    const rule = isCheck ? null : _BLOCK_RULES.find(x => x.re.test(marker));
    if (!rule && !isCheck) return;
    applying = true;
    try {
      // 1) Strip the marker characters from the block's leading text nodes.
      let remaining = marker.length;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let tn;
      while (remaining > 0 && (tn = walker.nextNode())) {
        const take = Math.min(remaining, tn.textContent.length);
        tn.textContent = tn.textContent.slice(take);
        remaining -= take;
      }

      // 2) Convert. When the caret sits in bare text directly under the
      //    root, only the leading inline run belongs to this "line" —
      //    later block elements must stay outside the new block.
      const isBlockEl = (nd) => nd.nodeType === 1 && /^(P|DIV|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE)$/.test(nd.tagName);
      const takeContents = (into) => {
        if (block === rich) {
          let c = rich.firstChild;
          const run = [];
          while (c && !isBlockEl(c)) { run.push(c); c = c.nextSibling; }
          run.forEach(nd => into.appendChild(nd));
          return c; // insertion anchor (first block el or null)
        }
        while (block.firstChild) into.appendChild(block.firstChild);
        return null;
      };
      const kind = isCheck ? 'check' : rule.kind;
      let target; // element that receives the caret
      if (kind === 'ul' || kind === 'ol' || kind === 'check') {
        const li = (inLi && isCheck) ? block : document.createElement('li');
        if (li !== block) {
          const list = document.createElement(kind === 'ol' ? 'ol' : 'ul');
          list.appendChild(li);
          const anchor = takeContents(li);
          if (block === rich) rich.insertBefore(list, anchor);
          else block.replaceWith(list);
        }
        if (kind === 'check' && !li.querySelector(':scope > input[type="checkbox"]')) {
          li.classList.add('note-rich-task');
          li.insertAdjacentHTML('afterbegin', '<input type="checkbox" contenteditable="false"> ');
        }
        target = li;
      } else {
        const el = document.createElement(kind);
        const anchor = takeContents(el);
        if (block === rich) rich.insertBefore(el, anchor);
        else block.replaceWith(el);
        target = el;
      }
      // Prune now-empty text nodes first — Chrome won't keep a caret in a
      // block whose only child is an empty text node (it normalizes the
      // caret OUT of the block, so typing landed before the heading).
      [...target.childNodes].forEach(nd => { if (nd.nodeType === 3 && !nd.textContent) nd.remove(); });
      // An emptied block needs a placeholder so the caret can live inside.
      if (!target.firstChild) target.appendChild(document.createElement('br'));

      // 3) Caret to the block's end (after a task item's fresh checkbox).
      const caret = document.createRange();
      if (target.lastChild && target.lastChild.nodeName === 'BR') caret.setStart(target, target.childNodes.length - 1);
      else { caret.selectNodeContents(target); caret.collapse(false); }
      caret.collapse(true);
      const s2 = window.getSelection();
      s2.removeAllRanges();
      s2.addRange(caret);
    } catch (_) {} finally { applying = false; }
    sync();
  };

  // Inline pairs are applied with pure DOM surgery, DEFERRED out of the
  // input event: running execCommand (or heavy DOM moves) inside an input
  // handler that was itself triggered by editing made Chrome misplace the
  // edits (content jumped to the end of the editor).
  const applyInline = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.getRangeAt(0).startContainer;
    if (node.nodeType !== 3 || !rich.contains(node)) return;
    const host = node.parentNode;
    if (!host || (host.closest && host.closest('.note-rich-raw, pre, code'))) return;
    const off = sel.getRangeAt(0).startOffset;
    const s = node.textContent.slice(0, off);

    let m, tag, math = false, display = false;
    if ((m = /\$\$([^$\n]+)\$\$$/.exec(s))) { math = true; display = true; }
    // Inline $…$: content must not start/end with whitespace, so prose
    // like "5$ und 3$" (currency) never converts.
    else if ((m = /(?<!\$)\$([^\s$][^$\n]*?)\$$/.exec(s)) && !/\s$/.test(m[1])) math = true;
    else if ((m = /\*\*([^*\n]+)\*\*$/.exec(s))) tag = 'strong';
    else if ((m = /(?<!\*)\*([^*\n]+)\*$/.exec(s)) && !m[1].startsWith('*')) tag = 'em';
    else if ((m = /`([^`\n]+)`$/.exec(s))) tag = 'code';
    else if ((m = /~~([^~\n]+)~~$/.exec(s))) tag = 's';
    else return;

    applying = true;
    try {
      const r = document.createRange();
      r.setStart(node, off - m[0].length);
      r.setEnd(node, off);
      r.deleteContents();
      const el = math ? _mathIslandEl(m[0], m[1], display) : document.createElement(tag);
      if (!math) el.textContent = m[1];
      r.insertNode(el);
      // Chrome keeps typing INSIDE a trailing inline element even with the
      // caret set after it — the standard escape hatch is a zero-width
      // space the caret can sit in (stripped again on serialize).
      const zw = document.createTextNode('​');
      el.after(zw);
      const after = document.createRange();
      after.setStart(zw, 1);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } catch (_) {} finally { applying = false; }
    sync();
  };

  rich.addEventListener('input', (e) => {
    if (applying || !e || e.inputType !== 'insertText') return;
    const ch = e.data;
    if (!ch || ch.length !== 1) return;
    if (ch === ' ' || ch.charCodeAt(0) === 160) setTimeout(applyBlock, 0);
    else if (ch === '*' || ch === '`' || ch === '~' || ch === '$') setTimeout(applyInline, 0);
  });
}

/**
 * Mount the rich editor next to a hidden source textarea.
 * The textarea keeps holding markdown (mirrored on every input), so all
 * existing collect/save paths stay valid. Returns a small handle.
 */
export function attach(ta, opts = {}) {
  if (!ta || ta._nreAttached) return null;
  ta._nreAttached = true;

  const wrap = document.createElement('div');
  wrap.className = 'note-rich-wrap';

  const toolbar = document.createElement('div');
  toolbar.className = 'doc-md-toolbar note-rich-toolbar';
  const items = document.createElement('div');
  items.className = 'md-toolbar-items';
  for (const b of _TB_BUTTONS) {
    if (b.sep) { items.insertAdjacentHTML('beforeend', '<span class="md-toolbar-sep"></span>'); continue; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.nre = b.action;
    btn.title = b.title;
    btn.innerHTML = b.html;
    items.appendChild(btn);
  }
  // Raw-markdown toggle sits apart on the right — it flips modes, not text.
  const rawBtn = document.createElement('button');
  rawBtn.type = 'button';
  rawBtn.className = 'note-rich-rawtoggle';
  rawBtn.title = 'Edit raw markdown';
  rawBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span class="md-view-label">md</span>';
  toolbar.appendChild(items);
  toolbar.appendChild(rawBtn);

  const rich = document.createElement('div');
  rich.className = 'note-form-content-rich note-md';
  // Swiss German fills any spell checker with red squiggles — off by design.
  rich.setAttribute('spellcheck', 'false');
  rich.contentEditable = 'true';
  rich.dataset.placeholder = ta.placeholder || 'Take a note...';

  wrap.appendChild(toolbar);
  wrap.appendChild(rich);
  ta.insertAdjacentElement('beforebegin', wrap);
  ta.style.display = 'none';
  ta.spellcheck = false;

  let rawMode = false;
  let destroyed = false;

  // Start fetching Turndown the moment the editor opens so the serializer
  // is ready before the first keystroke needs it.
  ensureTurndown().catch(() => {});

  const syncToTextarea = () => {
    if (destroyed || rawMode) return;
    ensureTurndown().then(() => {
      if (destroyed || rawMode) return;
      try {
        ta.value = htmlToMd(rich);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        // Serializer hiccup must never eat the note — leave the textarea's
        // last good markdown in place and log for diagnosis.
        console.warn('notesRichEditor serialize failed:', e);
      }
    }).catch((e) => console.warn('notesRichEditor: turndown unavailable:', e));
  };

  const renderFromTextarea = () => {
    rich.innerHTML = mdToEditorHtml(ta.value || '');
  };

  // The raw textarea gets a matching "back to rich" affordance right below it.
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'note-rich-backtoggle';
  backBtn.title = 'Back to rich editing';
  backBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span class="md-view-label">rich</span>';
  ta.insertAdjacentElement('afterend', backBtn);
  backBtn.style.display = 'none';

  const setMode = (on) => {
    if (on === rawMode) return;
    rawMode = on;
    if (on) {
      // rich → raw: textarea already mirrors the markdown.
      wrap.style.display = 'none';
      ta.style.display = '';
      ta.focus();
    } else {
      renderFromTextarea();
      wrap.style.display = '';
      ta.style.display = 'none';
      rich.focus();
    }
    rawBtn.classList.toggle('is-active', on);
    backBtn.style.display = on ? '' : 'none';
  };

  rawBtn.addEventListener('click', () => setMode(true));
  backBtn.addEventListener('click', () => setMode(false));

  items.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-nre]');
    if (!btn) return;
    e.preventDefault();
    _applyAction(rich, btn.dataset.nre, syncToTextarea);
  });
  // Keep the selection in the editor: toolbar mousedown must not steal focus.
  toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  // Input rules BEFORE the mirror listener: a rule that rewrites the DOM
  // should be serialized in the same tick, not one keystroke later.
  _wireInputRules(rich, syncToTextarea);
  rich.addEventListener('input', syncToTextarea);
  rich.addEventListener('change', syncToTextarea); // checkbox clicks
  // Paste as plain text — pasted HTML from chat/web brings styling that
  // would otherwise leak into the serialized markdown.
  rich.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  });
  // Checkbox toggles inside contenteditable fire click but not input.
  rich.addEventListener('click', (e) => {
    if (e.target && e.target.matches && e.target.matches('input[type="checkbox"]')) syncToTextarea();
  });

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}

  renderFromTextarea();

  return {
    el: rich,
    focus: () => (rawMode ? ta : rich).focus(),
    isRaw: () => rawMode,
    setRaw: setMode,
    refresh: renderFromTextarea,
    destroy: () => {
      destroyed = true;
      wrap.remove();
      backBtn.remove();
      ta.style.display = '';
      delete ta._nreAttached;
    },
  };
}

export default { attach, ensureTurndown };
