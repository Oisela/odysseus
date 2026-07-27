/**
 * RemNote Module — one page for "is it connected, what is waiting, why did it
 * fail". Alessios RemNote runs on his PC and Odysseus reaches it through the
 * bridge, so the connection is genuinely intermittent; before this page the
 * only feedback was a chat message, and parked cards had no home at all.
 *
 * Three parts: a status card (bridge addresses, which PC answered, round-trip
 * time, MCP entry), the offline buffer as cards (send / edit / delete, send
 * all), and a debug pane with the raw last response. Follows the shopping.js
 * tool-window pattern: lazy modal + makeWindowDraggable + modalManager.
 */

import { makeWindowDraggable } from './windowDrag.js';
import * as Modals from './modalManager.js';
import uiModule from './ui.js';
import markdownModule from './markdown.js';

const API_BASE = window.location.origin;

let _modal = null;
let _open = false;
let _status = null;
let _items = [];
let _editingId = null;
let _lastDebug = null;   // { at, action, ok, detail }
let _busy = false;

async function _api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${method} ${path} → ${res.status}`);
  return data;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Card text is authored as markdown with KaTeX ($…$) — the whole point of the
// skill's display rule is that Alessio approves a card without opening RemNote.
function _md(s) {
  try { return markdownModule.mdToHtml(s || '', { shortcodes: false }); }
  catch { return _esc(s); }
}

function _ago(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// ── Window ──

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'remnote-modal';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content remnote-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>RemNote</h4>
        <span style="flex:1"></span>
        <button type="button" class="remnote-header-icon-btn" id="remnote-refresh" title="Refresh status and buffer">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <button class="close-btn" id="remnote-close">&#10006;</button>
      </div>
      <div class="modal-body remnote-body" id="remnote-body"></div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#remnote-close').addEventListener('click', closeRemnote);
  _modal.querySelector('#remnote-refresh').addEventListener('click', () => _reload(true));
  _modal.addEventListener('click', (e) => { if (e.target === _modal) closeRemnote(); });
  const content = _modal.querySelector('.remnote-modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  _wireBody();
  return _modal;
}

// ── Rendering ──

function _statusHtml() {
  const b = (_status && _status.bridge) || {};
  const counts = (_status && _status.counts) || {};
  const ok = !!b.ok;
  const state = !b.configured ? 'not configured' : ok ? 'connected' : 'offline';
  const cls = !b.configured ? 'unconfigured' : ok ? 'online' : 'offline';
  const urls = Array.isArray(b.urls) ? b.urls : [];
  const rows = [];
  rows.push(`<div class="remnote-stat-row"><span class="remnote-stat-key">Bridge</span>
    <span class="remnote-badge remnote-badge-${cls}">${_esc(state)}</span></div>`);
  if (ok) {
    rows.push(`<div class="remnote-stat-row"><span class="remnote-stat-key">Answered by</span>
      <span class="remnote-stat-val">${_esc(b.active_url || '')}${b.ms != null ? ` · ${b.ms} ms` : ''}</span></div>`);
    const h = b.health || {};
    if (h.version || h.plugin || h.remnote) {
      rows.push(`<div class="remnote-stat-row"><span class="remnote-stat-key">Plugin</span>
        <span class="remnote-stat-val">${_esc(h.version || h.plugin || h.remnote || '')}</span></div>`);
    }
  } else {
    rows.push(`<div class="remnote-stat-row"><span class="remnote-stat-key">Configured</span>
      <span class="remnote-stat-val">${urls.length ? _esc(urls.join(', ')) : '—'}</span></div>`);
    if (b.error) {
      rows.push(`<div class="remnote-stat-err">${_esc(b.error)}</div>`);
    }
  }
  rows.push(`<div class="remnote-stat-row"><span class="remnote-stat-key">Buffer</span>
    <span class="remnote-stat-val">${counts.pending || 0} waiting · ${counts.failed || 0} failed · ${counts.sent || 0} sent</span></div>`);

  const canSendAll = ok && ((counts.pending || 0) + (counts.failed || 0)) > 0;
  return `
    <div class="remnote-card">
      <div class="remnote-card-head">Connection</div>
      ${rows.join('')}
      <div class="remnote-actions">
        <button type="button" class="memory-toolbar-btn" id="remnote-test">Test connection</button>
        <button type="button" class="memory-toolbar-btn" id="remnote-send-all"${canSendAll ? '' : ' disabled'} title="${canSendAll ? 'Send every waiting card to RemNote' : 'Nothing to send, or the bridge is offline'}">Send all to RemNote</button>
      </div>
      ${!b.configured ? `<div class="remnote-hint">Add the <code>remnote</code> MCP server with <code>REMNOTE_BRIDGE_URL</code> in Settings → Integrations.</div>` : ''}
      ${b.configured && !ok ? `<div class="remnote-hint">Cards you create while offline are parked below and can be sent once the PC is up.</div>` : ''}
    </div>`;
}

const _TYPES = ['basic', 'cloze', 'concept', 'note'];

function _itemHtml(it) {
  if (_editingId === it.id) {
    return `
      <div class="remnote-item editing" data-id="${_esc(it.id)}">
        <div class="remnote-item-form">
          <label class="remnote-field"><span>Target</span>
            <input type="text" class="styled-prompt-input rn-f-target" value="${_esc(it.target)}" placeholder="Journal or Physik/TIII/Kapitel 3" /></label>
          <label class="remnote-field"><span>Type</span>
            <select class="settings-select rn-f-type">
              ${_TYPES.map(t => `<option value="${t}"${t === it.card_type ? ' selected' : ''}>${t}</option>`).join('')}
            </select></label>
          <label class="remnote-field"><span>Front</span>
            <textarea class="rn-f-front" rows="2">${_esc(it.front)}</textarea></label>
          <label class="remnote-field"><span>Back</span>
            <textarea class="rn-f-back" rows="2">${_esc(it.back)}</textarea></label>
          <div class="remnote-actions">
            <button type="button" class="memory-toolbar-btn rn-cancel">Cancel</button>
            <button type="button" class="memory-toolbar-btn rn-save">Save</button>
          </div>
        </div>
      </div>`;
  }
  const failed = it.status === 'failed';
  const sent = it.status === 'sent';
  return `
    <div class="remnote-item${failed ? ' failed' : ''}${sent ? ' sent' : ''}" data-id="${_esc(it.id)}">
      <div class="remnote-item-meta">
        <span class="remnote-chip">${_esc(it.card_type)}</span>
        <span class="remnote-chip remnote-chip-target" title="Target in RemNote">${_esc(it.target)}</span>
        ${it.source === 'user' ? '' : '<span class="remnote-chip" title="Created by the assistant">agent</span>'}
        <span style="flex:1"></span>
        <span class="remnote-item-age">${_esc(_ago(it.created_at))}</span>
      </div>
      <div class="remnote-item-front note-md">${_md(it.front)}</div>
      ${it.back ? `<div class="remnote-item-back note-md">${_md(it.back)}</div>` : ''}
      ${failed && it.last_error ? `<div class="remnote-stat-err" title="Attempt ${it.attempts}">${_esc(it.last_error)}</div>` : ''}
      ${sent ? `<div class="remnote-item-sent">Sent ${_esc(_ago(it.sent_at))}${it.rem_id ? ` · <a href="https://www.remnote.com/document/${_esc(it.rem_id)}" target="_blank" rel="noopener">open in RemNote</a>` : ''}</div>` : ''}
      <div class="remnote-actions">
        ${sent ? '' : `<button type="button" class="memory-toolbar-btn rn-send" title="Send this card to RemNote now">Send</button>`}
        ${sent ? '' : `<button type="button" class="memory-toolbar-btn rn-edit">Edit</button>`}
        <button type="button" class="memory-toolbar-btn rn-del danger" title="Discard this card">Delete</button>
      </div>
    </div>`;
}

function _debugHtml() {
  if (!_lastDebug) return '';
  return `
    <details class="remnote-debug">
      <summary>Debug — last bridge call (${_esc(_lastDebug.action)}, ${_lastDebug.ok ? 'ok' : 'failed'})</summary>
      <pre>${_esc(JSON.stringify(_lastDebug.detail, null, 2))}</pre>
    </details>`;
}

function _render() {
  const body = _modal && _modal.querySelector('#remnote-body');
  if (!body) return;
  const waiting = _items.filter(i => i.status !== 'sent');
  const sent = _items.filter(i => i.status === 'sent');
  body.innerHTML = `
    ${_statusHtml()}
    <div class="remnote-card">
      <div class="remnote-card-head">Offline buffer${waiting.length ? ` · ${waiting.length}` : ''}</div>
      ${waiting.length
        ? waiting.map(_itemHtml).join('')
        : '<div class="remnote-empty">Nothing waiting — every card reached RemNote.</div>'}
    </div>
    ${sent.length ? `<div class="remnote-card">
      <div class="remnote-card-head">Recently sent</div>
      ${sent.slice(0, 10).map(_itemHtml).join('')}
    </div>` : ''}
    ${_debugHtml()}`;
}

// One delegated listener on the persistent body — _render replaces children.
function _wireBody() {
  const body = _modal.querySelector('#remnote-body');
  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || _busy) return;
    const wrap = btn.closest('.remnote-item');
    const id = wrap && wrap.dataset.id;

    if (btn.id === 'remnote-test') return _test();
    if (btn.id === 'remnote-send-all') return _sendAll();
    if (btn.classList.contains('rn-send')) return _send(id);
    if (btn.classList.contains('rn-del')) return _del(id);
    if (btn.classList.contains('rn-edit')) { _editingId = id; _render(); return; }
    if (btn.classList.contains('rn-cancel')) { _editingId = null; _render(); return; }
    if (btn.classList.contains('rn-save')) return _save(id, wrap);
  });
}

// ── Actions ──

async function _reload(showToast) {
  try {
    const [st, list] = await Promise.all([
      _api('/api/remnote/status'),
      _api('/api/remnote/pending?include_sent=true'),
    ]);
    _status = st;
    _items = list.items || [];
    _render();
    if (showToast) {
      const ok = st && st.bridge && st.bridge.ok;
      uiModule.showToast(ok ? 'RemNote bridge is connected' : 'RemNote bridge is offline');
    }
  } catch (e) {
    uiModule.showError('RemNote status failed: ' + e.message);
  }
}

async function _test() {
  _busy = true;
  try {
    const health = await _api('/api/remnote/test', { method: 'POST' });
    _lastDebug = { at: new Date().toISOString(), action: 'health', ok: !!health.ok, detail: health };
    _status = { ..._status, bridge: health };
    _render();
    uiModule.showToast(health.ok ? `Connected via ${health.active_url}` : 'No bridge answered');
  } catch (e) {
    uiModule.showError('Test failed: ' + e.message);
  } finally { _busy = false; }
}

async function _send(id) {
  if (!id) return;
  _busy = true;
  try {
    const out = await _api(`/api/remnote/pending/${id}/send`, { method: 'POST' });
    _lastDebug = { at: new Date().toISOString(), action: 'send', ok: !!out.ok, detail: out };
    if (out.ok) uiModule.showToast('Card sent to RemNote');
    else uiModule.showError('Send failed: ' + (out.error || 'unknown'));
    await _reload();
  } catch (e) {
    uiModule.showError('Send failed: ' + e.message);
  } finally { _busy = false; }
}

async function _sendAll() {
  _busy = true;
  try {
    const out = await _api('/api/remnote/pending/send-all', { method: 'POST' });
    _lastDebug = { at: new Date().toISOString(), action: 'send-all', ok: !!out.ok, detail: out };
    if (out.error) uiModule.showError(out.error);
    else uiModule.showToast(`${out.sent} sent${out.failed ? `, ${out.failed} failed` : ''}`);
    await _reload();
  } catch (e) {
    uiModule.showError('Send all failed: ' + e.message);
  } finally { _busy = false; }
}

async function _del(id) {
  if (!id) return;
  const ok = await uiModule.styledConfirm('Discard this card? It will not reach RemNote.',
    { confirmText: 'Delete', danger: true });
  if (!ok) return;
  _busy = true;
  try {
    await _api(`/api/remnote/pending/${id}`, { method: 'DELETE' });
    await _reload();
  } catch (e) {
    uiModule.showError('Delete failed: ' + e.message);
  } finally { _busy = false; }
}

async function _save(id, wrap) {
  if (!id || !wrap) return;
  const body = {
    target: wrap.querySelector('.rn-f-target').value.trim() || 'Journal',
    card_type: wrap.querySelector('.rn-f-type').value,
    front: wrap.querySelector('.rn-f-front').value,
    back: wrap.querySelector('.rn-f-back').value,
  };
  _busy = true;
  try {
    await _api(`/api/remnote/pending/${id}`, { method: 'PATCH', body });
    _editingId = null;
    await _reload();
  } catch (e) {
    uiModule.showError('Save failed: ' + e.message);
  } finally { _busy = false; }
}

// ── Public ──

export async function openRemnote() {
  const modal = _getModal();
  if (_open) { modal.style.display = 'flex'; return; }
  _open = true;
  Modals.register('remnote-modal', {
    sidebarBtnId: 'tool-remnote-btn',
    closeFn: () => closeRemnote(),
    restoreFn: () => { if (!_open) openRemnote(); },
  });
  modal.style.display = 'flex';
  document.getElementById('tool-remnote-btn')?.classList.add('active');
  await _reload();
}

export function closeRemnote() {
  if (!_modal) return;
  _open = false;
  _modal.style.display = 'none';
  document.getElementById('tool-remnote-btn')?.classList.remove('active');
}

export function isRemnoteOpen() { return _open; }

const remnoteModule = { openRemnote, closeRemnote, isRemnoteOpen };
export default remnoteModule;
