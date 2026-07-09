// Projects sidebar — chats grouped around a topic (lecture, exam, build).
// A project bundles: workspace folder (its files), a persona template,
// extra instructions, optional pinned skills, and its chats. The backend
// applies workspace/template/instructions server-side on every chat turn
// (routes/chat_routes._project_context_for_session); this module is "just" UI.
//
// Deliberately self-contained: renders into #projects-section and touches the
// rest of the app only via sessions.js exports, to keep upstream merges easy.

import Storage, { KEYS } from './storage.js';
import { selectSession, loadSessions, getSessions } from './sessions.js';

const API = window.location.origin;

let _projects = [];
let _expanded = JSON.parse(localStorage.getItem('ody-projects-expanded') || '{}');

async function _json(url, opts = {}) {
  const res = await fetch(API + url, { credentials: 'same-origin', ...opts });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText);
  return res.json();
}

export async function loadProjects() {
  try {
    const data = await _json('/api/projects');
    _projects = data.projects || [];
  } catch (e) {
    console.warn('Projekte laden fehlgeschlagen:', e);
    _projects = [];
  }
  render();
}

function _saveExpanded() {
  localStorage.setItem('ody-projects-expanded', JSON.stringify(_expanded));
}

function _openProjectChat(project, sessionId) {
  // Server enforces workspace/template anyway; mirror the workspace into the
  // client picker so the UI badge shows the right folder.
  if (project.workspace) {
    try { Storage.set(KEYS.WORKSPACE, project.workspace); } catch (e) { /* ignore */ }
  }
  selectSession(sessionId);
}

async function _newChatInProject(project) {
  // Clone model/endpoint from the most recent session so the new chat is
  // immediately usable without a model-picker round-trip.
  const all = getSessions() || [];
  const donor = all.find(s => s.model && s.endpoint_url) || all[0];
  const fd = new FormData();
  fd.append('name', project.name + ' – Chat');
  if (donor) {
    fd.append('model', donor.model || '');
    fd.append('endpoint_url', donor.endpoint_url || '');
  }
  fd.append('skip_validation', 'true');
  try {
    const res = await _json('/session', { method: 'POST', body: fd });
    const sid = res.id || res.session_id;
    await _json(`/api/projects/${project.id}/sessions/${sid}`, { method: 'POST' });
    await loadSessions();
    await loadProjects();
    _openProjectChat(project, sid);
  } catch (e) {
    alert('Chat konnte nicht angelegt werden: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Modal (create / edit / files)
// ---------------------------------------------------------------------------

function _closeModal() {
  document.getElementById('project-modal-overlay')?.remove();
}

async function _openModal(project) {
  _closeModal();
  const isNew = !project;
  const p = project || { name: '', instructions: '', template_id: '', pinned_skills: [], workspace: '' };

  let templates = [];
  try {
    const t = await _json('/api/presets/templates');
    templates = Array.isArray(t) ? t : (t.templates || []);
  } catch (e) { /* dropdown stays empty */ }

  const overlay = document.createElement('div');
  overlay.id = 'project-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;';
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) _closeModal(); });

  const tplOptions = ['<option value="">(keine – Standard)</option>']
    .concat(templates.map(t =>
      `<option value="${t.id}" ${t.id === p.template_id ? 'selected' : ''}>${t.name}</option>`))
    .join('');

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--sidebar-bg,#1c1c22);color:inherit;border:1px solid var(--bubble-border,#333);border-radius:10px;width:min(560px,92vw);max-height:88vh;overflow:auto;padding:18px;';
  panel.innerHTML = `
    <h3 style="margin:0 0 12px;">${isNew ? 'Neues Projekt' : 'Projekt: ' + p.name}</h3>
    <label style="display:block;font-size:12px;opacity:.75;margin-top:8px;">Name</label>
    <input id="pm-name" type="text" value="${(p.name || '').replace(/"/g, '&quot;')}" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--input-border,#333);background:var(--input-bg,#111);color:inherit;">
    <label style="display:block;font-size:12px;opacity:.75;margin-top:10px;">Persona / Template</label>
    <select id="pm-template" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--input-border,#333);background:var(--input-bg,#111);color:inherit;">${tplOptions}</select>
    <label style="display:block;font-size:12px;opacity:.75;margin-top:10px;">Projekt-Anweisungen (zusätzlich zur Persona)</label>
    <textarea id="pm-instructions" rows="6" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--input-border,#333);background:var(--input-bg,#111);color:inherit;resize:vertical;">${p.instructions || ''}</textarea>
    <label style="display:block;font-size:12px;opacity:.75;margin-top:10px;">Ordner (leer = automatisch; sonst Pfad unter data/, z. B. vorlesungen/tiii)</label>
    <input id="pm-workspace" type="text" value="${(p.workspace || '').replace(/"/g, '&quot;')}" placeholder="automatisch" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--input-border,#333);background:var(--input-bg,#111);color:inherit;">
    <label style="display:block;font-size:12px;opacity:.75;margin-top:10px;">Angepinnte Skills (optional, kommagetrennt, max. 4)</label>
    <input id="pm-skills" type="text" value="${(p.pinned_skills || []).join(', ')}" style="width:100%;padding:7px;border-radius:6px;border:1px solid var(--input-border,#333);background:var(--input-bg,#111);color:inherit;">
    ${isNew ? '' : `
      <div style="margin-top:14px;">
        <div style="font-size:12px;opacity:.75;margin-bottom:4px;">Dateien</div>
        <div id="pm-files" style="border:1px solid var(--bubble-border,#333);border-radius:6px;padding:6px;max-height:180px;overflow:auto;font-size:13px;">lade …</div>
        <input id="pm-upload" type="file" multiple style="margin-top:6px;font-size:12px;">
      </div>`}
    <div style="display:flex;gap:8px;justify-content:space-between;margin-top:16px;">
      <span>${isNew ? '' : '<button id="pm-delete" style="background:none;border:1px solid #a33;color:#c66;border-radius:6px;padding:6px 10px;cursor:pointer;">Projekt entfernen</button>'}</span>
      <span style="display:flex;gap:8px;">
        <button id="pm-cancel" style="background:none;border:1px solid var(--bubble-border,#444);color:inherit;border-radius:6px;padding:6px 12px;cursor:pointer;">Abbrechen</button>
        <button id="pm-save" style="background:var(--send-btn-bg,#c0392b);border:none;color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer;">Speichern</button>
      </span>
    </div>`;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  panel.querySelector('#pm-cancel').addEventListener('click', _closeModal);
  panel.querySelector('#pm-save').addEventListener('click', async () => {
    const body = {
      name: panel.querySelector('#pm-name').value.trim(),
      template_id: panel.querySelector('#pm-template').value,
      instructions: panel.querySelector('#pm-instructions').value,
      pinned_skills: panel.querySelector('#pm-skills').value
        .split(',').map(s => s.trim()).filter(Boolean).slice(0, 4),
    };
    const ws = panel.querySelector('#pm-workspace').value.trim();
    if (ws) body.workspace = ws;
    if (!body.name) { alert('Name fehlt'); return; }
    try {
      if (isNew) {
        await _json('/api/projects', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        await _json(`/api/projects/${p.id}`, { method: 'PUT',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      _closeModal();
      await loadProjects();
    } catch (e) {
      alert('Speichern fehlgeschlagen: ' + e.message);
    }
  });

  if (!isNew) {
    panel.querySelector('#pm-delete')?.addEventListener('click', async () => {
      if (!confirm(`Projekt "${p.name}" entfernen? Chats und Dateien bleiben erhalten.`)) return;
      await _json(`/api/projects/${p.id}`, { method: 'DELETE' });
      _closeModal();
      await Promise.all([loadProjects(), loadSessions()]);
    });

    const filesBox = panel.querySelector('#pm-files');
    const renderFiles = async () => {
      try {
        const data = await _json(`/api/projects/${p.id}/files`);
        if (!data.files.length) { filesBox.innerHTML = '<em style="opacity:.6;">noch keine Dateien</em>'; return; }
        filesBox.innerHTML = data.files.map(f => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;">
            <a href="${API}/api/projects/${p.id}/files/${encodeURIComponent(f.path)}" target="_blank" style="color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${f.path}</a>
            <span style="white-space:nowrap;opacity:.6;">${(f.size / 1024).toFixed(0)} KB
              <a href="#" data-del="${f.path}" style="color:#c66;text-decoration:none;margin-left:6px;">✕</a></span>
          </div>`).join('');
        filesBox.querySelectorAll('[data-del]').forEach(a => a.addEventListener('click', async (ev) => {
          ev.preventDefault();
          await _json(`/api/projects/${p.id}/files/${encodeURIComponent(a.dataset.del)}`, { method: 'DELETE' });
          renderFiles();
        }));
      } catch (e) {
        filesBox.textContent = 'Dateien laden fehlgeschlagen';
      }
    };
    renderFiles();
    panel.querySelector('#pm-upload')?.addEventListener('change', async (ev) => {
      for (const file of ev.target.files) {
        const fd = new FormData();
        fd.append('file', file);
        try {
          await _json(`/api/projects/${p.id}/files`, { method: 'POST', body: fd });
        } catch (e) {
          alert(`Upload ${file.name} fehlgeschlagen: ` + e.message);
        }
      }
      ev.target.value = '';
      renderFiles();
    });
  }
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function render() {
  const host = document.getElementById('projects-section');
  if (!host) return;
  const rows = _projects.map(p => {
    const open = !!_expanded[p.id];
    const chats = (p.sessions || []).map(s => `
      <div class="list-item project-chat-row" data-sid="${s.id}" data-pid="${p.id}" style="padding-left:26px;font-size:13px;" title="${(s.name || '').replace(/"/g, '&quot;')}">
        <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${s.name || '(unbenannt)'}</span>
      </div>`).join('');
    return `
      <div class="project-block" data-pid="${p.id}">
        <div class="list-item project-row" data-pid="${p.id}" style="font-weight:600;">
          <span style="width:14px;display:inline-block;opacity:.7;">${open ? '▾' : '▸'}</span>
          <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
          <button class="section-header-btn project-gear" data-pid="${p.id}" title="Projekt-Einstellungen" style="opacity:.7;">⚙</button>
        </div>
        ${open ? chats + `
        <div class="list-item project-newchat" data-pid="${p.id}" style="padding-left:26px;font-size:12px;opacity:.75;">+ Neuer Chat</div>` : ''}
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="section-header-flex">
      <span class="section-title"><svg class="section-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span class="section-title-label">Projekte</span></span>
      <button type="button" class="section-header-btn" id="project-add-btn" title="Neues Projekt" style="font-size:15px;line-height:1;">+</button>
    </div>
    ${rows || '<div style="font-size:12px;opacity:.55;padding:2px 8px 6px;">Noch keine Projekte</div>'}`;

  host.querySelector('#project-add-btn')?.addEventListener('click', () => _openModal(null));
  host.querySelectorAll('.project-row').forEach(el => el.addEventListener('click', (ev) => {
    if (ev.target.closest('.project-gear')) return;
    const pid = el.dataset.pid;
    _expanded[pid] = !_expanded[pid];
    _saveExpanded();
    render();
  }));
  host.querySelectorAll('.project-gear').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    _openModal(_projects.find(x => x.id === el.dataset.pid));
  }));
  host.querySelectorAll('.project-chat-row').forEach(el => el.addEventListener('click', () => {
    const proj = _projects.find(x => x.id === el.dataset.pid);
    _openProjectChat(proj || {}, el.dataset.sid);
  }));
  host.querySelectorAll('.project-newchat').forEach(el => el.addEventListener('click', () => {
    const proj = _projects.find(x => x.id === el.dataset.pid);
    if (proj) _newChatInProject(proj);
  }));
}

// Self-init: module scripts run after DOM parse.
loadProjects();

export default { loadProjects };
