/**
 * Shopping & Recipes Module — its own tool window (NOT part of Notes).
 *
 * Two tabs: "Shopping" (checkable list, duplicate-merging add, share
 * toggle) and "Recipes" (cards with image/instructions/ingredients and a
 * prominent "Add to shopping list" button; server merges duplicates).
 * Sharing v1: a shared recipe is visible to every account; a shared
 * shopping list can be seen/checked by everyone. Follows the pomodoro.js
 * tool-window pattern: lazy modal + makeWindowDraggable + modalManager.
 */

import { makeWindowDraggable } from './windowDrag.js';
import * as Modals from './modalManager.js';

const API_BASE = window.location.origin;

let _modal = null;
let _open = false;
let _tab = 'shopping';       // 'shopping' | 'recipes'
let _items = [];
let _listShared = false;
let _recipes = [];
let _editingRecipe = null;   // recipe object being edited, or {} for new, or null

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Data ──

async function _loadShopping() {
  try {
    const d = await fetch(`${API_BASE}/api/shopping`, { credentials: 'same-origin' }).then(r => r.json());
    _items = d.items || [];
    _listShared = !!d.list_shared;
  } catch { _items = []; }
}

async function _loadRecipes() {
  try {
    const d = await fetch(`${API_BASE}/api/recipes`, { credentials: 'same-origin' }).then(r => r.json());
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
        <button class="close-btn" id="shopping-close" style="margin-left:auto;">✖</button>
      </div>
      <div class="modal-body shopping-body" id="shopping-body"></div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#shopping-close').addEventListener('click', closeShopping);
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
      <div class="shopping-done-head"><span>In the cart · ${done.length}</span>
        <button type="button" class="shopping-text-btn" id="shopping-clear-done">Clear</button>
      </div>
      <div class="shopping-list shopping-list-done">${done.map(row).join('')}</div>` : ''}
    <label class="shopping-share-row" title="Everyone with an account sees and checks this list">
      <input type="checkbox" id="shopping-share-toggle" ${_listShared ? 'checked' : ''} />
      <span>Share my list with all accounts</span>
    </label>`;

  const input = body.querySelector('#shopping-add-input');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await fetch(`${API_BASE}/api/shopping`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    await _loadShopping();
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
      await fetch(`${API_BASE}/api/shopping/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: item.done }),
      }).catch(() => {});
    });
    el.querySelector('.shopping-item-rm').addEventListener('click', async () => {
      _items = _items.filter(i => i.id !== id);
      _render();
      await fetch(`${API_BASE}/api/shopping/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    });
  });

  body.querySelector('#shopping-clear-done')?.addEventListener('click', async () => {
    _items = _items.filter(i => !i.done || !i.mine);
    _render();
    await fetch(`${API_BASE}/api/shopping/clear-done`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    await _loadShopping();
    _render();
  });

  body.querySelector('#shopping-share-toggle').addEventListener('change', async (e) => {
    _listShared = e.target.checked;
    await fetch(`${API_BASE}/api/shopping/share`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shared: _listShared }),
    }).catch(() => {});
  });
}

// ── Recipes tab ──

function _renderRecipes(body) {
  if (_editingRecipe) return _renderRecipeForm(body, _editingRecipe);
  const card = (r) => `
    <div class="recipe-card" data-id="${_esc(r.id)}">
      ${r.image_url ? `<img class="recipe-card-img" src="${_esc(r.image_url)}" alt="" draggable="false" />` : ''}
      <div class="recipe-card-main">
        <div class="recipe-card-title">${_esc(r.title || '(untitled recipe)')}
          ${r.is_shared ? '<span class="recipe-shared-pill" title="Visible to all accounts">shared</span>' : ''}
          ${!r.mine ? `<span class="recipe-shared-pill" title="Shared by this user">${_esc(r.owner || '')}</span>` : ''}
        </div>
        <div class="recipe-card-sub">${(r.ingredients || []).length} ingredient${(r.ingredients || []).length === 1 ? '' : 's'}</div>
        ${(r.instructions || '').trim() ? `<div class="recipe-card-instructions">${_esc(r.instructions)}</div>` : ''}
        ${(r.ingredients || []).length ? `<ul class="recipe-card-ingredients">${r.ingredients.map(z => `<li>${_esc(z)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="recipe-card-actions">
        <button type="button" class="pomo-btn pomo-primary recipe-to-shopping" title="Every ingredient becomes one item on your shopping list">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>Add to shopping list
        </button>
        ${r.mine ? `
        <button type="button" class="shopping-text-btn recipe-edit">Edit</button>
        <button type="button" class="shopping-text-btn recipe-delete">Delete</button>` : ''}
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
        const res = await fetch(`${API_BASE}/api/recipes/${id}/to-shopping`, {
          method: 'POST', credentials: 'same-origin',
        }).then(r => r.json());
        btn.textContent = `${res.added} added${res.merged ? `, ${res.merged} merged` : ''}`;
        setTimeout(() => { _render(); }, 1400);
        await _loadShopping();
      } catch { btn.disabled = false; }
    });
    el.querySelector('.recipe-edit')?.addEventListener('click', () => {
      _editingRecipe = { ...rec };
      _render();
    });
    el.querySelector('.recipe-delete')?.addEventListener('click', async () => {
      _recipes = _recipes.filter(r => r.id !== id);
      _render();
      await fetch(`${API_BASE}/api/recipes/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    });
  });
}

function _renderRecipeForm(body, rec) {
  const isNew = !rec.id;
  body.innerHTML = `
    <div class="recipe-form">
      <input type="text" id="recipe-f-title" class="styled-prompt-input" placeholder="Recipe title" value="${_esc(rec.title || '')}" style="margin:0;" />
      <textarea id="recipe-f-instructions" class="styled-prompt-input" rows="5" placeholder="Instructions (markdown works)…" style="margin:0;resize:vertical;">${_esc(rec.instructions || '')}</textarea>
      <textarea id="recipe-f-ingredients" class="styled-prompt-input" rows="5" placeholder="Ingredients — one per line, e.g.&#10;200ml Milch&#10;2 Eier&#10;Mehl" style="margin:0;resize:vertical;">${_esc((rec.ingredients || []).join('\n'))}</textarea>
      <div class="shopping-add-row" style="gap:8px;align-items:center;">
        <button type="button" class="shopping-text-btn" id="recipe-f-photo">${rec.image_url ? 'Change photo' : 'Attach photo'}</button>
        ${rec.image_url ? `<img src="${_esc(rec.image_url)}" style="height:34px;border-radius:6px;border:1px solid var(--border);" alt="" />` : ''}
        <label class="shopping-share-row" style="margin:0;padding:0;border:0;">
          <input type="checkbox" id="recipe-f-shared" ${rec.is_shared ? 'checked' : ''} />
          <span>Share with all accounts</span>
        </label>
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
      const fd = new FormData();
      fd.append('files', f);
      try {
        const d = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, credentials: 'same-origin' }).then(r => r.json());
        const id = d.files && d.files[0] && d.files[0].id;
        if (id) {
          rec.image_url = `/api/upload/${id}`;
          // keep current field values across the re-render
          rec.title = body.querySelector('#recipe-f-title').value;
          rec.instructions = body.querySelector('#recipe-f-instructions').value;
          rec.ingredients = body.querySelector('#recipe-f-ingredients').value.split('\n').map(s => s.trim()).filter(Boolean);
          rec.is_shared = body.querySelector('#recipe-f-shared').checked;
          _render();
        }
      } catch { /* upload failed — keep editing */ }
    });
    fi.click();
  });
  body.querySelector('#recipe-f-cancel').addEventListener('click', () => { _editingRecipe = null; _render(); });
  body.querySelector('#recipe-f-save').addEventListener('click', async () => {
    const payload = {
      title: body.querySelector('#recipe-f-title').value.trim(),
      instructions: body.querySelector('#recipe-f-instructions').value,
      ingredients: body.querySelector('#recipe-f-ingredients').value.split('\n').map(s => s.trim()).filter(Boolean),
      image_url: rec.image_url || null,
      is_shared: body.querySelector('#recipe-f-shared').checked,
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
