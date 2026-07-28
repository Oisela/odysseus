// Dedicated Developer workspace.
//
// The roadmap/deployment controls historically lived inside Settings. Move
// that same DOM panel into this window instead of cloning it, so its IDs,
// event handlers, and server-backed state continue to have one owner.

import adminModule from './admin.js';
import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';

let modalEl = null;
let isOpen = false;

function getModal() {
  if (modalEl) return modalEl;

  const panel = document.querySelector('[data-settings-panel="developer"]');
  if (!panel) {
    console.error('Developer panel is missing');
    return null;
  }

  modalEl = document.createElement('div');
  modalEl.id = 'developer-modal';
  modalEl.className = 'modal';
  modalEl.style.display = 'none';
  modalEl.innerHTML = `
    <div class="modal-content developer-modal-content" role="dialog" aria-label="Developer">
      <div class="modal-header">
        <h4>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round"
               stroke-linejoin="round" aria-hidden="true">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
          Developer
        </h4>
        <span class="developer-header-spacer"></span>
        <button class="close-btn" type="button" aria-label="Close developer">&#10006;</button>
      </div>
      <div class="modal-body developer-body"></div>
    </div>`;

  panel.classList.remove('hidden');
  panel.classList.add('developer-page-panel');
  modalEl.querySelector('.developer-body').appendChild(panel);
  document.body.appendChild(modalEl);

  modalEl.querySelector('.close-btn').addEventListener('click', closeDeveloper);
  modalEl.addEventListener('click', event => {
    if (event.target === modalEl) closeDeveloper();
  });

  const content = modalEl.querySelector('.developer-modal-content');
  const header = modalEl.querySelector('.modal-header');
  makeWindowDraggable(modalEl, {
    content,
    header,
    skipSelector: 'button',
    enableDock: true,
  });
  return modalEl;
}

export function openDeveloper() {
  const modal = getModal();
  if (!modal) return;
  if (!isOpen) {
    isOpen = true;
    Modals.register('developer-modal', {
      sidebarBtnId: 'tool-developer-btn',
      label: 'Developer',
      icon: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
      closeFn: closeDeveloper,
      restoreFn: () => { if (!isOpen) openDeveloper(); },
    });
  }
  modal.style.display = 'flex';
  document.getElementById('tool-developer-btn')?.classList.add('active');
  adminModule.initDeveloperPage();
}

export function closeDeveloper() {
  if (!modalEl) return;
  isOpen = false;
  modalEl.style.display = 'none';
  document.getElementById('tool-developer-btn')?.classList.remove('active');
}

export function isDeveloperOpen() {
  return isOpen;
}

const developerModule = { openDeveloper, closeDeveloper, isDeveloperOpen };
export default developerModule;
