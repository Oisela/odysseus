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
import workspaceModule from './workspace.js';
import { makeWindowDraggable } from './windowDrag.js';
import { selectSession, loadSessions, getSessions, createSessionItem } from './sessions.js';

const API = window.location.origin;
// Same folder glyph as the workspace picker (not an emoji).
const _FOLDER_SVG = '<svg class="workspace-row-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const _FOLDER_PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>';

let _projects = [];
let _expanded = JSON.parse(localStorage.getItem('ody-projects-expanded') || '{}');

// Read-only accessor for other modules (presets.js resolves the project
// persona for the indicator chip without duplicating the fetch).
export function getProjects() {
  return _projects;
}

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

// The workspace pill is a client-global picker; project chats bind it to the
// project folder. Track when WE set it so leaving a project chat releases it
// again — otherwise the folder sticks to unrelated chats the user switches to.
let _workspaceFromProject = false;

/** Called by sessions.selectSession on every switch (like presets). */
export function onSessionSwitch(sessionId, projectId = null) {
  if (projectId) {
    // Also covers direct entry via URL hash, which skips _openProjectChat.
    const proj = _projects.find(p => String(p.id) === String(projectId));
    _syncProjectPanelBtn(proj || null);
    // The project pill replaces the workspace pill here — showing both would
    // name the same folder twice (CSS hides the workspace pill on this class).
    document.body.classList.toggle('project-chat', !!proj);
    if (proj && proj.workspace) {
      try { workspaceModule.setWorkspace(proj.workspace); _workspaceFromProject = true; } catch (e) { /* ignore */ }
    }
    return;
  }
  _syncProjectPanelBtn(null);
  document.body.classList.remove('project-chat');
  if (_workspaceFromProject) {
    _workspaceFromProject = false;
    try { workspaceModule.setWorkspace(''); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Project panel — PROJEKT.md (living context) + the project's files, opened
// via the "Files" pill that appears in project chats. Native modal markup,
// draggable like the other windows.
// ---------------------------------------------------------------------------

let _panelProjectId = null;

function _closeProjectPanel() {
  document.getElementById('project-panel')?.remove();
  _panelProjectId = null;
}

function _syncProjectPanelBtn(project) {
  const btn = document.getElementById('project-panel-btn');
  if (!btn) return;
  if (!project) {
    btn.style.display = 'none';
    _closeProjectPanel();
    return;
  }
  btn.style.display = '';
  // The pill wears the project's name (like the persona chip does) — the
  // folder glyph alone doesn't say WHICH project context you're in.
  const nameEl = btn.querySelector('#project-panel-name');
  if (nameEl) nameEl.textContent = project.name || 'Project';
  btn.onclick = () => {
    if (_panelProjectId === project.id && document.getElementById('project-panel')) {
      _closeProjectPanel();
    } else {
      _openProjectPanel(project);
    }
  };
  // Switching between two project chats: refresh the panel if it's open.
  if (_panelProjectId && _panelProjectId !== project.id && document.getElementById('project-panel')) {
    _openProjectPanel(project);
  }
}

async function _openProjectPanel(project) {
  document.getElementById('project-panel')?.remove();
  _panelProjectId = project.id;
  const modal = document.createElement('div');
  modal.id = 'project-panel';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" role="dialog" aria-label="Project files" style="max-width:520px;width:min(520px,94vw);">
      <div class="modal-header">
        <h4>${_FOLDER_SVG}<span style="margin-left:6px;">${_esc(project.name)}</span></h4>
        <button class="close-btn" aria-label="Close">✖</button>
      </div>
      <div style="padding:12px 16px;max-height:76vh;overflow:auto;">
        <label style="display:block;font-size:12px;opacity:.7;margin:2px 0 3px;">PROJEKT.md — living context, read by every project chat</label>
        <textarea id="pp-context" rows="10" spellcheck="false" style="width:100%;box-sizing:border-box;resize:vertical;font-family:var(--mono,monospace);font-size:12.5px;"></textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
          <button type="button" id="pp-save" class="confirm-btn confirm-btn-primary" disabled>Save</button>
          <span id="pp-msg" style="font-size:12px;opacity:.7;"></span>
        </div>
        <label style="display:block;font-size:12px;opacity:.7;margin:12px 0 3px;">Files</label>
        <div id="pp-files" class="workspace-body" style="max-height:220px;overflow:auto;font-size:13px;">loading …</div>
        <button type="button" id="pp-upload-btn" class="confirm-btn confirm-btn-secondary" style="margin-top:6px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Upload files
        </button>
        <input id="pp-upload" type="file" multiple style="display:none;">
      </div>
    </div>`;
  document.body.appendChild(modal);
  const q = (sel) => modal.querySelector(sel);
  q('.close-btn').addEventListener('click', _closeProjectPanel);
  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(modal, { content, header });

  // PROJEKT.md: read via the files API; save via the upload endpoint (a Blob
  // named PROJEKT.md lands at the folder root — no extra write endpoint).
  const ta = q('#pp-context'), saveBtn = q('#pp-save'), msg = q('#pp-msg');
  let saved = '';
  try {
    const res = await fetch(`${API}/api/projects/${project.id}/files/PROJEKT.md`, { credentials: 'same-origin' });
    saved = res.ok ? await res.text() : '';
  } catch (e) { saved = ''; }
  ta.value = saved;
  ta.placeholder = 'No PROJEKT.md yet — write the project context here and save.';
  ta.addEventListener('input', () => { saveBtn.disabled = ta.value === saved; });
  saveBtn.addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([ta.value], { type: 'text/markdown' }), 'PROJEKT.md');
    try {
      await _json(`/api/projects/${project.id}/files`, { method: 'POST', body: fd });
      saved = ta.value;
      saveBtn.disabled = true;
      msg.textContent = 'Saved.';
      setTimeout(() => { msg.textContent = ''; }, 2500);
    } catch (e) {
      if (uiModule.showError) uiModule.showError('Saving PROJEKT.md failed: ' + e.message);
    }
  });

  // Files list + upload — same rows as the project modal.
  const filesBox = q('#pp-files');
  const renderFiles = async () => {
    try {
      const data = await _json(`/api/projects/${project.id}/files`);
      if (!data.files.length) { filesBox.innerHTML = '<div class="workspace-empty">no files yet</div>'; return; }
      filesBox.innerHTML = data.files.map(f => `
        <div class="workspace-row" style="display:flex;justify-content:space-between;gap:8px;cursor:default;">
          <a href="${API}/api/projects/${project.id}/files/${encodeURIComponent(f.path)}" target="_blank" style="color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><svg class="workspace-row-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${_esc(f.path)}</a>
          <span style="white-space:nowrap;opacity:.6;">${(f.size / 1024).toFixed(0)} KB
            <a href="#" data-del="${_esc(f.path)}" style="color:var(--accent-error,#c66);text-decoration:none;margin-left:6px;" title="Delete">✕</a></span>
        </div>`).join('');
      filesBox.querySelectorAll('[data-del]').forEach(a => a.addEventListener('click', async (ev) => {
        ev.preventDefault();
        await _json(`/api/projects/${project.id}/files/${encodeURIComponent(a.dataset.del)}`, { method: 'DELETE' });
        renderFiles();
      }));
    } catch (e) {
      filesBox.innerHTML = '<div class="workspace-empty">Loading files failed</div>';
    }
  };
  renderFiles();
  q('#pp-upload-btn')?.addEventListener('click', () => q('#pp-upload')?.click());
  q('#pp-upload')?.addEventListener('change', async (ev) => {
    for (const file of ev.target.files) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        await _json(`/api/projects/${project.id}/files`, { method: 'POST', body: fd });
      } catch (e) {
        if (uiModule.showError) uiModule.showError(`Upload ${file.name} failed: ` + e.message);
      }
    }
    ev.target.value = '';
    renderFiles();
  });
}

function _openProjectChat(project, sessionId) {
  // Stale guard: the chat may have been deleted via the native row menu —
  // opening it then dies on an empty response. Resync instead.
  const exists = (getSessions() || []).some(s => String(s.id) === String(sessionId));
  if (!exists) {
    Promise.all([loadSessions(), loadProjects()]).catch(() => {});
    return;
  }
  // Server enforces workspace/template anyway; mirror the workspace into the
  // client picker so the UI pill shows the right folder.
  if (project.workspace) {
    try { workspaceModule.setWorkspace(project.workspace); } catch (e) { /* ignore */ }
  }
  selectSession(sessionId);
}

async function _newChatInProject(project) {
  // Project default model ("endpoint_url::model", same encoding as tasks)
  // wins; otherwise clone model/endpoint from the most recent session so the
  // new chat is immediately usable without a model-picker round-trip.
  const all = getSessions() || [];
  const donor = all.find(s => s.model && s.endpoint_url) || all[0];
  const fd = new FormData();
  // "Chat" is one of the placeholder names needs_auto_name() recognizes, so
  // the auto-namer titles the session from the first exchange — exactly like
  // regular chats.
  fd.append('name', 'Chat');
  const dm = String(project.default_model || '');
  const sep = dm.indexOf('::');
  if (sep > 0 && sep < dm.length - 2) {
    fd.append('endpoint_url', dm.slice(0, sep));
    fd.append('model', dm.slice(sep + 2));
  } else if (donor) {
    fd.append('model', donor.model || '');
    fd.append('endpoint_url', donor.endpoint_url || '');
  }
  fd.append('skip_validation', 'true');
  try {
    const res = await _json('/api/session', { method: 'POST', body: fd });
    const sid = res.id;
    await _json(`/api/projects/${project.id}/sessions/${sid}`, { method: 'POST' });
    await loadSessions();
    await loadProjects();
    _openProjectChat(project, sid);
  } catch (e) {
    if (uiModule.showError) uiModule.showError('Could not create chat: ' + e.message);
  }
}

/**
 * Start a fresh chat in a project from outside this module (Developer page's
 * "Go" button). Resolves the project by id, creates the chat with the
 * project's default model, and opens it.
 */
export async function startProjectChat(projectId) {
  let proj = _projects.find(p => String(p.id) === String(projectId));
  if (!proj) {
    try { await loadProjects(); } catch (e) { /* keep going with what we have */ }
    proj = _projects.find(p => String(p.id) === String(projectId));
  }
  if (!proj) throw new Error('Project not found');
  await _newChatInProject(proj);
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
      <div class="modal-footer workspace-footer" style="display:flex;gap:8px;justify-content:space-between;align-items:center;">
        <button type="button" class="confirm-btn confirm-btn-secondary" id="pfp-new" title="Create a new folder here">${_FOLDER_PLUS_SVG}<span style="margin-left:5px;">New folder</span></button>
        <span style="display:flex;gap:8px;">
          <button type="button" class="confirm-btn confirm-btn-secondary" id="pfp-cancel">Cancel</button>
          <button type="button" class="confirm-btn confirm-btn-primary" id="pfp-use">Use this folder</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.close-btn').addEventListener('click', close);
  modal.querySelector('#pfp-cancel').addEventListener('click', close);
  modal.querySelector('#pfp-use').addEventListener('click', () => { onPick(curPath); close(); });
  modal.querySelector('#pfp-new').addEventListener('click', async () => {
    const name = await uiModule.styledPrompt('Create a new folder inside:\n' + (curPath || '~'), {
      title: 'New folder', placeholder: 'Folder name', confirmText: 'Create', maxLength: 80,
    });
    if (!name) return;
    try {
      const res = await _json('/api/workspace/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: curPath, name }),
      });
      await nav(res && res.path ? res.path : curPath);
      if (uiModule.showToast) uiModule.showToast('Folder created');
    } catch (e) {
      if (uiModule.showError) uiModule.showError('Could not create folder: ' + (e && e.message ? e.message : e));
    }
  });
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
  const p = project || { name: '', instructions: '', template_id: '', pinned_skills: [], workspace: '', default_model: '' };

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

  // Default model: "endpoint_url::model" pairing (same encoding as tasks) —
  // new chats in the project start on it instead of cloning the last session.
  const curModelKey = p.default_model || '';
  let modelOptions = `<option value="">(none – last used model)</option>`;
  let modelKeyListed = !curModelKey;
  try {
    const data = await _json('/api/models');
    const items = (data.items || []).filter(it => (it.model_type || 'llm') === 'llm');
    for (const it of items) {
      // Unlike the task picker, don't require a live cached `models` list or
      // an online endpoint: some endpoints (e.g. Gemini) only carry pinned
      // models_extra, and a default choice doesn't need liveness right now.
      const merged = [...new Set([...(it.models || []), ...(it.models_extra || [])])];
      if (!merged.length) continue;
      const opts = merged.map(m => {
        const key = `${it.url}::${m}`;
        if (key === curModelKey) modelKeyListed = true;
        return `<option value="${_esc(key)}" ${key === curModelKey ? 'selected' : ''}>${_esc(m)}</option>`;
      }).join('');
      modelOptions += `<optgroup label="${_esc(it.endpoint_name || it.host || 'endpoint')}">${opts}</optgroup>`;
    }
  } catch (e) { /* dropdown stays minimal */ }
  // Preserve a previously-set pairing even if /api/models doesn't list it
  // anymore (e.g. endpoint disabled), so the user can see it's set.
  if (!modelKeyListed) {
    const m = curModelKey.slice(curModelKey.indexOf('::') + 2);
    modelOptions += `<option value="${_esc(curModelKey)}" selected>${_esc(m)} (unlisted endpoint)</option>`;
  }

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
        <label class="pm-label">Default model (new chats in this project start with it)</label>
        <select id="pm-model">${modelOptions}</select>
        <label class="pm-label">Project instructions (added on top of the persona)</label>
        <textarea id="pm-instructions" rows="6">${_esc(p.instructions)}</textarea>
        <label class="pm-label">Folder</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input id="pm-workspace" type="text" class="styled-prompt-input" value="${_esc(p.workspace)}" placeholder="automatic" style="flex:1;margin:0;height:38px;box-sizing:border-box;">
          <button type="button" id="pm-browse" class="confirm-btn confirm-btn-secondary" style="white-space:nowrap;margin:0;height:38px;box-sizing:border-box;padding:0 14px;display:inline-flex;align-items:center;">Browse…</button>
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
        <button type="button" id="pm-upload-btn" class="confirm-btn confirm-btn-secondary" style="margin-top:6px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Upload files
        </button>
        <input id="pm-upload" type="file" multiple style="display:none;">`}
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
    // Listener on the modal (not document): it dies with the modal, so
    // repeated open/close cycles don't stack handlers.
    modal.addEventListener('click', (ev) => {
      if (!skillsDd.contains(ev.target) && ev.target !== skillsBtn) skillsDd.style.display = 'none';
    });
  }

  q('#pm-save').addEventListener('click', async () => {
    const body = {
      name: q('#pm-name').value.trim(),
      template_id: q('#pm-template').value,
      default_model: q('#pm-model').value,
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
            <a href="${API}/api/projects/${p.id}/files/${encodeURIComponent(f.path)}" target="_blank" style="color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><svg class="workspace-row-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${_esc(f.path)}</a>
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
    q('#pm-upload-btn')?.addEventListener('click', () => q('#pm-upload')?.click());
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

let _renderRetries = 0;

function render() {
  // Header lives statically in index.html (so section collapse/reorder wire
  // up like every other section) — we only ever render the item list.
  const host = document.getElementById('projects-list');
  if (!host) return;
  const all = getSessions() || [];
  const bySid = new Map(all.map(s => [String(s.id), s]));

  // Build into a detached container first; swap only when the markup really
  // changed. renderSessionList fires often (streams, renames) and re-drawing
  // an identical tree every time reads as flicker.
  const frag = document.createElement('div');

  if (!_projects.length) {
    frag.insertAdjacentHTML('beforeend',
      '<div style="font-size:12px;opacity:.55;padding:2px 8px 6px;">No projects yet</div>');
  }

  // Flat structure — every row is a direct sibling (like the other sections),
  // so the section domino animation staggers via :nth-child exactly like in
  // Chats/Tools. No wrapper divs.
  let _missingSessions = false;
  for (const p of _projects) {
    const open = !!_expanded[p.id];

    const row = document.createElement('div');
    row.className = 'list-item project-row';
    row.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.5;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(p.name)}</span>
      <button class="section-header-btn project-gear" title="Project settings">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <svg class="project-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.6;transition:transform .15s ease;transform:rotate(${open ? '0' : '-90'}deg);"><polyline points="6 9 12 15 18 9"/></svg>`;
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.project-gear')) return;
      _expanded[p.id] = !_expanded[p.id];
      _saveExpanded();
      render();
    });
    row.querySelector('.project-gear').addEventListener('click', (ev) => {
      ev.stopPropagation();
      _openModal(p);
    });
    // Drop target: drag a chat row (Chats list or another project) onto the
    // project to move it here.
    row.addEventListener('dragover', (ev) => {
      if (![...ev.dataTransfer.types].includes('application/x-odysseus-session')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (ev) => {
      row.classList.remove('drag-over');
      const sid = ev.dataTransfer.getData('application/x-odysseus-session');
      if (!sid) return;
      ev.preventDefault();
      try {
        await _json(`/api/projects/${p.id}/sessions/${sid}`, { method: 'POST' });
        _expanded[p.id] = true;
        _saveExpanded();
        await Promise.all([loadSessions(), loadProjects()]);
      } catch (e) {
        if (uiModule.showError) uiModule.showError('Move failed: ' + e.message);
      }
    });
    frag.appendChild(row);

    if (open) {
      for (const ps of (p.sessions || [])) {
        const full = bySid.get(String(ps.id));
        if (full) {
          // The exact same row as the Chats list — icons, favorite, full
          // actions dropdown (rename/copy/move/archive/delete). Indent on the
          // row itself so it stays a direct sibling (animation stagger).
          const item = createSessionItem(full);
          item.style.marginLeft = '14px';
          frag.appendChild(item);
        } else {
          _missingSessions = true;
        }
      }
      const add = document.createElement('div');
      add.className = 'list-item project-newchat';
      add.style.cssText = 'padding-left:26px;font-size:12px;opacity:.75;';
      add.textContent = '+ New chat';
      add.addEventListener('click', () => _newChatInProject(p));
      frag.appendChild(add);
    }
  }

  // Swap only on real change (see note above — avoids re-render flicker).
  if (frag.innerHTML !== host.innerHTML) {
    host.innerHTML = '';
    while (frag.firstChild) host.appendChild(frag.firstChild);
  }

  // On first load the sessions module may not have fetched yet — retry a few
  // times until the full session objects are available for the native rows.
  if (_missingSessions && _renderRetries < 6) {
    _renderRetries += 1;
    setTimeout(render, 700);
  } else if (!_missingSessions) {
    _renderRetries = 0;
  }
}

// Self-init: module scripts run after DOM parse. The add button is part of
// the static header, so it is bound exactly once here.
document.getElementById('project-add-btn')?.addEventListener('click', () => _openModal(null));

// Dropping a chat onto the Chats section detaches it from its project.
const _chatsSection = document.getElementById('sessions-section');
if (_chatsSection) {
  _chatsSection.addEventListener('dragover', (ev) => {
    if (![...ev.dataTransfer.types].includes('application/x-odysseus-session')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  });
  _chatsSection.addEventListener('drop', async (ev) => {
    const sid = ev.dataTransfer.getData('application/x-odysseus-session');
    if (!sid) return;
    ev.preventDefault();
    const s = (getSessions() || []).find(x => String(x.id) === String(sid));
    if (!s || !s.project_id) return; // already a plain chat — nothing to do
    try {
      await _json(`/api/projects/sessions/${sid}`, { method: 'DELETE' });
      await Promise.all([loadSessions(), loadProjects()]);
    } catch (e) {
      if (uiModule.showError) uiModule.showError('Move failed: ' + e.message);
    }
  });
}

// Stay in sync with the native chats list: whenever it re-renders (delete/
// archive/rename/auto-name), refresh the project tree from the server so the
// mirrored rows never go stale. Debounced — renderSessionList fires often.
let _syncTimer = null;
window.addEventListener('odysseus-sessions-rendered', () => {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(loadProjects, 400);
});

loadProjects();

export default { loadProjects };
