// Projects sidebar — chats grouped around a topic (lecture, exam, build).
// A project bundles: workspace folder (its files), a persona template,
// extra instructions, optional pinned skills, and its chats. The backend
// applies workspace/template/instructions server-side on every chat turn
// (routes/chat_routes._project_context_for_session); this module is "just" UI.
//
// Deliberately self-contained: renders into #projects-section and touches the
// rest of the app only via sessions.js exports, to keep upstream merges easy.
// The modal reuses the app's native modal / modal-content / close-btn classes
// so it inherits every theme.

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

const _esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function loadProjects() {
  try {
    const data = await _json('/api/projects');
    _projects = data.projects || [];
  } catch (e) {
    console.warn('Loading projects failed:', e);
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
  fd.append('name', project.name + ' – chat');
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
    alert('Could not create chat: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Modal (create / edit / files) — native .modal markup so themes apply
// ---------------------------------------------------------------------------

function _closeModal() {
  document.getElementById('project-modal')?.remove();
}

async function _openModal(project) {
  _closeModal();
  const isNew = !project;
  const p = project || { name: '', instructions: '', template_id: '', pinned_skills: [], workspace: '' };

  // Personas: own templates + built-in presets, one dropdown with groups.
  let userTemplates = [];
  let builtinPresets = [];
  try {
    const t = await _json('/api/presets/templates');
    userTemplates = Array.isArray(t) ? t : (t.templates || []);
  } catch (e) { /* group stays empty */ }
  try {
    const all = await _json('/api/presets');
    const presets = all.presets || all;
    builtinPresets = Object.entries(presets)
      .filter(([k, v]) => v && typeof v === 'object' && v.system_prompt && k !== 'custom')
      .map(([k, v]) => ({ id: k, name: v.name || k }));
  } catch (e) { /* group stays empty */ }

  // Skills for the pin picker (checkboxes, max 4).
  let skills = [];
  try {
    const s = await _json('/api/skills');
    skills = (s.skills || []).map(x => ({
      name: x.name,
      description: String(x.description || '').slice(0, 90),
    }));
  } catch (e) { /* section hidden */ }

  const grp = (label, items, sel) => items.length
    ? `<optgroup label="${label}">` + items.map(t =>
        `<option value="${_esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${_esc(t.name)}</option>`).join('') + '</optgroup>'
    : '';
  const tplOptions = `<option value="">(none – default)</option>`
    + grp('Your templates', userTemplates, p.template_id)
    + grp('Presets', builtinPresets, p.template_id);

  const pinned = new Set(p.pinned_skills || []);
  const skillRows = skills.map(s => `
    <label class="project-skill-row" title="${_esc(s.description)}" style="display:flex;gap:6px;align-items:baseline;font-size:12.5px;padding:1px 0;cursor:pointer;">
      <input type="checkbox" class="pm-skill" value="${_esc(s.name)}" ${pinned.has(s.name) ? 'checked' : ''}>
      <span><strong>${_esc(s.name)}</strong> <span style="opacity:.6;">– ${_esc(s.description)}</span></span>
    </label>`).join('');

  const modal = document.createElement('div');
  modal.id = 'project-modal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" role="dialog" aria-label="Project" style="max-width:580px;width:min(580px,94vw);">
      <div class="modal-header">
        <h4>${isNew ? 'New Project' : 'Project: ' + _esc(p.name)}</h4>
        <button class="close-btn" aria-label="Close">✖</button>
      </div>
      <div style="padding:14px 16px;max-height:74vh;overflow:auto;">
        <label class="pm-label">Name</label>
        <input id="pm-name" type="text" value="${_esc(p.name)}">
        <label class="pm-label">Persona / template</label>
        <select id="pm-template">${tplOptions}</select>
        <label class="pm-label">Project instructions (added on top of the persona)</label>
        <textarea id="pm-instructions" rows="6">${_esc(p.instructions)}</textarea>
        <label class="pm-label">Folder</label>
        <div style="display:flex;gap:6px;">
          <input id="pm-workspace" type="text" value="${_esc(p.workspace)}" placeholder="automatic" style="flex:1;">
          <button type="button" id="pm-browse" class="section-header-btn" style="padding:4px 10px;">Browse…</button>
        </div>
        <div id="pm-browser" style="display:none;border:1px solid var(--bubble-border,#3333);border-radius:6px;margin-top:6px;padding:6px;font-size:13px;max-height:180px;overflow:auto;"></div>
        ${skills.length ? `
        <label class="pm-label">Pinned skills (optional, max. 4 — preferred in project chats)</label>
        <div style="border:1px solid var(--bubble-border,#3333);border-radius:6px;padding:6px 8px;max-height:130px;overflow:auto;">${skillRows}</div>` : ''}
        ${isNew ? '' : `
        <label class="pm-label">Files</label>
        <div id="pm-files" style="border:1px solid var(--bubble-border,#3333);border-radius:6px;padding:6px 8px;max-height:180px;overflow:auto;font-size:13px;">loading …</div>
        <input id="pm-upload" type="file" multiple style="margin-top:6px;font-size:12px;">`}
        <div style="display:flex;gap:8px;justify-content:space-between;margin-top:16px;">
          <span>${isNew ? '' : '<button id="pm-delete" class="section-header-btn" style="color:var(--accent-error,#c66);border-color:var(--accent-error,#c66);padding:5px 10px;">Remove project</button>'}</span>
          <span style="display:flex;gap:8px;">
            <button id="pm-cancel" class="section-header-btn" style="padding:5px 12px;">Cancel</button>
            <button id="pm-save" class="section-header-btn" style="padding:5px 14px;font-weight:600;">Save</button>
          </span>
        </div>
      </div>
    </div>
    <style>
      #project-modal .pm-label { display:block; font-size:12px; opacity:.7; margin:10px 0 3px; }
      #project-modal input[type=text], #project-modal select, #project-modal textarea {
        width:100%; box-sizing:border-box; resize:vertical;
      }
    </style>`;
  document.body.appendChild(modal);

  const q = (sel) => modal.querySelector(sel);
  q('.close-btn').addEventListener('click', _closeModal);
  q('#pm-cancel').addEventListener('click', _closeModal);
  modal.addEventListener('click', (ev) => { if (ev.target === modal) _closeModal(); });

  // --- folder browser (uses the same server API as the workspace picker) ---
  const browser = q('#pm-browser');
  let _browsePath = '';
  async function _renderBrowser(path) {
    browser.style.display = 'block';
    browser.innerHTML = '<em style="opacity:.6;">loading …</em>';
    try {
      const data = await _json('/api/workspace/browse?path=' + encodeURIComponent(path || ''));
      _browsePath = data.path;
      const rows = (data.dirs || []).map(d =>
        `<div class="list-item pm-dir" data-path="${_esc(d.path)}" style="padding:2px 6px;">📁 ${_esc(d.name)}</div>`).join('');
      browser.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px;">
          <code style="font-size:11px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(data.path)}</code>
          <button type="button" id="pm-usefolder" class="section-header-btn" style="padding:2px 8px;white-space:nowrap;">Use this folder</button>
        </div>
        ${data.parent ? `<div class="list-item pm-dir" data-path="${_esc(data.parent)}" style="padding:2px 6px;opacity:.7;">↑ ..</div>` : ''}
        ${rows || '<div style="opacity:.5;padding:2px 6px;">no subfolders</div>'}`;
      browser.querySelectorAll('.pm-dir').forEach(el =>
        el.addEventListener('click', () => _renderBrowser(el.dataset.path)));
      browser.querySelector('#pm-usefolder')?.addEventListener('click', () => {
        q('#pm-workspace').value = _browsePath;
        browser.style.display = 'none';
      });
    } catch (e) {
      browser.innerHTML = '<em style="opacity:.6;">Browsing unavailable (' + _esc(e.message) + ')</em>';
    }
  }
  q('#pm-browse').addEventListener('click', () => {
    if (browser.style.display === 'block') { browser.style.display = 'none'; return; }
    _renderBrowser(q('#pm-workspace').value.trim() || p.workspace || '');
  });

  // --- max 4 pinned skills ---
  modal.querySelectorAll('.pm-skill').forEach(cb => cb.addEventListener('change', () => {
    const checked = modal.querySelectorAll('.pm-skill:checked');
    if (checked.length > 4) { cb.checked = false; alert('At most 4 pinned skills.'); }
  }));

  q('#pm-save').addEventListener('click', async () => {
    const body = {
      name: q('#pm-name').value.trim(),
      template_id: q('#pm-template').value,
      instructions: q('#pm-instructions').value,
      pinned_skills: [...modal.querySelectorAll('.pm-skill:checked')].map(cb => cb.value).slice(0, 4),
    };
    const ws = q('#pm-workspace').value.trim();
    if (ws) body.workspace = ws;
    if (!body.name) { alert('Name is required'); return; }
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
      alert('Saving failed: ' + e.message);
    }
  });

  if (!isNew) {
    q('#pm-delete')?.addEventListener('click', async () => {
      if (!confirm(`Remove project "${p.name}"? Chats and files are kept.`)) return;
      await _json(`/api/projects/${p.id}`, { method: 'DELETE' });
      _closeModal();
      await Promise.all([loadProjects(), loadSessions()]);
    });

    const filesBox = q('#pm-files');
    const renderFiles = async () => {
      try {
        const data = await _json(`/api/projects/${p.id}/files`);
        if (!data.files.length) { filesBox.innerHTML = '<em style="opacity:.6;">no files yet</em>'; return; }
        filesBox.innerHTML = data.files.map(f => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;">
            <a href="${API}/api/projects/${p.id}/files/${encodeURIComponent(f.path)}" target="_blank" style="color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${_esc(f.path)}</a>
            <span style="white-space:nowrap;opacity:.6;">${(f.size / 1024).toFixed(0)} KB
              <a href="#" data-del="${_esc(f.path)}" style="color:var(--accent-error,#c66);text-decoration:none;margin-left:6px;">✕</a></span>
          </div>`).join('');
        filesBox.querySelectorAll('[data-del]').forEach(a => a.addEventListener('click', async (ev) => {
          ev.preventDefault();
          await _json(`/api/projects/${p.id}/files/${encodeURIComponent(a.dataset.del)}`, { method: 'DELETE' });
          renderFiles();
        }));
      } catch (e) {
        filesBox.textContent = 'Loading files failed';
      }
    };
    renderFiles();
    q('#pm-upload')?.addEventListener('change', async (ev) => {
      for (const file of ev.target.files) {
        const fd = new FormData();
        fd.append('file', file);
        try {
          await _json(`/api/projects/${p.id}/files`, { method: 'POST', body: fd });
        } catch (e) {
          alert(`Upload ${file.name} failed: ` + e.message);
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
      <div class="list-item project-chat-row" data-sid="${_esc(s.id)}" data-pid="${_esc(p.id)}" style="padding-left:26px;font-size:13px;" title="${_esc(s.name)}">
        <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(s.name) || '(untitled)'}</span>
      </div>`).join('');
    return `
      <div class="project-block" data-pid="${_esc(p.id)}">
        <div class="list-item project-row" data-pid="${_esc(p.id)}" style="font-weight:600;">
          <span style="width:14px;display:inline-block;opacity:.7;">${open ? '▾' : '▸'}</span>
          <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(p.name)}</span>
          <button class="section-header-btn project-gear" data-pid="${_esc(p.id)}" title="Project settings" style="opacity:.7;">⚙</button>
        </div>
        ${open ? chats + `
        <div class="list-item project-newchat" data-pid="${_esc(p.id)}" style="padding-left:26px;font-size:12px;opacity:.75;">+ New chat</div>` : ''}
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="section-header-flex">
      <span class="section-title"><svg class="section-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span class="section-title-label">Projects</span></span>
      <button type="button" class="section-header-btn" id="project-add-btn" title="New project" style="font-size:15px;line-height:1;">+</button>
    </div>
    ${rows || '<div style="font-size:12px;opacity:.55;padding:2px 8px 6px;">No projects yet</div>'}`;

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
