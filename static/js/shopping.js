/**
 * Shopping & Recipes Module — its own tool window (NOT part of Notes).
 *
 * Two tabs: "Shopping" (checkable list, duplicate-merging add, share
 * toggle) and "Recipes" (cards with image/instructions/ingredients and a
 * prominent "Add to shopping list" button; server merges duplicates).
 * Sharing v1 lives in Settings (per-user switches): a user can share
 * their whole shopping list and/or recipe collection with all accounts. Follows the pomodoro.js
 * tool-window pattern: lazy modal + makeWindowDraggable + modalManager.
 */

import { makeWindowDraggable } from './windowDrag.js';
import * as Modals from './modalManager.js';
import uiModule from './ui.js';

const API_BASE = window.location.origin;

// Small fetch wrapper — every endpoint here is same-origin JSON.
async function _api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

// Shared by the photo button and paste-into-instructions: upload one image
// file, return its /api/upload URL (or null).
async function _uploadImage(file) {
  const fd = new FormData();
  fd.append('files', file);
  try {
    const d = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, credentials: 'same-origin' }).then(r => r.json());
    const id = d.files && d.files[0] && d.files[0].id;
    return id ? `/api/upload/${id}` : null;
  } catch (e) {
    return null;
  }
}

let _modal = null;
let _open = false;
let _tab = 'shopping';       // 'shopping' | 'recipes'
let _items = [];
let _listShared = false;
let _recipes = [];
let _editingRecipe = null;   // recipe object being edited, or {} for new, or null
let _doneOpen = false;       // "In the cart" section collapsed by default

// Canonical escaper from ui.js (same wrapper as notes.js/admin.js use).
function _esc(s) {
  return uiModule.esc ? uiModule.esc(s == null ? '' : String(s)) : String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Data ──

async function _loadShopping() {
  try {
    const d = await _api('/api/shopping');
    _items = d.items || [];
    _listShared = !!d.list_shared;
  } catch { _items = []; }
}

async function _loadRecipes() {
  try {
    const d = await _api('/api/recipes');
    _recipes = d.recipes || [];
  } catch { _recipes = []; }
}

// ── Window ──

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'shopping-modal';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content shopping-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>Shopping</h4>
        <div class="shopping-tabs" id="shopping-tabs">
          <button type="button" class="shopping-tab active" data-tab="shopping">Shopping</button>
          <button type="button" class="shopping-tab" data-tab="recipes">Recipes</button>
        </div>
        <button type="button" class="shopping-header-icon-btn" id="shopping-share-btn" title="Sharing is configured in Settings — click to jump there">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="close-btn" id="shopping-close">✖</button>
      </div>
      <div class="modal-body shopping-body" id="shopping-body"></div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#shopping-close').addEventListener('click', closeShopping);
  // Share shortcut — sharing lives in Settings (both switches); jump there
  // and flash the card so it's findable.
  _modal.querySelector('#shopping-share-btn').addEventListener('click', () => {
    import('./settings.js').then((m) => {
      (m.default || m).open('account');
      setTimeout(() => {
        const card = document.getElementById('set-shoppingShareToggle')?.closest('.admin-card');
        if (card) {
          card.scrollIntoView({ block: 'center', behavior: 'smooth' });
          card.style.transition = 'box-shadow 0.3s';
          card.style.boxShadow = '0 0 0 2px var(--accent, var(--red))';
          setTimeout(() => { card.style.boxShadow = ''; }, 1800);
        }
      }, 150);
    }).catch(() => {});
  });
  _modal.addEventListener('click', (e) => { if (e.target === _modal) closeShopping(); });
  _modal.querySelector('#shopping-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.shopping-tab');
    if (!btn || btn.dataset.tab === _tab) return;
    _tab = btn.dataset.tab;
    _editingRecipe = null;
    _modal.querySelectorAll('.shopping-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === _tab));
    _render();
  });
  const content = _modal.querySelector('.shopping-modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

// ── Shopping tab ──

function _renderShopping(body) {
  const open = _items.filter(i => !i.done);
  const done = _items.filter(i => i.done);
  const row = (i) => `
    <div class="shopping-item${i.done ? ' done' : ''}" data-id="${_esc(i.id)}">
      <button type="button" class="shopping-check" title="${i.done ? 'Uncheck' : 'Check off'}"></button>
      <span class="shopping-item-text">${_esc(i.text)}</span>
      ${!i.mine ? `<span class="shopping-item-owner" title="From a shared list">${_esc(i.owner || '')}</span>` : ''}
      <button type="button" class="shopping-item-rm" title="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  body.innerHTML = `
    <div class="shopping-add-row">
      <input type="text" id="shopping-add-input" class="styled-prompt-input" placeholder="+ Add an item (duplicates merge)" autocomplete="off" style="flex:1;min-width:0;margin:0;" />
    </div>
    <div class="shopping-list">${open.map(row).join('') || '<div class="shopping-empty">Nothing to buy — add items above or open a recipe.</div>'}</div>
    ${done.length ? `
      <div class="shopping-done-head${_doneOpen ? ' open' : ''}" id="shopping-done-head" role="button" tabindex="0" title="${_doneOpen ? 'Hide' : 'Show'} checked-off items">
        <span><svg class="shopping-done-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>In the cart · ${done.length}</span>
        <button type="button" class="shopping-text-btn" id="shopping-clear-done">Clear</button>
      </div>
      ${_doneOpen ? `<div class="shopping-list shopping-list-done">${done.map(row).join('')}</div>` : ''}` : ''}`;

  const input = body.querySelector('#shopping-add-input');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      // The POST returns the created/merged row — patch locally instead
      // of refetching the whole list per Enter press.
      const d = await _api('/api/shopping', { method: 'POST', body: { text } });
      if (d && d.item) {
        const i = _items.findIndex(x => x.id === d.item.id);
        if (i >= 0) _items[i] = d.item; else _items.unshift(d.item);
      }
    } catch (err) { await _loadShopping(); }
    _render();
    body.querySelector('#shopping-add-input')?.focus();
  });

  body.querySelectorAll('.shopping-item').forEach(el => {
    const id = el.dataset.id;
    el.querySelector('.shopping-check').addEventListener('click', async () => {
      const item = _items.find(i => i.id === id);
      if (!item) return;
      item.done = !item.done;
      _render();
      await _api(`/api/shopping/${id}`, { method: 'PATCH', body: { done: item.done } }).catch(() => {});
    });
    el.querySelector('.shopping-item-rm').addEventListener('click', async () => {
      _items = _items.filter(i => i.id !== id);
      _render();
      await _api(`/api/shopping/${id}`, { method: 'DELETE' }).catch(() => {});
    });
  });

  const doneHead = body.querySelector('#shopping-done-head');
  if (doneHead) {
    const toggle = () => { _doneOpen = !_doneOpen; _render(); };
    doneHead.addEventListener('click', (e) => {
      if (e.target.closest('#shopping-clear-done')) return;
      toggle();
    });
    doneHead.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  body.querySelector('#shopping-clear-done')?.addEventListener('click', async () => {
    _items = _items.filter(i => !i.done || !i.mine);
    _render();
    await _api('/api/shopping/clear-done', { method: 'POST' }).catch(() => {});
  });

}

// Instructions may embed pasted screenshots as markdown image links —
// render those (upload-URLs only), everything else stays escaped text.
function _instrHtml(t) {
  return _esc(t).replace(
    /!\[[^\]]*\]\((\/api\/upload\/[A-Za-z0-9_-]+)\)/g,
    '<img class="recipe-instr-img" src="$1" alt="" draggable="false" />',
  );
}

// ── Recipes tab ──

function _renderRecipes(body) {
  if (_editingRecipe) return _renderRecipeForm(body, _editingRecipe);
  const card = (r) => `
    <div class="recipe-card" data-id="${_esc(r.id)}">
      ${r.image_url ? `<img class="recipe-card-img" src="${_esc(r.image_url)}" alt="" draggable="false" />` : ''}
      <div class="recipe-card-main">
        <div class="recipe-card-title">${_esc(r.title || '(untitled recipe)')}
          ${!r.mine ? `<span class="recipe-shared-pill" title="Shared by this user">${_esc(r.owner || '')}</span>` : ''}
        </div>
        <div class="recipe-card-sub">${(r.ingredients || []).length} ingredient${(r.ingredients || []).length === 1 ? '' : 's'}</div>
        ${(r.instructions || '').trim() ? `<div class="recipe-card-instructions">${_instrHtml(r.instructions)}</div>` : ''}
        ${(r.ingredients || []).length ? `<div class="recipe-ingredients">${r.ingredients.map((z, i) => `
          <div class="recipe-ing${z.done ? ' done' : ''}" data-idx="${i}">
            <button type="button" class="shopping-check" title="Check off while cooking"></button>
            <span class="recipe-ing-text">${_esc(z.text)}</span>
          </div>`).join('')}</div>` : ''}
      </div>
      <div class="recipe-card-actions">
        <button type="button" class="pomo-btn pomo-primary recipe-to-shopping" title="Every ingredient becomes one item on your shopping list">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>Add to shopping list
        </button>
        <button type="button" class="shopping-text-btn recipe-edit" title="${r.mine ? 'Edit' : 'Shared recipes may be edited by everyone'}">Edit</button>
        ${r.mine ? `<button type="button" class="shopping-text-btn recipe-delete">Delete</button>` : ''}
      </div>
    </div>`;
  body.innerHTML = `
    <div class="shopping-add-row">
      <button type="button" class="pomo-btn" id="recipe-new">+ New recipe</button>
    </div>
    <div class="recipe-grid">${_recipes.map(card).join('') || '<div class="shopping-empty">No recipes yet — create your first one.</div>'}</div>`;

  body.querySelector('#recipe-new').addEventListener('click', () => {
    _editingRecipe = {};
    _render();
  });
  body.querySelectorAll('.recipe-card').forEach(el => {
    const id = el.dataset.id;
    const rec = _recipes.find(r => r.id === id);
    el.querySelector('.recipe-to-shopping').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await _api(`/api/recipes/${id}/to-shopping`, { method: 'POST' });
        btn.textContent = `${res.added} added${res.merged ? `, ${res.merged} merged` : ''}`;
        setTimeout(() => { _render(); }, 1400);
        await _loadShopping();
      } catch { btn.disabled = false; }
    });
    // Cooking mode: tick ingredients off directly on the card (shared
    // recipes: everyone may tick/edit — server checks the share pref).
    // Toggle the one row in place — a full re-render would re-decode every
    // recipe image per click.
    el.querySelectorAll('.recipe-ing .shopping-check:not([disabled])').forEach(cb => {
      cb.addEventListener('click', async () => {
        const row = cb.closest('.recipe-ing');
        const idx = Number(row.dataset.idx);
        try {
          const d = await _api(`/api/recipes/${id}/ingredients/${idx}/toggle`, { method: 'POST' });
          if (rec && Array.isArray(d.ingredients)) rec.ingredients = d.ingredients;
          row.classList.toggle('done', !!(d.ingredients && d.ingredients[idx] && d.ingredients[idx].done));
        } catch (err) { /* keep current state */ }
      });
    });
    el.querySelector('.recipe-edit')?.addEventListener('click', () => {
      _editingRecipe = { ...rec };
      _render();
    });
    el.querySelector('.recipe-delete')?.addEventListener('click', async () => {
      _recipes = _recipes.filter(r => r.id !== id);
      _render();
      await _api(`/api/recipes/${id}`, { method: 'DELETE' }).catch(() => {});
    });
  });
}

function _renderRecipeForm(body, rec) {
  const isNew = !rec.id;
  body.innerHTML = `
    <div class="recipe-form">
      <input type="text" id="recipe-f-title" class="styled-prompt-input" placeholder="Recipe title" value="${_esc(rec.title || '')}" style="margin:0;" />
      <textarea id="recipe-f-instructions" class="styled-prompt-input" rows="5" placeholder="Instructions (markdown works)…" style="margin:0;resize:vertical;">${_esc(rec.instructions || '')}</textarea>
      <div class="recipe-f-ingredients" id="recipe-f-ingredients"></div>
      <div class="shopping-add-row" style="gap:8px;align-items:center;">
        <button type="button" class="shopping-text-btn" id="recipe-f-photo">${rec.image_url ? 'Change photo' : 'Attach photo'}</button>
        ${rec.image_url ? `<img src="${_esc(rec.image_url)}" style="height:34px;border-radius:6px;border:1px solid var(--border);" alt="" />` : ''}
        <span style="flex:1"></span>
        <button type="button" class="shopping-text-btn" id="recipe-f-cancel">Cancel</button>
        <button type="button" class="pomo-btn pomo-primary" id="recipe-f-save">Save</button>
      </div>
    </div>`;

  body.querySelector('#recipe-f-photo').addEventListener('click', () => {
    const fi = document.createElement('input');
    fi.type = 'file';
    fi.accept = 'image/*';
    fi.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(fi);
    fi.addEventListener('change', async () => {
      const f = fi.files && fi.files[0];
      fi.remove();
      if (!f) return;
      const url = await _uploadImage(f);
      if (url) {
        rec.image_url = url;
        // keep current field values across the re-render
        rec.title = body.querySelector('#recipe-f-title').value;
        rec.instructions = body.querySelector('#recipe-f-instructions').value;
        rec.ingredients = _collectIngredients();
        _render();
      }
    });
    fi.click();
  });
  // Ingredient editor = real todo-style rows (Enter appends the next row,
  // X removes, done-circles carry the cooking state) — not a bare textarea.
  const ingWrap = body.querySelector('#recipe-f-ingredients');
  const ingRows = () => Array.from(ingWrap.querySelectorAll('.recipe-f-ing-row'));
  const _collectIngredients = () => ingRows()
    .map(r => ({ text: r.querySelector('input[type="text"]').value.trim(), done: r.dataset.done === '1' }))
    .filter(i => i.text);
  const addIngRow = (ing, focus) => {
    const row = document.createElement('div');
    row.className = 'recipe-f-ing-row';
    row.dataset.done = ing && ing.done ? '1' : '0';
    row.innerHTML = `
      <span class="shopping-check${ing && ing.done ? ' checked' : ''}" aria-hidden="true"></span>
      <input type="text" placeholder="e.g. 200ml Milch" value="${_esc((ing && (ing.text || ing)) || '')}" />
      <button type="button" class="recipe-f-ing-rm" title="Remove ingredient">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    const input = row.querySelector('input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addIngRow(null, true);
      } else if (e.key === 'Backspace' && !input.value && ingRows().length > 1) {
        e.preventDefault();
        const prev = row.previousElementSibling;
        row.remove();
        prev?.querySelector('input')?.focus();
      }
    });
    row.querySelector('.recipe-f-ing-rm').addEventListener('click', () => {
      row.remove();
      if (!ingRows().length) addIngRow(null, true);
    });
    ingWrap.appendChild(row);
    if (focus) input.focus();
  };
  const _initialIngs = (rec.ingredients && rec.ingredients.length) ? rec.ingredients : [null];
  _initialIngs.forEach(i => addIngRow(i, false));

  // Paste a screenshot straight into the instructions — uploads it and
  // drops a markdown image link at the cursor (rendered on the card).
  const instrTa = body.querySelector('#recipe-f-instructions');
  instrTa.addEventListener('paste', async (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        e.preventDefault();
        const f = it.getAsFile();
        if (!f) return;
        const url = await _uploadImage(f);
        if (url) {
          const md = `\n![bild](${url})\n`;
          const at = instrTa.selectionStart != null ? instrTa.selectionStart : instrTa.value.length;
          instrTa.value = instrTa.value.slice(0, at) + md + instrTa.value.slice(at);
          instrTa.setSelectionRange(at + md.length, at + md.length);
        }
        return;
      }
    }
  });
  body.querySelector('#recipe-f-cancel').addEventListener('click', () => { _editingRecipe = null; _render(); });
  body.querySelector('#recipe-f-save').addEventListener('click', async () => {
    const payload = {
      title: body.querySelector('#recipe-f-title').value.trim(),
      instructions: body.querySelector('#recipe-f-instructions').value,
      ingredients: _collectIngredients(),
      image_url: rec.image_url || null,
    };
    const url = isNew ? `${API_BASE}/api/recipes` : `${API_BASE}/api/recipes/${rec.id}`;
    await fetch(url, {
      method: isNew ? 'POST' : 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
    _editingRecipe = null;
    await _loadRecipes();
    _render();
  });
}

// ── Render / open / close ──

function _render() {
  if (!_modal || !_open) return;
  const body = _modal.querySelector('#shopping-body');
  if (_tab === 'shopping') _renderShopping(body);
  else _renderRecipes(body);
}

export async function openShopping() {
  const modal = _getModal();
  if (_open) { modal.style.display = 'flex'; return; }
  _open = true;
  Modals.register('shopping-modal', {
    sidebarBtnId: 'tool-shopping-btn',
    closeFn: () => closeShopping(),
    restoreFn: () => { if (!_open) openShopping(); },
  });
  modal.style.display = 'flex';
  document.getElementById('tool-shopping-btn')?.classList.add('active');
  await Promise.all([_loadShopping(), _loadRecipes()]);
  _render();
}

export function closeShopping() {
  if (!_modal) return;
  _open = false;
  _modal.style.display = 'none';
  document.getElementById('tool-shopping-btn')?.classList.remove('active');
}

export function isShoppingOpen() { return _open; }

const shoppingModule = { openShopping, closeShopping, isShoppingOpen };
export default shoppingModule;
