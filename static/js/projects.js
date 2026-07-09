// Projects sidebar — chats grouped around a topic (lecture, exam, build).
// A project bundles: workspace folder (its files), a persona template,
// extra instructions, optional pinned skills, and its chats. The backend
// applies workspace/template/instructions server-side on every chat turn
// (routes/chat_routes._project_context_for_session); this module is "just" UI.
//
// Deliberately self-contained: renders into #projects-section and touches the
// rest of the app only via sessions.js / storage.js / windowDrag.js exports,
// to keep upstream merges easy. Modals reuse the app's native modal markup
// (modal / modal-content / modal-header / confirm-btn / workspace-row) so
// every theme applies, and are draggable like the other windows.

import Storage, { KEYS } from './storage.js';
import uiModule from './ui.js';
import { makeWindowDraggable } from './windowDrag.js';
import { selectSession, loadSessions, getSessions } from './sessions.js';

const API = window.location.origin;
// Same folder glyph as the workspace picker (not an emoji).
const _FOLDER_SVG = '<svg class="workspace-row-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

let _projects = [];
let _expanded = JSON.parse(localStorage.getItem('ody-projects-expanded') || '{}');

async function _json(url, opts = {}) {
  const res = await fetch(API + url, { credentials: 'same-origin', ...opts });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText);
  return res.json();
}

const _esc = (s) => uiModule.esc ? uiModule.esc(String(s ?? '')) : String(s ?? '')
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
  // client picker so the UI pill shows the right folder.
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
    if (uiModule.showError) uiModule.showError('Could not create chat: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Folder picker — same markup/classes as the workspace picker, but with an
// onPick callback instead of binding the global workspace.
// ---------------------------------------------------------------------------

function _openFolderPicker(initialPath, onPick) {
  document.getElementById('project-folder-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'project-folder-modal';
  modal.className = 'modal';
  modal.style.zIndex = '260'; // above the project modal
  let curPath = '';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h4>${_FOLDER_SVG}<span style="margin-left:6px;">Select folder</span></h4>
        <button class="close-btn" aria-label="Close">✖</button>
      </div>
      <input type="text" class="styled-prompt-input workspace-cur" id="pfp-path"
             spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"
             placeholder="Type or paste a folder path, then press Enter" />
      <p class="muted workspace-note">This folder holds the project's files and is the agent's workspace in project chats.</p>
      <div class="modal-body workspace-body" id="pfp-body"></div>
      <div class="modal-footer workspace-footer">
        <button type="button" class="confirm-btn confirm-btn-secondary" id="pfp-cancel">Cancel</button>
        <button type="button" class="confirm-btn confirm-btn-primary" id="pfp-use">Use this folder</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.close-btn').addEventListener('click', close);
  modal.querySelector('#pfp-cancel').addEventListener('click', close);
  modal.querySelector('#pfp-use').addEventListener('click', () => { onPick(curPath); close(); });
  modal.querySelector('#pfp-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      if (v) nav(v);
    }
  });
  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(modal, { content, header });

  async function nav(path) {
    try {
      const data = await _json('/api/workspace/browse?path=' + encodeURIComponent(path || ''));
      curPath = data.path;
      const pathEl = modal.querySelector('#pfp-path');
      pathEl.value = data.path;
      pathEl.title = data.path;
      let rows = '';
      if (data.parent) {
        rows += `<div class="workspace-row workspace-up" data-path="${encodeURIComponent(data.parent)}">↑ ..</div>`;
      }
      for (const d of (data.dirs || [])) {
        rows += `<div class="workspace-row" data-path="${encodeURIComponent(d.path)}">${_FOLDER_SVG}<span>${_esc(d.name)}</span></div>`;
      }
      if (!(data.dirs || []).length && !data.parent) rows = '<div class="workspace-empty">No subfolders</div>';
      const body = modal.querySelector('#pfp-body');
      body.innerHTML = rows || '<div class="workspace-empty">No subfolders</div>';
      body.querySelectorAll('.workspace-row').forEach((row) => {
        row.addEventListener('click', () => nav(decodeURIComponent(row.dataset.path)));
      });
      const useBtn = modal.querySelector('#pfp-use');
      useBtn.disabled = data.selectable === false;
      useBtn.title = data.selectable === false ? 'This folder cannot be used' : '';
    } catch (e) {
      if (uiModule.showError) uiModule.showError('Could not browse folders');
    }
  }
  nav(initialPath || '');
}

// ---------------------------------------------------------------------------
// Project modal (create / edit / files)
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

  // Skills for the pin dropdown.
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

  const modal = document.createElement('div');
  modal.id = 'project-modal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" role="dialog" aria-label="Project" style="max-width:580px;width:min(580px,94vw);">
      <div class="modal-header">
        <h4>${isNew ? 'New project' : 'Project: ' + _esc(p.name)}</h4>
        <button class="close-btn" aria-label="Close">✖</button>
      </div>
      <div style="padding:14px 16px;max-height:74vh;overflow:auto;">
        <label class="pm-label">Name</label>
        <input id="pm-name" type="text" class="styled-prompt-input" value="${_esc(p.name)}">
        <label class="pm-label">Persona / template</label>
        <select id="pm-template">${tplOptions}</select>
        <label class="pm-label">Project instructions (added on top of the persona)</label>
        <textarea id="pm-instructions" rows="6">${_esc(p.instructions)}</textarea>
        <label class="pm-label">Folder</label>
        <div style="display:flex;gap:6px;align-items:stretch;">
          <input id="pm-workspace" type="text" class="styled-prompt-input" value="${_esc(p.workspace)}" placeholder="automatic" style="flex:1;margin:0;height:auto;">
          <button type="button" id="pm-browse" class="confirm-btn confirm-btn-secondary" style="white-space:nowrap;margin:0;align-self:stretch;">Browse…</button>
        </div>
        ${skills.length ? `
        <label class="pm-label">Pinned skills (optional, max. 4 — preferred in project chats)</label>
        <div>
          <button type="button" id="pm-skills-btn" class="confirm-btn confirm-btn-secondary" style="width:100%;text-align:left;margin:0;"></button>
          <!-- In-flow (accordion) instead of absolute: the modal body scrolls,
               and an absolutely positioned panel gets clipped by overflow. -->
          <div id="pm-skills-dd" class="dropdown" style="display:none;position:static;width:100%;box-sizing:border-box;margin-top:2px;max-height:170px;overflow:auto;">
            ${skills.map(s => `
              <label class="dropdown-item" title="${_esc(s.description)}" style="display:flex;gap:7px;align-items:baseline;cursor:pointer;">
                <input type="checkbox" class="pm-skill" value="${_esc(s.name)}" ${pinned.has(s.name) ? 'checked' : ''}>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><strong>${_esc(s.name)}</strong> <span style="opacity:.6;">– ${_esc(s.description)}</span></span>
              </label>`).join('')}
          </div>
        </div>` : ''}
        ${isNew ? '' : `
        <label class="pm-label">Files</label>
        <div id="pm-files" class="workspace-body" style="max-height:180px;overflow:auto;font-size:13px;">loading …</div>
        <input id="pm-upload" type="file" multiple style="margin-top:6px;font-size:12px;">`}
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:space-between;">
        <span>${isNew ? '' : '<button id="pm-delete" class="confirm-btn confirm-btn-secondary" style="color:var(--accent-error,#c66);">Remove project</button>'}</span>
        <span style="display:flex;gap:8px;">
          <button id="pm-cancel" class="confirm-btn confirm-btn-secondary">Cancel</button>
          <button id="pm-save" class="confirm-btn confirm-btn-primary">Save</button>
        </span>
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
  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(modal, { content, header });

  // Folder picker (native look, callback into the form field).
  q('#pm-browse').addEventListener('click', () => {
    _openFolderPicker(q('#pm-workspace').value.trim() || p.workspace || '', (picked) => {
      q('#pm-workspace').value = picked;
    });
  });

  // Skills dropdown: button shows the selection, panel holds checkboxes.
  const skillsBtn = q('#pm-skills-btn');
  const skillsDd = q('#pm-skills-dd');
  const _syncSkillsBtn = () => {
    if (!skillsBtn) return;
    const sel = [...modal.querySelectorAll('.pm-skill:checked')].map(cb => cb.value);
    skillsBtn.textContent = sel.length ? sel.join(', ') : 'Select skills…';
  };
  if (skillsBtn && skillsDd) {
    _syncSkillsBtn();
    skillsBtn.addEventListener('click', () => {
      skillsDd.style.display = skillsDd.style.display === 'none' ? 'block' : 'none';
    });
    modal.querySelectorAll('.pm-skill').forEach(cb => cb.addEventListener('change', () => {
      const checked = modal.querySelectorAll('.pm-skill:checked');
      if (checked.length > 4) {
        cb.checked = false;
        if (uiModule.showToast) uiModule.showToast('At most 4 pinned skills.');
      }
      _syncSkillsBtn();
    }));
    document.addEventListener('click', function _outside(ev) {
      if (!modal.contains(ev.target)) return;
      if (!skillsDd.contains(ev.target) && ev.target !== skillsBtn) skillsDd.style.display = 'none';
    });
  }

  q('#pm-save').addEventListener('click', async () => {
    const body = {
      name: q('#pm-name').value.trim(),
      template_id: q('#pm-template').value,
      instructions: q('#pm-instructions').value,
      pinned_skills: [...modal.querySelectorAll('.pm-skill:checked')].map(cb => cb.value).slice(0, 4),
    };
    const ws = q('#pm-workspace').value.trim();
    if (ws) body.workspace = ws;
    if (!body.name) { if (uiModule.showToast) uiModule.showToast('Name is required'); return; }
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
      if (uiModule.showError) uiModule.showError('Saving failed: ' + e.message);
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
        if (!data.files.length) { filesBox.innerHTML = '<div class="workspace-empty">no files yet</div>'; return; }
        filesBox.innerHTML = data.files.map(f => `
          <div class="workspace-row" style="display:flex;justify-content:space-between;gap:8px;cursor:default;">
            <a href="${API}/api/projects/${p.id}/files/${encodeURIComponent(f.path)}" target="_blank" style="color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_FOLDER_SVG.replace('workspace-row-icon', 'workspace-row-icon file')} ${_esc(f.path)}</a>
            <span style="white-space:nowrap;opacity:.6;">${(f.size / 1024).toFixed(0)} KB
              <a href="#" data-del="${_esc(f.path)}" style="color:var(--accent-error,#c66);text-decoration:none;margin-left:6px;" title="Delete">✕</a></span>
          </div>`).join('');
        filesBox.querySelectorAll('[data-del]').forEach(a => a.addEventListener('click', async (ev) => {
          ev.preventDefault();
          await _json(`/api/projects/${p.id}/files/${encodeURIComponent(a.dataset.del)}`, { method: 'DELETE' });
          renderFiles();
        }));
      } catch (e) {
        filesBox.innerHTML = '<div class="workspace-empty">Loading files failed</div>';
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
          if (uiModule.showError) uiModule.showError(`Upload ${file.name} failed: ` + e.message);
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
