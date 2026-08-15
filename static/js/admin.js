// static/js/admin.js — Admin panel module (ES6)
// Admin-only: users, endpoints, MCP, RAG, embeddings, tokens, webhooks, features

import uiModule from './ui.js';
import { uploadImageMdRe } from './markdown.js';
import settingsModule, { fetchModelEndpoints, fillEndpointSelect, fillModelSelect } from './settings.js';
import { providerLogo, providerLogoFromUrl } from './providers.js';
import { sortModelObjects } from './modelSort.js';
import { PROVIDER_DEVICE_FLOWS, formatDeviceFlowError, runProviderDeviceFlow } from './providerDeviceFlow.js';

let initialized = false;
let modalEl = null;
// When the user adds an endpoint, store its id so the next render of
// the endpoints list can flash a glow on that row. Cleared once the
// animation fires.
let _recentlyAddedEpId = null;
let _authPolicy = { password_min_length: 8, reserved_usernames: [] };

function el(id) { return document.getElementById(id); }
function esc(s) { return uiModule.esc(s); }

/* ═══════════════════════════════════════════
   USERS TAB
   ═══════════════════════════════════════════ */
const PRIV_LABELS = {
  can_use_agent: 'Agent mode',
  can_use_browser: 'Browser automation',
  can_use_bash: 'Shell / Python / Files',
  can_use_documents: 'Document editor',
  can_use_research: 'Deep research',
  can_generate_images: 'Image generation',
  can_manage_memory: 'Memory & skills',
};

async function loadUsers() {
  const list = el('adm-userList');
  try {
    const res = await fetch('/api/auth/users', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) { list.innerHTML = '<div class="admin-empty">Access denied</div>'; return; }
    const data = await res.json();
    if (!data.users || data.users.length === 0) { list.innerHTML = '<div class="admin-empty">No users found</div>'; return; }
    list.innerHTML = '';
    data.users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'admin-user-row';

      // Header: name + badges + delete
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;';
      const initial = u.username.charAt(0).toUpperCase();
      header.innerHTML = `
        <div class="admin-user-info">
          <div style="width:28px;height:28px;border-radius:50%;background:color-mix(in srgb, var(--accent) 20%, var(--panel));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0;color:var(--accent);">${esc(initial)}</div>
          <div>
            <span class="admin-user-name">${esc(u.username)}</span>
            ${u.is_admin ? '<span class="admin-badge" style="margin-left:6px;">ADMIN</span>' : '<span style="font-size:10px;opacity:0.4;display:block;">Click to manage privileges</span>'}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="admin-btn-sm" data-adm-toggle-admin="${esc(u.username)}" data-make-admin="${u.is_admin ? '0' : '1'}" style="font-size:11px;">${u.is_admin ? 'Revoke admin' : 'Make admin'}</button>
          <button class="admin-btn-sm" data-adm-rename-user="${esc(u.username)}" style="font-size:11px;">Rename</button>
          ${u.is_admin ? '' : `<button class="admin-btn-delete" data-adm-del-user="${esc(u.username)}" style="font-size:11px;">Remove</button>`}
          ${u.is_admin ? '' : '<svg class="admin-user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>'}
        </div>
      `;
      row.appendChild(header);

      // Privileges panel (hidden by default, not for admins)
      if (!u.is_admin) {
        const privPanel = document.createElement('div');
        privPanel.className = 'admin-priv-panel hidden';
        privPanel.style.cssText = 'padding:8px 0 4px;border-top:1px solid var(--border);margin-top:8px;';

        // Boolean toggles
        let html = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.35;font-weight:600;margin-bottom:4px;">Features</div>';
        for (const [key, label] of Object.entries(PRIV_LABELS)) {
          const checked = u.privileges && u.privileges[key] ? 'checked' : '';
          html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
            <span style="font-size:12px;">${label}</span>
            <label class="admin-switch" style="transform:scale(0.85);"><input type="checkbox" data-priv="${key}" data-user="${esc(u.username)}" ${checked}><span class="admin-slider"></span></label>
          </div>`;
        }
        // UI preset — writes the account's ui_visibility pref server-side;
        // takes effect on the user's next load on any device.
        html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.35;font-weight:600;margin:10px 0 4px;">Interface</div>';
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
          <div>
            <span style="font-size:12px;">UI preset</span>
            <div style="font-size:10px;opacity:0.4;">Simple = chat, notes, calendar &amp; shopping only</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="admin-btn-sm" data-ui-preset="simple" data-user="${esc(u.username)}" style="font-size:11px;">Simple</button>
            <button class="admin-btn-sm" data-ui-preset="full" data-user="${esc(u.username)}" style="font-size:11px;">Full</button>
          </div>
        </div>`;
        // Rate limit
        html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.35;font-weight:600;margin:10px 0 4px;">Limits</div>';
        const maxMsg = (u.privileges && u.privileges.max_messages_per_day) || 0;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
          <div>
            <span style="font-size:12px;">Daily message limit</span>
            <div style="font-size:10px;opacity:0.4;">0 = no limit</div>
          </div>
          <input type="number" min="0" value="${maxMsg}" data-priv="max_messages_per_day" data-user="${esc(u.username)}" style="width:70px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-size:12px;text-align:center;">
        </div>`;
        // Allowed models — checkbox list
        const allowedModels = Array.isArray(u.privileges && u.privileges.allowed_models)
          ? u.privileges.allowed_models
          : [];
        const allowedSet = new Set(allowedModels);
        const modelsRestricted = !!(u.privileges && u.privileges.allowed_models_restricted);
        const blockAllModels = !!(u.privileges && u.privileges.block_all_models);
        html += `<div style="padding:4px 0;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:12px;">Allowed models</span>
            <div style="display:flex;gap:8px;">
              <a href="#" class="priv-models-all" data-user="${esc(u.username)}" style="font-size:10px;opacity:0.5;">All</a>
              <a href="#" class="priv-models-none" data-user="${esc(u.username)}" style="font-size:10px;opacity:0.5;">None</a>
            </div>
          </div>
          <div style="font-size:10px;opacity:0.4;margin-bottom:4px;">${blockAllModels ? 'No models allowed' : (!modelsRestricted ? 'All models allowed (no restrictions)' : (allowedSet.size === 0 ? 'No models allowed' : allowedSet.size + ' model(s) allowed'))}</div>
          <div class="priv-models-list" data-user="${esc(u.username)}">
            <span style="opacity:0.4;font-size:11px;">Loading models...</span>
          </div>
        </div>`;
        privPanel.innerHTML = html;
        row.appendChild(privPanel);

        // Toggle panel visibility + rotate chevron + load models
        let _modelsLoaded = false;
        header.addEventListener('click', (e) => {
          if (e.target.closest('.admin-btn-delete, [data-adm-rename-user], [data-adm-toggle-admin]')) return;
          privPanel.classList.toggle('hidden');
          const chevron = header.querySelector('.admin-user-chevron');
          if (chevron) {
            const isOpen = !privPanel.classList.contains('hidden');
            chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
            chevron.style.opacity = isOpen ? '0.7' : '0.3';
          }
          // Load models list on first expand
          if (!_modelsLoaded && !privPanel.classList.contains('hidden')) {
            _modelsLoaded = true;
            _loadModelsForUser(u.username, allowedSet, modelsRestricted, blockAllModels, privPanel);
          }
        });

        // Wire the per-account UI preset buttons
        privPanel.querySelectorAll('[data-ui-preset]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const value = btn.dataset.uiPreset === 'simple'
              ? (window.uiSimpleState ? window.uiSimpleState() : {})
              : {};
            try {
              const r = await fetch(`/api/prefs/admin/${encodeURIComponent(btn.dataset.user)}/ui_visibility`, {
                method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value }),
              });
              if (!r.ok) throw new Error(String(r.status));
              uiModule.showToast(`${btn.dataset.uiPreset === 'simple' ? 'Simple' : 'Full'} UI set for ${btn.dataset.user} — applies on their next load.`);
            } catch (e) { uiModule.showError('Failed to set UI preset'); }
          });
        });

        // Wire privilege changes (boolean + number inputs, not model checkboxes)
        privPanel.querySelectorAll('[data-priv]').forEach(input => {
          const handler = async () => {
            const username = input.dataset.user;
            const key = input.dataset.priv;
            let value;
            if (input.type === 'checkbox') value = input.checked;
            else if (input.type === 'number') value = parseInt(input.value) || 0;
            else value = input.value;
            try {
              await fetch(`/api/auth/users/${encodeURIComponent(username)}/privileges`, {
                method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value }),
              });
            } catch (e) { uiModule.showError('Failed to update privilege'); }
          };
          if (input.type === 'checkbox') input.addEventListener('change', handler);
          else input.addEventListener('change', handler);
        });
      }

      // Rename button
      const renameBtn = row.querySelector('[data-adm-rename-user]');
      if (renameBtn) {
        renameBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const oldUsername = renameBtn.dataset.admRenameUser;
          const next = await uiModule.styledPrompt(`Rename "${oldUsername}"`, {
            defaultValue: oldUsername,
            placeholder: 'New username',
            confirmText: 'Rename',
          });
          const username = (next || '').trim();
          if (!username || username === oldUsername) return;
          try {
            const res = await fetch(`/api/auth/users/${encodeURIComponent(oldUsername)}/rename`, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              uiModule.showError(data.detail || 'Failed to rename user');
              return;
            }
            if (data.renamed_self) {
              window.location.reload();
              return;
            }
            loadUsers();
          } catch (err) {
            uiModule.showError('Failed to rename user');
          }
        });
      }

      // Delete button
      const delBtn = row.querySelector('[data-adm-del-user]');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const username = delBtn.dataset.admDelUser;
          if (!await uiModule.styledConfirm(`Remove user "${username}"?`, { confirmText: 'Remove', danger: true })) return;
          const res = await fetch('/api/auth/users', { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
          if (res.ok) loadUsers();
          else uiModule.showError('Failed to delete user');
        });
      }

      // Promote / demote (admin toggle) — present on every row
      const adminToggleBtn = row.querySelector('[data-adm-toggle-admin]');
      if (adminToggleBtn) {
        adminToggleBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const username = adminToggleBtn.dataset.admToggleAdmin;
          const makeAdmin = adminToggleBtn.dataset.makeAdmin === '1';
          const confirmMsg = makeAdmin
            ? `Grant admin rights to "${username}"? They'll get full access to all settings and users — including the power to demote or remove other admins (you included).`
            : `Revoke admin rights from "${username}"? They'll lose access to the admin panel.`;
          if (!await uiModule.styledConfirm(confirmMsg, { confirmText: makeAdmin ? 'Make admin' : 'Revoke admin', danger: !makeAdmin })) return;
          adminToggleBtn.disabled = true;
          try {
            const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}/admin`, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ is_admin: makeAdmin }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              uiModule.showError(data.detail || 'Failed to change admin status');
              adminToggleBtn.disabled = false;
              return;
            }
            // Demoting yourself drops your own admin access — reload into the
            // normal-user view (mirrors the rename-self reload above).
            if (data.self) { window.location.reload(); return; }
            loadUsers();
          } catch (err) {
            uiModule.showError('Failed to change admin status');
            adminToggleBtn.disabled = false;
          }
        });
      }

      list.appendChild(row);
    });
  } catch (e) { list.innerHTML = '<div class="admin-error">Failed to load users</div>'; }
}

async function _loadModelsForUser(username, allowedSet, modelsRestricted, blockAllModels, privPanel) {
  const listEl = privPanel.querySelector(`.priv-models-list[data-user="${username}"]`);
  if (!listEl) return;
  try {
    // Use /api/model-endpoints rather than /api/models — the latter is
    // backed by `cached_models`, so endpoints that haven't been probed yet
    // (e.g. a freshly-added cloud API like DeepSeek) simply don't show up
    // until some other endpoint happens to trigger a cache refresh. The
    // endpoints listing always reflects every configured endpoint.
    const res = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    const data = await res.json();
    const allModels = [];
    (Array.isArray(data) ? data : []).forEach(ep => {
      if (!ep.online) return;
      (ep.models || []).forEach(mid => {
        allModels.push({ mid, epName: ep.name || '', display: mid.split('/').pop() });
      });
    });
    if (!allModels.length) {
      listEl.innerHTML = '<span style="opacity:0.4;font-size:11px;">No models available</span>';
      return;
    }
    let restricted = modelsRestricted;
    let blockAll = blockAllModels;
    listEl.innerHTML = sortModelObjects(allModels).map(m => {
      const checked = !blockAll && (!restricted || allowedSet.has(m.mid)) ? 'checked' : '';
      return `<label>
        <input type="checkbox" class="priv-model-cb" data-mid="${esc(m.mid)}" ${checked}>
        <span>${esc(m.display)}</span>
        <span style="opacity:0.3;font-size:10px;margin-left:auto;">${esc(m.epName)}</span>
      </label>`;
    }).join('');

    // Save on change
    function _saveModels() {
      const checked = [];
      listEl.querySelectorAll('.priv-model-cb').forEach(cb => {
        if (cb.checked) checked.push(cb.dataset.mid);
      });
      // Three distinct states the backend must be able to tell apart:
      //  - all checked   -> no restriction (allowed_models: [], block_all_models: false)
      //  - none checked  -> block everything (allowed_models: [], block_all_models: true)
      //  - some checked  -> allowlist (allowed_models: checked, block_all_models: false)
      let value, hintText;
      if (checked.length === allModels.length) {
        restricted = false;
        blockAll = false;
        value = [];
        hintText = 'All models allowed (no restrictions)';
      } else if (checked.length === 0) {
        restricted = true;
        blockAll = true;
        value = [];
        hintText = 'No models allowed';
      } else {
        restricted = true;
        blockAll = false;
        value = checked;
        hintText = value.length + ' model(s) allowed';
      }
      const hint = privPanel.querySelector('.priv-models-list[data-user]')?.previousElementSibling?.querySelector('div[style*="opacity"]');
      if (hint) hint.textContent = hintText;
      fetch(`/api/auth/users/${encodeURIComponent(username)}/privileges`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed_models: value, allowed_models_restricted: restricted, block_all_models: blockAll }),
      }).catch(() => {});
    }
    listEl.querySelectorAll('.priv-model-cb').forEach(cb => cb.addEventListener('change', _saveModels));

    // All / None buttons
    privPanel.querySelector(`.priv-models-all[data-user="${username}"]`)?.addEventListener('click', (e) => {
      e.preventDefault();
      listEl.querySelectorAll('.priv-model-cb').forEach(cb => cb.checked = true);
      _saveModels();
    });
    privPanel.querySelector(`.priv-models-none[data-user="${username}"]`)?.addEventListener('click', (e) => {
      e.preventDefault();
      listEl.querySelectorAll('.priv-model-cb').forEach(cb => cb.checked = false);
      _saveModels();
    });
  } catch (e) {
    listEl.innerHTML = '<span style="opacity:0.4;font-size:11px;">Failed to load models</span>';
  }
}

function initSignupToggle() {
  const toggle = el('adm-signupToggle');
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => { toggle.checked = !!d.signup_enabled; })
    .catch(e => console.warn('Auth status fetch failed:', e));
  toggle.addEventListener('change', async () => {
    try {
      const res = await fetch('/api/auth/signup-toggle', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      toggle.checked = data.signup_enabled;
    } catch (e) { toggle.checked = !toggle.checked; }
  });
}

function initShareDefaultsToggle() {
  const toggle = el('adm-shareDefaultsToggle');
  fetch('/api/auth/settings', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => { toggle.checked = !!d.share_defaults_with_users; })
    .catch(e => console.warn('Settings fetch failed:', e));
  toggle.addEventListener('change', async () => {
    try {
      const res = await fetch('/api/auth/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_defaults_with_users: toggle.checked }),
      });
      const data = await res.json();
      toggle.checked = !!data.share_defaults_with_users;
    } catch (e) {
      toggle.checked = !toggle.checked;
    }
  });
}

function initAddUser() {
  fetch('/api/auth/policy', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(policy => {
      if (!policy) return;
      _authPolicy = policy;
      const admPw = el('adm-newPassword');
      if (admPw) admPw.placeholder = `Password (min ${policy.password_min_length})`;
    })
    .catch(() => {});
  el('adm-addBtn').addEventListener('click', async () => {
    const msg = el('adm-addMsg');
    msg.textContent = ''; msg.className = '';
    const username = el('adm-newUsername').value.trim();
    const password = el('adm-newPassword').value;
    const is_admin = el('adm-newIsAdmin').checked;
    if (!username) { msg.textContent = 'Username required'; msg.className = 'admin-error'; return; }
    if (password.length < _authPolicy.password_min_length) { msg.textContent = `Password must be at least ${_authPolicy.password_min_length} characters`; msg.className = 'admin-error'; return; }
    if (_authPolicy.reserved_usernames.includes(username.toLowerCase())) { msg.textContent = 'This username is reserved'; msg.className = 'admin-error'; return; }
    el('adm-addBtn').disabled = true;
    try {
      const res = await fetch('/api/auth/users', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, is_admin }) });
      const data = await res.json();
      if (res.ok) { msg.textContent = 'User created'; msg.className = 'admin-success'; el('adm-newUsername').value = ''; el('adm-newPassword').value = ''; el('adm-newIsAdmin').checked = false; loadUsers(); }
      else { msg.textContent = data.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
    el('adm-addBtn').disabled = false;
  });
}

/* ═══════════════════════════════════════════
   SERVICES TAB — Endpoints
   ═══════════════════════════════════════════ */
function _isLocalEndpoint(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true;
    if (h.endsWith('.local')) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
    // Tailscale CGNAT range (100.64.0.0/10 → 100.64.x–100.127.x). Servers
    // found via "Scan for Servers" come back as tailnet IPs, which are still
    // your own machines, so group them under Local rather than API.
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
    // Single-label hostnames are LAN by convention.
    if (!h.includes('.')) return true;
    return false;
  } catch { return false; }
}

async function _refreshAfterEndpointChange(deletedEndpointId) {
  try {
    const sm = window.sessionModule;
    const pending = sm && sm.getPendingChat ? sm.getPendingChat() : null;
    if (deletedEndpointId && pending && String(pending.endpointId || '') === String(deletedEndpointId)) {
      if (sm.setPendingChat) sm.setPendingChat(null);
    }
  } catch (_) {}
  try {
    if (window.modelsModule && window.modelsModule.refreshModels) {
      await window.modelsModule.refreshModels(true);
    }
  } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent('ge:model-endpoints-updated', {
      detail: { deletedEndpointId: deletedEndpointId || null }
    }));
  } catch (_) {}
  try {
    if (window.sessionModule && window.sessionModule.updateModelPicker) {
      window.sessionModule.updateModelPicker();
    }
  } catch (_) {}
}

async function _selectAddedModelInChat(endpoint) {
  const modelId = endpoint && Array.isArray(endpoint.models) ? endpoint.models[0] : '';
  if (!modelId) return;
  try {
    if (window.modelsModule && window.modelsModule.refreshModels) {
      await window.modelsModule.refreshModels(true);
    }
  } catch (_) {}
  try {
    document.dispatchEvent(new CustomEvent('odysseus:auto-select-model', {
      detail: {
        endpointId: endpoint.id || '',
        endpointName: endpoint.name || '',
        modelId,
        url: endpoint.base_url || '',
      }
    }));
  } catch (_) {}
}

async function loadEndpoints() {
  const listLocal = el('adm-epList-local');
  const listApi = el('adm-epList-api');
  // Fallback to the legacy single list if the split containers don't exist
  // (older HTML or third-party embedding).
  const listLegacy = el('adm-epList');
  // Refresh model picker so new endpoints show up in chat
  if (window.modelsModule && window.modelsModule.refreshModels) {
    window.modelsModule.refreshModels(true);
    setTimeout(() => {
      if (window.sessionModule && window.sessionModule.updateModelPicker) {
        window.sessionModule.updateModelPicker();
      }
    }, 1500);
  }
  if (settingsModule && typeof settingsModule.refreshAiModelEndpoints === 'function') {
    settingsModule.refreshAiModelEndpoints();
  }
  try {
    const res = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
    // Treat a non-OK response (e.g. 401/403 for non-admins, or backend
    // returning an error envelope) the same as "no endpoints yet": show the
    // empty state, not "Failed to load". The user just installed the app —
    // there's literally nothing to load, so the error read as broken UI.
    let data = [];
    if (res.ok) {
      try { data = await res.json(); } catch { data = []; }
    }
    if (!Array.isArray(data) || data.length === 0) {
      const empty = '<div class="admin-empty">None</div>';
      if (listLocal) listLocal.innerHTML = empty;
      if (listApi) listApi.innerHTML = '<div class="admin-empty">None</div>';
      if (listLegacy) listLegacy.innerHTML = empty;
      return;
    }
    const rowHtml = data.map(ep => {
      const epModels = Array.isArray(ep.models) ? ep.models : [];
      const visibleCount = epModels.length;
      const totalCount = visibleCount + (ep.hidden_count || 0);
      // `ep.models` is the *visible* set — when every model is hidden it's
      // empty, but we still need to render the expand panel so the user can
      // un-hide them. Gate on the total instead.
      const hasModels = ep.online && totalCount > 0;
      const statusBadge = ep.status === 'empty'
        ? '<span class="admin-badge">no models</span>'
        : ep.online
          ? `<span class="admin-badge">${visibleCount}/${totalCount} models enabled</span>`
          : '<span class="admin-badge admin-badge-off">offline</span>';
      const justAddedClass = (_recentlyAddedEpId && String(ep.id) === _recentlyAddedEpId) ? ' adm-ep-just-added' : '';
      const category = ep.category || (_isLocalEndpoint(ep.base_url) ? 'local' : 'api');
      const kindLabel = ep.endpoint_kind && ep.endpoint_kind !== 'auto' ? ep.endpoint_kind.toUpperCase() : '';
      const keyLabel = ep.has_key
        ? (ep.api_key_fingerprint ? ` (key ${esc(ep.api_key_fingerprint)})` : ' (key set)')
        : '';
      return `
        <div class="admin-user-row${ep.is_enabled ? '' : ' admin-ep-disabled'}${justAddedClass}" data-adm-ep-id="${ep.id}">
          <div style="display:flex;align-items:center;justify-content:space-between;${hasModels ? 'cursor:pointer;' : ''}padding:4px 0;" data-adm-ep-header="${ep.id}">
            <div class="admin-user-info" style="flex:1;flex-wrap:wrap;gap:0.3rem;align-items:center;">
              <span class="adm-ep-row-logo" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;opacity:0.9;">${providerLogoFromUrl(ep.base_url) || ''}</span>
              <input type="text" class="admin-user-name adm-ep-rename" data-adm-ep-rename="${ep.id}" value="${esc(ep.name)}" placeholder="Endpoint name" title="Click to rename (e.g. &quot;Google Gemini Free&quot;)" style="background:transparent;border:1px solid transparent;border-radius:4px;padding:2px 4px;min-width:120px;max-width:260px;font:inherit;color:inherit;">

              ${ep.model_type === 'image' ? '<span class="admin-badge" style="background:color-mix(in srgb, var(--accent) 20%, transparent);color:var(--accent);">Image</span>' : ''}
              ${kindLabel ? `<span class="admin-badge">${esc(kindLabel)}</span>` : ''}
              ${statusBadge}
              ${ep.is_enabled ? '' : '<span class="admin-badge admin-badge-off">disabled</span>'}
              ${hasModels ? `<span style="font-size:10px;opacity:0.4;${category === 'api' ? 'flex-basis:100%;' : ''}">Click to manage models</span>` : ''}
            </div>
            <div style="display:flex;gap:4px;align-items:center;">
              <button class="admin-btn-sm" data-adm-toggle-ep="${ep.id}">${ep.is_enabled ? 'Disable' : 'Enable'}</button>
              <button class="admin-btn-delete" data-adm-del-ep="${ep.id}" data-adm-ep-online="${ep.online ? '1' : '0'}">Delete</button>
              ${hasModels ? '<svg class="admin-user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>' : ''}
            </div>
          </div>
          <div class="admin-ep-detail">${esc(ep.base_url)}${category === 'local' ? `<button type="button" class="admin-ep-copy-btn" data-adm-copy-url="${esc(ep.base_url)}" title="Copy URL" aria-label="Copy URL" style="background:none;border:none;padding:0 2px;margin-left:6px;cursor:pointer;color:inherit;opacity:0.45;vertical-align:-2px;line-height:1;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : ''}${keyLabel}</div>
          ${hasModels ? `<div class="mcp-tools-panel hidden" data-adm-ep-models-panel="${ep.id}"></div>` : ''}
        </div>`;
    });
    // Partition rows into Local vs API for the split sections.
    // Subsections without any rows are hidden entirely (heading + all)
    // so empty groups don't take up vertical real estate.
    const _renderInto = (container, indices) => {
      if (!container) return;
      const section = container.closest('.adm-ep-section');
      if (!indices.length) {
        if (section) section.style.display = 'none';
        container.innerHTML = '';
        return;
      }
      if (section) section.style.display = '';
      container.innerHTML = indices.map(i => rowHtml[i]).join('');
    };
    const localIdx = [], apiIdx = [];
    data.forEach((ep, i) => ((ep.category || (_isLocalEndpoint(ep.base_url) ? 'local' : 'api')) === 'local' ? localIdx : apiIdx).push(i));
    // Sort each section: enabled endpoints first, disabled at the bottom.
    // Preserve original order within each group via stable sort.
    const _sortByEnabled = (a, b) => Number(!!data[b].is_enabled) - Number(!!data[a].is_enabled);
    localIdx.sort(_sortByEnabled);
    apiIdx.sort(_sortByEnabled);
    _renderInto(listLocal, localIdx);
    _renderInto(listApi, apiIdx);
    if (listLegacy) listLegacy.innerHTML = rowHtml.join('');
    // Iterate matching nodes across both containers.
    const queryAll = (sel) => {
      const out = [];
      [listLocal, listApi, listLegacy].forEach(c => {
        if (c) c.querySelectorAll(sel).forEach(n => out.push(n));
      });
      return out;
    };
    // Inline endpoint rename (same pattern as the token rename): commit on
    // blur/Enter via the field-targeted PATCH. Lets two keys of the same
    // provider carry distinct names ("Google Gemini Free" vs "... Paid") —
    // the name flows into the model picker as endpoint_name.
    queryAll('[data-adm-ep-rename]').forEach(input => {
      const original = input.value;
      input.addEventListener('click', e => e.stopPropagation());
      const commit = async () => {
        const name = (input.value || '').trim();
        if (!name || name === original) { input.value = original; return; }
        try {
          const r = await fetch(`/api/model-endpoints/${input.dataset.admEpRename}`, {
            method: 'PATCH', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!r.ok) throw new Error('Save failed');
          loadEndpoints();
        } catch (_) { input.value = original; }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });
    queryAll('[data-adm-toggle-ep]').forEach(btn => {
      btn.addEventListener('click', async (e) => { e.stopPropagation(); await fetch(`/api/model-endpoints/${btn.dataset.admToggleEp}`, { method: 'PATCH' }); loadEndpoints(); });
    });
    queryAll('[data-adm-copy-url]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = btn.dataset.admCopyUrl || '';
        if (!url) return;
        uiModule.copyToClipboard(url).then(() => {
          // Brief icon swap to a checkmark so the user gets feedback that
          // the copy actually happened. Reverts after ~1.4s.
          const prev = btn.innerHTML;
          btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          btn.style.opacity = '1';
          setTimeout(() => { btn.innerHTML = prev; btn.style.opacity = ''; }, 1400);
        }).catch(() => {});
      });
    });
    queryAll('[data-adm-del-ep]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        var epId = btn.dataset.admDelEp;
        var isOffline = btn.dataset.admEpOnline === '0';
        // Offline endpoints are already broken — skip the confirm dialog
        // entirely and delete immediately. The optimistic UI removal makes
        // the action feel instant.
        if (!isOffline) {
          var deps = [];
          try {
            var depRes = await fetch('/api/model-endpoints/' + epId + '/dependents', { credentials: 'same-origin' });
            var depData = await depRes.json();
            deps = depData.dependents || [];
          } catch (e) { /* proceed without warning */ }
          var msg = 'Delete this endpoint?';
          if (deps.length) {
            msg += '\n\nThe following settings use this endpoint and will be reset:\n— ' + deps.join('\n— ');
          }
          if (!await uiModule.styledConfirm(msg, { confirmText: 'Delete', danger: true })) return;
        }
        // Optimistic: remove from UI immediately
        const row = btn.closest('[data-adm-ep-id]');
        if (row) row.remove();
        fetch('/api/model-endpoints/' + epId, { method: 'DELETE' })
          .then(() => _refreshAfterEndpointChange(epId))
          .then(() => loadEndpoints())
          .catch(() => loadEndpoints());
      });
    });
    // Clear the just-added marker now that the row has been rendered
    // with the animation class — keeps the glow from re-firing on every
    // subsequent loadEndpoints() call (e.g. when toggling a model).
    if (_recentlyAddedEpId) _recentlyAddedEpId = null;
    // Models expand/collapse (click anywhere on card)
    queryAll('[data-adm-ep-id]').forEach(row => {
      const header = row.querySelector('[data-adm-ep-header]');
      if (!header) return;
      let _modelsLoaded = false;
      row.style.cursor = 'pointer';
      row.addEventListener('click', async (e) => {
        // Don't let interactions inside the expanded panel re-fire the
        // expand/collapse handler — the search box was getting closed
        // because clicking it bubbled up to here.
        if (e.target.closest('.admin-btn-sm, .admin-btn-delete, .mcp-tools-list, .mcp-tools-header, .mcp-tools-search, input, label')) return;
        const epId = header.dataset.admEpHeader;
        const panel = row.querySelector(`[data-adm-ep-models-panel="${epId}"]`);
        if (!panel) return;
        panel.classList.toggle('hidden');
        const chevron = row.querySelector('.admin-user-chevron');
        const isOpen = !panel.classList.contains('hidden');
        if (chevron) {
          chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
          chevron.style.opacity = isOpen ? '0.7' : '0.3';
        }
        if (!_modelsLoaded && isOpen) {
          _modelsLoaded = true;
          // Our shared whirlpool spinner (consistent with the rest of the app).
          panel.innerHTML = '';
          let _modelsSpin = null;
          const _ld = document.createElement('span');
          _ld.style.cssText = 'opacity:0.55;font-size:11px;display:inline-flex;align-items:center;gap:8px;';
          _ld.appendChild(document.createTextNode('Loading models…'));
          try {
            const _sp = (await import('./spinner.js')).default;
            _modelsSpin = _sp.createWhirlpool(14);
            _modelsSpin.element.style.cssText = 'width:14px;height:14px;margin:0;display:inline-block;';
            _ld.appendChild(_modelsSpin.element);
          } catch (_) {}
          panel.appendChild(_ld);
          const _stopSpin = () => { try { _modelsSpin && _modelsSpin.stop(); } catch (_) {} };
          const _loadingHtml = (label) => `<span style="opacity:0.55;font-size:11px;display:inline-flex;align-items:center;gap:8px;">${esc(label)}</span>`;
          const renderModels = (models, warning = '') => {
            const sortedModels = sortModelObjects(models);
            const warningHtml = warning ? `<div class="admin-error" style="font-size:11px;margin:6px 0;">${esc(warning)}</div>` : '';
            const attachRefresh = () => {
              panel.querySelector(`[data-ep-refresh-models="${epId}"]`)?.addEventListener('click', async (e) => {
                e.preventDefault();
                panel.innerHTML = _loadingHtml('Refreshing models...');
                try {
                  const res = await fetch(`/api/model-endpoints/${epId}/models?refresh=true&refresh_timeout=60`, { credentials: 'same-origin' });
                  const refreshWarning = res.headers.get('X-Model-Refresh-Warning') || '';
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  const refreshedModels = await res.json();
                  renderModels(refreshedModels, refreshWarning);
                  if (refreshWarning && uiModule?.showToast) uiModule.showToast(refreshWarning, 6000);
                } catch (_) {
                  renderModels(sortedModels, 'Model refresh failed; kept cached models.');
                }
              });
            };
            if (!sortedModels.length) {
              panel.innerHTML = `<div class="mcp-tools-header">
                <span>Models</span>
                <span style="display:flex;gap:8px;align-items:center;">
                  <span class="mcp-tools-count">0/0 enabled</span>
                  <a href="#" data-ep-refresh-models="${epId}">Refresh</a>
                </span>
              </div>${warningHtml}<span style="opacity:0.5;font-size:11px;">No models</span>`;
              attachRefresh();
              return;
            }
            const hiddenSet = new Set(sortedModels.filter(m => m.is_hidden).map(m => m.id));
            const showSearch = sortedModels.length >= 8;
            panel.innerHTML = `<div class="mcp-tools-header">
              <span>Models</span>
              <span style="display:flex;gap:8px;align-items:center;">
                <span class="mcp-tools-count">${sortedModels.length - hiddenSet.size}/${sortedModels.length} enabled</span>
                <a href="#" data-ep-refresh-models="${epId}">Refresh</a>
                <a href="#" data-ep-select-all="${epId}">All</a>
                <a href="#" data-ep-select-none="${epId}">None</a>
              </span>
            </div>${warningHtml}${showSearch ? `<input type="search" class="mcp-tools-search" placeholder="Search ${sortedModels.length} models..." data-ep-search="${epId}">` : ''}<div class="mcp-tools-list">` + sortedModels.map(m =>
              `<label title="${esc(m.id)}" data-ep-model-row data-search="${esc((m.display + ' ' + m.id).toLowerCase())}" class="adm-model-row">
                <input type="checkbox" class="adm-cb-hidden" data-ep-model-id="${esc(m.id)}" ${!m.is_hidden ? 'checked' : ''}>
                <span class="adm-check-dot" aria-hidden="true"></span>
                <span>${esc(m.display)}</span>
              </label>`
            ).join('') + '</div>';
            const filterRows = (q) => {
              const needle = q.trim().toLowerCase();
              panel.querySelectorAll('[data-ep-model-row]').forEach(row => {
                row.style.display = (!needle || row.dataset.search.includes(needle)) ? '' : 'none';
              });
            };
            attachRefresh();
            panel.querySelector(`[data-ep-search="${epId}"]`)?.addEventListener('input', (e) => filterRows(e.target.value));
            panel.querySelector(`[data-ep-select-all="${epId}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('[data-ep-model-row]').forEach(row => {
                if (row.style.display !== 'none') row.querySelector('input[type=checkbox]').checked = true;
              });
              _saveEpModelState(epId, panel);
            });
            panel.querySelector(`[data-ep-select-none="${epId}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('[data-ep-model-row]').forEach(row => {
                if (row.style.display !== 'none') row.querySelector('input[type=checkbox]').checked = false;
              });
              _saveEpModelState(epId, panel);
            });
            panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
              cb.addEventListener('change', () => _saveEpModelState(epId, panel));
            });
          };
          try {
            const res = await fetch(`/api/model-endpoints/${epId}/models`, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const models = await res.json();
            _stopSpin();
            renderModels(models);
          } catch (e) { _stopSpin(); panel.innerHTML = '<span class="admin-error" style="font-size:11px;">Failed to load models</span>'; }
        }
      });
    });
  } catch (e) {
    const err = '<div class="admin-error">Failed to load</div>';
    [listLocal, listApi, listLegacy].forEach(c => { if (c) c.innerHTML = err; });
  }
}

async function _saveEpModelState(epId, panel) {
  const hidden = [];
  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    if (!cb.checked) hidden.push(cb.dataset.epModelId);
  });
  const total = panel.querySelectorAll('input[type=checkbox]').length;
  try {
    await fetch(`/api/model-endpoints/${epId}/models`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ hidden }),
    });
    const countLabel = panel.querySelector('.mcp-tools-count');
    if (countLabel) countLabel.textContent = `${total - hidden.length}/${total} enabled`;
    const row = panel.closest('[data-adm-ep-id]');
    if (row) {
      const badge = row.querySelector('.admin-badge');
      if (badge && !badge.classList.contains('admin-badge-off')) badge.textContent = `${total - hidden.length}/${total} models enabled`;
    }
    if (settingsModule && typeof settingsModule.refreshAiModelEndpoints === 'function') {
      settingsModule.refreshAiModelEndpoints();
    }
  } catch (e) { /* silent */ }
}

function initEndpointForm() {
  const provider = el('adm-epProvider');
  const urlInput = el('adm-epUrl');
  const kindSel = el('adm-epKind');

  // Custom provider picker — mirrors the (now hidden) <select id="adm-epProvider">
  // so the rest of this function (which reads provider.value and dispatches
  // change events) keeps working unchanged.
  const picker = el('adm-provider-picker');
  const pickerBtn = el('adm-provider-btn');
  const pickerMenu = el('adm-provider-menu');
  const pickerCurrent = picker ? picker.querySelector('.adm-provider-current') : null;
  const DEVICE_AUTH_PROVIDER_VALUES = new Set(Object.keys(PROVIDER_DEVICE_FLOWS));
  let deviceAuthPolling = false;
  function _selectedProviderOption() {
    return provider && provider.selectedOptions ? provider.selectedOptions[0] : null;
  }
  function _selectedDeviceAuthProvider() {
    const opt = _selectedProviderOption();
    const flow = opt && opt.dataset ? opt.dataset.authFlow : '';
    if (flow && DEVICE_AUTH_PROVIDER_VALUES.has(flow)) return flow;
    return DEVICE_AUTH_PROVIDER_VALUES.has(provider.value) ? provider.value : '';
  }
  function _isDeviceAuthSelected() {
    return !!_selectedDeviceAuthProvider();
  }
  function _setApiFormForProvider() {
    const deviceAuthProvider = _selectedDeviceAuthProvider();
    const deviceAuthConfig = PROVIDER_DEVICE_FLOWS[deviceAuthProvider] || null;
    const apiKey = el('adm-epApiKey');
    const testBtn = el('adm-epApiTestBtn');
    const addBtn = el('adm-epAddBtn');
    const status = el('adm-deviceAuthStatus');
    const msg = _endpointMsg('api');
    if (deviceAuthConfig) {
      urlInput.value = '';
      urlInput.placeholder = deviceAuthProvider === 'copilot'
        ? 'GitHub Copilot uses GitHub account sign-in'
        : 'ChatGPT Subscription uses OpenAI account sign-in';
      urlInput.readOnly = true;
      if (apiKey) {
        apiKey.value = '';
        apiKey.placeholder = 'No API key needed';
        apiKey.disabled = true;
      }
      if (testBtn) {
        testBtn.disabled = true;
        testBtn.style.opacity = '0.45';
        testBtn.style.cursor = 'not-allowed';
      }
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = 'Add';
        addBtn.style.width = '55px';
        addBtn.style.display = '';
      }
      if (kindSel) kindSel.value = 'api';
      if (msg) {
        msg.textContent = '';
        msg.className = '';
      }
    } else {
      urlInput.placeholder = 'Base URL or pick provider';
      urlInput.readOnly = false;
      if (apiKey) {
        apiKey.placeholder = 'API key';
        apiKey.disabled = false;
      }
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.style.opacity = '';
        testBtn.style.cursor = '';
      }
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = 'Add';
        addBtn.style.width = '55px';
        addBtn.style.display = '';
      }
      if (msg) {
        msg.textContent = '';
        msg.className = '';
      }
      if (!deviceAuthPolling && status) status.textContent = '';
    }
  }
  function _renderPickerMenu() {
    if (!pickerMenu) return;
    pickerMenu.innerHTML = Array.from(provider.options).map(o => {
      const logo = o.dataset.logo ? (providerLogo(o.dataset.logo) || '') : '';
      const active = o.value === provider.value ? ' active' : '';
      return `<div class="adm-provider-item${active}" role="option" data-value="${o.value.replace(/"/g, '&quot;')}">
        <span class="adm-provider-logo">${logo}</span>
        <span>${o.textContent}</span>
      </div>`;
    }).join('');
  }
  function _syncPickerCurrent() {
    if (!pickerCurrent) return;
    const opt = provider.selectedOptions[0] || provider.options[0];
    const logo = opt.dataset.logo ? (providerLogo(opt.dataset.logo) || '') : '';
    pickerCurrent.querySelector('.adm-provider-logo').innerHTML = logo;
    pickerCurrent.querySelector('.adm-provider-name').textContent = opt.textContent;
  }
  if (picker && pickerBtn && pickerMenu && pickerCurrent) {
    _renderPickerMenu();
    _syncPickerCurrent();
    if (provider.value && !urlInput.value) urlInput.value = provider.value;
    pickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pickerMenu.classList.toggle('hidden');
    });
    pickerMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.adm-provider-item');
      if (!item) return;
      provider.value = item.dataset.value;
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      pickerMenu.classList.add('hidden');
      _renderPickerMenu();
      _syncPickerCurrent();
    });
    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target)) pickerMenu.classList.add('hidden');
    });
    // Capture-phase Esc: dismiss the picker menu without bubbling to the
    // settings-modal handler that would otherwise close the whole modal.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (pickerMenu.classList.contains('hidden')) return;
      e.stopPropagation();
      pickerMenu.classList.add('hidden');
    }, { capture: true });
  }

  provider.addEventListener('change', () => {
    if (_isDeviceAuthSelected()) {
      _setApiFormForProvider();
      _renderPickerMenu();
      _syncPickerCurrent();
      return;
    }
    if (provider.value) urlInput.value = provider.value;
    else urlInput.value = '';
    if (kindSel) kindSel.value = provider.value ? 'api' : 'proxy';
    _setApiFormForProvider();
  });
  urlInput.addEventListener('input', () => {
    if (provider.value && urlInput.value.trim() !== provider.value) {
      provider.value = '';
      if (kindSel) kindSel.value = 'api';
      _renderPickerMenu();
      _syncPickerCurrent();
    }
  });
  if (kindSel) kindSel.value = kindSel.value || 'api';
  function _apiEndpointKind() {
    return (kindSel && kindSel.value) ? kindSel.value : 'api';
  }
  function _modelRefreshModeForApiEndpoint(url, endpointKind) {
    if (endpointKind === 'proxy') return 'manual';
    try {
      if ((new URL(url)).hostname.toLowerCase() === 'generativelanguage.googleapis.com') return '';
    } catch (_) {}
    return 'auto';
  }
  function _normalizeBaseUrl(raw) {
    let u = raw.trim();
    // Fix common protocol typos
    u = u.replace(/^https?:\/(?!\/)/, m => m + '/');  // https:/ → https://
    u = u.replace(/^htp:/, 'http:').replace(/^htps:/, 'https:');
    u = u.replace(/^http:\/\/\//, 'http://');  // http:/// → http://
    u = u.replace(/^https:\/\/\//, 'https://');
    // Add http:// if no protocol
    if (!/^https?:\/\//.test(u)) u = 'http://' + u;
    // Strip trailing slashes
    u = u.replace(/\/+$/, '');
    // Strip trailing paths that shouldn't be in a base URL
    u = u.replace(/\/v1\/(models|chat\/completions|completions|messages)\/?$/i, '/v1');
    u = u.replace(/\/(models|chat\/completions|completions|v1\/messages)\/?$/i, '');
    u = u.replace(/\/api\/(chat|tags|generate)\/?$/i, '/api');
    // Fix double /v1/v1
    u = u.replace(/\/v1\/v1$/, '/v1');
    // Strip query params and fragments
    u = u.split('?')[0].split('#')[0];
    try {
      const parsed = new URL(u);
      if (parsed.hostname.endsWith('ollama.com')) {
        u = 'https://ollama.com/api';
      }
    } catch(e) {}
    // Ensure /v1 suffix for bare host:port URLs (not cloud providers)
    if (!u.includes('api.') && !u.includes('openrouter') && !u.includes('opencode.ai') && !u.includes('ollama.com') && !u.endsWith('/v1')) {
      try {
        const parsed = new URL(u);
        if (!parsed.pathname || parsed.pathname === '/') {
          u += '/v1';
        }
      } catch(e) {}
    }
    return u;
  }

  async function _defaultOllamaUrl() {
    try {
      const res = await fetch('/api/runtime', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ollama_base_url) return data.ollama_base_url;
      }
    } catch (_) {}
    return 'http://127.0.0.1:11434/v1';
  }

  function _renderEndpointTestResult(msg, res, d) {
    if (res.ok && d.status === 'empty') {
      msg.textContent = 'Online — no models found';
      msg.className = 'admin-success';
      return;
    }
    if (res.ok && d.online) {
      const models = d.models || [];
      const preview = models.slice(0, 3).map(m => esc(String(m).split('/').pop())).join(', ');
      msg.innerHTML = `Online — found ${models.length} model${models.length !== 1 ? 's' : ''}${preview ? `: ${preview}${models.length > 3 ? ', …' : ''}` : ''}`;
      msg.className = 'admin-success';
      return;
    }
    msg.textContent = (d && d.detail) || (d && d.ping_error ? `Offline — ${d.ping_error}` : 'Offline');
    msg.className = 'admin-error';
  }

  function _endpointMsg(kind) {
    return el(kind === 'local' ? 'adm-epLocalMsg' : 'adm-epApiMsg') || el('adm-epMsg');
  }

  let apiTestController = null;
  const apiTestBtn = el('adm-epApiTestBtn');
  const apiCancelTestBtn = el('adm-epApiCancelTestBtn');
  if (apiTestBtn) {
    apiTestBtn.addEventListener('click', async () => {
      if (_isDeviceAuthSelected()) {
        const msg = _endpointMsg('api');
        msg.textContent = '';
        msg.className = '';
        return;
      }
      const msg = _endpointMsg('api');
      msg.textContent = ''; msg.className = '';
      const rawUrl = (urlInput.value || provider.value).trim();
      const apiKey = el('adm-epApiKey').value.trim();
      if (!rawUrl) { msg.textContent = 'Select a provider or enter a base URL'; msg.className = 'admin-error'; return; }
      if (provider.value && !apiKey) { msg.textContent = 'API key is required for cloud providers'; msg.className = 'admin-error'; return; }
      const url = provider.value && rawUrl === provider.value ? rawUrl : _normalizeBaseUrl(rawUrl);
      apiTestController = new AbortController();
      apiTestBtn.disabled = true;
      apiTestBtn.textContent = 'Testing...';
      if (apiCancelTestBtn) apiCancelTestBtn.classList.remove('hidden');
      try {
        const fd = new FormData();
        fd.append('base_url', url);
        fd.append('endpoint_kind', _apiEndpointKind());
        fd.append('model_refresh_timeout', '30');
        if (apiKey) fd.append('api_key', apiKey);
        const res = await fetch('/api/model-endpoints/test', {
          method: 'POST',
          body: fd,
          credentials: 'same-origin',
          signal: apiTestController.signal,
        });
        const d = await res.json();
        _renderEndpointTestResult(msg, res, d);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          msg.textContent = 'Test canceled';
          msg.className = '';
        } else {
          msg.textContent = 'Test failed: ' + (e && e.message ? e.message : 'request failed');
          msg.className = 'admin-error';
        }
      }
      apiTestController = null;
      apiTestBtn.disabled = false;
      apiTestBtn.textContent = 'Test';
      if (apiCancelTestBtn) apiCancelTestBtn.classList.add('hidden');
    });
  }
  if (apiCancelTestBtn) {
    apiCancelTestBtn.addEventListener('click', () => {
      if (apiTestController) apiTestController.abort();
    });
  }

  el('adm-epAddBtn').addEventListener('click', async () => {
    const deviceAuthProvider = _selectedDeviceAuthProvider();
    if (deviceAuthProvider) {
      await _startProviderDeviceAuth(deviceAuthProvider, el('adm-epAddBtn'));
      return;
    }
    const msg = _endpointMsg('api');
    msg.textContent = ''; msg.className = '';
    const rawUrl = (urlInput.value || provider.value).trim();
    const apiKey = el('adm-epApiKey').value.trim();
    if (!rawUrl) { msg.textContent = 'Select a provider or enter a base URL'; msg.className = 'admin-error'; return; }
    if (provider.value && !apiKey) { msg.textContent = 'API key is required for cloud providers'; msg.className = 'admin-error'; return; }
    // Normalize URL (fix typos, add /v1, strip wrong paths)
    const url = provider.value && rawUrl === provider.value ? rawUrl : _normalizeBaseUrl(rawUrl);
    const btn = el('adm-epAddBtn');
    btn.disabled = true; btn.textContent = 'Adding...';
    try {
      const fd = new FormData();
      fd.append('base_url', url);
      const endpointKind = _apiEndpointKind();
      fd.append('endpoint_kind', endpointKind);
      const refreshMode = _modelRefreshModeForApiEndpoint(url, endpointKind);
      if (refreshMode) fd.append('model_refresh_mode', refreshMode);
      fd.append('model_refresh_timeout', '30');
      if (apiKey) fd.append('api_key', apiKey);
      if (provider.value && provider.selectedOptions && provider.selectedOptions[0]) {
        fd.append('name', provider.selectedOptions[0].textContent.trim());
      }
      const epType = el('adm-epType');
      if (epType) fd.append('model_type', epType.value);
      if (provider.value && /openrouter\.ai|ollama\.com/i.test(provider.value)) fd.append('require_models', 'true');
      else fd.append('skip_probe', 'false');
      const res = await fetch('/api/model-endpoints', { method: 'POST', body: fd, credentials: 'same-origin' });
      const d = await res.json();
      if (res.ok) {
        const count = d.models ? d.models.length : 0;
        urlInput.value = ''; urlInput.style.display = '';
        el('adm-epApiKey').value = ''; provider.value = '';
        if (kindSel) kindSel.value = 'proxy';
        if (epType) epType.value = 'llm';
        if (d.id) _recentlyAddedEpId = String(d.id);
        await loadEndpoints();
        await _selectAddedModelInChat(d);
        const goLink = ' <a href="#" data-go-added-models style="margin-left:6px;text-decoration:underline;color:inherit;font-weight:600;">Added Models →</a>';
        if (!d.online) {
          msg.innerHTML = 'Added (endpoint offline — will retry on next load)' + goLink;
          msg.className = 'admin-error';
        } else if (d.status === 'empty') {
          msg.innerHTML = 'Added — endpoint reachable, no models found' + goLink;
          msg.className = 'admin-success';
        } else {
          msg.innerHTML = `Added — found ${count} model${count !== 1 ? 's' : ''}` + goLink;
          msg.className = 'admin-success';
        }
      } else { msg.textContent = d.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
    btn.disabled = false; btn.textContent = 'Add';
  });

  async function _startProviderDeviceAuth(providerKey, triggerEl = null) {
    if (deviceAuthPolling) return;
    const config = PROVIDER_DEVICE_FLOWS[providerKey];
    if (!config) return;
    const status = el('adm-deviceAuthStatus') || _endpointMsg('api');
    if (!status) return;
    const triggerText = triggerEl ? triggerEl.textContent : '';
    // Render an error with an inline "Try again" (the top button is hidden for
    // device-auth providers, so retry lives here). Built with DOM methods, not
    // innerHTML. Call reset() first so the deviceAuthPolling guard is cleared.
    const showAuthError = (text) => {
      status.className = 'admin-error';
      status.textContent = text + ' ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'admin-btn-sm';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => { _startProviderDeviceAuth(providerKey, triggerEl); });
      status.appendChild(retry);
    };
    const reset = () => {
      if (triggerEl) {
        triggerEl.disabled = false;
        triggerEl.textContent = triggerText || 'Add';
      }
      deviceAuthPolling = false;
      _setApiFormForProvider();
    };
    status.textContent = '';
    status.className = 'adm-ep-inline-msg';
    if (triggerEl) {
      triggerEl.disabled = true;
      triggerEl.textContent = 'Starting...';
    }
    deviceAuthPolling = true;
    _setApiFormForProvider();
    status.textContent = `Starting ${config.label} sign-in...`;

    try {
      const result = await runProviderDeviceFlow(providerKey, {
        openWindow: () => {},
        onStart: ({ start, authUrl }) => {
          if (triggerEl) triggerEl.textContent = 'Waiting...';
          status.className = '';
          const authLabel = providerKey === 'copilot' ? 'Authorize on GitHub' : 'Authorize with OpenAI';
          const waitLabel = providerKey === 'copilot' ? 'Waiting for GitHub authorization...' : 'Waiting for ChatGPT authorization...';
          status.innerHTML =
            '<div class="adm-copilot-panel">' +
              '<div class="adm-copilot-wait"><span class="admin-spinner"></span>' +
                '<span>' + esc(waitLabel) + '</span></div>' +
              '<div class="adm-copilot-coderow">' +
                '<span class="adm-copilot-code-label">Code</span>' +
                '<code class="adm-copilot-code">' + esc(start.user_code) + '</code>' +
                '<button type="button" class="admin-btn-sm adm-device-auth-copy">Copy</button>' +
              '</div>' +
              '<a class="admin-btn-add adm-copilot-auth" href="' + encodeURI(authUrl || '') + '" target="_blank" rel="noopener">' + esc(authLabel) + ' ↗</a>' +
            '</div>';
          const copyBtn = status.querySelector('.adm-device-auth-copy');
          if (copyBtn) copyBtn.addEventListener('click', async () => {
            const code = start.user_code || '';
            let ok = false;
            try {
              if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(code);
                ok = true;
              }
            } catch (e) {}
            if (!ok) {
              // navigator.clipboard is unavailable in non-secure contexts (HTTP
              // self-host over a LAN IP), so fall back to execCommand('copy').
              const ta = document.createElement('textarea');
              ta.value = code;
              ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';
              document.body.appendChild(ta);
              ta.focus();
              ta.select();
              try { ta.setSelectionRange(0, code.length); } catch (e) {}
              try { ok = document.execCommand('copy'); } catch (e) {}
              ta.remove();
            }
            copyBtn.textContent = ok ? 'Copied' : 'Failed';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
          });
        },
      });
      if (result.status === 'authorized') {
        const endpoint = result.endpoint || {};
        const n = ((endpoint && endpoint.models) || []).length;
        status.className = 'admin-success';
        status.textContent = 'Connected - ' + n + ' ' + config.label + ' model' + (n !== 1 ? 's' : '') + ' available.';
        if (endpoint && endpoint.id) _recentlyAddedEpId = String(endpoint.id);
        await loadEndpoints();
        await _selectAddedModelInChat(endpoint || {});
        reset();
        return;
      }
      if (result.status === 'failed') {
        reset();
        showAuthError('Authorization failed (' + (result.error || 'denied') + ').');
        return;
      }
      if (result.status === 'expired') {
        reset();
        showAuthError('Authorization expired.');
        return;
      }
    } catch (e) {
      reset();
      showAuthError(formatDeviceFlowError(e));
    }
  }

  // API Key reveal toggle. The key inputs are hidden by default so the Add
  // form reads as a single action row; the Key button toggles the input row
  // and flips aria-expanded for screen readers / CSS pseudo-classes.
  const _wireKeyToggle = (btnId, rowId) => {
    const btn = el(btnId);
    const row = el(rowId);
    if (!btn || !row) return;
    btn.addEventListener('click', () => {
      const showing = row.style.display !== 'none';
      row.style.display = showing ? 'none' : '';
      btn.setAttribute('aria-expanded', showing ? 'false' : 'true');
      btn.style.opacity = showing ? '0.75' : '1';
      if (!showing) {
        const inp = row.querySelector('input');
        if (inp) inp.focus();
      }
    });
  };
  _wireKeyToggle('adm-epLocalKeyBtn', 'adm-epLocalApiKey-row');

  // Delegated link handler for jumping between settings tabs.
  //   [data-go-added-models]              → quick shortcut for the Added Models tab
  //   [data-go-settings-tab="X"]          → any tab whose nav button has data-settings-tab="X"
  //   [data-go-scroll-to="#elementId"]    → after switching, scroll the element into view
  document.addEventListener('click', (e) => {
    const explicit = e.target.closest('[data-go-settings-tab]');
    if (explicit) {
      e.preventDefault();
      const tab = explicit.getAttribute('data-go-settings-tab');
      const scrollTo = explicit.getAttribute('data-go-scroll-to');
      const btn = document.querySelector(`[data-settings-tab="${tab}"]`);
      if (btn) btn.click();
      if (scrollTo) {
        // Defer to the next frame so the panel has actually become visible
        // before we try to scroll into it.
        requestAnimationFrame(() => {
          const target = document.querySelector(scrollTo);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      return;
    }
    const link = e.target.closest('[data-go-added-models]');
    if (!link) return;
    e.preventDefault();
    const btn = document.querySelector('[data-settings-tab="added-models"]');
    if (btn) btn.click();
  });

  // Generic open/close helper for the kebab dropdowns in this card.
  // Both the Local and API cards use the same shape: an h2-anchored button
  // with id "<prefix>MoreBtn" toggles a sibling menu with id "<prefix>MoreMenu".
  // Global Esc handler: close any currently-open kebab menu in the admin
  // panel regardless of which _wireKebab instance owns it. Belt-and-braces
  // backup for the per-instance handler below — registered once.
  if (!document._admKebabEscWired) {
    document._admKebabEscWired = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Any visible kebab dropdown in the admin panel — match by id pattern
      // so adding a new kebab elsewhere automatically benefits.
      const menus = document.querySelectorAll(
        '#adm-epLocalMoreMenu, #adm-epApiMoreMenu'
      );
      let closed = false;
      menus.forEach((m) => {
        if (m && m.style.display !== 'none') {
          m.style.display = 'none';
          // Sync the associated button's aria-expanded when we can find it.
          const btn = document.getElementById(m.id.replace('Menu', 'Btn'));
          if (btn) btn.setAttribute('aria-expanded', 'false');
          closed = true;
        }
      });
      if (closed) e.stopPropagation();
    }, { capture: true });
  }

  const _wireKebab = (btnId, menuId, onItem) => {
    const btn = el(btnId);
    const menu = el(menuId);
    if (!btn || !menu) return;
    const isOpen = () => menu.style.display !== 'none';
    const close = () => { menu.style.display = 'none'; btn.setAttribute('aria-expanded', 'false'); };
    const open = () => { menu.style.display = 'flex'; btn.setAttribute('aria-expanded', 'true'); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpen()) close(); else open();
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.adm-more-item');
      if (!item) return;
      if (onItem) onItem(item, e);
      close();
    });
    document.addEventListener('click', (e) => {
      if (!isOpen()) return;
      if (e.target.closest('#' + menuId + ', #' + btnId)) return;
      close();
    });
    // Use capture phase so this fires before the settings-modal Esc handler
    // (which is in bubble phase). stopPropagation prevents the modal from
    // closing when the user only meant to dismiss this menu.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        e.stopPropagation();
        close();
      }
    }, { capture: true });
  };

  // API card "..." menu: contains the Proxy/API connection-mode toggle.
  // Sync the visible checkmarks with the hidden #adm-epKind select so
  // downstream code (which reads kindSel.value) keeps working.
  (function wireApiKindMenu() {
    const kind = el('adm-epKind');
    if (!kind) return;
    const opts = document.querySelectorAll('#adm-epApiMoreMenu .adm-kind-opt');
    const sync = () => {
      opts.forEach((o) => {
        const check = o.querySelector('.adm-kind-check');
        if (check) check.style.visibility = (o.dataset.kind === kind.value) ? 'visible' : 'hidden';
      });
    };
    sync();
    kind.addEventListener('change', sync);
    _wireKebab('adm-epApiMoreBtn', 'adm-epApiMoreMenu', (item) => {
      const k = item.dataset.kind;
      if (!k) return;
      kind.value = k;
      kind.dispatchEvent(new Event('change'));
    });
  })();

  // Local card "..." kebab: holds Scan network / Ollama / API key reveal.
  // Item buttons keep their own click handlers; the helper just handles
  // open/close + outside-click + Esc.
  _wireKebab('adm-epLocalMoreBtn', 'adm-epLocalMoreMenu');

  // ── Added Models toolbar: Probe + Clear offline ────────────────────
  // Both buttons act over the currently-rendered endpoint list. The
  // online/offline marker is stamped on each row's [data-adm-ep-online]
  // attribute by loadEndpoints(), so both buttons just iterate the DOM
  // without re-fetching anything they don't already have.
  const _refreshOfflineCount = () => {
    const lbl = el('adm-epOfflineCount');
    if (!lbl) return;
    const n = document.querySelectorAll('[data-adm-ep-id] [data-adm-ep-online="0"]').length;
    lbl.textContent = n > 0 ? `(${n})` : '';
    // Hide the button entirely when there's nothing offline — no point
    // showing an action that has nothing to act on.
    const btn = el('adm-epClearOfflineBtn');
    if (btn) btn.style.display = n === 0 ? 'none' : '';
  };
  // Wire after every loadEndpoints() run by patching the render hook —
  // simplest path: MutationObserver on the two list containers.
  const _obsRoots = ['adm-epList-local', 'adm-epList-api']
    .map(id => el(id)).filter(Boolean);
  if (_obsRoots.length) {
    const mo = new MutationObserver(_refreshOfflineCount);
    _obsRoots.forEach(r => mo.observe(r, { childList: true, subtree: true }));
    _refreshOfflineCount();
  }

  const _fetchWithTimeout = async (url, opts = {}, timeoutMs = 25000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const _collectAddedEndpointIds = async () => {
    const domIds = Array.from(document.querySelectorAll('[data-adm-ep-id]'))
      .map(r => r.getAttribute('data-adm-ep-id'))
      .filter(Boolean);
    if (domIds.length) return Array.from(new Set(domIds));
    try {
      const res = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
      const data = await res.json().catch(() => []);
      return (Array.isArray(data) ? data : []).map(ep => ep && ep.id).filter(Boolean);
    } catch (_) {
      return [];
    }
  };
  const _setProbeAllButtonLabel = async (btn, text, whirlpoolRef) => {
    btn.innerHTML = '';
    if (whirlpoolRef && whirlpoolRef.element) btn.appendChild(whirlpoolRef.element);
    btn.appendChild(document.createTextNode(text));
  };
  if (!window.__admEpProbeAllWired) {
    window.__admEpProbeAllWired = true;
    document.addEventListener('click', async (ev) => {
      const probeAllBtn = ev.target.closest('#adm-epProbeAllBtn');
      if (!probeAllBtn || probeAllBtn.disabled) return;
      ev.preventDefault();
      probeAllBtn.disabled = true;
      const origHTML = probeAllBtn.innerHTML;
      let _wp = null;
      try {
        try {
          const sp = window.spinnerModule || (await import('./spinner.js')).default;
          _wp = sp.createWhirlpool(11);
          _wp.element.style.cssText = 'display:inline-flex;width:11px;height:11px;margin:0 4px 0 0;';
          await _setProbeAllButtonLabel(probeAllBtn, 'Probing', _wp);
        } catch (_) {
          probeAllBtn.innerHTML = '<span style="opacity:0.7;">Probing...</span>';
        }
        await _fetchWithTimeout('/api/model-endpoints/probe-local', { credentials: 'same-origin' }, 12000).catch(() => null);
        const ids = await _collectAddedEndpointIds();
        if (!ids.length) {
          await loadEndpoints();
          if (uiModule && uiModule.showToast) uiModule.showToast('No endpoints to probe', 1800);
          return;
        }
        let done = 0;
        let failed = 0;
        const lane = async (id) => {
          try {
            const res = await _fetchWithTimeout(`/api/model-endpoints/${encodeURIComponent(id)}/models?refresh=true&refresh_timeout=20`, {
              credentials: 'same-origin'
            }, 25000);
            if (!res || !res.ok || res.headers.get('X-Model-Refresh-Status') === 'failed') failed += 1;
            else await res.json().catch(() => null);
          } catch (err) {
            failed += 1;
            console.warn('Endpoint probe failed', id, err);
          } finally {
            done += 1;
            try { await _setProbeAllButtonLabel(probeAllBtn, `Probing ${done}/${ids.length}`, _wp); } catch (_) {}
          }
        };
        const queue = [...ids];
        const workers = Array.from({ length: Math.min(4, queue.length) }, () => (async () => {
          while (queue.length) {
            const id = queue.shift();
            if (id) await lane(id);
          }
        })());
        await Promise.all(workers);
        await loadEndpoints();
        _refreshOfflineCount();
        if (uiModule && uiModule.showToast) {
          const ok = Math.max(0, ids.length - failed);
          uiModule.showToast(failed ? `Probed ${ok}/${ids.length} endpoints; ${failed} failed` : `Probed ${ids.length} endpoints`, failed ? 4200 : 1800);
        }
      } finally {
        if (_wp) { try { _wp.destroy(); } catch (_) {} }
        probeAllBtn.innerHTML = origHTML;
        probeAllBtn.disabled = false;
      }
    });
  }

  const clearOfflineBtn = el('adm-epClearOfflineBtn');
  if (clearOfflineBtn) {
    clearOfflineBtn.addEventListener('click', async () => {
      const offlineBtns = Array.from(document.querySelectorAll('[data-adm-del-ep][data-adm-ep-online="0"]'));
      const ids = offlineBtns.map(b => b.getAttribute('data-adm-del-ep')).filter(Boolean);
      if (!ids.length) {
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('No offline endpoints — nothing to clear', 1800);
        }
        return;
      }
      const confirmMsg = ids.length === 1
        ? 'Remove 1 offline endpoint?'
        : `Remove ${ids.length} offline endpoints?`;
      if (uiModule && uiModule.styledConfirm) {
        const ok = await uiModule.styledConfirm(confirmMsg, { confirmText: 'Remove', danger: true });
        if (!ok) return;
      } else if (!confirm(confirmMsg)) {
        return;
      }
      clearOfflineBtn.disabled = true;
      // Optimistic UI: pull rows immediately, then fire the DELETEs.
      offlineBtns.forEach(b => {
        const row = b.closest('[data-adm-ep-id]');
        if (row) row.remove();
      });
      await Promise.all(ids.map(id =>
        fetch('/api/model-endpoints/' + id, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {})
      ));
      try { await loadEndpoints(); } catch (_) {}
      _refreshOfflineCount();
      if (uiModule && uiModule.showToast) uiModule.showToast(`Removed ${ids.length} offline endpoint${ids.length === 1 ? '' : 's'}`, 1800);
    });
  }

  // Clear-on-focus for the API key inputs. The fields are type=password so the
  // value is masked; users can't see what's there to edit it in place, so the
  // expected gesture is "click in, type new key". Wiping on focus removes the
  // select-all-and-delete dance.
  const _wireClearOnFocus = (id) => {
    const inp = el(id);
    if (!inp) return;
    inp.addEventListener('focus', () => {
      if (inp.value) inp.value = '';
    });
  };
  _wireClearOnFocus('adm-epLocalApiKey');
  _wireClearOnFocus('adm-epApiKey');

  // Drop the Ollama provider logo into the Ollama Quickstart button. Reuses
  // the same SVG the provider picker uses, so brand parity stays free.
  try {
    const _ollamaLogoSlot = document.querySelector('#adm-epOllamaBtn .adm-ollama-logo');
    if (_ollamaLogoSlot) {
      const svg = providerLogo('ollama') || '';
      if (svg) _ollamaLogoSlot.innerHTML = svg;
    }
  } catch (_) {}

  // Local "Add" button — sibling form for self-hosted base URLs.
  const localAddBtn = el('adm-epLocalAddBtn');
  const localTestBtn = el('adm-epLocalTestBtn');
  if (localTestBtn) {
    localTestBtn.addEventListener('click', async () => {
      const testOriginalHtml = localTestBtn.innerHTML || '>Test';
      const msg = _endpointMsg('local');
      msg.textContent = ''; msg.className = 'adm-ep-inline-msg';
      const raw = (el('adm-epLocalUrl').value || '').trim();
      if (!raw) { msg.textContent = 'Enter a base URL to test'; msg.className = 'admin-error'; return; }
      const url = _normalizeBaseUrl(raw);
      const keyEl = el('adm-epLocalApiKey');
      const apiKey = keyEl ? keyEl.value.trim() : '';
      localTestBtn.disabled = true;
      localTestBtn.innerHTML = testOriginalHtml.replace(/>Test\s*$/, '>Testing...');
      try {
        const fd = new FormData();
        fd.append('base_url', url);
        if (apiKey) fd.append('api_key', apiKey);
        const res = await fetch('/api/model-endpoints/test', { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        _renderEndpointTestResult(msg, res, d);
      } catch (e) {
        msg.textContent = 'Test failed: ' + (e && e.message ? e.message : 'request failed');
        msg.className = 'admin-error';
      }
      localTestBtn.disabled = false;
      localTestBtn.innerHTML = testOriginalHtml;
    });
  }
  if (localAddBtn) {
    localAddBtn.addEventListener('click', async () => {
      const addOriginalHtml = localAddBtn.innerHTML || '>Add';
      const msg = _endpointMsg('local');
      msg.textContent = ''; msg.className = 'adm-ep-inline-msg';
      const raw = (el('adm-epLocalUrl').value || '').trim();
      if (!raw) { msg.textContent = 'Enter a base URL (e.g. http://localhost:8002/v1)'; msg.className = 'admin-error'; return; }
      const url = _normalizeBaseUrl(raw);
      const keyEl = el('adm-epLocalApiKey');
      const apiKey = keyEl ? keyEl.value.trim() : '';
      localAddBtn.disabled = true;
      localAddBtn.innerHTML = addOriginalHtml.replace(/>Add\s*$/, '>Adding...');
      try {
        const fd = new FormData();
        fd.append('base_url', url);
        if (apiKey) fd.append('api_key', apiKey);
        fd.append('endpoint_kind', 'local');
        fd.append('model_refresh_mode', 'auto');
        const lt = el('adm-epLocalType');
        if (lt) fd.append('model_type', lt.value);
        fd.append('skip_probe', 'false');
        const res = await fetch('/api/model-endpoints', { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (res.ok) {
          el('adm-epLocalUrl').value = '';
          if (keyEl) keyEl.value = '';
          if (lt) lt.value = 'llm';
          if (d.id) _recentlyAddedEpId = String(d.id);
          await loadEndpoints();
          await _selectAddedModelInChat(d);
          const count = (d.models || []).length;
          const baseText = d.status === 'empty'
            ? 'Added — Ollama is running, no models pulled yet'
            : d.online
            ? `Added — found ${count} model${count !== 1 ? 's' : ''}`
            : 'Added (offline — will retry on next load)';
          msg.innerHTML = `${baseText} <a href="#" data-go-added-models style="margin-left:6px;text-decoration:underline;color:inherit;font-weight:600;">Added Models →</a>`;
          msg.className = d.online ? 'admin-success' : 'admin-error';
        } else { msg.textContent = d.detail || 'Failed'; msg.className = 'admin-error'; }
      } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
      localAddBtn.disabled = false;
      localAddBtn.innerHTML = addOriginalHtml;
    });
  }

  const ollamaBtn = el('adm-epOllamaBtn');
  if (ollamaBtn) {
    ollamaBtn.addEventListener('click', async () => {
      const input = el('adm-epLocalUrl');
      if (input) {
        input.value = await _defaultOllamaUrl();
        input.focus();
      }
      const msg = _endpointMsg('local');
      if (msg) {
        msg.innerHTML = '<span style="font-size:11px;opacity:0.55;">Ollama ready to test.</span>';
        msg.className = '';
      }
    });
  }

  // Discover local models button
  const discoverBtn = el('adm-epDiscoverBtn');
  if (discoverBtn) {
    discoverBtn.addEventListener('click', async () => {
      const msg = _endpointMsg('local');
      discoverBtn.disabled = true;
      msg.className = 'adm-ep-inline-msg';
      msg.innerHTML = '';
      try {
        const sp = window.spinnerModule || (await import('./spinner.js')).default;
        const wp = sp.createWhirlpool(20);
        wp.element.style.cssText = 'display:inline-block;vertical-align:middle;margin:0 8px 0 0;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;padding:8px 0;';
        wrap.appendChild(wp.element);
        const txt = document.createElement('span');
        txt.textContent = 'Scanning ports 8000-8020, 8080, 1234, 11434, and 11435 for model servers...';
        txt.style.cssText = 'font-size:12px;opacity:0.7;';
        wrap.appendChild(txt);
        msg.appendChild(wrap);
        discoverBtn._wp = wp;
      } catch(e) { msg.textContent = 'Scanning...'; }
      try {
        const res = await fetch('/api/discover');
        const data = await res.json();
        const items = data.items || [];
        if (!items.length) {
          msg.textContent = 'No model servers found. Make sure vLLM, llama.cpp, SGLang, or Ollama is running. Docker users may need Ollama bound to a trusted reachable interface.';
          msg.className = 'admin-error';
        } else {
          // Auto-add each discovered endpoint. Server dedupes on base_url
          // and returns `existing: true` for already-registered ones.
          // Map fingerprinted provider IDs to friendly display names.
          const _PROVIDER_DISPLAY = {
            llamacpp: 'llama.cpp', lmstudio: 'LM Studio', vllm: 'vLLM',
            ollama: 'Ollama',
          };
          let added = 0;
          let skipped = 0;
          for (const item of items) {
            const base = item.url.replace('/chat/completions', '').replace(/\/$/, '');
            const providerDisplay = _PROVIDER_DISPLAY[item.provider] || null;
            const fd = new FormData();
            fd.append('base_url', base);
            if (providerDisplay) {
              // Use "Provider (host:port)" so the endpoint is immediately
              // identifiable in the list, e.g. "llama.cpp (localhost:8080)".
              const hostPart = base.replace(/^https?:\/\//, '').split('/')[0];
              fd.append('name', `${providerDisplay} (${hostPart})`);
            }
            fd.append('endpoint_kind', 'local');
            fd.append('model_refresh_mode', 'auto');
            fd.append('skip_probe', 'false');
            const r = await fetch('/api/model-endpoints', { method: 'POST', body: fd });
            if (r.ok) {
              try {
                const dd = await r.json();
                if (dd && dd.existing) { skipped++; }
                else { added++; if (dd && dd.id) _recentlyAddedEpId = String(dd.id); }
              } catch (_) { added++; }
            }
          }
          const totalModels = items.reduce((n, i) => n + (i.models ? i.models.length : 0), 0);
          const serverNames = items.map(i =>
            (_PROVIDER_DISPLAY[i.provider] || i.url.replace(/^https?:\/\//, '').split('/')[0])
          );
          const parts = [
            `Found ${items.length} server${items.length !== 1 ? 's' : ''} (${serverNames.join(', ')}) with ${totalModels} model${totalModels !== 1 ? 's' : ''}`,
          ];
          if (added) parts.push(`added ${added} new`);
          if (skipped) parts.push(`${skipped} already added`);
          msg.innerHTML = parts.join(' — ');
          msg.className = 'admin-success';
          loadEndpoints();
        }
      } catch (e) {
        msg.textContent = 'Scan failed: ' + e.message;
        msg.className = 'admin-error';
      }
      if (discoverBtn._wp) { discoverBtn._wp.destroy(); discoverBtn._wp = null; }
      discoverBtn.disabled = false;
      discoverBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-1px;margin-right:4px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Scan for Servers';
    });
  }

  document.querySelectorAll('.adm-quickstart-section').forEach((sec) => {
    const head = sec.querySelector('.adm-quickstart-toggle');
    if (!head) return;
    const key = 'odysseus.addModels.' + sec.id + '.open';
    let open = false;
    try { open = localStorage.getItem(key) === '1'; } catch {}
    const apply = () => {
      sec.classList.toggle('collapsed', !open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    apply();
    const toggle = () => {
      open = !open;
      try { localStorage.setItem(key, open ? '1' : '0'); } catch {}
      apply();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

/* ═══════════════════════════════════════════
   TOOLS TAB — MCP
   ═══════════════════════════════════════════ */

const _GOOGLE_OAUTH_HELP = `To get Google OAuth credentials:
1. Go to console.cloud.google.com
2. Click the project dropdown (top left) > New Project > name it > Create
3. APIs & Services > Library > enable the API you need (Gmail, Calendar, Drive, etc.)
4. APIs & Services > OAuth consent screen > configure (External, app name + email)
5. Under Audience, click Add Users > add your Google email as a test user
6. APIs & Services > Credentials > + Create Credentials > OAuth Client ID > Desktop App
7. Copy the Client ID and Client Secret into the fields above
8. After adding the server, click Authorize to sign in with Google
9. If accessing remotely: sign in, then copy the URL from the error page and paste it back`;

const MCP_PRESETS = [
  { name: "Gmail",           command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],      env: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" },
    oauthFile: { dir: "gmail", filename: "gcp-oauth.keys.json" },
    oauth: {
      provider: "google",
      keys_file: "gmail/gcp-oauth.keys.json",
      token_file: "gmail/credentials.json",
      scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.settings.basic"],
    },
    help: `Setup:
1. Go to console.cloud.google.com > create or select a project
2. APIs & Services > Library > search "Gmail API" > Enable
3. APIs & Services > OAuth consent screen > set up (External is fine)
4. Under Audience, add your Gmail address as a test user
5. APIs & Services > Credentials > + Create Credentials > OAuth Client ID
6. Application type: Desktop App > Create
7. Copy the Client ID and Client Secret into the fields above
8. Click Add Server, then click the Authorize button
9. Sign in with Google, copy the URL from the error page, paste it back` },
  { name: "Email (IMAP/SMTP)", command: "npx", args: ["-y", "@codefuturist/email-mcp", "stdio"],        env: { MCP_EMAIL_ADDRESS: "", MCP_EMAIL_PASSWORD: "", MCP_EMAIL_IMAP_HOST: "", MCP_EMAIL_SMTP_HOST: "" },
    providerDropdown: {
      label: "Provider",
      targets: { MCP_EMAIL_IMAP_HOST: "imap", MCP_EMAIL_SMTP_HOST: "smtp" },
      options: [
        { name: "Migadu",        imap: "imap.migadu.com",     smtp: "smtp.migadu.com" },
        { name: "Fastmail",      imap: "imap.fastmail.com",   smtp: "smtp.fastmail.com" },
        { name: "Proton Bridge", imap: "127.0.0.1",           smtp: "127.0.0.1" },
        { name: "Outlook/Hotmail", imap: "outlook.office365.com", smtp: "smtp.office365.com" },
        { name: "Yahoo",         imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com" },
        { name: "iCloud",        imap: "imap.mail.me.com",    smtp: "smtp.mail.me.com" },
        { name: "Zoho",          imap: "imap.zoho.com",       smtp: "smtp.zoho.com" },
        { name: "Custom",        imap: "",                    smtp: "" },
      ],
    },
    help: "Works with any IMAP/SMTP email provider.\n1. Pick your provider from the dropdown (or choose Custom)\n2. Enter your email address and password (or app password)\n3. Click Add Server" },
  { name: "CalDAV (Radicale/Nextcloud)", command: "npx", args: ["-y", "caldav-mcp"],                     env: { CALDAV_BASE_URL: "http://localhost:5232", CALDAV_USERNAME: "", CALDAV_PASSWORD: "" },
    help: "Works with any CalDAV server (Radicale, Nextcloud, etc.).\n1. Enter your CalDAV server URL (e.g. http://localhost:5232)\n2. Enter your username and password\n3. Click Add Server" },
  { name: "Google Calendar", command: "npx", args: ["-y", "@cocal/google-calendar-mcp"],                 env: { GOOGLE_OAUTH_CREDENTIALS: "" },
    help: `Setup:
1. Go to console.cloud.google.com > create/select a project
2. APIs & Services > Library > enable Google Calendar API
3. APIs & Services > Credentials > + Create Credentials > OAuth Client ID
4. Application type: Desktop App > Create
5. Click "Download JSON" on the credential you just created
6. Set Google Oauth Credentials to the full path of the downloaded JSON file` },
  { name: "Google Drive",    command: "npx", args: ["-y", "@modelcontextprotocol/server-gdrive"],        env: {},
    help: "Google Drive uses browser-based OAuth on first run. No env vars needed — just click Add and authorize when prompted." },
  { name: "GitHub",          command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    help: "1. Go to github.com > Settings > Developer Settings > Personal Access Tokens > Fine-grained tokens\n2. Generate a new token with the repo permissions you need\n3. Paste it as Github Personal Access Token" },
  { name: "Slack",           command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],         env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    help: "1. Go to api.slack.com/apps > Create New App > From Scratch\n2. Add Bot Token Scopes (channels:read, chat:write, etc.)\n3. Install to workspace, copy the Bot User OAuth Token (xoxb-...)\n4. Team ID is in your workspace URL or Slack admin settings" },
  { name: "Notion",          command: "npx", args: ["-y", "@notionhq/notion-mcp-server"],               env: { OPENAPI_MCP_HEADERS: "" },
    help: "1. Go to notion.so/my-integrations\n2. Create a new integration\n3. Copy the Internal Integration Secret\n4. Share the Notion pages/databases you want accessible with the integration\n5. For Openapi Mcp Headers enter:\n   {\"Authorization\": \"Bearer YOUR_SECRET\", \"Notion-Version\": \"2022-06-28\"}" },
  { name: "Linear",          command: "npx", args: ["-y", "mcp-linear"],                                env: { LINEAR_API_KEY: "" },
    help: "1. Go to linear.app > Settings > API\n2. Create a Personal API Key\n3. Paste it as Linear Api Key" },
  { name: "Brave Search",    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" },
    help: "1. Go to brave.com/search/api\n2. Sign up for a free plan (2000 queries/month)\n3. Copy your API key" },
  { name: "Browser (Playwright)", command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"],  env: {},
    help: "Browser automation via Playwright. The AI can navigate pages, click, fill forms, and read content.\nRuns headless by default. Remove --headless from Args to see the browser window.\nFirst run installs Chromium automatically." },
  { name: "Filesystem",      command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home"], env: {},
    help: "Edit the Args field to change which directory the server has access to." },
  { name: "Memory",          command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],        env: {} },
  { name: "Postgres",        command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/db"], env: {},
    help: "Replace the connection string in the Args field with your actual Postgres connection URL." },
  { name: "Todoist",         command: "npx", args: ["-y", "todoist-mcp-server"],                         env: { TODOIST_API_TOKEN: "" },
    help: "1. Go to todoist.com > Settings > Integrations > Developer\n2. Copy your API token" },
];
// ── Built-in tools management ──
const TOOL_META = {
  bash:              { name: 'Shell',            desc: 'Execute bash commands',           cat: 'Code',       ctx: '~200' },
  python:            { name: 'Python',           desc: 'Run Python scripts',              cat: 'Code',       ctx: '~200' },
  read_file:         { name: 'Read File',        desc: 'Read files from disk',            cat: 'Code',       ctx: '~150' },
  write_file:        { name: 'Write File',       desc: 'Write/create files',              cat: 'Code',       ctx: '~150' },
  web_search:        { name: 'Web Search',       desc: 'Search the web via SearXNG',      cat: 'Search',     ctx: '~300' },
  search_chats:      { name: 'Search Chats',     desc: 'Search conversation history',     cat: 'Search',     ctx: '~150' },
  create_document:   { name: 'Create Document',  desc: 'Create new documents',            cat: 'Documents',  ctx: '~200' },
  update_document:   { name: 'Update Document',  desc: 'Modify existing documents',       cat: 'Documents',  ctx: '~200' },
  edit_document:     { name: 'Edit Document',    desc: 'Find & replace in documents',     cat: 'Documents',  ctx: '~200' },
  suggest_document:  { name: 'Suggest Changes',  desc: 'Propose document edits',          cat: 'Documents',  ctx: '~200' },
  manage_documents:  { name: 'Manage Documents', desc: 'List, delete, organize docs',     cat: 'Documents',  ctx: '~150' },
  generate_image:    { name: 'Generate Image',   desc: 'Create images via AI',            cat: 'Media',      ctx: '~150' },
  manage_memory:     { name: 'Memory',           desc: 'Save and recall memories',        cat: 'Knowledge',  ctx: '~200' },
  manage_skills:     { name: 'Skills',           desc: 'Learn and use procedures',        cat: 'Knowledge',  ctx: '~200' },
  manage_rag:        { name: 'RAG / Docs',       desc: 'Query indexed documents',         cat: 'Knowledge',  ctx: '~150' },
  chat_with_model:   { name: 'Chat with Model',  desc: 'Talk to another AI model',        cat: 'Multi-Agent', ctx: '~200' },
  pipeline:          { name: 'Pipeline',         desc: 'Multi-step AI workflows',         cat: 'Multi-Agent', ctx: '~200' },
  ask_teacher:       { name: 'Ask Teacher',      desc: 'Query a more capable model',      cat: 'Multi-Agent', ctx: '~150' },
  send_to_session:   { name: 'Send to Session',  desc: 'Send message to another chat',    cat: 'Sessions',   ctx: '~100' },
  create_session:    { name: 'Create Session',   desc: 'Start a new chat session',        cat: 'Sessions',   ctx: '~100' },
  list_sessions:     { name: 'List Sessions',    desc: 'Browse existing sessions',        cat: 'Sessions',   ctx: '~100' },
  manage_session:    { name: 'Manage Session',   desc: 'Rename, archive, configure',      cat: 'Sessions',   ctx: '~100' },
  list_models:       { name: 'List Models',      desc: 'Show available models',           cat: 'System',     ctx: '~100' },
  ui_control:        { name: 'UI Control',       desc: 'Change theme, layout, settings',  cat: 'System',     ctx: '~150' },
  manage_tasks:      { name: 'Tasks',            desc: 'Schedule automated tasks',        cat: 'System',     ctx: '~150' },
  api_call:          { name: 'API Call',         desc: 'Make HTTP requests',              cat: 'System',     ctx: '~200' },
  manage_endpoints:  { name: 'Endpoints',        desc: 'Add/remove model endpoints',      cat: 'System',     ctx: '~100' },
  manage_mcp:        { name: 'MCP Servers',      desc: 'Manage MCP connections',          cat: 'System',     ctx: '~100' },
  manage_webhooks:   { name: 'Webhooks',         desc: 'Configure webhook events',        cat: 'System',     ctx: '~100' },
  manage_tokens:     { name: 'API Tokens',       desc: 'Manage API access tokens',        cat: 'System',     ctx: '~100' },
  manage_settings:   { name: 'Settings',         desc: 'Change app settings',             cat: 'System',     ctx: '~100' },
};

async function loadBuiltinTools() {
  const list = el('adm-builtin-tools-list');
  if (!list) return;
  try {
    const res = await fetch('/api/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const tools = data.tools || [];
    if (!tools.length) { list.innerHTML = '<div class="admin-empty">No tools found</div>'; return; }

    // Group by category
    const groups = {};
    for (const t of tools) {
      const meta = TOOL_META[t.id] || { name: t.id, desc: '', cat: 'Other', ctx: '?' };
      const cat = meta.cat;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ ...t, ...meta });
    }

    // Category order
    const catOrder = ['Code', 'Search', 'Documents', 'Media', 'Knowledge', 'Multi-Agent', 'Sessions', 'System', 'Other'];
    let html = '';
    for (const cat of catOrder) {
      const items = groups[cat];
      if (!items) continue;
      const enabledCount = items.filter(i => i.enabled).length;
      const totalCount = items.length;
      const catId = 'tool-cat-' + cat.replace(/[^a-zA-Z]/g, '');
      const allEnabled = enabledCount === totalCount;
      html += `<div class="admin-tool-category">
        <div class="admin-tool-cat-header" data-tool-cat="${catId}" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
          <span>${esc(cat)}</span>
          <span style="display:flex;align-items:center;gap:6px;" class="admin-tool-cat-right">
            <span class="admin-tool-cat-count" style="font-size:10px;opacity:0.5;">${enabledCount}/${totalCount}</span>
            <label class="admin-switch" style="flex-shrink:0;">
              <input type="checkbox" data-tool-cat-toggle="${catId}" ${allEnabled ? 'checked' : ''}>
              <span class="admin-slider"></span>
            </label>
            <svg class="admin-tool-cat-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
        </div>
        <div class="admin-tool-cat-body hidden" id="${catId}">`;
      for (const t of items) {
        html += `
        <div class="admin-tool-row">
          <div class="admin-tool-info">
            <span class="admin-tool-name">${esc(t.name)}</span>
            <span class="admin-tool-desc">${esc(t.desc)}</span>
          </div>
          <span class="admin-tool-ctx" title="Approximate context tokens used">${esc(t.ctx)}</span>
          <label class="admin-switch" style="flex-shrink:0;">
            <input type="checkbox" data-tool-id="${esc(t.id)}" ${t.enabled ? 'checked' : ''}>
            <span class="admin-slider"></span>
          </label>
        </div>`;
      }
      html += '</div></div>';
    }
    list.innerHTML = html;

    // Prevent toggle clicks from expanding/collapsing
    list.querySelectorAll('.admin-tool-cat-right').forEach(span => {
      span.addEventListener('click', e => e.stopPropagation());
    });

    // Wire category expand/collapse
    list.querySelectorAll('[data-tool-cat]').forEach(header => {
      header.addEventListener('click', () => {
        const body = el(header.dataset.toolCat);
        if (!body) return;
        body.classList.toggle('hidden');
        const chevron = header.querySelector('.admin-tool-cat-chevron');
        const isOpen = !body.classList.contains('hidden');
        if (chevron) {
          chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
          chevron.style.opacity = isOpen ? '0.7' : '0.3';
        }
      });
    });

    // Helper: save disabled tools + update counters
    async function _saveToolState() {
      const allChecks = list.querySelectorAll('input[data-tool-id]');
      const disabled = [];
      allChecks.forEach(c => { if (!c.checked) disabled.push(c.dataset.toolId); });
      await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled }),
        credentials: 'same-origin',
      });
    }
    function _updateCatCounter(catEl) {
      if (!catEl) return;
      const catChecks = catEl.querySelectorAll('input[data-tool-id]');
      const catEnabled = Array.from(catChecks).filter(c => c.checked).length;
      const counter = catEl.querySelector('.admin-tool-cat-count');
      if (counter) counter.textContent = catEnabled + '/' + catChecks.length;
      const catToggle = catEl.querySelector('input[data-tool-cat-toggle]');
      if (catToggle) catToggle.checked = (catEnabled === catChecks.length);
    }

    // Wire individual tool toggles
    list.querySelectorAll('input[data-tool-id]').forEach(chk => {
      chk.addEventListener('change', async () => {
        await _saveToolState();
        _updateCatCounter(chk.closest('.admin-tool-category'));
      });
    });

    // Wire category-level toggle (enable/disable all in category)
    list.querySelectorAll('input[data-tool-cat-toggle]').forEach(chk => {
      chk.addEventListener('change', async () => {
        const catEl = chk.closest('.admin-tool-category');
        if (!catEl) return;
        const checked = chk.checked;
        catEl.querySelectorAll('input[data-tool-id]').forEach(c => { c.checked = checked; });
        await _saveToolState();
        _updateCatCounter(catEl);
      });
    });
  } catch (e) {
    console.error('Failed to load tools:', e);
    list.innerHTML = '<div class="admin-empty">Failed to load tools</div>';
  }
}

async function loadMcpServers() {
  const list = el('adm-mcpList');
  if (!list) return;  // MCP section not visible / not yet rendered
  try {
    const res = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
    const servers = await res.json();
    if (!servers.length) { list.innerHTML = '<div class="admin-empty">No MCP servers configured</div>'; return; }
    list.innerHTML = servers.map(s => {
      const statusColor = s.needs_oauth ? '#e5a33a' : s.status === 'connected' ? 'var(--fg)' : s.status === 'error' ? 'var(--red)' : 'color-mix(in srgb, var(--fg) 50%, transparent)';
      const toolInfo = s.status === 'connected' ? `${s.enabled_tool_count}/${s.tool_count} tools enabled` : '';
      const statusText = s.needs_oauth ? 'Needs authorization' : s.status === 'connected' ? `Connected (${toolInfo})` : s.status === 'error' ? `Error: ${s.error || 'unknown'}` : 'Disconnected';
      const hasTools = s.status === 'connected' && s.tool_count > 0;
      return `<div class="admin-user-row" data-adm-mcp-id="${s.id}">
        <div style="display:flex;align-items:center;justify-content:space-between;${hasTools ? 'cursor:pointer;' : ''}padding:4px 0;" data-adm-mcp-header="${s.id}">
          <div class="admin-user-info" style="flex:1;flex-wrap:wrap;gap:0.3rem;">
            <span class="admin-user-name">${esc(s.name)}</span>
            <span class="admin-badge" style="background:${statusColor}33;color:${statusColor}">${statusText}</span>
            ${hasTools ? `<span style="font-size:10px;opacity:0.4;">Click to manage tools</span>` : ''}
          </div>
          <div style="display:flex;gap:4px;align-items:center;">
            ${s.needs_oauth ? `<a href="/api/mcp/oauth/authorize/${s.id}" target="_blank" class="admin-btn-sm" style="background:var(--red);color:#fff;text-decoration:none;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600;">Authorize</a>` : ''}
            <button class="admin-btn-sm" data-adm-mcp-reconnect="${s.id}">Reconnect</button>
            <button class="admin-btn-delete" style="border-color:${s.is_enabled ? 'color-mix(in srgb, var(--red) 30%, transparent)' : 'color-mix(in srgb, var(--fg) 30%, transparent)'};color:${s.is_enabled ? 'var(--red)' : 'var(--fg)'};" data-adm-mcp-toggle="${s.id}" data-adm-mcp-enable="${!s.is_enabled}">${s.is_enabled ? 'Disable' : 'Enable'}</button>
            <button class="admin-btn-delete" data-adm-mcp-delete="${s.id}">Delete</button>
            ${hasTools ? '<svg class="admin-user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;transition:transform 0.2s,opacity 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>' : ''}
          </div>
        </div>
        ${hasTools ? `<div class="mcp-tools-panel hidden" data-adm-mcp-tools-panel="${s.id}"></div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('[data-adm-mcp-reconnect]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msg = el('adm-mcpMsg'); msg.textContent = 'Reconnecting...'; msg.className = '';
        try {
          const res = await fetch(`/api/mcp/servers/${btn.dataset.admMcpReconnect}/reconnect`, { method: 'POST', credentials: 'same-origin' });
          const data = await res.json();
          msg.textContent = data.connected ? `Reconnected (${data.tool_count} tools)` : `Failed: ${data.error || 'unknown'}`;
          msg.className = data.connected ? 'admin-success' : 'admin-error';
          loadMcpServers();
        } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
      });
    });
    list.querySelectorAll('[data-adm-mcp-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const fd = new FormData(); fd.append('is_enabled', btn.dataset.admMcpEnable);
        await fetch(`/api/mcp/servers/${btn.dataset.admMcpToggle}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
        loadMcpServers();
      });
    });
    list.querySelectorAll('[data-adm-mcp-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await uiModule.styledConfirm('Delete this MCP server?', { confirmText: 'Delete', danger: true })) return;
        await fetch(`/api/mcp/servers/${btn.dataset.admMcpDelete}`, { method: 'DELETE', credentials: 'same-origin' });
        loadMcpServers();
      });
    });
    // Tools expand/collapse (click anywhere on card)
    list.querySelectorAll('[data-adm-mcp-id]').forEach(row => {
      const header = row.querySelector('[data-adm-mcp-header]');
      if (!header) return;
      let _toolsLoaded = false;
      row.style.cursor = 'pointer';
      row.addEventListener('click', async (e) => {
        if (e.target.closest('.admin-btn-sm, .admin-btn-delete, a, .mcp-tools-list, .mcp-tools-header')) return;
        const sid = header.dataset.admMcpHeader;
        const panel = row.querySelector(`[data-adm-mcp-tools-panel="${sid}"]`);
        if (!panel) return;
        panel.classList.toggle('hidden');
        const chevron = row.querySelector('.admin-user-chevron');
        const isOpen = !panel.classList.contains('hidden');
        if (chevron) {
          chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
          chevron.style.opacity = isOpen ? '0.7' : '0.3';
        }
        if (!_toolsLoaded && isOpen) {
          _toolsLoaded = true;
          panel.innerHTML = '<span style="opacity:0.5;font-size:11px;">Loading tools...</span>';
          try {
            const res = await fetch(`/api/mcp/servers/${sid}/tools`, { credentials: 'same-origin' });
            const tools = await res.json();
            if (!tools.length) { panel.innerHTML = '<span style="opacity:0.5;font-size:11px;">No tools</span>'; return; }
            const disabled = new Set(tools.filter(t => t.is_disabled).map(t => t.name));
            panel.innerHTML = `<div class="mcp-tools-header">
              <span>Tools</span>
              <span style="display:flex;gap:8px;align-items:center;">
                <span class="mcp-tools-count">${tools.length - disabled.size}/${tools.length} enabled</span>
                <a href="#" data-mcp-select-all="${sid}">All</a>
                <a href="#" data-mcp-select-none="${sid}">None</a>
              </span>
            </div><div class="mcp-tools-list">` + tools.map(t =>
              `<label title="${esc(t.description)}">
                <input type="checkbox" data-mcp-tool-name="${esc(t.name)}" ${!t.is_disabled ? 'checked' : ''}>
                <span><strong>${esc(t.name)}</strong> <span style="opacity:0.5;">— ${esc((t.description || '').slice(0, 80))}</span></span>
              </label>`
            ).join('') + '</div>';
            panel.querySelector(`[data-mcp-select-all="${sid}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
              _saveMcpToolState(sid, panel);
            });
            panel.querySelector(`[data-mcp-select-none="${sid}"]`)?.addEventListener('click', (e) => {
              e.preventDefault();
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
              _saveMcpToolState(sid, panel);
            });
            panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
              cb.addEventListener('change', () => _saveMcpToolState(sid, panel));
            });
          } catch (e) { panel.innerHTML = '<span class="admin-error" style="font-size:11px;">Failed to load tools</span>'; }
        }
      });
    });
  } catch (e) { if (list) list.innerHTML = '<div class="admin-error">Failed to load MCP servers</div>'; }
}

async function _saveMcpToolState(serverId, panel) {
  const disabled = [];
  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    if (!cb.checked) disabled.push(cb.dataset.mcpToolName);
  });
  const total = panel.querySelectorAll('input[type=checkbox]').length;
  try {
    await fetch(`/api/mcp/servers/${serverId}/tools`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ disabled }),
    });
    // Update the count label in the panel
    const countLabel = panel.querySelector('.mcp-tools-count');
    if (countLabel) countLabel.textContent = `${total - disabled.length}/${total} enabled`;
    // Update badge in the server row
    const row = panel.closest('[data-adm-mcp-id]');
    if (row) {
      const badge = row.querySelector('.admin-badge');
      if (badge) badge.textContent = `Connected (${total - disabled.length}/${total} tools enabled)`;
    }
  } catch (e) { /* silent */ }
}

function initMcpForm() {
  const cmdEl = el('adm-mcpCommand');
  if (!cmdEl) return;  // MCP form not present in this build — nothing to wire
  const transportSel = el('adm-mcpTransport');
  const sseRow = el('adm-mcpSseRow');
  const envRow = el('adm-mcpEnvRow');
  const envFieldsWrap = el('adm-mcpEnvFields');
  const helpBox = el('adm-mcpHelp');
  const cmdRow = cmdEl.parentElement;
  let _activeHelp = null;
  let _envKeys = []; // track which env keys have dedicated fields
  let _activeOauthFile = null; // preset oauthFile config (for Google servers)
  let _activeOauth = null;     // preset OAuth flow config (provider, scopes, etc.)

  function _clearEnvFields() {
    envFieldsWrap.innerHTML = '';
    _envKeys = [];
    envRow.style.display = 'none';
    el('adm-mcpEnv').value = '';
    _activeOauth = null;
  }

  function _buildEnvFields(envObj, help, preset) {
    _clearEnvFields();
    const keys = Object.keys(envObj);
    if (!keys.length) return;
    _envKeys = keys;

    // Provider dropdown (e.g. for Email IMAP/SMTP)
    if (preset?.providerDropdown) {
      const pd = preset.providerDropdown;
      const row = document.createElement('div');
      row.className = 'admin-model-form-row';
      row.style.cssText = 'gap:6px;align-items:center;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;opacity:0.55;min-width:0;white-space:nowrap;';
      label.textContent = pd.label || 'Provider';
      const select = document.createElement('select');
      select.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;';
      pd.options.forEach((opt, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = opt.name;
        select.appendChild(o);
      });
      select.addEventListener('change', () => {
        const opt = pd.options[parseInt(select.value)];
        for (const [envKey, field] of Object.entries(pd.targets)) {
          const inp = envFieldsWrap.querySelector(`.mcp-env-input[data-env-key="${envKey}"]`);
          if (inp) inp.value = opt[field] || '';
        }
      });
      row.appendChild(label);
      row.appendChild(select);
      envFieldsWrap.appendChild(row);
      // Auto-fill with first provider after inputs are created
      setTimeout(() => {
        const first = pd.options[0];
        for (const [envKey, field] of Object.entries(pd.targets)) {
          const inp = envFieldsWrap.querySelector(`.mcp-env-input[data-env-key="${envKey}"]`);
          if (inp && !inp.value) inp.value = first[field] || '';
        }
      }, 0);
    }

    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'admin-model-form-row';
      row.style.cssText = 'gap:6px;align-items:center;';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;opacity:0.55;min-width:0;white-space:nowrap;';
      label.textContent = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const input = document.createElement('input');
      input.type = key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') || key.toLowerCase().includes('key') || key.toLowerCase().includes('password') ? 'password' : 'text';
      input.placeholder = key;
      input.dataset.envKey = key;
      input.className = 'mcp-env-input';
      input.style.cssText = 'flex:1;';
      if (envObj[key]) input.value = envObj[key];
      row.appendChild(label);
      row.appendChild(input);
      envFieldsWrap.appendChild(row);
    }
    // Help toggle link
    if (help) {
      _activeHelp = help;
      const helpLink = document.createElement('a');
      helpLink.textContent = 'How do I get these?';
      helpLink.href = '#';
      helpLink.style.cssText = 'font-size:10.5px;opacity:0.5;margin-top:2px;display:inline-block;';
      helpLink.addEventListener('click', (e) => {
        e.preventDefault();
        helpBox.style.display = helpBox.style.display === 'none' ? '' : 'none';
      });
      envFieldsWrap.appendChild(helpLink);
      helpBox.textContent = help;
      helpBox.style.display = 'none';
    } else {
      _activeHelp = null;
      helpBox.style.display = 'none';
    }
  }

  // Collect env from either dedicated fields or raw JSON fallback
  function _collectEnv() {
    if (_envKeys.length) {
      const obj = {};
      envFieldsWrap.querySelectorAll('.mcp-env-input').forEach(inp => {
        if (inp.value.trim()) obj[inp.dataset.envKey] = inp.value.trim();
      });
      return JSON.stringify(obj);
    }
    return el('adm-mcpEnv').value.trim() || '{}';
  }

  transportSel.addEventListener('change', () => {
    const isSse = transportSel.value === 'sse';
    sseRow.style.display = isSse ? '' : 'none';
    cmdRow.style.display = isSse ? 'none' : '';
    if (isSse) { _clearEnvFields(); helpBox.style.display = 'none'; }
  });

  // Preset catalog
  const presetSel = el('adm-mcpPreset');
  if (presetSel) {
    MCP_PRESETS.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = p.name + (Object.keys(p.env).length ? '  (requires keys)' : '');
      presetSel.appendChild(opt);
    });
    presetSel.addEventListener('change', () => {
      if (presetSel.value === '') return;
      const p = MCP_PRESETS[parseInt(presetSel.value)];
      el('adm-mcpName').value = p.name.toLowerCase().replace(/\s+/g, '-');
      transportSel.value = 'stdio';
      el('adm-mcpCommand').value = p.command;
      el('adm-mcpArgs').value = JSON.stringify(p.args);
      sseRow.style.display = 'none';
      cmdRow.style.display = '';
      _buildEnvFields(p.env, p.help || null, p);
      _activeOauthFile = p.oauthFile || null;
      _activeOauth = p.oauth || null;
      presetSel.value = '';
      // Focus first env field if keys are needed
      const firstInput = envFieldsWrap.querySelector('.mcp-env-input');
      if (firstInput) firstInput.focus();
      else el('adm-mcpAddBtn').focus();
    });
  }

  el('adm-mcpAddBtn').addEventListener('click', async () => {
    const name = el('adm-mcpName').value.trim();
    const transport = transportSel.value;
    const command = el('adm-mcpCommand').value.trim();
    const args = el('adm-mcpArgs').value.trim() || '[]';
    const env = _collectEnv();
    const url = el('adm-mcpUrl').value.trim();
    const msg = el('adm-mcpMsg');
    if (!name) { msg.textContent = 'Name is required'; msg.className = 'admin-error'; return; }
    if (transport === 'stdio' && !command) { msg.textContent = 'Command is required for stdio'; msg.className = 'admin-error'; return; }
    if (transport === 'sse' && !url) { msg.textContent = 'URL is required for SSE'; msg.className = 'admin-error'; return; }
    try { JSON.parse(env); } catch { msg.textContent = 'Env must be valid JSON'; msg.className = 'admin-error'; return; }
    const fd = new FormData();
    fd.append('name', name); fd.append('transport', transport); fd.append('command', command); fd.append('args', args); fd.append('env', env); fd.append('url', url);
    // If preset has oauthFile config, send credentials for file generation
    if (_activeOauthFile) {
      const envObj = JSON.parse(env);
      fd.append('oauth_file', JSON.stringify({
        dir: _activeOauthFile.dir,
        filename: _activeOauthFile.filename,
        client_id: envObj.GOOGLE_CLIENT_ID || '',
        client_secret: envObj.GOOGLE_CLIENT_SECRET || '',
      }));
    }
    // If preset has OAuth flow config, send it so the server can handle authorization
    if (_activeOauth) {
      fd.append('oauth_config', JSON.stringify(_activeOauth));
    }
    msg.textContent = 'Adding...'; msg.className = '';
    try {
      const res = await fetch('/api/mcp/servers', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (data.needs_oauth) {
        msg.innerHTML = `Added ${esc(name)} — <a href="/api/mcp/oauth/authorize/${data.id}" target="_blank" style="color:var(--red);font-weight:600;">Authorize with Google</a> to connect`;
        msg.className = 'admin-success';
      } else if (data.connected) {
        msg.textContent = `Added ${name} (${data.tool_count} tools discovered)`; msg.className = 'admin-success';
      } else { msg.textContent = `Added but connection failed: ${data.error || 'unknown'}`; msg.className = 'admin-error'; }
      el('adm-mcpName').value = ''; el('adm-mcpCommand').value = ''; el('adm-mcpArgs').value = ''; el('adm-mcpUrl').value = '';
      _clearEnvFields(); helpBox.style.display = 'none'; _activeHelp = null; _activeOauthFile = null; _activeOauth = null;
      loadMcpServers();
    } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
  });
}

/* ── Embedding model ──
   No settings UI: the embedding model (RAG, semantic memory, tool selection)
   is fixed infrastructure that ships with the app, and swapping it would
   invalidate every existing vector. Configure via the FASTEMBED_MODEL /
   EMBEDDING_URL env vars if you really need to override it. */

/* ── RAG ── */
async function loadRag() {
  try {
    const res = await fetch('/api/personal');
    const data = await res.json();
    const dirList = el('adm-ragDirList');
    const dirs = data.directories || [];
    if (dirs.length === 0) { dirList.innerHTML = '<div class="admin-empty">No directories indexed</div>'; }
    else {
      dirList.innerHTML = dirs.map(d => `<div class="admin-rag-item"><span class="admin-rag-item-name" title="${esc(d)}">${esc(d)}</span><button class="admin-btn-delete" data-adm-rag-dir="${esc(d)}">Remove</button></div>`).join('');
      dirList.querySelectorAll('[data-adm-rag-dir]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!await uiModule.styledConfirm(`Remove directory "${btn.dataset.admRagDir}" from RAG?`, { confirmText: 'Remove', danger: true })) return;
          btn.disabled = true; btn.textContent = '...';
          try {
            const res = await fetch('/api/personal/remove_directory?directory=' + encodeURIComponent(btn.dataset.admRagDir), { method: 'DELETE' });
            if (res.ok) { ragMsg('Directory removed'); loadRag(); }
            else { const e = await res.json(); ragMsg(e.detail || 'Failed', true); }
          } catch (e) { ragMsg('Error: ' + e.message, true); }
        });
      });
    }
    const fileList = el('adm-ragFileList');
    const files = data.files || [];
    if (files.length === 0) { fileList.innerHTML = '<div class="admin-empty">No files indexed</div>'; }
    else {
      fileList.innerHTML = files.map(f => {
        const size = f.size ? (f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B') : '';
        return `<div class="admin-rag-item"><span class="admin-rag-item-name" title="${esc(f.path || f.name)}">${esc(f.name)}</span><span class="admin-rag-item-meta">${size}</span><button class="admin-btn-delete" data-adm-rag-file="${esc(f.path || f.name)}">Delete</button></div>`;
      }).join('');
      fileList.querySelectorAll('[data-adm-rag-file]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!await uiModule.styledConfirm(`Delete "${btn.dataset.admRagFile}" from RAG?`, { confirmText: 'Delete', danger: true })) return;
          btn.disabled = true; btn.textContent = '...';
          try {
            const res = await fetch('/api/personal/file?filepath=' + encodeURIComponent(btn.dataset.admRagFile), { method: 'DELETE' });
            if (res.ok) { ragMsg('File removed'); loadRag(); }
            else { const e = await res.json(); ragMsg(e.detail || 'Failed', true); }
          } catch (e) { ragMsg('Error: ' + e.message, true); }
        });
      });
    }
  } catch (e) {
    el('adm-ragDirList').innerHTML = '<div class="admin-error">Failed to load</div>';
    el('adm-ragFileList').innerHTML = '';
  }
}

let _ragMsgTimer = null;
function ragMsg(text, isError, persist) {
  const s = el('adm-ragStatus');
  s.textContent = text; s.style.color = isError ? 'var(--red)' : 'var(--fg)';
  if (_ragMsgTimer) { clearTimeout(_ragMsgTimer); _ragMsgTimer = null; }
  if (text && !persist) _ragMsgTimer = setTimeout(() => { s.textContent = ''; }, 5000);
}

async function ragUpload(files) {
  if (!files || files.length === 0) return;
  ragMsg('Uploading ' + files.length + ' file(s)...', false, true);
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  try {
    const res = await fetch('/api/personal/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.success) { ragMsg(`Uploaded ${data.uploaded.length} file(s), ${data.indexed_count} chunks indexed`); loadRag(); }
    else ragMsg(data.detail || 'Upload failed', true);
  } catch (e) { ragMsg('Upload error: ' + e.message, true); }
}

function initRag() {
  const dropZone = el('adm-ragDropZone');
  const fileInput = el('adm-ragFileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => ragUpload(fileInput.files));
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); ragUpload(e.dataTransfer.files); });
  el('adm-ragAddDirBtn').addEventListener('click', async () => {
    const dir = el('adm-ragDirInput').value.trim();
    if (!dir) return;
    const btn = el('adm-ragAddDirBtn');
    btn.disabled = true; btn.textContent = 'Indexing...';
    try {
      const res = await fetch('/api/personal/add_directory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: dir }) });
      const data = await res.json();
      if (data.success) { ragMsg(`Indexed ${data.indexed_count} chunks from directory`); el('adm-ragDirInput').value = ''; loadRag(); }
      else ragMsg(data.detail || data.message || 'Failed', true);
    } catch (e) { ragMsg('Error: ' + e.message, true); }
    btn.disabled = false; btn.textContent = 'Add Directory';
  });
  el('adm-ragReloadBtn').addEventListener('click', async () => {
    const btn = el('adm-ragReloadBtn');
    btn.disabled = true; btn.textContent = 'Reloading...';
    try {
      const res = await fetch('/api/personal/reload', { method: 'POST' });
      const data = await res.json();
      ragMsg(`Index reloaded: ${data.count} documents`);
      loadRag();
    } catch (e) { ragMsg('Reload failed: ' + e.message, true); }
    btn.disabled = false; btn.textContent = 'Reload Index';
  });
}

/* ═══════════════════════════════════════════
   SYSTEM TAB — Tokens
   ═══════════════════════════════════════════ */
// Catalog mirrors the one in settings.js integration form. Keep keys in
// sync with the backend scope allowlist.
const _TOKEN_SCOPES = [
  { key: 'todos:read',        label: 'Todos read',        detail: 'Read notes and checklists' },
  { key: 'todos:write',       label: 'Todos write',       detail: 'Create, update, delete, and toggle todo items' },
  { key: 'documents:read',    label: 'Documents read',    detail: 'Read documents when a document API is enabled' },
  { key: 'documents:write',   label: 'Documents write',   detail: 'Create and update draft documents' },
  { key: 'email:read',        label: 'Email read',        detail: 'Read email when an email API is enabled' },
  { key: 'email:draft',       label: 'Email draft',       detail: 'Create email reply drafts without sending' },
  { key: 'email:send',        label: 'Email send',        detail: 'Send email directly' },
  { key: 'calendar:read',     label: 'Calendar read',     detail: 'Read calendar events when enabled' },
  { key: 'calendar:write',    label: 'Calendar write',    detail: 'Create and update calendar events' },
  { key: 'memory:read',       label: 'Memory read',       detail: 'Read memory when enabled' },
  { key: 'memory:write',      label: 'Memory write',      detail: 'Write memory when enabled' },
  { key: 'cookbook:read',     label: 'Cookbook read',     detail: 'List cookbook tasks + tail their tmux output' },
  { key: 'cookbook:launch',   label: 'Cookbook launch',   detail: 'Launch and stop cookbook serve tasks' },
];

function _renderTokenScopeRows(t) {
  const have = new Set(t.scopes || []);
  return _TOKEN_SCOPES.map(s => {
    const action = (s.key.split(':')[1] || '').toLowerCase();
    const pill = action === 'read'
      ? 'background:rgba(150,150,150,0.18);color:var(--fg-muted,#888);'
      : 'background:color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);color:var(--accent, var(--red));';
    const tool = s.label.replace(/\s+(read|write|draft|send|launch)$/i, '');
    return `
      <label style="display:flex;align-items:center;gap:8px;min-height:28px;padding:1px 0;">
        <span class="settings-label" style="width:90px;flex-shrink:0;padding:0;font-size:12px;">${esc(tool)}</span>
        <span style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:1px 7px;border-radius:999px;flex-shrink:0;min-width:44px;text-align:center;box-sizing:border-box;${pill}">${esc(action)}</span>
        <span style="font-size:11px;line-height:1.35;opacity:0.62;flex:1;min-width:0;">${esc(s.detail)}</span>
        <label class="admin-switch" style="margin-left:auto;flex-shrink:0;"><input type="checkbox" class="adm-tok-scope" data-token-id="${esc(t.id)}" data-scope="${esc(s.key)}" ${have.has(s.key) ? 'checked' : ''}><span class="admin-slider"></span></label>
      </label>`;
  }).join('');
}

async function loadTokens() {
  const list = el('adm-tokenList');
  if (!list) return;
  try {
    const res = await fetch('/api/tokens', { credentials: 'same-origin' });
    const tokens = await res.json();
    if (!tokens.length) { list.innerHTML = '<div class="admin-empty" style="color:var(--accent, var(--red));opacity:0.7;font-size:10px;">No API tokens</div>'; return; }
    list.innerHTML = tokens.map(t => `
      <div class="admin-user-row" data-adm-tok-row="${esc(t.id)}" style="display:block;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div class="admin-user-info" style="flex:1;min-width:0;flex-wrap:wrap;gap:0.3rem;">
            <input type="text" class="adm-tok-rename" data-token-id="${esc(t.id)}" value="${esc(t.name || '')}" placeholder="Token name" style="font-size:13px;font-weight:600;padding:3px 6px;background:transparent;border:1px solid transparent;border-radius:4px;min-width:160px;" title="Click to rename">
            <span class="admin-badge">${esc(t.token_prefix)}...</span>
            ${t.owner ? `<span style="font-size:0.75rem;opacity:0.5;">Owner: ${esc(t.owner)}</span>` : ''}
            ${t.last_used_at ? `<span style="font-size:0.75rem;opacity:0.5;">Last used: ${new Date(t.last_used_at).toLocaleDateString()}</span>` : '<span style="font-size:0.75rem;opacity:0.4;">Never used</span>'}
          </div>
          <button class="admin-btn-sm" data-adm-tok-toggle="${esc(t.id)}" style="opacity:0.75;">Permissions</button>
          <button class="admin-btn-delete" data-adm-del-token="${esc(t.id)}">Revoke</button>
        </div>
        <div data-adm-tok-perm="${esc(t.id)}" style="display:none;margin-top:8px;padding:8px 4px 0;border-top:1px solid var(--border);">
          ${_renderTokenScopeRows(t)}
          <div class="adm-tok-scope-msg" data-token-id="${esc(t.id)}" style="font-size:11px;min-height:14px;margin-top:4px;"></div>
        </div>
      </div>`).join('');

    // Revoke
    list.querySelectorAll('[data-adm-del-token]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await uiModule.styledConfirm('Revoke this API token? External integrations using it will stop working.', { confirmText: 'Revoke', danger: true })) return;
        await fetch(`/api/tokens/${btn.dataset.admDelToken}`, { method: 'DELETE', credentials: 'same-origin' });
        loadTokens();
        // Codex / Claude integration cards on the Integrations panel are
        // backed by these tokens — let them re-render so the deleted token
        // disappears there too.
        try { window.dispatchEvent(new CustomEvent('odysseus-integrations-changed')); } catch (_) {}
      });
    });
    // Toggle permissions panel
    list.querySelectorAll('[data-adm-tok-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = list.querySelector(`[data-adm-tok-perm="${btn.dataset.admTokToggle}"]`);
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
      });
    });
    // Rename
    list.querySelectorAll('.adm-tok-rename').forEach(input => {
      const original = input.value;
      const commit = async () => {
        const name = (input.value || '').trim();
        if (!name || name === original) return;
        try {
          const r = await fetch(`/api/tokens/${input.dataset.tokenId}`, {
            method: 'PATCH', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!r.ok) throw new Error('Save failed');
          loadTokens();
        } catch (_) { input.value = original; }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });
    // Scope toggle change → PATCH the whole scopes array for this token.
    list.querySelectorAll('.adm-tok-scope').forEach(cb => {
      cb.addEventListener('change', async () => {
        const tokenId = cb.dataset.tokenId;
        const panel = list.querySelector(`[data-adm-tok-perm="${tokenId}"]`);
        const msg = list.querySelector(`.adm-tok-scope-msg[data-token-id="${tokenId}"]`);
        const scopes = Array.from(panel.querySelectorAll('.adm-tok-scope:checked')).map(input => input.dataset.scope);
        try {
          const r = await fetch(`/api/tokens/${tokenId}`, {
            method: 'PATCH', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scopes }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.detail || 'Failed');
          if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; setTimeout(() => { msg.textContent = ''; }, 1200); }
        } catch (err) {
          cb.checked = !cb.checked;
          if (msg) { msg.textContent = (err && err.message) || 'Failed'; msg.style.color = 'var(--red)'; }
        }
      });
    });
  } catch (e) { list.innerHTML = '<div class="admin-error">Failed to load tokens</div>'; }
}

function initTokenForm() {
  const addBtn = el('adm-tokenAddBtn');
  if (!addBtn || addBtn.dataset.bound) return;
  addBtn.dataset.bound = '1';
  addBtn.addEventListener('click', async () => {
    const msg = el('adm-tokenMsg');
    const reveal = el('adm-tokenReveal');
    msg.textContent = ''; msg.className = ''; reveal.style.display = 'none';
    const name = el('adm-tokenName').value.trim();
    if (!name) { msg.textContent = 'Token name is required'; msg.className = 'admin-error'; return; }
    const fd = new FormData(); fd.append('name', name);
    const scopes = (el('adm-tokenScopes')?.value || '').trim();
    if (scopes) fd.append('scopes', scopes);
    try {
      const res = await fetch('/api/tokens', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (res.ok) {
        el('adm-tokenValue').textContent = data.token;
        reveal.style.display = '';
        el('adm-tokenName').value = '';
        if (el('adm-tokenScopes')) el('adm-tokenScopes').value = '';
        loadTokens();
      }
      else { msg.textContent = data.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Request failed'; msg.className = 'admin-error'; }
  });
  const TOKEN_COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const TOKEN_CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  el('adm-tokenCopyBtn').addEventListener('click', () => {
    const val = el('adm-tokenValue').textContent;
    const btn = el('adm-tokenCopyBtn');
    navigator.clipboard.writeText(val).then(() => {
      btn.innerHTML = TOKEN_CHECK_ICON;
      btn.style.color = 'var(--accent, var(--red))';
      btn.style.opacity = '1';
      setTimeout(() => {
        btn.innerHTML = TOKEN_COPY_ICON;
        btn.style.color = '';
        btn.style.opacity = '0.7';
      }, 1600);
    });
  });
}

/* ── Webhooks ── */
async function loadWebhooks() {
  const list = el('adm-whList');
  try {
    const res = await fetch('/api/webhooks', { credentials: 'same-origin' });
    const hooks = await res.json();
    if (!hooks.length) { list.innerHTML = '<div class="admin-empty">No webhooks configured</div>'; return; }
    list.innerHTML = hooks.map(w => {
      const events = (w.events || []).map(e => `<span class="admin-badge">${esc(e)}</span>`).join(' ');
      const statusBadge = w.last_status_code
        ? `<span class="admin-badge" style="background:${w.last_status_code < 400 ? 'color-mix(in srgb, var(--fg) 20%, transparent)' : 'color-mix(in srgb, var(--red) 20%, transparent)'};color:${w.last_status_code < 400 ? 'var(--fg)' : 'var(--red)'};">${w.last_status_code}</span>`
        : '';
      const lastTriggered = w.last_triggered_at ? new Date(w.last_triggered_at).toLocaleString() : 'Never';
      const errorText = w.last_error ? `<div style="font-size:0.75rem;color:var(--red);margin-top:0.2rem;">Error: ${esc(w.last_error.substring(0, 80))}</div>` : '';
      return `
        <div class="admin-ep-item" style="flex-wrap:wrap;">
          <div class="admin-ep-info" style="flex:1;min-width:200px;">
            <div class="admin-ep-name">${esc(w.name)} ${w.is_active ? '' : '<span class="admin-badge admin-badge-off">disabled</span>'} ${w.has_secret ? '<span class="admin-badge">signed</span>' : ''}</div>
            <div class="admin-ep-detail">${esc(w.url)}</div>
            <div style="margin-top:0.3rem;">${events}</div>
            <div class="admin-ep-detail">Last: ${lastTriggered} ${statusBadge}</div>
            ${errorText}
          </div>
          <div class="admin-ep-actions">
            <button class="admin-btn-sm" data-adm-wh-test="${w.id}">Test</button>
            <button class="admin-btn-sm" data-adm-wh-toggle="${w.id}">${w.is_active ? 'Disable' : 'Enable'}</button>
            <button class="admin-btn-delete" data-adm-wh-delete="${w.id}">Delete</button>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('[data-adm-wh-test]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const msg = el('adm-whMsg'); msg.textContent = 'Sending test...'; msg.className = '';
        try {
          const res = await fetch(`/api/webhooks/${btn.dataset.admWhTest}/test`, { method: 'POST', credentials: 'same-origin' });
          msg.textContent = res.ok ? 'Test sent!' : 'Test failed'; msg.className = res.ok ? 'admin-success' : 'admin-error';
          setTimeout(() => loadWebhooks(), 1000);
        } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
      });
    });
    list.querySelectorAll('[data-adm-wh-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => { await fetch(`/api/webhooks/${btn.dataset.admWhToggle}`, { method: 'PATCH', credentials: 'same-origin' }); loadWebhooks(); });
    });
    list.querySelectorAll('[data-adm-wh-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await uiModule.styledConfirm('Delete this webhook?', { confirmText: 'Delete', danger: true })) return;
        await fetch(`/api/webhooks/${btn.dataset.admWhDelete}`, { method: 'DELETE', credentials: 'same-origin' }); loadWebhooks();
      });
    });
  } catch (e) { list.innerHTML = '<div class="admin-error">Failed to load webhooks</div>'; }
}

function initWebhookForm() {
  el('adm-whAddBtn').addEventListener('click', async () => {
    const msg = el('adm-whMsg');
    msg.textContent = ''; msg.className = '';
    const name = el('adm-whName').value.trim();
    const url = el('adm-whUrl').value.trim();
    const secret = el('adm-whSecret').value.trim();
    const events = Array.from(modalEl.querySelectorAll('.adm-wh-event:checked')).map(e => e.value).join(',');
    if (!name) { msg.textContent = 'Name is required'; msg.className = 'admin-error'; return; }
    if (!url) { msg.textContent = 'URL is required'; msg.className = 'admin-error'; return; }
    if (!events) { msg.textContent = 'Select at least one event'; msg.className = 'admin-error'; return; }
    const fd = new FormData();
    fd.append('name', name); fd.append('url', url); fd.append('secret', secret); fd.append('events', events);
    try {
      const res = await fetch('/api/webhooks', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (res.ok) { msg.textContent = 'Webhook added'; msg.className = 'admin-success'; el('adm-whName').value = ''; el('adm-whUrl').value = ''; el('adm-whSecret').value = ''; loadWebhooks(); }
      else { const d = await res.json(); msg.textContent = d.detail || 'Failed'; msg.className = 'admin-error'; }
    } catch (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'admin-error'; }
  });
}

/* ── Features ── */
const featureLabels = {
  web_search: 'Web Search', deep_research: 'Deep Research',
  memory: 'Memory', document_editor: 'Document Editor', rag: 'RAG Knowledge Base', sensitive_filter: 'Sensitive Info Filter',
  gallery: 'Gallery'
};

async function loadFeatures() {
  const container = el('adm-featureToggles');
  try {
    const res = await fetch('/api/auth/features', { credentials: 'same-origin' });
    const features = await res.json();
    container.innerHTML = Object.entries(featureLabels).map(([key, label]) => `
      <div class="admin-toggle-row" style="padding:0.4rem 0;border-bottom:1px solid var(--border);">
        <div class="admin-toggle-label">${label}</div>
        <label class="admin-switch"><input type="checkbox" data-adm-feature="${key}" ${features[key] ? 'checked' : ''}><span class="admin-slider"></span></label>
      </div>`).join('');
    container.querySelectorAll('input[data-adm-feature]').forEach(toggle => {
      toggle.addEventListener('change', async () => {
        const body = {}; body[toggle.dataset.admFeature] = toggle.checked;
        await fetch('/api/auth/features', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      });
    });
  } catch (e) { container.innerHTML = '<div class="admin-error">Failed to load features</div>'; }
}

/* ── CalDAV Config ── */
function initCalDAV() {
  const urlIn = el('caldav-url');
  const userIn = el('caldav-user');
  const passIn = el('caldav-pass');
  const saveBtn = el('caldav-save-btn');
  const testBtn = el('caldav-test-btn');
  const status = el('caldav-status');
  if (!urlIn || !saveBtn) return;

  // Load current config
  fetch(`/api/calendar/config`, { credentials: 'same-origin' })
    .then(r => r.json()).then(d => {
      urlIn.value = d.caldav_url || '';
      userIn.value = d.caldav_username || '';
      passIn.value = d.caldav_password || '';
    }).catch(() => {});

  saveBtn.addEventListener('click', async () => {
    status.textContent = 'Saving...';
    try {
      const res = await fetch(`/api/calendar/config`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caldav_url: urlIn.value, caldav_username: userIn.value, caldav_password: passIn.value }),
      });
      const d = await res.json();
      status.textContent = d.ok ? 'Saved' : 'Error';
      status.style.color = d.ok ? 'var(--green)' : 'var(--red)';
    } catch (e) { status.textContent = 'Error'; status.style.color = 'var(--red)'; }
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  });

  testBtn.addEventListener('click', async () => {
    status.textContent = 'Testing...';
    try {
      // Save first
      await fetch(`/api/calendar/config`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caldav_url: urlIn.value, caldav_username: userIn.value, caldav_password: passIn.value }),
      });
      const res = await fetch(`/api/calendar/test`, { method: 'POST', credentials: 'same-origin' });
      const d = await res.json();
      status.textContent = d.ok ? `Connected (${d.calendars} calendars)` : `Failed: ${d.error}`;
      status.style.color = d.ok ? 'var(--green)' : 'var(--red)';
    } catch (e) { status.textContent = 'Error'; status.style.color = 'var(--red)'; }
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 5000);
  });
}

/* ── System status + promotion ── */
async function _loadSystemStatus() {
  const vEl = el('sys-version'), cEl = el('sys-commit'), bEl = el('sys-beta');
  const btn = el('sys-promoteBtn'), msg = el('sys-statusMsg');
  if (!vEl) return;
  try {
    const res = await fetch(`/api/system/status`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const d = await res.json();
    vEl.textContent = d.version || 'unknown';
    cEl.textContent = d.commit || 'unknown';
    if (d.beta_active) {
      bEl.textContent = `${d.beta_branch || '?'} @ ${d.beta_commit || '?'}`;
    } else {
      bEl.textContent = 'not running';
    }
    btn.disabled = !d.promotable;
    if (!d.beta_active) {
      btn.title = 'No beta running on :7001';
    } else if (!d.beta_in_dev) {
      btn.title = 'Beta commit is not in origin/dev — prod builds from dev, so it would not ship this beta';
      msg.textContent = 'Beta is running but its commit is not merged into dev; promoting would build a different tree.';
      msg.className = 'admin-error';
    } else {
      btn.title = 'Merge dev → build & restart prod';
      msg.textContent = ''; msg.className = '';
    }
  } catch (e) {
    vEl.textContent = cEl.textContent = bEl.textContent = 'error';
    btn.disabled = true;
    msg.textContent = 'Failed to load system status: ' + e.message; msg.className = 'admin-error';
  }
}

// Tiny semver compare: returns <0 / 0 / >0 like strcmp. Tolerates missing
// segments ("3.3" vs "3.3.1"). Local copy — cookbook-hwfit.js has its own.
function _sysCmpSemver(a, b) {
  const _parse = (s) => String(s || '').split(/[.+-]/).filter(p => /^\d+$/.test(p)).map(Number);
  const A = _parse(a), B = _parse(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const av = A[i] || 0, bv = B[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Below this, prod has no version switcher / fixed update button of its own —
// switching back to a newer version after landing here needs the CLI fallback
// (ssh + switch-version.sh). Warn before jumping down that far.
const _SYS_SWITCHER_MIN_VERSION = '3.3.1';

/* Version switcher — jump prod to any RELEASED version (down- or re-upgrade).
   The list comes from the host's release ledger; the server refuses commits
   that are not in it. Works with zero AI involvement by design. */
// Mounted twice (Settings → System and the Developer page), and
// initDeveloperPage() re-runs on every visit to that page. The release list is
// re-fetched each time — that part SHOULD be fresh — but the listeners are
// attached exactly once per mount. Without the guard a user who opened the
// Developer page three times would fire three confirms and three POSTs from one
// click on the switch button. Element-property guard is the house idiom
// (cf. `textarea._slashAcWired` in slashAutocomplete.js).
const _switcherReleases = {};

async function _initVersionSwitcher(prefix = 'sys-') {
  const sel = el(prefix + 'versionSel'), btn = el(prefix + 'switchBtn'), msg = el(prefix + 'statusMsg');
  if (!sel || !btn) return;
  let releases = [];
  let currentCommit = '';
  try {
    const res = await fetch(`/api/system/releases`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`releases ${res.status}`);
    const d = await res.json();
    releases = d.releases || [];
    currentCommit = d.current_commit || '';
  } catch (e) {
    sel.innerHTML = '<option value="">n/a</option>';
    sel.disabled = true;
    return;
  }
  sel.innerHTML = '';
  if (!releases.length) {
    sel.appendChild(new Option('no releases yet', ''));
    sel.disabled = true;
    return;
  }
  // Newest last in the ledger — show newest first in the picker.
  [...releases].reverse().forEach((r) => {
    const label = `v${r.version} (${r.commit})${r.current ? ' — current' : ''}`;
    sel.appendChild(new Option(label, r.commit));
  });
  // Listeners read through the map, never through this call's closure — on a
  // re-open the closure would hold the PREVIOUS fetch's list and a freshly
  // released version would be rejected as "not a release".
  _switcherReleases[prefix] = releases;
  const sync = () => {
    const chosen = (_switcherReleases[prefix] || []).find((r) => r.commit === sel.value);
    btn.disabled = !chosen || chosen.current;
  };
  sync();
  if (btn._switcherWired) return;
  btn._switcherWired = true;
  sel.addEventListener('change', sync);
  btn.addEventListener('click', async () => {
    const chosen = (_switcherReleases[prefix] || []).find((r) => r.commit === sel.value);
    if (!chosen) return;
    let confirmMsg = `Switch production to v${chosen.version} (${chosen.commit})?\n\nData is kept; dev stays untouched. IMPORTANT: close and reopen the app window once it is back.`;
    if (_sysCmpSemver(chosen.version, _SYS_SWITCHER_MIN_VERSION) < 0) {
      confirmMsg += `\n\nWarning: v${chosen.version} predates the version switcher (added in v${_SYS_SWITCHER_MIN_VERSION}). Once switched, THIS PAGE won't have a working switcher to come back with — you'd need the CLI fallback (see the odysseus-entwickler skill) to return to a newer version.`;
    }
    if (!confirm(confirmMsg)) return;
    btn.disabled = true;
    if (msg) msg.textContent = '';
    try {
      const res = await fetch(`/api/system/switch`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: chosen.commit }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d && d.status === 'switch_started') {
        if (msg) { msg.textContent = `Switching to v${d.version} — prod rebuilds and restarts shortly. Close and REOPEN the app window once it is back.`; msg.className = 'admin-success'; }
      } else {
        if (msg) { msg.textContent = (d && (d.detail || d.message)) || `Switch failed (status ${res.status})`; msg.className = 'admin-error'; }
        btn.disabled = false;
      }
    } catch (e) {
      if (msg) { msg.textContent = 'Switch failed: ' + e.message; msg.className = 'admin-error'; }
      btn.disabled = false;
    }
  });
}

function initSystemStatus() {
  const btn = el('sys-promoteBtn');
  if (!btn) return;
  _initVersionSwitcher();
  btn.addEventListener('click', async () => {
    const msg = el('sys-statusMsg');
    if (!confirm('Update production to the released version? This rebuilds prod from dev and restarts the server.')) return;
    btn.disabled = true; btn.textContent = 'Updating...'; msg.textContent = ''; msg.className = '';
    try {
      const res = await fetch(`/api/system/promote`, { method: 'POST', credentials: 'same-origin' });
      const d = await res.json().catch(() => null);
      if (res.ok && d && d.status === 'promotion_started') {
        msg.textContent = 'Update started. Prod will rebuild and restart shortly — reload with Ctrl+Shift+R once it is back.';
        msg.className = 'admin-success';
      } else {
        msg.textContent = (d && (d.detail || d.message)) || `Update failed (status ${res.status})`;
        msg.className = 'admin-error';
        btn.disabled = false;
      }
    } catch (e) {
      msg.textContent = 'Update failed: ' + e.message; msg.className = 'admin-error';
      btn.disabled = false;
    }
    btn.textContent = 'Update';
  });
  _loadSystemStatus();
}

/* ── Developer page (package status + editable roadmap) ── */
let _roadmapText = '';

// One definition of what a roadmap item line looks like. The four-state
// character class used to be spelled out inline in four separate places, so
// adding a state meant finding every one of them — miss one and items silently
// stop parsing, or stop being writable.
const _RM_MARK_RE = /^- \[[ xX~!?]\] /;
const _RM_MARK_SET_RE = /^- \[[ xX~!?]\]/;

function _roadmapSections(text) {
  // Top-level "## " headers with their line ranges; items are top-level
  // "- [ ]"/"- [x]" lines inside a section (continuation lines are the
  // indented non-list lines that follow an item).
  const lines = text.split('\n');
  const sections = [];
  let cur = null;
  lines.forEach((line, i) => {
    if (line.startsWith('## ')) {
      if (cur) cur.end = i;
      cur = { title: line.slice(3).trim(), start: i, end: lines.length, items: [] };
      sections.push(cur);
      return;
    }
    // Pipeline states: [?] under consideration, [ ] planned, [~] in progress,
    // [!] ready to test, [x] done. The developer reads the same markers from
    // ROADMAP.md, so the character IS the contract — see _RM_MARK_RE.
    if (cur && _RM_MARK_RE.test(line)) {
      const mark = line.charAt(3);
      cur.items.push({
        line: i,
        done: mark === 'x' || mark === 'X',
        status: (mark === 'x' || mark === 'X') ? 'done'
          : mark === '~' ? 'wip'
          : mark === '!' ? 'review'
          : mark === '?' ? 'consideration'
          : 'planned',
        text: line.slice(6).trim(),
        extra: [],
        extraLines: [],   // raw line indices of the continuation lines (for editing)
        endLine: i,       // last line belonging to this item — grows below
      });
    } else if (cur && cur.items.length && /^\s{2,}\S/.test(line)) {
      const item = cur.items[cur.items.length - 1];
      item.extra.push(line.trim());
      item.extraLines.push(i);
      item.endLine = i;
    }
  });
  return { lines, sections };
}

const _RM_DETAIL_LABELS = {
  beschreibung: 'description',
  ziel: 'goal',
  akzeptanzkriterien: 'acceptance',
  version: 'version',
  zielversion: 'version',
  priorität: 'priority',
  prioritaet: 'priority',
  abhängigkeiten: 'dependencies',
  abhaengigkeiten: 'dependencies',
  notizen: 'notes',
  testpunkte: 'tests',
  tests: 'tests',
};

// A test point carries its own checkbox inside the roadmap line:
//   - [x] Open the Developer page, the board loads
// Alessio 2026-07-31: "bei den einzelnen Features beim Testen grad Todos machen
// können was ich testen muss damit ich die dann abhaken kann — ist
// übersichtlicher als eine Datei immer." Keeping the tick in ROADMAP.md means
// the developer agent reads the same state Alessio sees, and a pre-4.1 Odysseus
// still shows the points as an ordinary list instead of losing them.
const _RM_TEST_RE = /^-?\s*\[([ xX])\]\s*(.*)$/;

function _rmTestPoint(line) {
  const m = String(line).match(_RM_TEST_RE);
  if (m) return { text: m[2].trim(), done: m[1].toLowerCase() === 'x' };
  return { text: String(line).replace(/^-\s+/, '').trim(), done: false };
}

// Carry ticks across an edit by matching on the text, not the position — the
// alternative (index) silently moves a tick to a different point as soon as
// somebody reorders or inserts a line.
function _mergeTestPoints(next, previous) {
  const wasDone = new Map((previous || []).map(t => [t.text, t.done]));
  return next.filter(t => t.text).map(t => ({ text: t.text, done: wasDone.get(t.text) === true }));
}

function _roadmapDetails(item) {
  const details = {
    id: '', description: '', goal: '', acceptance: '',
    version: '', priority: 'Normal', dependencies: '', notes: '',
    tests: [], screenshots: [],
  };
  let field = '';
  const legacy = [];
  for (const raw of item.extra || []) {
    const idMatch = raw.match(/^<!--\s*ody:id=([a-zA-Z0-9_-]+)\s*-->$/);
    if (idMatch) { details.id = idMatch[1]; continue; }
    let line = raw;
    line = line.replace(uploadImageMdRe('\\s*'), (_, url) => { details.screenshots.push(url); return ''; }).trim();
    if (!line) continue;
    const label = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (label) {
      field = _RM_DETAIL_LABELS[label[1].trim().toLowerCase()] || '';
      if (field) {
        const value = label[2].trim();
        if (field === 'tests') {
          if (value) details.tests.push(_rmTestPoint(value));
        } else if (value) {
          details[field] = value;
        }
        continue;
      }
    }
    if (field === 'tests') {
      details.tests.push(_rmTestPoint(line));
    } else if (field) {
      const value = line.replace(/^-\s+/, '').trim();
      details[field] += (details[field] ? '\n' : '') + value;
    } else {
      legacy.push(line);
    }
  }
  if (!details.description && legacy.length) details.description = legacy.join('\n');
  return details;
}

function _newRoadmapId() {
  if (globalThis.crypto?.randomUUID) return `rm-${crypto.randomUUID().slice(0, 12)}`;
  return `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// New and edited cards carry a stable ID in a hidden Markdown comment. Legacy
// cards retain the title hash until they are edited.
function _itemKey(item) {
  const details = _roadmapDetails(item);
  if (details.id) return details.id;
  const s = _rmCardText(item);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function _roadmapItemBlock(mark, title, details, images = []) {
  const id = details.id || _newRoadmapId();
  const block = [`- [${mark}] ${title.trim()}`, `      <!-- ody:id=${id} -->`];
  const addText = (label, value) => {
    const rows = (value || '').split('\n').map(v => v.trim()).filter(Boolean);
    if (!rows.length) return;
    block.push(`      **${label}:** ${rows[0]}`);
    for (const row of rows.slice(1)) block.push(`      ${row}`);
  };
  addText('Beschreibung', details.description);
  addText('Ziel', details.goal);
  const criteria = (details.acceptance || '').split('\n').map(v => v.replace(/^-\s*/, '').trim()).filter(Boolean);
  if (criteria.length) {
    block.push('      **Akzeptanzkriterien:**');
    for (const criterion of criteria) block.push(`        - ${criterion}`);
  }
  const tests = Array.isArray(details.tests) ? details.tests.filter(t => t && t.text) : [];
  if (tests.length) {
    block.push('      **Testpunkte:**');
    for (const t of tests) block.push(`        - [${t.done ? 'x' : ' '}] ${String(t.text).trim()}`);
  }
  addText('Version', details.version);
  addText('Priorität', details.priority && details.priority !== 'Normal' ? details.priority : '');
  addText('Abhängigkeiten', details.dependencies);
  addText('Notizen', details.notes);
  for (const url of images) block.push(`      ![screenshot](${url})`);
  return block;
}

async function _saveItemEdit(item, newTitle, details) {
  const lines = _roadmapText.split('\n');
  // Look the mark up rather than re-deriving it: the old ternary chain had no
  // branch for a new state, so editing an "under consideration" card would
  // silently demote it to planned.
  const mark = (_RM_COLS.find(c => c.key === item.status) || { mark: ' ' }).mark;
  const previous = _roadmapDetails(item);
  // Preserve a legacy title-hash as the new stable ID so an existing build
  // association remains reachable after the first structured edit.
  details.id = previous.id || _itemKey(item);
  // The edit form shows test points as plain lines; the ticks live outside it,
  // so they have to be carried over here or every edit would clear them.
  details.tests = _mergeTestPoints(details.tests || [], previous.tests);
  const block = _roadmapItemBlock(mark, newTitle, details, previous.screenshots);
  lines.splice(item.line, item.endLine - item.line + 1, ...block);
  const ok = await _saveRoadmap(lines.join('\n'), el('dev-roadmap-msg'));
  if (ok) _renderRoadmap();
  return ok;
}

// Ticking a box rewrites only that card's block, the same way _setItemStatus
// rewrites only its marker line — the roadmap file stays the source of truth
// and two people editing different cards do not clobber each other's lines.
async function _setTestPoint(item, index, done) {
  const details = _roadmapDetails(item);
  if (!details.tests[index]) return false;
  details.tests[index] = { ...details.tests[index], done };
  const mark = (_RM_COLS.find(c => c.key === item.status) || { mark: ' ' }).mark;
  const lines = _roadmapText.split('\n');
  const block = _roadmapItemBlock(mark, _rmCardText(item), details, details.screenshots);
  lines.splice(item.line, item.endLine - item.line + 1, ...block);
  const ok = await _saveRoadmap(lines.join('\n'), el('dev-roadmap-msg'));
  if (ok) _renderRoadmap();
  return ok;
}

async function _saveRoadmap(text, msgEl) {
  try {
    const res = await fetch(`/api/system/roadmap`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`save ${res.status}`);
    _roadmapText = text;
    if (msgEl) { msgEl.textContent = 'Saved.'; msgEl.className = 'admin-success'; setTimeout(() => { msgEl.textContent = ''; }, 2500); }
    return true;
  } catch (e) {
    if (msgEl) { msgEl.textContent = 'Save failed: ' + e.message; msgEl.className = 'admin-error'; }
    return false;
  }
}

// Collapsed-state of roadmap sections, persisted per section title.
// Released/rejected packages start collapsed so the card leads with the
// open package and the inbox (v3.5, Alessios Wunsch: übersichtlicher).
let _roadmapCollapsed = null;

function _roadmapCollapsedState() {
  if (!_roadmapCollapsed) {
    try { _roadmapCollapsed = JSON.parse(localStorage.getItem('ody-roadmap-collapsed') || '{}'); }
    catch (_) { _roadmapCollapsed = {}; }
  }
  return _roadmapCollapsed;
}

// ── Board view ──
// Alessio 2026-07-27: "roadmap mit cards wie geplant / in progress … halt mit
// statusen". ROADMAP.md stays the source of truth (the developer reads it);
// the board is a second lens on the same file, and a status click rewrites
// only that line's marker.
// The pipeline, in order. `mark` is what lands in ROADMAP.md, so these
// characters are a contract shared with the developer agent and dev.sh.
//
// `?` for "under consideration" fits the existing bracket slot, reads correctly
// in a plain editor, and does not collide with list syntax the way -, > or /
// would. Downgrade cost, stated plainly: a pre-4.0 Odysseus parses only
// [ x ~ !], so these items become invisible in ITS ui — the file keeps them
// intact and re-upgrading brings them back.
//
// `done` is not rendered as a board column; it lives behind the Done button.
const _RM_COLS = [
  { key: 'consideration', label: 'Under consideration', mark: '?' },
  { key: 'planned', label: 'Planned', mark: ' ' },
  { key: 'wip', label: 'In progress', mark: '~' },
  { key: 'review', label: 'Ready to test', mark: '!' },
  { key: 'done', label: 'Done', mark: 'x' },
];
const _RM_BOARD_COLS = _RM_COLS.filter(c => c.key !== 'done');
// How many finished items the Done view keeps. The board used to show the last
// ten in a column; behind a button there is room for a real history.
const _RM_DONE_LIMIT = 50;

async function _setItemStatus(item, statusKey) {
  const col = _RM_COLS.find(c => c.key === statusKey);
  if (!col) return false;
  const ls = _roadmapText.split('\n');
  ls[item.line] = ls[item.line].replace(_RM_MARK_SET_RE, `- [${col.mark}]`);
  const saved = await _saveRoadmap(ls.join('\n'), el('dev-roadmap-msg'));
  if (saved) _renderRoadmap();
  return saved;
}

function _normalizeRoadmapVersion(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const number = value.replace(/^v/i, '');
  return /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(number)
    ? `v${number}`
    : '';
}

async function _setAllPlannedVersions(rawVersion) {
  const version = _normalizeRoadmapVersion(rawVersion);
  if (!version) throw new Error('Please enter a valid version, e.g. 3.10.');
  const parsed = _roadmapSections(_roadmapText);
  const targets = parsed.sections
    .filter(section => !/RELEASED/i.test(section.title))
    .flatMap(section => section.items)
    .filter(item => item.status === 'planned')
    .sort((a, b) => b.line - a.line);
  if (!targets.length) return 0;
  const lines = parsed.lines.slice();
  for (const item of targets) {
    const details = _roadmapDetails(item);
    details.version = version;
    const block = _roadmapItemBlock(' ', item.text, details, details.screenshots);
    lines.splice(item.line, item.endLine - item.line + 1, ...block);
  }
  const saved = await _saveRoadmap(lines.join('\n'), el('dev-roadmap-msg'));
  if (!saved) throw new Error('The roadmap could not be saved.');
  _renderRoadmap();
  return targets.length;
}

function _rmCardText(item) {
  // Strip screenshot links and the leading **Bug:**-style prefix for a
  // compact card title; the full wrapped text goes in the tooltip.
  const IMG_RE = uploadImageMdRe('\\s*');
  return item.text.replace(IMG_RE, '').replace(/\*\*/g, '').trim();
}

// ── Build workflow ──
// Alessio 2026-07-27: "damit ich Beschreibungen hinzufügen kann, damit ich
// die Feature genauer definieren kann ... in die eigene Entwicklungspipeline
// einbauen, am besten mit Klick auf Button, dann baut er das Feature ... im
// Hintergrund, Modell auswählen können auf dieser Seite."
//
// Workflow a Build click runs, end to end:
//  1. Mark the roadmap item [~] immediately at the hand-off.
//  2. Ensure the Builder project exists (projects.js, same as the Go button).
//  3. Create a chat session with the CHOSEN endpoint/model directly
//     (POST /api/session — same call materializePendingSession uses), then
//     attach it to the Builder project (POST /api/projects/{id}/sessions/{sid}).
//  4. Switch to that chat, close Settings, force Agent+Shell
//     (window.__odysseusPrepareDeveloperMode — the exact function the Go
//     button already calls, so behavior stays identical).
//  5. Fill the composer with a prompt built from the card's title +
//     description and submit it via chat.handleChatSubmit — the SAME send
//     path a typed message takes, so streaming/tools/detach-on-navigate all
//     work unchanged. This is what "runs in the background" means here:
//     once sent, the turn keeps going even if you switch chats or close
//     Settings, exactly like any other in-flight agent turn.
//  6. Record {item_key, session_id, model} so the card shows "Building —
//     open chat" after a reload.
//
// Disabled on beta (no host/clone access there), mirroring the Go button.
let _roadmapBuilds = null;   // Map item_key -> build record, or null = not loaded
let _channelIsBeta = null;

async function _loadRoadmapBuilds() {
  try {
    const res = await fetch('/api/system/roadmap/builds', { credentials: 'same-origin' });
    const d = await res.json();
    _roadmapBuilds = new Map((d.builds || []).map(b => [b.item_key, b]));
  } catch (_) {
    _roadmapBuilds = new Map();
  }
  if (_channelIsBeta === null) {
    try {
      const v = await fetch('/api/version', { credentials: 'same-origin' }).then(r => r.json());
      _channelIsBeta = v.channel === 'beta';
    } catch (_) { _channelIsBeta = false; }
  }
}

async function _openBuildChat(sessionId) {
  try {
    settingsModule.close(); // window.Modals.close(...) never existed - the modal never actually closed (found 2026-07-27)
    const s = await import('./sessions.js');
    await s.selectSession(sessionId, { keepSidebar: true, showLoading: false });
  } catch (e) {
    if (uiModule?.showError) uiModule.showError('Could not open that chat: ' + e.message);
  }
}

// doAdd() writes every new item's title as "**Bug:** …" / "**Feature:** …",
// so the type is already in the file and does not need its own field.
// Unlabelled legacy items count as features — the cautious track.
function _rmItemKind(item) {
  const m = _rmCardText(item).match(/^\*\*(Bug|Feature|Idee|Polish)\s*:?\*\*/i);
  return m ? m[1].toLowerCase() : 'feature';
}

// Bugs and polish go straight to main so Alessio can keep debugging live;
// features get a short beta pass and then wait for an explicit go-word.
function _rmTrackForKind(kind) {
  return (kind === 'bug' || kind === 'polish') ? 'bug' : 'feature';
}

function _buildPrompt(item, buildMode) {
  const title = _rmCardText(item);
  const d = _roadmapDetails(item);
  const kind = _rmItemKind(item);
  const track = _rmTrackForKind(kind);
  const section = (label, value) => value?.trim() ? `\n**${label}:**\n${value.trim()}\n` : '';
  const directBugfix = buildMode === 'direct-bugfix';
  const approach = buildMode === 'plan'
    ? `Erstelle zuerst einen konkreten Umsetzungsplan, prüfe offene Fragen und warte auf meine Freigabe, bevor du Dateien änderst.`
    : `Arbeite autonom bis zur Gate-Frage deines Tracks. Frage nur nach, wenn eine Entscheidung das Produktverhalten wesentlich verändert oder du wirklich blockiert bist.`;
  const workflow = (directBugfix || track === 'bug')
    ? `**Track BUG — direkt auf main, ohne Beta.**\n`
      + `1. \`dev.sh start fix/<slug>\`\n`
      + `2. Fix bauen, \`dev.sh check\`, relevante pytest.\n`
      + `3. EINE Frage an Alessio: "Bugfix <slug> direkt auf main?" Ohne Ja: stopp.\n`
      + `4. \`dev.sh bugfix fix/<slug>\` (Patch-Bump + Prod-Rebuild, kein Beta).\n`
      + `5. \`dev.sh verify prod <version>\` — erst wenn das OK sagt, ist es fertig.\n`
      + `6. \`dev.sh roadmap-status ${_itemKey(item)} x\`\n`
    : `**Track FEATURE — kurz auf Beta, dann warten.**\n`
      + `1. \`dev.sh start feat/<slug>\`\n`
      + `2. Bauen, \`dev.sh check\`, relevante pytest.\n`
      + `3. \`dev.sh ready feat/<slug>\` (pusht auf Beta und hält an).\n`
      + `4. \`dev.sh roadmap-status ${_itemKey(item)} '!'\` und\n`
      + `   \`dev.sh roadmap-testpoints ${_itemKey(item)} "..." "..."\` — die\n`
      + `   Testpunkte gehören an die Karte, damit Alessio sie dort abhakt.\n`
      + `5. Melde Beta-URL und eine kurze Testanleitung — und STOPP.\n`
      + `   Auf der Beta zählt vor allem: stürzt nichts ab, und funktioniert\n`
      + `   der Downgrade-Knopf. Alles andere findet Alessio live auf main.\n`
      + `6. NUR nach einem Go-Wort ("push to main", "auf main", "promote",\n`
      + `   "ausrollen", "prod", "go"): \`dev.sh promote-main feat/<slug>\`,\n`
      + `   dann \`dev.sh verify prod <version>\` und roadmap-status x.\n`;
  return `Setze dieses Roadmap-Item aus der ROADMAP.md um.\n\n`
    + `**Roadmap-ID:** ${_itemKey(item)}\n`
    + `**Typ:** ${kind}\n`
    + `**Titel:** ${title}\n`
    + section('Beschreibung', d.description)
    + section('Ziel / Problem', d.goal)
    + section('Akzeptanzkriterien', d.acceptance)
    + section('Testpunkte', (d.tests || []).map(t => t.text).join('\n'))
    + section('Zielversion', d.version)
    + section('Priorität', d.priority)
    + section('Abhängigkeiten', d.dependencies)
    + section('Technische Notizen / Grenzen', d.notes)
    + `\n${approach}\n\n${workflow}\n`
    + `Status IMMER über \`dev.sh roadmap-status\` setzen — ROADMAP.md nie von `
    + `Hand editieren, die stabile ID steht auf einer Folgezeile und ein sed `
    + `trifft den falschen Eintrag.`;
}

async function _startRoadmapBuild(it, endpointId, model, modelLabel, buildMode) {
  const title = _rmCardText(it);
  // Persist [~] before any slower project/session/model work. This is the
  // actual hand-off point, so ROADMAP.md immediately shows that an agent has
  // picked up the item.
  if (!await _setItemStatus(it, 'wip')) {
    throw new Error('Could not mark the roadmap item as in progress');
  }
  let buildSessionId = '';
  try {
    const projectsMod = await import('./projects.js');
    if (!projectsMod.ensureDeveloperProject) throw new Error('Developer project setup is unavailable');
    const builder = await projectsMod.ensureDeveloperProject();

    const fd = new FormData();
    fd.append('name', 'Chat');
    fd.append('endpoint_id', endpointId);
    fd.append('model', model);
    fd.append('skip_validation', 'true');
    const sessRes = await fetch('/api/session', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (!sessRes.ok) throw new Error(`Session creation failed (HTTP ${sessRes.status})`);
    const sess = await sessRes.json();
    buildSessionId = sess.id;

    const attachRes = await fetch(`/api/projects/${builder.id}/sessions/${sess.id}`, {
      method: 'POST', credentials: 'same-origin',
    });
    if (!attachRes.ok) throw new Error(`Could not attach the chat to the Builder project (HTTP ${attachRes.status})`);

    const buildRecord = {
      item_key: _itemKey(it), item_title: title, session_id: sess.id,
      endpoint_id: endpointId, model, model_label: modelLabel,
    };
    const recordRes = await fetch('/api/system/roadmap/builds', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRecord),
    });
    if (!recordRes.ok) {
      throw new Error(`Could not link the build chat to the roadmap item (HTTP ${recordRes.status})`);
    }
    if (!_roadmapBuilds) _roadmapBuilds = new Map();
    _roadmapBuilds.set(buildRecord.item_key, buildRecord);

    const sessionsMod = await import('./sessions.js');
    await sessionsMod.loadSessions();
    settingsModule.close(); // window.Modals.close(...) never existed - the modal never actually closed (found 2026-07-27)
    await sessionsMod.selectSession(sess.id, { keepSidebar: true, showLoading: false });
    if (typeof window.__odysseusPrepareDeveloperMode === 'function') window.__odysseusPrepareDeveloperMode();

    const msgInput = document.getElementById('message');
    if (!msgInput) throw new Error('Composer not found — cannot send the build prompt');
    msgInput.value = _buildPrompt(it, buildMode);
    msgInput.dispatchEvent(new Event('input', { bubbles: true }));
    const chatMod = await import('./chat.js');
    await chatMod.handleChatSubmit({ preventDefault() {} });

    if (uiModule?.showToast) uiModule.showToast(`Build started (${modelLabel}) — running in the background.`);
  } catch (error) {
    // The hand-off never became a running agent turn. Put the item back so
    // the board does not claim work is active after a setup/send failure.
    if (buildSessionId) {
      await fetch(`/api/system/roadmap/builds/${encodeURIComponent(buildSessionId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      }).catch(() => {});
      const itemKey = _itemKey(it);
      if (_roadmapBuilds?.get(itemKey)?.session_id === buildSessionId) {
        _roadmapBuilds.delete(itemKey);
      }
    }
    await _setItemStatus(it, 'planned');
    throw error;
  }
}

function _cardBuildFormHtml() {
  return `
    <div class="rm-buildform">
      ${_channelIsBeta ? '<div class="rm-hint">Preview: on beta you can check the model and workflow; the real start stays locked, because only Prod can reach the server repo.</div>' : ''}
      <label class="rm-field"><span>Endpoint</span>
        <span class="adm-model-logo" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;"></span>
        <select class="settings-select rm-build-ep"></select></label>
      <label class="rm-field"><span>Model</span>
        <span class="adm-model-logo" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;"></span>
        <select class="settings-select rm-build-model"></select></label>
      <label class="rm-field"><span>Workflow</span>
        <select class="settings-select rm-build-mode">
          <option value="build">Build autonomously up to beta</option>
          <option value="direct-bugfix">Fix bug directly on main</option>
          <option value="plan">Plan and ask first</option>
        </select></label>
      <div class="rm-build-msg" style="display:none;"></div>
      <div class="rm-actions">
        <button type="button" class="memory-toolbar-btn rm-build-cancel">Cancel</button>
        <button type="button" class="memory-toolbar-btn rm-build-start"${_channelIsBeta ? ' disabled title="Only available on Prod"' : ''}>${_channelIsBeta ? 'Start on Prod only' : 'Start build'}</button>
      </div>
    </div>`;
}

function _cardEditFormHtml(it) {
  const d = _roadmapDetails(it);
  return `
    <div class="rm-editform">
      <label class="rm-edit-field"><span>Title</span><input type="text" class="styled-prompt-input rm-edit-title" value="${esc(_rmCardText(it))}" /></label>
      <label class="rm-edit-field"><span>Description</span><textarea class="rm-edit-desc" rows="3" placeholder="What should happen?">${esc(d.description)}</textarea></label>
      <label class="rm-edit-field"><span>Goal / Problem</span><textarea class="rm-edit-goal" rows="2" placeholder="Why do we need this?">${esc(d.goal)}</textarea></label>
      <label class="rm-edit-field"><span>Done when …</span><textarea class="rm-edit-acceptance" rows="3" placeholder="One checkable criterion per line">${esc(d.acceptance)}</textarea></label>
      <label class="rm-edit-field"><span>Test points</span><textarea class="rm-edit-tests" rows="3" placeholder="One thing to click through per line">${esc(d.tests.map(t => t.text).join('\n'))}</textarea></label>
      <div class="rm-edit-grid">
        <label class="rm-edit-field"><span>Priority</span><select class="settings-select rm-edit-priority">
          ${[['Niedrig', 'Low'], ['Normal', 'Normal'], ['Hoch', 'High'], ['Kritisch', 'Critical']].map(([v, label]) => `<option value="${v}"${d.priority === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select></label>
        <label class="rm-edit-field"><span>Target version</span><input type="text" class="styled-prompt-input rm-edit-version" maxlength="32" value="${esc(d.version)}" placeholder="e.g. 3.10" /></label>
      </div>
      <label class="rm-edit-field"><span>Dependencies</span><input type="text" class="styled-prompt-input rm-edit-dependencies" value="${esc(d.dependencies)}" placeholder="None" /></label>
      <label class="rm-edit-field"><span>Technical notes / limits</span><textarea class="rm-edit-notes" rows="2" placeholder="Optional">${esc(d.notes)}</textarea></label>
      <div class="rm-actions">
        <button type="button" class="memory-toolbar-btn rm-edit-cancel">Cancel</button>
        <button type="button" class="memory-toolbar-btn rm-edit-save">Save</button>
      </div>
    </div>`;
}

function _detailsFromForm(root, prefix = '.rm-edit-') {
  const value = name => root.querySelector(`${prefix}${name}`)?.value?.trim() || '';
  return {
    description: value('desc'),
    goal: value('goal'),
    acceptance: value('acceptance'),
    version: _normalizeRoadmapVersion(value('version')),
    priority: value('priority') || 'Normal',
    dependencies: value('dependencies'),
    notes: value('notes'),
    // Plain lines in, structured points out. Ticks are merged back in
    // _saveItemEdit, which is the only place that knows the previous state.
    tests: value('tests').split('\n').map(_rmTestPoint).filter(t => t.text),
  };
}

// Done lives behind a button, not in a column. Built fresh rather than cloned
// (same discipline as the Developer window, which is pinned by a test): a clone
// would duplicate every id on the page.
let _doneModalEl = null;

function _ensureDoneModal() {
  if (_doneModalEl) return _doneModalEl;
  _doneModalEl = document.createElement('div');
  _doneModalEl.id = 'roadmap-done-modal';
  _doneModalEl.className = 'modal';
  _doneModalEl.style.display = 'none';
  _doneModalEl.innerHTML = `
    <div class="modal-content" role="dialog" aria-label="Completed roadmap items">
      <div class="modal-header">
        <h4>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span id="rm-done-title">Done</span>
        </h4>
        <button class="close-btn" type="button" aria-label="Close">&#10006;</button>
      </div>
      <div class="modal-body"><div id="rm-done-list" class="rm-done-list"></div></div>
    </div>`;
  document.body.appendChild(_doneModalEl);
  _doneModalEl.querySelector('.close-btn').addEventListener('click', _closeDoneView);
  _doneModalEl.addEventListener('click', (e) => {
    if (e.target === _doneModalEl) _closeDoneView();
  });
  return _doneModalEl;
}

function _closeDoneView() {
  if (_doneModalEl) _doneModalEl.style.display = 'none';
}

// Roadmap cards deliberately stay compact on the board. Open their complete
// structured content in a shared modal instead of expanding a column and
// pushing every other card out of view.
let _roadmapItemModalEl = null;

function _ensureRoadmapItemModal() {
  if (_roadmapItemModalEl) return _roadmapItemModalEl;
  _roadmapItemModalEl = document.createElement('div');
  _roadmapItemModalEl.id = 'roadmap-item-modal';
  _roadmapItemModalEl.className = 'modal';
  _roadmapItemModalEl.style.display = 'none';
  _roadmapItemModalEl.innerHTML = `
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="rm-item-modal-title">
      <div class="modal-header">
        <h4 id="rm-item-modal-title"></h4>
        <button class="close-btn" type="button" aria-label="Close">&#10006;</button>
      </div>
      <div class="modal-body rm-item-modal-body"></div>
    </div>`;
  document.body.appendChild(_roadmapItemModalEl);
  _roadmapItemModalEl.querySelector('.close-btn').addEventListener('click', _closeRoadmapItemModal);
  _roadmapItemModalEl.addEventListener('click', (e) => {
    if (e.target === _roadmapItemModalEl) _closeRoadmapItemModal();
  });
  return _roadmapItemModalEl;
}

function _closeRoadmapItemModal() {
  if (_roadmapItemModalEl) _roadmapItemModalEl.style.display = 'none';
}

function _appendRoadmapDetail(body, label, value) {
  if (!value) return;
  const section = document.createElement('section');
  section.className = 'rm-item-detail';
  const heading = document.createElement('h5');
  heading.textContent = label;
  const content = document.createElement('div');
  content.className = 'rm-item-detail-content';
  content.textContent = value;
  section.appendChild(heading);
  section.appendChild(content);
  body.appendChild(section);
}

function _openRoadmapItemModal(item, section) {
  const modal = _ensureRoadmapItemModal();
  const details = _roadmapDetails(item);
  modal.querySelector('#rm-item-modal-title').textContent = _rmCardText(item);
  const body = modal.querySelector('.rm-item-modal-body');
  body.innerHTML = '';

  const meta = document.createElement('div');
  meta.className = 'rm-item-modal-meta';
  const sectionChip = document.createElement('span');
  sectionChip.className = 'rm-chip';
  sectionChip.textContent = section.title.replace(/\s*\(.*$/, '');
  meta.appendChild(sectionChip);
  if (details.version) {
    const versionChip = document.createElement('span');
    versionChip.className = 'rm-chip rm-version-chip';
    versionChip.textContent = details.version;
    meta.appendChild(versionChip);
  }
  if (details.priority && details.priority !== 'Normal') {
    const priorityChip = document.createElement('span');
    priorityChip.className = `rm-chip rm-priority rm-priority-${details.priority.toLowerCase()}`;
    priorityChip.textContent = details.priority;
    meta.appendChild(priorityChip);
  }
  body.appendChild(meta);

  _appendRoadmapDetail(body, 'Description', details.description);
  _appendRoadmapDetail(body, 'Goal / problem', details.goal);
  _appendRoadmapDetail(body, 'Done when', details.acceptance);
  _appendRoadmapDetail(body, 'Dependencies', details.dependencies);
  _appendRoadmapDetail(body, 'Technical notes / limits', details.notes);

  if (details.tests.length) {
    const tests = document.createElement('section');
    tests.className = 'rm-item-detail';
    const heading = document.createElement('h5');
    heading.textContent = 'Test points';
    const list = document.createElement('div');
    list.className = 'rm-item-modal-tests';
    details.tests.forEach((test, index) => {
      const row = document.createElement('label');
      row.className = 'rm-test-row' + (test.done ? ' rm-test-row-done' : '');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!test.done;
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true;
        if (!await _setTestPoint(item, index, checkbox.checked)) {
          checkbox.checked = !checkbox.checked;
          checkbox.disabled = false;
          return;
        }
        row.classList.toggle('rm-test-row-done', checkbox.checked);
      });
      const text = document.createElement('span');
      text.textContent = test.text;
      row.appendChild(checkbox);
      row.appendChild(text);
      list.appendChild(row);
    });
    tests.appendChild(heading);
    tests.appendChild(list);
    body.appendChild(tests);
  }

  _appendScreenshots(body, details);
  modal.style.display = 'flex';
  modal.querySelector('.close-btn').focus();
}

function _doneItems(sections) {
  // Unlike the board, RELEASED sections are included — shipped work IS the
  // history this view exists to show.
  const out = [];
  for (const sec of sections) {
    for (const it of sec.items) {
      if ((it.status || 'planned') === 'done') out.push({ it, sec });
    }
  }
  return out;
}

function _openDoneView(sections) {
  const modal = _ensureDoneModal();
  const all = _doneItems(sections);
  const shown = all.slice(-_RM_DONE_LIMIT).reverse();
  const title = modal.querySelector('#rm-done-title');
  // Keep the count honest about what is being hidden.
  title.textContent = all.length > shown.length
    ? `Done — latest ${shown.length} of ${all.length}`
    : `Done (${all.length})`;

  const list = modal.querySelector('#rm-done-list');
  list.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'rm-col-empty';
    empty.textContent = 'Nothing completed yet';
    list.appendChild(empty);
  }
  for (const { it, sec } of shown) {
    const details = _roadmapDetails(it);
    const card = document.createElement('div');
    card.className = 'rm-card rm-card-done';

    const titleEl = document.createElement('div');
    titleEl.className = 'rm-card-text';
    titleEl.textContent = _rmCardText(it);
    card.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'rm-card-meta';
    const secChip = document.createElement('span');
    secChip.className = 'rm-chip';
    secChip.textContent = sec.title.replace(/\s*\(.*$/, '').slice(0, 26);
    meta.appendChild(secChip);
    if (details.version) {
      const versionChip = document.createElement('span');
      versionChip.className = 'rm-chip rm-version-chip';
      versionChip.textContent = details.version;
      meta.appendChild(versionChip);
    }
    const doneTestChip = _testProgressChip(details);
    if (doneTestChip) meta.appendChild(doneTestChip);
    card.appendChild(meta);
    _appendScreenshots(card, details);

    const actions = document.createElement('div');
    actions.className = 'rm-card-actions';
    const reopen = document.createElement('button');
    reopen.className = 'admin-btn-sm';
    reopen.type = 'button';
    reopen.textContent = 'Move to planned';
    reopen.addEventListener('click', async () => {
      reopen.disabled = true;
      if (await _setItemStatus(it, 'planned')) _closeDoneView();
      else reopen.disabled = false;
    });
    actions.appendChild(reopen);
    card.appendChild(actions);
    list.appendChild(card);
  }
  modal.style.display = 'flex';
}

// One builder for both render sites. Screenshots were once lost precisely
// because a card detail was built inline in only one of them.
function _testProgressChip(details) {
  const tests = details.tests || [];
  if (!tests.length) return null;
  const done = tests.filter(t => t.done).length;
  const chip = document.createElement('span');
  chip.className = 'rm-chip rm-chip-tests';
  if (done === tests.length) chip.classList.add('rm-chip-tests-done');
  chip.textContent = `${done}/${tests.length} tested`;
  chip.title = tests.map(t => `${t.done ? '✓' : '○'} ${t.text}`).join('\n');
  return chip;
}

// Alessio ticks these off while clicking through a finished build, so they sit
// on the card itself. Real checkboxes rather than click-anywhere rows: the card
// is draggable between columns, and a stray drag must not tick a test.
function _appendTestPoints(card, item, details) {
  const tests = details.tests || [];
  if (!tests.length) return;
  const box = document.createElement('div');
  box.className = 'rm-card-tests';
  box.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  tests.forEach((t, i) => {
    const row = document.createElement('label');
    row.className = 'rm-test-row' + (t.done ? ' rm-test-row-done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!t.done;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      // On failure put the box back where it was — a tick that did not reach
      // ROADMAP.md must not look like it did.
      if (!await _setTestPoint(item, i, cb.checked)) {
        cb.checked = !cb.checked;
        cb.disabled = false;
      }
    });
    const text = document.createElement('span');
    text.textContent = t.text;
    row.appendChild(cb);
    row.appendChild(text);
    box.appendChild(row);
  });
  card.appendChild(box);
}

// Screenshots used to render only in the list view. With that view gone they
// would have silently stopped appearing anywhere, so pasting one into a roadmap
// entry would produce nothing visible.
function _appendScreenshots(card, details) {
  const shots = details.screenshots || [];
  if (!shots.length) return;
  const row = document.createElement('div');
  row.className = 'rm-card-shots';
  for (const url of shots) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'screenshot';
    img.loading = 'lazy';
    img.className = 'rm-card-shot';
    img.addEventListener('click', (e) => { e.stopPropagation(); window.open(url, '_blank'); });
    row.appendChild(img);
  }
  card.appendChild(row);
}

function _renderRoadmapBoard(list, sections) {
  // Released sections are history — the board is about what is moving now.
  const live = sections.filter(s => !/RELEASED/i.test(s.title));
  const board = document.createElement('div');
  board.className = 'rm-board';
  // Done is not a column — finished work is history, and a column for it grew
  // without bound while pushing the live states off the screen. It opens from
  // the toolbar button instead (_openDoneView).
  for (const col of _RM_BOARD_COLS) {
    const items = [];
    for (const sec of live) {
      for (const it of sec.items) {
        if ((it.status || 'planned') === col.key) items.push({ it, sec });
      }
    }
    const totalItems = items.length;
    const colEl = document.createElement('div');
    colEl.className = 'rm-col';
    colEl.dataset.col = col.key;
    colEl.innerHTML = `<div class="rm-col-head">${col.label}<span class="folder-count">${totalItems}</span></div>`;
    const body = document.createElement('div');
    body.className = 'rm-col-body';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'rm-col-empty';
      empty.textContent = col.key === 'wip' ? 'Nothing in progress' : 'Empty';
      body.appendChild(empty);
    }
    for (const { it, sec } of items) {
      const card = document.createElement('div');
      card.className = 'rm-card' + (col.key === 'done' ? ' rm-card-done' : '');
      card.draggable = true;
      card.dataset.line = String(it.line);
      const itemKey = _itemKey(it);
      const build = _roadmapBuilds ? _roadmapBuilds.get(itemKey) : null;
      const details = _roadmapDetails(it);

      const renderView = () => {
        card.innerHTML = '';
        card.draggable = true;
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'rm-card-text rm-card-open';
        title.textContent = _rmCardText(it);
        title.title = 'Open roadmap item';
        title.addEventListener('click', (e) => {
          e.stopPropagation();
          _openRoadmapItemModal(it, sec);
        });
        card.appendChild(title);
        if (details.description) {
          const desc = document.createElement('div');
          desc.className = 'rm-card-desc';
          desc.textContent = details.description.replace(/\n/g, ' ');
          card.appendChild(desc);
        }
        const meta = document.createElement('div');
        meta.className = 'rm-card-meta';
        const secChip = document.createElement('span');
        secChip.className = 'rm-chip';
        secChip.textContent = sec.title.replace(/\s*\(.*$/, '').slice(0, 26);
        meta.appendChild(secChip);
        if (details.version) {
          const versionChip = document.createElement('span');
          versionChip.className = 'rm-chip rm-version-chip';
          versionChip.textContent = details.version;
          versionChip.title = 'Target version';
          meta.appendChild(versionChip);
        }
        if (details.priority && details.priority !== 'Normal') {
          const priorityChip = document.createElement('span');
          priorityChip.className = `rm-chip rm-priority rm-priority-${details.priority.toLowerCase()}`;
          priorityChip.textContent = details.priority;
          meta.appendChild(priorityChip);
        }
        if (details.acceptance) {
          const criteriaChip = document.createElement('span');
          criteriaChip.className = 'rm-chip';
          criteriaChip.title = details.acceptance;
          criteriaChip.textContent = `${details.acceptance.split('\n').filter(Boolean).length} criteria`;
          meta.appendChild(criteriaChip);
        }
        const testChip = _testProgressChip(details);
        if (testChip) meta.appendChild(testChip);
        if (build) {
          const buildChip = document.createElement('button');
          buildChip.type = 'button';
          buildChip.className = 'rm-chip rm-chip-build';
          buildChip.title = 'Open the build chat';
          buildChip.textContent = `${it.status === 'review' ? 'Test on beta' : it.status === 'done' ? 'Build chat' : 'Building'} — ${build.model_label || build.model || 'chat'}`;
          buildChip.addEventListener('click', (e) => { e.stopPropagation(); _openBuildChat(build.session_id); });
          meta.appendChild(buildChip);
        }
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'rm-move-btn';
        editBtn.title = 'Define this feature more precisely';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', (e) => { e.stopPropagation(); renderEdit(); });
        meta.appendChild(editBtn);
        const buildBtn = document.createElement('button');
        buildBtn.type = 'button';
        buildBtn.className = 'rm-move-btn rm-build-btn';
        buildBtn.title = _channelIsBeta ? 'Start on Prod so the builder can reach the server repo' : 'Build this feature in a linked agent chat';
        buildBtn.textContent = build ? 'Rebuild' : 'Build';
        buildBtn.addEventListener('click', (e) => { e.stopPropagation(); renderBuild(); });
        meta.appendChild(buildBtn);
        const moves = document.createElement('span');
        moves.className = 'rm-card-moves';
        for (const target of _RM_COLS) {
          if (target.key === col.key) continue;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'rm-move-btn';
          b.title = `Move to ${target.label}`;
          b.textContent = target.key === 'planned' ? 'Plan' : target.key === 'wip' ? 'Start' : target.key === 'review' ? 'Test' : 'Done';
          b.addEventListener('click', (e) => { e.stopPropagation(); _setItemStatus(it, target.key); });
          moves.appendChild(b);
        }
        meta.appendChild(moves);
        card.appendChild(meta);
        _appendTestPoints(card, it, details);
        _appendScreenshots(card, details);
      };

      const renderEdit = () => {
        card.draggable = false;
        card.innerHTML = _cardEditFormHtml(it);
        card.querySelector('.rm-edit-cancel').addEventListener('click', (e) => { e.stopPropagation(); renderView(); });
        card.querySelector('.rm-edit-save').addEventListener('click', async (e) => {
          e.stopPropagation();
          const newTitle = card.querySelector('.rm-edit-title').value;
          if (!newTitle.trim()) return;
          const rawVersion = card.querySelector('.rm-edit-version')?.value?.trim() || '';
          const detailsFromForm = _detailsFromForm(card);
          if (rawVersion && !detailsFromForm.version) {
            card.querySelector('.rm-edit-version')?.focus();
            if (uiModule?.showError) uiModule.showError('Invalid version — example: 3.10');
            return;
          }
          await _saveItemEdit(it, newTitle, detailsFromForm);
        });
        card.querySelectorAll('input, textarea, select').forEach(control =>
          control.addEventListener('click', (e) => e.stopPropagation()));
      };

      const renderBuild = async () => {
        card.draggable = false;
        card.innerHTML = _cardBuildFormHtml();
        const form = card.querySelector('.rm-buildform');
        form.addEventListener('click', (e) => e.stopPropagation());
        card.querySelector('.rm-build-cancel')?.addEventListener('click', (e) => { e.stopPropagation(); renderView(); });
        const epSel = card.querySelector('.rm-build-ep');
        const modelSel = card.querySelector('.rm-build-model');
        const modeSel = card.querySelector('.rm-build-mode');
        const msgBox = card.querySelector('.rm-build-msg');
        const missing = [];
        if (!details.description) missing.push('Description');
        if (!details.goal) missing.push('Goal');
        if (!details.acceptance) missing.push('Acceptance criteria');
        if (missing.length) {
          msgBox.textContent = `Still vague: ${missing.join(', ')}. You can start anyway or edit first.`;
          msgBox.classList.add('rm-build-warning');
          msgBox.style.display = '';
        }
        let endpoints = [];
        try {
          endpoints = await fetchModelEndpoints();
          fillEndpointSelect(epSel, endpoints, '', false);
          const fillModels = () => {
            const ep = endpoints.find(e => e.id === epSel.value);
            fillModelSelect(modelSel, ep ? ep.models : [], '', false);
          };
          fillModels();
          epSel.addEventListener('change', fillModels);
        } catch (e) {
          msgBox.textContent = 'Could not load models: ' + e.message;
          msgBox.style.display = '';
        }
        card.querySelector('.rm-build-start').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (_channelIsBeta) return;
          const startBtn = e.currentTarget;
          const endpointId = epSel.value, model = modelSel.value;
          if (!endpointId || !model) {
            msgBox.textContent = 'Pick an endpoint and a model first.';
            msgBox.style.display = '';
            return;
          }
          const epLabel = epSel.options[epSel.selectedIndex]?.textContent || endpointId;
          const modelLabel = modelSel.options[modelSel.selectedIndex]?.textContent || model;
          startBtn.disabled = true;
          if (!missing.length) msgBox.style.display = 'none';
          try {
            await _startRoadmapBuild(it, endpointId, model, `${epLabel} · ${modelLabel}`, modeSel.value);
          } catch (err) {
            msgBox.textContent = 'Could not start the build: ' + err.message;
            msgBox.style.display = '';
            startBtn.disabled = false;
          }
        });
      };

      renderView();
      card.addEventListener('dragstart', (e) => {
        if (!card.draggable) { e.preventDefault(); return; }
        card.classList.add('rm-dragging');
        try { e.dataTransfer.setData('text/plain', String(it.line)); } catch (_) {}
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => card.classList.remove('rm-dragging'));
      body.appendChild(card);
    }
    colEl.appendChild(body);
    colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('rm-col-over'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('rm-col-over'));
    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('rm-col-over');
      let lineNo = NaN;
      try { lineNo = parseInt(e.dataTransfer.getData('text/plain'), 10); } catch (_) {}
      if (!Number.isFinite(lineNo)) return;
      _setItemStatus({ line: lineNo }, col.key);
    });
    board.appendChild(colEl);
  }
  list.appendChild(board);
}

// One-time cleanup: the view toggle is gone, so its key is dead weight.
try { localStorage.removeItem('ody-roadmap-view'); } catch (_) {}

function _closeNewItemModal() {
  const m = el('roadmap-new-modal');
  if (m) m.style.display = 'none';
}

function _renderRoadmap() {
  const list = el('dev-roadmap-list');
  if (!list) return;
  const { sections } = _roadmapSections(_roadmapText);
  list.innerHTML = '';
  // Board only since v4.0. The list view was a second rendering of the same
  // data with its own checkbox write path, and Alessio never used it.
  if (!sections.length) {
    list.innerHTML = '<div style="opacity:0.6">No roadmap file yet — add an entry or use Edit raw.</div>';
    _syncDoneButton([]);
    return;
  }
  _renderRoadmapBoard(list, sections);
  _syncDoneButton(sections);
}

// The Done button carries the count, so finished work stays visible as a number
// even though it no longer occupies a column.
function _syncDoneButton(sections) {
  const btn = el('dev-roadmap-done-btn');
  if (!btn) return;
  const n = _doneItems(sections).length;
  btn.textContent = `Done (${n})`;
  btn.disabled = !n;
  if (!btn._doneWired) {
    btn._doneWired = true;
    btn.addEventListener('click', () => {
      _openDoneView(_roadmapSections(_roadmapText).sections);
    });
  }
}

async function _loadRoadmap() {
  const msg = el('dev-roadmap-msg');
  try {
    const res = await fetch(`/api/system/roadmap`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`load ${res.status}`);
    const d = await res.json();
    _roadmapText = d.content || '';
    if (!_roadmapBuilds) await _loadRoadmapBuilds();
    _renderRoadmap();
  } catch (e) {
    if (msg) { msg.textContent = 'Failed to load roadmap: ' + e.message; msg.className = 'admin-error'; }
  }
}

// `origin` is fetched in the background now (it used to block every /status
// call for ~2 s). So dev_version describes the last SUCCESSFUL fetch — if the
// host goes unreachable the fetch quietly stops and the open-package line would
// keep showing an old version as if it were current. Say so instead. Silent in
// the normal case: a fetch runs every 2 min, so anything under 5 is fine.
function _devVersionStaleness(d) {
  if (!d || !d.dev_version) return '';
  const age = d.fetch_age_seconds;
  if (age === null || age === undefined) return ' · not synced yet';
  if (age < 300) return '';
  const minutes = Math.round(age / 60);
  return minutes < 60
    ? ` · last synced ${minutes} min ago`
    : ` · last synced ${Math.round(minutes / 60)} h ago`;
}

// The beta row, in the three states it can actually be in. Until this existed
// the row printed `branch @ commit` and nothing else — the address was in no
// file anywhere, so the only way in was to remember it. `odysseus-beta:7001`
// (2026-08-15) is what guessing looks like.
//
// The middle state is the one worth the code: container answering, tailscale
// serve off. The host probe says healthy, the browser says connection refused.
function _renderBetaRow(node, d) {
  node.textContent = '';
  node.title = '';
  if (!d.beta_active) {
    node.textContent = 'not running';
    return;
  }
  const label = `${d.beta_branch || '?'} @ ${d.beta_commit || '?'}`;
  if (d.beta_exposed && d.beta_url) {
    const link = document.createElement('a');
    link.className = 'dev-beta-link';
    link.href = d.beta_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    link.title = `Open the beta — ${d.beta_url}`;
    node.appendChild(link);
    return;
  }
  node.textContent = label;
  const warn = document.createElement('span');
  warn.className = 'admin-error';
  warn.style.marginLeft = '6px';
  warn.style.marginTop = '0';
  warn.textContent = 'running, not shared on :7001';
  warn.title = 'The container answers on the host but tailscale serve is off, '
    + 'so no browser can reach it. Run the System check to fix it.';
  node.appendChild(warn);
}

async function _loadDevStatus() {
  const pkg = el('dev-package'), prod = el('dev-prod'), beta = el('dev-beta'), upd = el('dev-update');
  if (!pkg) return;
  // Channel awareness: on the beta instance the SSH-based host lookups don't
  // work (no keys by design) — but the instance KNOWS it is the beta, so say
  // that instead of a confusing "not running".
  let channel = '', build = '';
  try {
    const v = await fetch(`/api/version`, { credentials: 'same-origin' }).then(r => r.json());
    channel = v.channel || '';
    build = v.build || '';
  } catch (e) { /* keep defaults */ }
  try {
    const res = await fetch(`/api/system/status`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const d = await res.json();
    pkg.textContent = (d.dev_version ? `v${d.dev_version} (on dev)` : `v${d.version}`)
      + _devVersionStaleness(d);
    if (channel === 'beta') {
      prod.textContent = d.commit && d.commit !== 'unknown' ? `v? @ ${d.commit}` : 'n/a from beta (no host access)';
      beta.textContent = `this instance — ${build || `v${d.version}`}`;
      upd.textContent = 'test here, then Update on prod';
    } else {
      prod.textContent = `v${d.version} @ ${d.commit || '?'}`;
      _renderBetaRow(beta, d);
      if (d.promotable) {
        upd.textContent = 'ready — press Update on the System card';
      } else if (d.dev_version && d.dev_version !== d.version) {
        upd.textContent = `v${d.dev_version} in development`;
      } else {
        upd.textContent = 'up to date';
      }
    }
    _renderRoadmapFreshness(d.roadmap);
  } catch (e) {
    pkg.textContent = prod.textContent = beta.textContent = 'error';
    if (upd) upd.textContent = '—';
  }
}

// Nag when the roadmap has no section for the version being built — the
// developer reads that file on every start, so a gap means it plans from a
// stale picture (v3.7 documented while the code was at 3.9.5, 2026-07-27).
let _serverMetricsLoading = false;
let _serverMetricsTimer = null;

function _formatMetricBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const sized = value / (1024 ** power);
  return `${sized >= 10 || power < 2 ? sized.toFixed(0) : sized.toFixed(1)} ${units[power]}`;
}

function _formatUptime(seconds) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function _setMetricValue(id, value, percent) {
  const node = el(id);
  if (!node) return;
  node.textContent = value;
  const card = node.closest('.dev-metric');
  if (card && Number.isFinite(percent)) {
    card.style.setProperty('--metric-level', `${Math.max(0, Math.min(100, percent))}%`);
  }
}

async function _loadServerMetrics(force = false) {
  if (_serverMetricsLoading || !el('dev-server-metrics')) return;
  _serverMetricsLoading = true;
  const refresh = el('dev-server-refresh');
  const status = el('dev-metrics-status');
  const dot = el('dev-metrics-dot');
  if (refresh) refresh.disabled = true;
  try {
    const response = await fetch(`/api/system/metrics${force ? '?refresh=1' : ''}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.available) throw new Error('No metrics available');
    const cpu = data.cpu || {};
    const memory = data.memory || {};
    const disk = data.disk || {};
    _setMetricValue(
      'dev-metric-cpu',
      Number.isFinite(cpu.percent) ? `${cpu.percent.toFixed(1)} %` : 'misst …',
      cpu.percent,
    );
    el('dev-metric-load').textContent = Number.isFinite(cpu.load_1)
      ? `Load ${cpu.load_1.toFixed(2)} · ${cpu.cores || '?'} cores`
      : `${cpu.cores || '?'} cores`;
    _setMetricValue(
      'dev-metric-memory',
      Number.isFinite(memory.percent) ? `${memory.percent.toFixed(1)} %` : '—',
      memory.percent,
    );
    el('dev-metric-memory-detail').textContent =
      `${_formatMetricBytes(memory.used_bytes)} / ${_formatMetricBytes(memory.total_bytes)}`;
    _setMetricValue(
      'dev-metric-disk',
      Number.isFinite(disk.percent) ? `${disk.percent.toFixed(1)} %` : '—',
      disk.percent,
    );
    el('dev-metric-disk-detail').textContent =
      `${_formatMetricBytes(disk.used_bytes)} / ${_formatMetricBytes(disk.total_bytes)}`;
    _setMetricValue('dev-metric-uptime', _formatUptime(data.uptime_seconds));
    el('dev-metric-source').textContent =
      data.source === 'server' ? 'Odysseus-Server' : 'App-Container';
    const sampled = data.sampled_at ? new Date(data.sampled_at) : new Date();
    status.textContent = `Live · ${sampled.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    dot?.classList.add('is-live');
  } catch (error) {
    if (status) status.textContent = `Not reachable · ${error.message}`;
    dot?.classList.remove('is-live');
  } finally {
    _serverMetricsLoading = false;
    if (refresh) refresh.disabled = false;
  }
}

function _startServerMetricsPolling() {
  if (_serverMetricsTimer) return;
  _serverMetricsTimer = setInterval(() => {
    const modal = el('developer-modal');
    if (modal && modal.style.display !== 'none') _loadServerMetrics();
  }, 5000);
}

function _renderRoadmapFreshness(rm) {
  const box = el('dev-roadmap-stale');
  if (!box) return;
  if (!rm || rm.current) { box.style.display = 'none'; box.textContent = ''; return; }
  const want = rm.expected_section || '?';
  box.style.display = '';
  box.textContent = rm.missing
    ? 'No roadmap file yet — the developer has nothing to work from. Add an entry below.'
    : `Roadmap is behind: no "## ${want}" section, but that is the version being built. `
      + `Last sections: ${(rm.sections || []).join(' · ')}. Add the round's section so the `
      + `developer stops planning from an outdated picture.`;
}

async function _initBuilderLink() {
  const btn = el('dev-builder-btn');
  const prepareBtn = el('dev-prepare-btn');
  const msg = el('dev-chat-msg');
  if (!btn || !prepareBtn) return;
  const setMsg = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = ok ? 'admin-success' : 'admin-error';
  };
  const prepareMode = () => {
    if (typeof window.__odysseusPrepareDeveloperMode !== 'function') {
      throw new Error('Developer mode controls are not ready');
    }
    window.__odysseusPrepareDeveloperMode();
  };
  try {
    const m = await import('./projects.js');
    btn.style.display = '';
    prepareBtn.style.display = '';
    try {
      const versionRes = await fetch('/api/version', { credentials: 'same-origin' });
      const version = await versionRes.json();
      if (version.channel === 'beta') {
        btn.disabled = prepareBtn.disabled = true;
        btn.title = prepareBtn.title = 'Developer chat setup is available on the main instance';
        setMsg('Developer chat setup is intentionally disabled on beta (no host or clone access).', true);
        return;
      }
    } catch (e) { /* status failure: let the server endpoint enforce access */ }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setMsg('', true);
      try {
        if (!m.ensureDeveloperProject) throw new Error('Developer project setup is unavailable');
        const builder = await m.ensureDeveloperProject();
        settingsModule.close(); // window.Modals.close(...) never existed - the modal never actually closed (found 2026-07-27)
        // Fresh developer chat in the builder project (pinned skill + clone
        // workspace ride along server-side). Fallback: open its last chat.
        if (m.startProjectChat) {
          await m.startProjectChat(builder.id);
        } else if ((builder.sessions || []).length) {
          const s = await import('./sessions.js');
          await s.selectSession(builder.sessions[0].id);
        }
        prepareMode();
        if (uiModule?.showToast) uiModule.showToast('Developer chat ready — Agent mode and Shell are active.');
      } catch (e) {
        console.warn('start developer chat failed', e);
        setMsg('Could not start a developer chat: ' + e.message, false);
        if (uiModule?.showError) uiModule.showError('Could not start a developer chat');
      } finally {
        btn.disabled = false;
      }
    });
    prepareBtn.addEventListener('click', async () => {
      prepareBtn.disabled = true;
      setMsg('', true);
      try {
        if (!m.ensureDeveloperProject) throw new Error('Developer project setup is unavailable');
        const builder = await m.ensureDeveloperProject();
        if (!m.prepareCurrentProjectChat) throw new Error('Project setup action is unavailable');
        await m.prepareCurrentProjectChat(builder.id);
        prepareMode();
        settingsModule.close(); // window.Modals.close(...) never existed - the modal never actually closed (found 2026-07-27)
        if (uiModule?.showToast) {
          uiModule.showToast('Developer chat ready — Builder project, Agent mode and Shell are active.');
        }
      } catch (e) {
        console.warn('prepare developer chat failed', e);
        setMsg('Could not prepare this chat: ' + e.message, false);
        if (uiModule?.showError) uiModule.showError('Could not prepare this chat');
      } finally {
        prepareBtn.disabled = false;
      }
    });
  } catch (e) { /* projects module unavailable — keep button hidden */ }
}

// ── System check ──
//
// Alessio 2026-08-15: "ein cleanup button der einfach schaut ob alles uptodate
// ist und da ist wo es sein sollte." Deliberately NOT one "fix everything"
// button: the useful part is seeing WHAT is wrong, and a repair you did not
// look at first is how a stale beta gets torn down mid-test.
const _CHECK_STATE_LABEL = { ok: 'OK', warn: 'Check', fail: 'Broken' };

function _renderSelfcheck(data) {
  const list = el('dev-selfcheck-list');
  const summary = el('dev-selfcheck-summary');
  if (!list) return;
  list.textContent = '';
  const findings = data?.findings || [];
  if (summary) {
    const bad = findings.filter(f => f.state !== 'ok').length;
    summary.textContent = !findings.length ? ''
      : bad ? `${bad} of ${findings.length} need a look`
            : `All ${findings.length} checks clean`;
  }
  for (const f of findings) {
    const row = document.createElement('div');
    row.className = `dev-check-row dev-check-${f.state}`;
    const dot = document.createElement('span');
    dot.className = 'dev-check-dot';
    dot.title = _CHECK_STATE_LABEL[f.state] || f.state;
    const body = document.createElement('div');
    body.className = 'dev-check-body';
    const label = document.createElement('div');
    label.className = 'dev-check-label';
    label.textContent = f.label;
    const detail = document.createElement('div');
    detail.className = 'dev-check-detail';
    detail.textContent = f.detail || '';
    body.append(label, detail);
    row.append(dot, body);
    if (f.fix) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-btn-sm dev-check-fix';
      btn.textContent = 'Fix';
      btn.addEventListener('click', () => _runSelfcheckFix(f.fix, btn));
      row.appendChild(btn);
    }
    list.appendChild(row);
  }
}

async function _loadSelfcheck(force = false) {
  const btn = el('dev-selfcheck-run');
  const summary = el('dev-selfcheck-summary');
  const list = el('dev-selfcheck-list');
  if (!list) return;
  if (btn) btn.disabled = true;
  if (summary) summary.textContent = 'checking…';
  try {
    const res = await fetch(`/api/system/selfcheck${force ? '?refresh=1' : ''}`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _renderSelfcheck(await res.json());
  } catch (e) {
    list.textContent = '';
    if (summary) summary.textContent = 'Check failed: ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _runSelfcheckFix(fixId, btn) {
  btn.disabled = true;
  const before = btn.textContent;
  btn.textContent = 'fixing…';
  try {
    const res = await fetch(`/api/system/selfcheck/fix`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fix: fixId }),
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new Error((d && (d.detail || d.message)) || `HTTP ${res.status}`);
    if (uiModule?.showToast) uiModule.showToast(d?.detail || 'Fixed.');
    // Re-check with a forced refresh: the cached snapshot predates the fix and
    // would report the problem as still there.
    await _loadSelfcheck(true);
    _loadDevStatus();
  } catch (e) {
    if (uiModule?.showError) uiModule.showError('Fix failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = before;
  }
}

function _initSelfcheck() {
  const btn = el('dev-selfcheck-run');
  if (!btn || btn._checkWired) return;
  btn._checkWired = true;
  btn.addEventListener('click', () => _loadSelfcheck(true));
  // Not on page load: the probe is a 25 s SSH budget and opening Developer is
  // usually about something else. The button is the trigger.
}

function _initBetaButtons() {
  const startBtn = el('dev-beta-start'), stopBtn = el('dev-beta-stop'), msg = el('dev-beta-msg');
  if (!startBtn || !stopBtn) return;
  // The beta instance has no host access (no SSH keys by design) — these
  // buttons only act from prod, so disable them on the beta itself.
  fetch(`/api/version`, { credentials: 'same-origin' }).then(r => r.json()).then((v) => {
    if (v.channel === 'beta') {
      startBtn.disabled = stopBtn.disabled = true;
      startBtn.title = stopBtn.title = 'Only available on the main instance';
    }
  }).catch(() => {});
  const say = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = ok ? 'admin-success' : 'admin-error';
  };
  // Every path that reports a live beta ends by handing over the address. The
  // status row carries it too, but the person who just pressed Start is looking
  // HERE, and sending them hunting is how the round stalls.
  const sayWithLink = async (text) => {
    say(text, true);
    if (!msg) return;
    try {
      const d = await fetch(`/api/system/status`, { credentials: 'same-origin' }).then(r => r.json());
      if (!d.beta_url) return;
      msg.appendChild(document.createTextNode(' '));
      const link = document.createElement('a');
      link.className = 'dev-beta-link';
      link.href = d.beta_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = d.beta_url.replace(/^https?:\/\//, '');
      msg.appendChild(link);
    } catch (_) { /* the sentence alone is still useful */ }
  };
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    say('', true);
    try {
      const res = await fetch(`/api/system/beta-start`, { method: 'POST', credentials: 'same-origin' });
      const d = await res.json().catch(() => null);
      if (res.ok && d && d.status === 'already_running') {
        await sayWithLink('Beta is already running on :7001 —');
      } else if (res.ok && d && d.status === 'beta_start_requested') {
        say('Beta is starting on dev — the first build takes 2–4 minutes; the status refreshes every 30s (or hit Refresh).', true);
        // Poll until the Beta row flips to live (build can take minutes);
        // stop after ~8 min so an aborted build doesn't poll forever.
        // Once it IS live, hand over the address instead of making the person
        // who just waited four minutes go looking for it.
        let polls = 0;
        const iv = setInterval(async () => {
          await _loadDevStatus();
          try {
            const s = await fetch(`/api/system/status`, { credentials: 'same-origin' }).then(r => r.json());
            if (s.beta_active) {
              clearInterval(iv);
              await sayWithLink('Beta is up —');
              return;
            }
          } catch (_) { /* keep polling */ }
          if (++polls >= 16) clearInterval(iv);
        }, 30000);
      } else {
        say((d && (d.detail || d.message)) || `Beta start failed (status ${res.status})`, false);
      }
    } catch (e) {
      say('Beta start failed: ' + e.message, false);
    }
    startBtn.disabled = false;
  });
  stopBtn.addEventListener('click', async () => {
    if (!confirm('Stop the beta channel? (:7001 goes offline; beta data is kept)')) return;
    stopBtn.disabled = true;
    say('', true);
    try {
      const res = await fetch(`/api/system/beta-stop`, { method: 'POST', credentials: 'same-origin' });
      const d = await res.json().catch(() => null);
      if (res.ok) {
        say('Beta stopped.', true);
        _loadDevStatus();
      } else {
        say((d && (d.detail || d.message)) || `Beta stop failed (status ${res.status})`, false);
      }
    } catch (e) {
      say('Beta stop failed: ' + e.message, false);
    }
    stopBtn.disabled = false;
  });
}

function _initDirectMainButton() {
  const btn = el('dev-direct-main-btn');
  const input = el('dev-direct-main-summary');
  const msg = el('dev-direct-main-msg');
  if (!btn || !input) return;
  const setMsg = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = ok ? 'admin-success' : 'admin-error';
  };
  const submit = async () => {
    const summary = input.value.trim();
    if (summary.length < 3) {
      setMsg('Enter a short bugfix summary first.', false);
      input.focus();
      return;
    }
    btn.disabled = input.disabled = true;
    setMsg('', true);
    try {
      const projectsMod = await import('./projects.js');
      if (!projectsMod.ensureDeveloperProject || !projectsMod.startProjectChat) {
        throw new Error('Developer chat setup is unavailable');
      }
      const builder = await projectsMod.ensureDeveloperProject();
      settingsModule.close();
      await projectsMod.startProjectChat(builder.id);
      if (typeof window.__odysseusPrepareDeveloperMode !== 'function') {
        throw new Error('Developer mode controls are not ready');
      }
      window.__odysseusPrepareDeveloperMode();
      const prompt = `Behebe diesen Bug an Odysseus und rolle ihn über den BUG-Track direkt auf main aus: ${summary}\n\n`
        + `Arbeite autonom bis zur Gate-Frage. Nutze fix/<slug>, dev.sh check und relevante pytest. `
        + `Frage mich dann genau einmal: "Bugfix <slug> direkt auf main?" Erst nach meinem Ja `
        + `dev.sh bugfix fix/<slug>, danach dev.sh finish und den Roadmap-Status aktualisieren. Keine Beta.`;
      const chatMod = await import('./chat.js');
      const textarea = el('message-input');
      if (!textarea || !chatMod.handleChatSubmit) throw new Error('Chat composer is unavailable');
      textarea.value = prompt;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await chatMod.handleChatSubmit();
      input.value = '';
      if (uiModule?.showToast) uiModule.showToast('Direct bugfix sent to the Builder.');
    } catch (error) {
      setMsg('Could not start the direct bugfix: ' + error.message, false);
      btn.disabled = input.disabled = false;
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submit(); }
  });
}

function initDeveloper() {
  if (!el('settings-dev-status-card')) return;
  _initDirectMainButton();
  const addBtn = el('dev-roadmap-add'), input = el('dev-roadmap-new'), typeSel = el('dev-roadmap-type');
  const imgBtn = el('dev-roadmap-img');
  const detailsBtn = el('dev-roadmap-details'), detailsPanel = el('dev-roadmap-new-details');
  const msg = el('dev-roadmap-msg');
  // #dev-roadmap-msg sits BELOW the board, i.e. behind the popup. While the
  // popup is open that is invisible, which is why "Screenshot attached" never
  // reached Alessio. Prefer the in-popup line whenever the popup is showing.
  const _roadmapNote = (text, cls = '') => {
    const modal = el('roadmap-new-modal');
    const inPopup = modal && modal.style.display !== 'none';
    const target = inPopup ? el('dev-roadmap-new-msg') : msg;
    if (!target) return;
    target.textContent = text;
    target.className = cls;
    if (text) setTimeout(() => { if (target.textContent === text) target.textContent = ''; }, 2500);
  };
  detailsBtn?.addEventListener('click', () => {
    const opening = detailsPanel?.classList.contains('hidden');
    detailsPanel?.classList.toggle('hidden');
    detailsBtn.textContent = opening ? 'Hide details' : 'Add details';
    if (opening) el('dev-roadmap-description')?.focus();
  });
  // Screenshots attached to the next entry (bug reports need pictures).
  // Uploaded immediately; the markdown link goes into the entry on Add.
  let pendingImgs = [];
  const _syncImgBtn = () => {
    if (!imgBtn) return;
    imgBtn.style.color = pendingImgs.length ? 'var(--accent, var(--red))' : '';
    imgBtn.title = pendingImgs.length
      ? `${pendingImgs.length} screenshot(s) attached to the next entry`
      : 'Attach a screenshot (or paste one into the text field)';
  };
  const _uploadRoadmapImg = async (file) => {
    const fd = new FormData();
    fd.append('files', file);
    const res = await fetch(`/api/upload`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json();
    const fileId = data.files?.[0]?.id;
    if (!fileId) throw new Error('Upload failed');
    pendingImgs.push(`/api/upload/${fileId}`);
    _syncImgBtn();
    _roadmapNote(`${pendingImgs.length} screenshot(s) attached`);
  };
  if (imgBtn) imgBtn.addEventListener('click', () => {
    const fi = document.createElement('input');
    fi.type = 'file';
    fi.accept = 'image/*';
    fi.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(fi);
    fi.addEventListener('change', async () => {
      const f = fi.files?.[0];
      fi.remove();
      if (f) { try { await _uploadRoadmapImg(f); } catch (_) { _roadmapNote('Upload failed', 'admin-error'); } }
    });
    fi.click();
  });
  const _onRoadmapPaste = async (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        // stopPropagation is the point: app.js has a window-level paste handler
        // that puts any pasted file into the CHAT attach strip. Without this the
        // screenshot went to the chat as well, which is why pasting into the
        // roadmap field looked like it did nothing.
        e.stopPropagation();
        const f = it.getAsFile();
        if (f) { try { await _uploadRoadmapImg(f); } catch (_) { _roadmapNote('Upload failed'); } }
        return;
      }
    }
  };
  // Alessio: "grundsaetzlich ueberall [...] copy paste von Bildern zulassen."
  // Every field of the new-item popup takes a screenshot, not just the title
  // line — a bug report is usually typed into Description, and pasting there
  // used to do nothing at all.
  if (input) input.addEventListener('paste', _onRoadmapPaste);
  for (const id of [
    'dev-roadmap-description', 'dev-roadmap-goal', 'dev-roadmap-acceptance',
    'dev-roadmap-tests', 'dev-roadmap-dependencies', 'dev-roadmap-notes',
  ]) {
    el(id)?.addEventListener('paste', _onRoadmapPaste);
  }
  const doAdd = async () => {
    const text = (input.value || '').trim();
    if (!text && !pendingImgs.length) return;
    // New entries always land in Eingang, tagged by type — the developer
    // sorts them into a version when picking them up.
    const kind = (typeSel && typeSel.value) || 'Idee';
    const rawVersion = el('dev-roadmap-version')?.value?.trim() || '';
    const normalizedVersion = _normalizeRoadmapVersion(rawVersion);
    if (rawVersion && !normalizedVersion) {
      if (msg) {
        msg.textContent = 'Invalid version — example: 3.10';
        msg.className = 'admin-error';
      }
      el('dev-roadmap-version')?.focus();
      return;
    }
    const details = {
      id: _newRoadmapId(),
      description: el('dev-roadmap-description')?.value?.trim() || '',
      goal: el('dev-roadmap-goal')?.value?.trim() || '',
      acceptance: el('dev-roadmap-acceptance')?.value?.trim() || '',
      version: normalizedVersion,
      priority: el('dev-roadmap-priority')?.value || 'Normal',
      dependencies: el('dev-roadmap-dependencies')?.value?.trim() || '',
      notes: el('dev-roadmap-notes')?.value?.trim() || '',
      tests: (el('dev-roadmap-tests')?.value || '').split('\n').map(_rmTestPoint).filter(t => t.text),
    };
    const title = `**${kind}:** ${text || '(Screenshot)'}`;
    // The chosen column decides the marker. Default is Under consideration:
    // a fresh thought is not yet a commitment to build it.
    const colKey = el('dev-roadmap-column')?.value || 'consideration';
    const colMark = (_RM_COLS.find(c => c.key === colKey) || _RM_COLS[0]).mark;
    const entryBlock = _roadmapItemBlock(colMark, title, details, pendingImgs);
    const { lines, sections } = _roadmapSections(_roadmapText);
    const sec = sections.find(s => /^(Eingang|Inbox)/i.test(s.title));
    let ls;
    if (!sec) {
      // Empty/missing file: start a minimal queue with an Eingang section.
      ls = _roadmapText ? _roadmapText.split('\n') : [];
      if (ls.length && ls[ls.length - 1].trim() !== '') ls.push('');
      ls.push('## Inbox', ...entryBlock);
    } else {
      // Insert at the section end, before trailing blank lines.
      let at = sec.end;
      ls = lines.slice();
      while (at > sec.start + 1 && ls[at - 1].trim() === '') at--;
      ls.splice(at, 0, ...entryBlock);
    }
    if (await _saveRoadmap(ls.join('\n'), msg)) {
      input.value = '';
      for (const id of [
        'dev-roadmap-description', 'dev-roadmap-goal', 'dev-roadmap-acceptance',
        'dev-roadmap-version', 'dev-roadmap-dependencies', 'dev-roadmap-notes',
        'dev-roadmap-tests',
      ]) {
        const control = el(id);
        if (control) control.value = '';
      }
      if (el('dev-roadmap-priority')) el('dev-roadmap-priority').value = 'Normal';
      pendingImgs = [];
      _syncImgBtn();
      _closeNewItemModal();
      _renderRoadmap();
    }
  };
  const newModal = el('roadmap-new-modal');
  if (newModal) {
    el('dev-roadmap-new-btn')?.addEventListener('click', () => {
      newModal.style.display = 'flex';
      el('dev-roadmap-new')?.focus();
    });
    el('dev-roadmap-new-close')?.addEventListener('click', _closeNewItemModal);
    newModal.addEventListener('click', (e) => { if (e.target === newModal) _closeNewItemModal(); });
    newModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeNewItemModal(); });
  }
  if (addBtn) addBtn.addEventListener('click', doAdd);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

  // Raw editor for everything the structured view can't express.
  const rawBtn = el('dev-roadmap-raw-btn'), raw = el('dev-roadmap-raw'), rawActions = el('dev-roadmap-raw-actions');
  if (rawBtn) rawBtn.addEventListener('click', () => {
    raw.value = _roadmapText;
    raw.classList.remove('hidden');
    rawActions.classList.remove('hidden');
  });
  const closeRaw = () => { raw.classList.add('hidden'); rawActions.classList.add('hidden'); };
  el('dev-roadmap-raw-save')?.addEventListener('click', async () => {
    if (await _saveRoadmap(raw.value, msg)) { closeRaw(); _renderRoadmap(); }
  });
  el('dev-roadmap-raw-cancel')?.addEventListener('click', closeRaw);

  const bulkVersionInput = el('dev-roadmap-bulk-version');
  const bulkVersionBtn = el('dev-roadmap-bulk-version-apply');
  const applyBulkVersion = async () => {
    if (!bulkVersionBtn) return;
    bulkVersionBtn.disabled = true;
    try {
      const count = await _setAllPlannedVersions(bulkVersionInput?.value);
      if (msg) {
        msg.textContent = count
          ? `${count} planned entries were set to ${_normalizeRoadmapVersion(bulkVersionInput?.value)}.`
          : 'No planned entries found outside released packages.';
        msg.className = 'admin-success';
      }
    } catch (error) {
      if (msg) {
        msg.textContent = error.message;
        msg.className = 'admin-error';
      }
    } finally {
      bulkVersionBtn.disabled = false;
    }
  };
  bulkVersionBtn?.addEventListener('click', applyBulkVersion);
  bulkVersionInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyBulkVersion();
    }
  });
  el('dev-roadmap-refresh')?.addEventListener('click', async (e) => {
    // A successful reload re-renders to something identical, so without a word
    // of feedback the button looks broken. Alessio: "da passiert gar nichts".
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Reloading…';
    _roadmapBuilds = null;
    try {
      await _loadRoadmap();
      if (msg) { msg.textContent = 'Roadmap reloaded.'; msg.className = ''; }
      setTimeout(() => { if (msg && msg.textContent === 'Roadmap reloaded.') msg.textContent = ''; }, 2500);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  el('dev-status-refresh')?.addEventListener('click', () => {
    _loadDevStatus();
    _loadSystemStatus();
    _loadServerMetrics();
  });
  el('dev-server-refresh')?.addEventListener('click', () => _loadServerMetrics(true));
  _initBetaButtons();
  _loadDevStatus();
  _loadServerMetrics();
  _startServerMetricsPolling();
  _loadRoadmap();
  _initSelfcheck();
  _initBuilderLink();
}

/* ── Data Backup (export/import) ── */
function initBackup() {
  el('adm-exportDataBtn').addEventListener('click', async () => {
    const btn = el('adm-exportDataBtn');
    const msg = el('adm-backupMsg');
    btn.disabled = true; btn.textContent = 'Exporting...'; msg.textContent = '';
    try {
      const res = await fetch('/api/export', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename=(.+)/);
      const filename = match ? match[1] : 'odysseus_backup.json';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      msg.textContent = 'Export downloaded.'; msg.className = 'admin-success';
    } catch (e) { msg.textContent = 'Export failed: ' + e.message; msg.className = 'admin-error'; }
    btn.disabled = false; btn.textContent = 'Export Data';
  });

  const fileInput = el('adm-importFile');
  el('adm-importDataBtn').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const msg = el('adm-backupMsg');
    const btn = el('adm-importDataBtn');
    btn.disabled = true; btn.textContent = 'Importing...'; msg.textContent = '';
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '').trim();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('Invalid backup file: ' + e.message);
      }
      const res = await fetch('/api/import', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json().catch(() => null);
      if (!result) {
        throw new Error(`Import failed: server returned ${res.status}`);
      }
      if (res.ok && result.ok) {
        msg.textContent = result.message || 'Import successful.'; msg.className = 'admin-success';
      } else {
        msg.textContent = result.message || result.detail || 'Import failed'; msg.className = 'admin-error';
      }
    } catch (e) { msg.textContent = 'Import failed: ' + e.message; msg.className = 'admin-error'; }
    btn.disabled = false; btn.textContent = 'Import Data';
  });
}

/* ── Danger Zone ── */
function initDangerZone() {
  // Per-category Danger Zone wipes. Each button declares its target
  // via data-wipe-kind; one delegated handler handles double-confirm,
  // POSTs to /api/admin/wipe/{kind}, and writes the result.
  const _LABELS = {
    chats: 'chats', memory: 'memory entries', skills: 'skills',
    notes: 'notes', tasks: 'tasks', documents: 'documents',
    gallery: 'gallery images', calendar: 'calendar items',
  };
  const _wipeMsg = el('adm-wipeMsg');
  modalEl.querySelectorAll('[data-wipe-kind]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.wipeKind;
      const isAll = kind === '__all__';
      const label = isAll ? 'data across every category' : (_LABELS[kind] || kind);
      if (!await uiModule.styledConfirm(`Delete ALL ${label}? This cannot be undone.`, { confirmText: 'Delete', danger: true })) return;
      if (!await uiModule.styledConfirm(`Really delete every one of your ${label}?`, { confirmText: isAll ? 'Yes, delete everything' : 'Yes, delete everything', danger: true })) return;
      btn.disabled = true;
      const prevHtml = btn.innerHTML;
      btn.innerHTML = isAll ? 'Deleting all…' : 'Deleting…';
      if (_wipeMsg) { _wipeMsg.textContent = ''; _wipeMsg.className = ''; }
      try {
        if (isAll) {
          // Iterate every known category. Failures in one shouldn't stop
          // the rest — record per-category counts and surface a summary.
          const kinds = Object.keys(_LABELS);
          const results = [];
          for (const k of kinds) {
            try {
              const r = await fetch(`/api/admin/wipe/${k}`, { method: 'DELETE', credentials: 'same-origin' });
              const d = await r.json().catch(() => ({}));
              results.push({ k, ok: r.ok, count: d.count ?? 0, error: r.ok ? null : (d.detail || 'failed') });
            } catch (e) {
              results.push({ k, ok: false, count: 0, error: e.message });
            }
          }
          const okCount = results.filter(r => r.ok).length;
          const total = results.reduce((n, r) => n + (r.ok ? r.count : 0), 0);
          const fails = results.filter(r => !r.ok).map(r => r.k);
          if (_wipeMsg) {
            if (!fails.length) {
              _wipeMsg.textContent = `Deleted ${total} items across all ${okCount} categories.`;
              _wipeMsg.className = 'admin-success';
            } else {
              _wipeMsg.textContent = `Deleted ${total} items; failed: ${fails.join(', ')}.`;
              _wipeMsg.className = 'admin-error';
            }
          }
        } else {
          const res = await fetch(`/api/admin/wipe/${kind}`, { method: 'DELETE', credentials: 'same-origin' });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            if (_wipeMsg) { _wipeMsg.textContent = `Deleted ${data.count ?? 0} ${label}.`; _wipeMsg.className = 'admin-success'; }
          } else {
            if (_wipeMsg) { _wipeMsg.textContent = data.detail || 'Failed'; _wipeMsg.className = 'admin-error'; }
          }
        }
      } catch (e) {
        if (_wipeMsg) { _wipeMsg.textContent = 'Request failed: ' + e.message; _wipeMsg.className = 'admin-error'; }
      }
      btn.disabled = false; btn.innerHTML = prevHtml;
    });
  });
}

/* ═══════════════════════════════════════════
   TERMINAL LOGS VIEWER
   ═══════════════════════════════════════════ */
let logsPollInterval = null;
let isLogsPolling = false;
let cachedLogs = [];
let logsAbortController = null;

function renderLogs(isAutoPoll = false) {
  const consoleContainer = el('log-console-container');
  const levelSelect = el('log-level-select');
  const searchInput = el('log-search-input');

  if (!consoleContainer) return;

  const levelFilter = levelSelect ? levelSelect.value : 'ALL';
  const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';

  let logs = cachedLogs;

  // Filter by level locally
  if (levelFilter !== 'ALL') {
    logs = logs.filter(line => line.includes(` - ${levelFilter} - `));
  }

  // Filter by search query locally
  if (searchQuery) {
    logs = logs.filter(line => line.toLowerCase().includes(searchQuery));
  }

  if (logs.length === 0) {
    consoleContainer.innerHTML = '<div class="settings-system-logs-placeholder">No logs found matching current filters.</div>';
    return;
  }

  // Preserve scroll position if user is reading previous logs
  const atBottom = consoleContainer.scrollHeight - consoleContainer.scrollTop - consoleContainer.clientHeight < 40;

  consoleContainer.innerHTML = logs.map(line => {
    let levelClass = 'log-line-default';

    if (line.includes(' - INFO - ')) {
      levelClass = 'log-line-info';
    } else if (line.includes(' - WARNING - ')) {
      levelClass = 'log-line-warning';
    } else if (line.includes(' - ERROR - ') || line.includes(' - CRITICAL - ')) {
      levelClass = 'log-line-error';
    } else if (line.includes(' - DEBUG - ')) {
      levelClass = 'log-line-debug';
    }

    // XSS safe escape
    const escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    return `<div class="log-line ${levelClass}">${escaped}</div>`;
  }).join('');

  if (!isAutoPoll || atBottom) {
    consoleContainer.scrollTop = consoleContainer.scrollHeight;
  }
}

async function loadLogs(isAutoPoll = false) {
  const consoleContainer = el('log-console-container');
  const limitSelect = el('log-limit-select');

  if (!consoleContainer) return;

  const limit = limitSelect ? limitSelect.value : 200;

  if (logsAbortController) {
    logsAbortController.abort();
  }
  logsAbortController = new AbortController();
  const { signal } = logsAbortController;

  try {
    const res = await fetch(`/api/diagnostics/logs?limit=${limit}`, {
      credentials: 'same-origin',
      signal
    });

    if (!res.ok) {
      if (!isAutoPoll) {
        consoleContainer.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.style.color = 'var(--red)';
        errDiv.style.fontWeight = '600';
        errDiv.textContent = `Failed to load logs: HTTP ${res.status}`;
        consoleContainer.appendChild(errDiv);
      }
      return;
    }

    const data = await res.json();
    if (data.status !== 'success' || !data.logs) {
      if (!isAutoPoll) {
        consoleContainer.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.style.color = 'var(--red)';
        errDiv.style.fontWeight = '600';
        errDiv.textContent = 'Failed to parse logs data';
        consoleContainer.appendChild(errDiv);
      }
      return;
    }

    cachedLogs = data.logs;
    renderLogs(isAutoPoll);
  } catch (err) {
    if (err.name === 'AbortError') {
      return; // Silently ignore deliberate abort
    }
    if (!isAutoPoll) {
      consoleContainer.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.style.color = 'var(--red)';
      errDiv.style.fontWeight = '600';
      errDiv.textContent = `Error retrieving logs: ${err.message}`;
      consoleContainer.appendChild(errDiv);
    }
  } finally {
    if (logsAbortController?.signal === signal) {
      logsAbortController = null;
    }
  }
}

function startLogsPolling() {
  if (isLogsPolling) return;
  isLogsPolling = true;
  const toggle = el('log-auto-refresh-toggle');
  if (toggle) toggle.checked = true;

  logsPollInterval = setInterval(() => {
    const modal = el('settings-modal');
    const systemPanel = el('settings-modal')?.querySelector('[data-settings-panel="system"]');

    // Safe self-cleanup if modal or panel is hidden/closed
    if (!modal || modal.classList.contains('hidden') || !systemPanel || systemPanel.classList.contains('hidden')) {
      stopLogsPolling();
      return;
    }

    loadLogs(true);
  }, 3000);
}

function stopLogsPolling() {
  if (!isLogsPolling) return;
  isLogsPolling = false;
  if (logsPollInterval) {
    clearInterval(logsPollInterval);
    logsPollInterval = null;
  }
  const toggle = el('log-auto-refresh-toggle');
  if (toggle) toggle.checked = false;
}

function initLogsView() {
  const refreshBtn = el('log-refresh-btn');
  const levelSelect = el('log-level-select');
  const limitSelect = el('log-limit-select');
  const searchInput = el('log-search-input');
  const autoRefreshToggle = el('log-auto-refresh-toggle');

  if (refreshBtn) refreshBtn.addEventListener('click', () => loadLogs(false));
  if (levelSelect) levelSelect.addEventListener('change', () => renderLogs(false));
  if (limitSelect) limitSelect.addEventListener('change', () => loadLogs(false));
  if (searchInput) searchInput.addEventListener('input', () => renderLogs(false));

  if (autoRefreshToggle) {
    autoRefreshToggle.addEventListener('change', (e) => {
      if (e.target.checked) {
        startLogsPolling();
      } else {
        stopLogsPolling();
      }
    });
  }

  // Initial fetch on view loading
  loadLogs(false);
}

/* ═══════════════════════════════════════════
   INIT & REFRESH
   ═══════════════════════════════════════════ */
function initAll() {
  modalEl = el('settings-modal');
  const inits = [
    initSignupToggle, initShareDefaultsToggle, initAddUser, initEndpointForm, initMcpForm,
    initCalDAV, initSystemStatus, initDeveloper, initBackup, initDangerZone, initTokenForm, initLogsView,
    () => settingsModule.initIntegrations()
  ];
  for (const fn of inits) {
    try { fn(); } catch (e) { console.error('Admin init error in', fn.name || 'anonymous', e); }
  }
  initialized = true;
  refreshAll();
}

function refreshAll() {
  loadUsers();
  loadEndpoints();
  loadBuiltinTools();
  loadMcpServers();
  loadTokens();
  loadLogs(false);
}

/* ═══════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════ */
export function _initData() {
  if (!initialized) initAll();
  else refreshAll();
}

export function initDeveloperPage() {
  // Fall through rather than return: on the FIRST call initAll() wires the
  // admin surface, but none of the Developer-page loads below. Opening
  // Developer is usually the first admin action of a session, so returning
  // here left the version dropdown stuck on its "versions…" placeholder until
  // you happened to open the page a second time — and that dropdown is the
  // downgrade button. Every call below is safe to repeat: the loads are plain
  // fetches, metrics polling has its own guard, and the switcher attaches its
  // listeners once (btn._switcherWired).
  if (!initialized) initAll();
  _loadDevStatus();
  _loadServerMetrics();
  _startServerMetricsPolling();
  _loadRoadmap();
  _initSelfcheck();
  _initVersionSwitcher('dev-');
}

export function open(tab) {
  _initData();
  settingsModule.open(tab || 'services');
}

export function close() {
  stopLogsPolling();
  settingsModule.close();
}

const adminModule = {
  open,
  close,
  _initData,
  initDeveloperPage,
  get _initialized() { return initialized; },
};
export default adminModule;
