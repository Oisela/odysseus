// Reduced, role-safe Server live workspace.
// Reuses the Developer page's existing metric card classes and endpoint while
// deliberately omitting every admin deployment control.

import { API_BASE } from './config.js';

let modalEl = null;
let timer = null;
let loading = false;

function el(id) { return document.getElementById(id); }

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const sized = value / (1024 ** power);
  return `${sized >= 10 || power < 2 ? sized.toFixed(0) : sized.toFixed(1)} ${units[power]}`;
}

function formatUptime(seconds) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function setMetricValue(id, value, percent) {
  const node = el(id);
  if (!node) return;
  node.textContent = value;
  const card = node.closest('.dev-metric');
  if (card && Number.isFinite(percent)) {
    card.style.setProperty('--metric-level', `${Math.max(0, Math.min(100, percent))}%`);
  }
}

async function loadMetrics(force = false) {
  if (loading || !modalEl || modalEl.classList.contains('hidden')) return;
  loading = true;
  const refresh = el('server-live-refresh');
  const status = el('server-live-status');
  const dot = el('server-live-dot');
  if (refresh) refresh.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/system/metrics${force ? '?refresh=1' : ''}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.available) throw new Error('No metrics available');
    const cpu = data.cpu || {};
    const memory = data.memory || {};
    const disk = data.disk || {};
    setMetricValue('server-live-cpu', Number.isFinite(cpu.percent) ? `${cpu.percent.toFixed(1)} %` : 'Measuring…', cpu.percent);
    el('server-live-load').textContent = Number.isFinite(cpu.load_1)
      ? `Load ${cpu.load_1.toFixed(2)} · ${cpu.cores || '?'} cores`
      : `${cpu.cores || '?'} cores`;
    setMetricValue('server-live-memory', Number.isFinite(memory.percent) ? `${memory.percent.toFixed(1)} %` : '—', memory.percent);
    el('server-live-memory-detail').textContent = `${formatBytes(memory.used_bytes)} / ${formatBytes(memory.total_bytes)}`;
    setMetricValue('server-live-disk', Number.isFinite(disk.percent) ? `${disk.percent.toFixed(1)} %` : '—', disk.percent);
    el('server-live-disk-detail').textContent = `${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)}`;
    setMetricValue('server-live-uptime', formatUptime(data.uptime_seconds));
    el('server-live-source').textContent = data.source === 'server' ? 'Odysseus server' : 'App container';
    const sampled = data.sampled_at ? new Date(data.sampled_at) : new Date();
    status.textContent = `Live · ${sampled.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    dot?.classList.add('is-live');
  } catch (error) {
    status.textContent = `Not reachable · ${error.message}`;
    dot?.classList.remove('is-live');
  } finally {
    loading = false;
    if (refresh) refresh.disabled = false;
  }
}

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement('div');
  modalEl.id = 'server-live-modal';
  modalEl.className = 'modal hidden';
  modalEl.innerHTML = `
    <div class="modal-content developer-modal-content" role="dialog" aria-label="Server live">
      <div class="modal-header">
        <h2><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg>Server live</h2>
        <button class="close-btn" type="button" aria-label="Close server live">&#10006;</button>
      </div>
      <div class="modal-body developer-body">
        <div class="admin-card dev-server-card">
          <div class="dev-card-heading">
            <div>
              <h2>Server live</h2>
              <div class="admin-toggle-sub">Secure, aggregated load without process names, network details, or deployment controls. Updates every 5 seconds.</div>
            </div>
            <button class="admin-btn-sm" id="server-live-refresh" type="button" title="Refresh server load now">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              Refresh
            </button>
          </div>
          <div class="dev-metrics" aria-live="polite">
            <div class="dev-metric"><span>CPU</span><strong id="server-live-cpu">…</strong><small id="server-live-load">Loading…</small></div>
            <div class="dev-metric"><span>RAM</span><strong id="server-live-memory">…</strong><small id="server-live-memory-detail">Loading…</small></div>
            <div class="dev-metric"><span>Disk</span><strong id="server-live-disk">…</strong><small id="server-live-disk-detail">Loading…</small></div>
            <div class="dev-metric"><span>Uptime</span><strong id="server-live-uptime">…</strong><small id="server-live-source">Loading…</small></div>
          </div>
          <div class="dev-metrics-foot"><span class="dev-live-dot" id="server-live-dot"></span><span id="server-live-status">Connecting…</span></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  modalEl.querySelector('.close-btn').addEventListener('click', closeServerLive);
  modalEl.addEventListener('click', event => { if (event.target === modalEl) closeServerLive(); });
  el('server-live-refresh').addEventListener('click', () => loadMetrics(true));
}

export function openServerLive() {
  ensureModal();
  modalEl.classList.remove('hidden');
  el('tool-server-live-btn')?.classList.add('active');
  loadMetrics();
  if (!timer) timer = setInterval(() => loadMetrics(), 5000);
}

export function closeServerLive() {
  modalEl?.classList.add('hidden');
  el('tool-server-live-btn')?.classList.remove('active');
}

export default { openServerLive, closeServerLive };
