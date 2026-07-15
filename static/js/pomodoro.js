/**
 * Pomodoro Module — focus timer under Tools.
 *
 * Work / short-break / long-break cycle with a ring countdown, browser
 * notifications and optional ntfy phone pings. Focus time is logged
 * server-side (/api/pomodoro/log), so today/week/average stats are shared
 * across devices. When a focus phase ends the clock keeps counting UP
 * (overtime); "+" banks that extra time before the break starts. Manual
 * logging covers "forgot to stop the timer" days.
 *
 * Follows the calendar.js tool-window pattern: lazy modal +
 * makeWindowDraggable + modalManager registration. Config and the running
 * phase persist through Storage (timestamps, not tick counting — background
 * tab throttling can't drift the clock; a reload resumes the phase).
 */

import { makeWindowDraggable } from './windowDrag.js';
import * as Modals from './modalManager.js';
import Storage from './storage.js';

const API_BASE = window.location.origin;

const DEFAULTS = { work: 25, short: 5, long: 15, rounds: 4, ntfy: true };

const PHASE_LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };

const _RING_R = 88;
const _RING_C = 2 * Math.PI * _RING_R;

let _modal = null;
let _open = false;
let _interval = null;
let _pip = null; // Document-PiP popout window (declared here — _save touches it during module init)

let _cfg = { ...DEFAULTS };
// Running state — one of:
//   null                                              fresh (round 1 next)
//   { phase:'ready',    round }                       break done, waiting for Start
//   { phase:'work',     round, endsAt, remainingMs, baseLogged }
//   { phase:'overtime', round, since }                focus done, counting up
//   { phase:'short'|'long', round, endsAt, remainingMs }
// endsAt is a timestamp; remainingMs is non-null only while paused.
let _run = null;

(function _load() {
  const saved = Storage.getJSON(Storage.KEYS.POMODORO, null);
  if (saved && typeof saved === 'object') {
    _cfg = { ...DEFAULTS, ...(saved.cfg || {}) };
    const run = saved.run;
    if (run && run.phase) {
      _run = run;
      _catchUp();
      if (_isTicking()) _ensureTicking();
      // A live session survives the reload — surface it as a dock chip right
      // away instead of ticking invisibly until the window is opened.
      if (_isLive()) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', _minimizeToChip);
        } else {
          _minimizeToChip();
        }
      }
    }
  }
})();

/** Register (idempotent) and park the timer as a live chip in the dock. */
function _minimizeToChip() {
  Modals.register('pomodoro-modal', {
    sidebarBtnId: 'tool-pomodoro-btn',
    closeFn: () => _doClosePomodoro(),
    // The chip may exist before the modal DOM does (reload mid-session) —
    // restore must build the window, not just unhide it.
    restoreFn: () => { if (!_open) openPomodoro(); },
  });
  Modals.minimize('pomodoro-modal');
  _updateChip();
}

function _save() {
  Storage.setJSON(Storage.KEYS.POMODORO, { cfg: _cfg, run: _run });
  // Every state transition goes through _save — keep the external displays
  // (dock chip, PiP popout) in step.
  _updateChip();
  _renderPiP();
}

function _phaseMs(phase) {
  const mins = phase === 'work' ? _cfg.work : (phase === 'short' ? _cfg.short : _cfg.long);
  return Math.max(1, Number(mins) || DEFAULTS[phase] || 25) * 60000;
}

function _fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _fmtHours(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function _isTicking() {
  return !!(_run && (_run.phase === 'overtime' || (_run.endsAt && _run.remainingMs == null)));
}

/** A session worth keeping visible: running, paused or overtime — not 'ready'. */
function _isLive() {
  return !!(_run && _run.phase !== 'ready');
}

/** Reconcile a restored state with wall-clock time (tab was closed/reloaded). */
function _catchUp() {
  if (!_run || _run.remainingMs != null) return;
  if (_run.phase === 'work' && _run.endsAt && _run.endsAt <= Date.now()) {
    _finishWork();
  } else if ((_run.phase === 'short' || _run.phase === 'long') && _run.endsAt && _run.endsAt <= Date.now()) {
    _finishBreak();
  }
}

// ── Timer engine ──

function _ensureTicking() {
  if (_interval) return;
  _interval = setInterval(_tick, 500);
}

function _stopTicking() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

function _tick() {
  if (!_run) { _stopTicking(); return; }
  if (_run.phase === 'work' && _run.remainingMs == null && _run.endsAt - Date.now() <= 0) {
    _finishWork();
    _notify('Focus done', 'Extra time is counting — press + to bank it when you take your break.');
  } else if ((_run.phase === 'short' || _run.phase === 'long')
             && _run.remainingMs == null && _run.endsAt - Date.now() <= 0) {
    const nextRound = _run.phase === 'long' ? 1 : _run.round + 1;
    _finishBreak();
    _notify('Break over', `Round ${nextRound} is ready — press Start.`);
  }
  if (_open) _render();
  _updateChip();
  _renderPiP();
}

/**
 * Live label on the minimized dock chip — 'Focus 12:34', 'Break 3:10',
 * '+2:11' (overtime), 'Paused 12:34'. The dock renderer rebuilds chips with
 * the static label on dock changes; the next tick corrects it.
 */
function _updateChip() {
  const lbl = document.querySelector('.minimized-dock-chip[data-modal-id="pomodoro-modal"] .minimized-dock-label');
  if (!lbl) return;
  let text = 'Pomodoro';
  if (_run) {
    if (_run.phase === 'overtime') {
      text = '+' + _fmt(Date.now() - _run.since);
    } else if (_run.phase === 'ready') {
      text = 'Ready ' + _fmt(_phaseMs('work'));
    } else {
      const paused = _run.remainingMs != null;
      const remaining = paused ? _run.remainingMs : Math.max(0, _run.endsAt - Date.now());
      const word = paused ? 'Paused' : (_run.phase === 'work' ? 'Focus' : 'Break');
      text = `${word} ${_fmt(remaining)}`;
    }
  }
  if (lbl.textContent !== text) lbl.textContent = text;
}

/** Focus phase completed: bank the base minutes once, switch to overtime. */
function _finishWork() {
  const endedAt = _run.endsAt || Date.now();
  if (!_run.baseLogged) {
    const secs = Math.round(_phaseMs('work') / 1000);
    _logSeconds(secs, {
      start: new Date(endedAt - secs * 1000).toISOString(),
      end: new Date(endedAt).toISOString(),
      note: 'Focus',
    });
    _run.baseLogged = true;
  }
  _run = { phase: 'overtime', round: _run.round, since: endedAt };
  _save();
}

function _finishBreak() {
  const nextRound = _run.phase === 'long' ? 1 : _run.round + 1;
  _run = { phase: 'ready', round: nextRound };
  _stopTicking();
  _save();
}

function _startPhase(phase, round) {
  _run = { phase, round, endsAt: Date.now() + _phaseMs(phase), remainingMs: null };
  if (phase === 'work') _run.baseLogged = false;
  _save();
  _ensureTicking();
  if (_open) _render();
}

function _breakFor(round) {
  return (round % Math.max(1, _cfg.rounds) === 0) ? 'long' : 'short';
}

function _notify(title, body) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'odysseus-pomodoro' });
    }
  } catch (e) { /* notification API unavailable — ntfy still fires */ }
  if (_cfg.ntfy) {
    fetch(`${API_BASE}/api/pomodoro/notify`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    }).catch(() => {});
  }
}

// ── Focus-time ledger (server-side, shared across devices) ──

function _logSeconds(seconds, opts = {}) {
  const payload = { seconds: Math.round(seconds) };
  if (opts.date) payload.date = opts.date;
  if (opts.start) payload.start = opts.start;
  if (opts.end) payload.end = opts.end;
  if (opts.note) payload.note = opts.note;
  return fetch(`${API_BASE}/api/pomodoro/log`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => { if (r.ok) _refreshStats(); return r; }).catch(() => {});
}

async function _refreshStats() {
  const box = _modal?.querySelector('#pomo-stats');
  if (!box) return;
  try {
    const res = await fetch(`${API_BASE}/api/pomodoro/stats`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const s = await res.json();
    box.querySelector('[data-stat="today"]').textContent = _fmtHours(s.today_s);
    box.querySelector('[data-stat="week"]').textContent = _fmtHours(s.week_s);
    box.querySelector('[data-stat="avg"]').textContent = _fmtHours(s.week_avg_s);
  } catch (e) { /* stats are cosmetic — never break the timer */ }
  _renderTodayRecords().catch(() => {});
}

// ── Focus record (individual sessions, TickTick-style) ──

const _escTxt = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function _localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _recTime(e) {
  const t = (iso) => {
    try {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch (err) { return ''; }
  };
  if (e.start && e.end) return `${t(e.start)} – ${t(e.end)}`;
  if (e.end || e.start) return t(e.end || e.start);
  return _escTxt(e.note || 'logged');
}

async function _fetchRecords() {
  try {
    const res = await fetch(`${API_BASE}/api/pomodoro/records`, { credentials: 'same-origin' });
    if (!res.ok) return [];
    return (await res.json()).records || [];
  } catch (e) { return []; }
}

async function _deleteRecord(id) {
  try {
    await fetch(`${API_BASE}/api/pomodoro/records/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
  } catch (e) { /* refresh shows the truth either way */ }
  _refreshStats();
  if (document.getElementById('pomodoro-stats-modal')) _renderStatsModal();
}

function _recordRowsHtml(recs) {
  return recs.map((r) => `
    <div class="pomo-rec-row">
      <span class="pomo-rec-time">${_recTime(r)}</span>
      <span class="pomo-rec-dur">${_fmtHours(r.seconds)}</span>
      <button type="button" class="pomo-rec-del" data-id="${_escTxt(r.id)}" title="Delete entry">✕</button>
    </div>`).join('');
}

function _wireRecordDeletes(root) {
  root.querySelectorAll('.pomo-rec-del').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); _deleteRecord(b.dataset.id); }));
}

/** Today's sessions under the stats row — see and undo what got logged. */
async function _renderTodayRecords() {
  const box = _modal?.querySelector('#pomo-today');
  if (!box) return;
  const today = _localDate();
  const recs = (await _fetchRecords()).filter((r) => r.date === today);
  box.innerHTML = recs.length ? _recordRowsHtml(recs) : '';
  _wireRecordDeletes(box);
}

// ── Statistics window (overview + full focus record) ──

function _openStatsModal() {
  document.getElementById('pomodoro-stats-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'pomodoro-stats-modal';
  modal.className = 'modal';
  modal.style.zIndex = '260'; // above the pomodoro window
  modal.innerHTML = `
    <div class="modal-content pomo-modal-content" style="max-width:420px;width:min(420px,94vw);">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>Focus statistics</h4>
        <button class="close-btn" id="pomo-stats-close">✖</button>
      </div>
      <div class="modal-body" style="padding:12px 16px;max-height:70vh;overflow:auto;">
        <div class="pomo-stats" id="pomo-stats-overview" style="margin-bottom:12px;">
          <span><b data-k="today_sessions">–</b>Today's pomos</span>
          <span><b data-k="total_sessions">–</b>Total pomos</span>
          <span><b data-k="today_s">–</b>Today's focus</span>
          <span><b data-k="total_s">–</b>Total focus</span>
        </div>
        <div id="pomo-stats-records" style="font-size:13px;"><div style="opacity:0.6">loading …</div></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#pomo-stats-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(modal, { content, header });
  _renderStatsModal();
}

async function _renderStatsModal() {
  const modal = document.getElementById('pomodoro-stats-modal');
  if (!modal) return;
  try {
    const [sRes, recs] = await Promise.all([
      fetch(`${API_BASE}/api/pomodoro/stats`, { credentials: 'same-origin' }),
      _fetchRecords(),
    ]);
    const s = sRes.ok ? await sRes.json() : {};
    const ov = modal.querySelector('#pomo-stats-overview');
    ov.querySelector('[data-k="today_sessions"]').textContent = s.today_sessions ?? 0;
    ov.querySelector('[data-k="total_sessions"]').textContent = s.total_sessions ?? 0;
    ov.querySelector('[data-k="today_s"]').textContent = _fmtHours(s.today_s);
    ov.querySelector('[data-k="total_s"]').textContent = _fmtHours(s.total_s);
    const box = modal.querySelector('#pomo-stats-records');
    if (!recs.length) {
      box.innerHTML = '<div style="opacity:0.6">No focus sessions logged yet.</div>';
      return;
    }
    let html = '';
    let lastDay = '';
    for (const r of recs) {
      if (r.date !== lastDay) {
        html += `<div class="pomo-rec-day">${_escTxt(r.date)}</div>`;
        lastDay = r.date;
      }
      html += _recordRowsHtml([r]);
    }
    box.innerHTML = html;
    _wireRecordDeletes(box);
  } catch (e) {
    const box = modal.querySelector('#pomo-stats-records');
    if (box) box.innerHTML = '<div style="opacity:0.6">Failed to load statistics.</div>';
  }
}

// ── Controls ──

function _handleAction(action) {
  if (action === 'start') {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) { /* ignore */ }
    const round = (_run && _run.phase === 'ready') ? _run.round : 1;
    _startPhase('work', round);
    return;
  }
  if (action === 'pause') {
    _run.remainingMs = Math.max(0, _run.endsAt - Date.now());
    _run.endsAt = null;
  } else if (action === 'resume') {
    _run.endsAt = Date.now() + _run.remainingMs;
    _run.remainingMs = null;
    _ensureTicking();
  } else if (action === 'bank') {
    // "+" — bank the overtime, then start the break.
    const extra = Math.round((Date.now() - _run.since) / 1000);
    if (extra > 0) _logSeconds(extra, {
      start: new Date(_run.since).toISOString(),
      end: new Date().toISOString(),
      note: 'Overtime',
    });
    _startPhase(_breakFor(_run.round), _run.round);
    return;
  } else if (action === 'break') {
    // Skip the overtime, straight into the break.
    _startPhase(_breakFor(_run.round), _run.round);
    return;
  } else if (action === 'reset') {
    _run = null;
    _stopTicking();
  }
  _save();
  _render();
}

// ── Modal ──

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'pomodoro-modal';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content pomo-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>Pomodoro</h4>
        <button class="pomo-pip-btn" id="pomo-stats-btn" title="Focus statistics" style="margin-left:auto;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg></button>
        <button class="pomo-pip-btn" id="pomo-pip" title="Pop out mini timer" style="display:none;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1"/></svg></button>
        <button class="close-btn" id="pomo-close">✖</button>
      </div>
      <div class="modal-body pomo-body">
        <div class="pomo-phase" id="pomo-phase"></div>
        <div class="pomo-ring-wrap">
          <svg class="pomo-ring" viewBox="0 0 200 200" aria-hidden="true">
            <circle class="pomo-ring-bg" cx="100" cy="100" r="${_RING_R}"/>
            <circle class="pomo-ring-fg" id="pomo-ring-fg" cx="100" cy="100" r="${_RING_R}"
              stroke-dasharray="${_RING_C.toFixed(2)}" stroke-dashoffset="${_RING_C.toFixed(2)}"/>
          </svg>
          <div class="pomo-time" id="pomo-time"></div>
        </div>
        <div class="pomo-controls" id="pomo-controls"></div>
        <div class="pomo-stats" id="pomo-stats">
          <span><b data-stat="today">–</b>Today</span>
          <span><b data-stat="week">–</b>This week</span>
          <span><b data-stat="avg">–</b>Ø / day</span>
        </div>
        <div class="pomo-today" id="pomo-today"></div>
        <div class="pomo-settings">
          <label>Focus (min)<input type="number" class="pomo-input" id="pomo-cfg-work" min="1" max="180"></label>
          <label>Rounds<input type="number" class="pomo-input" id="pomo-cfg-rounds" min="1" max="12"></label>
          <label>Break (min)<input type="number" class="pomo-input" id="pomo-cfg-short" min="1" max="60"></label>
          <label>Long break (min)<input type="number" class="pomo-input" id="pomo-cfg-long" min="1" max="120"></label>
          <label class="pomo-ntfy-row"><input type="checkbox" id="pomo-cfg-ntfy"><span>Notify phone (ntfy)</span></label>
          <div class="pomo-manual-row">
            <label>Add focus time (min)<input type="number" class="pomo-input" id="pomo-manual-mins" min="1" max="600" placeholder="25"></label>
            <button type="button" class="pomo-btn" id="pomo-manual-add" title="Add focus time you forgot to track (today)">Log manually</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#pomo-close').addEventListener('click', closePomodoro);
  _modal.addEventListener('click', (e) => { if (e.target === _modal) closePomodoro(); });

  // TickTick-style popout: Document Picture-in-Picture floats the timer above
  // other apps. Chromium-only — the button stays hidden elsewhere.
  const pipBtn = _modal.querySelector('#pomo-pip');
  if ('documentPictureInPicture' in window) {
    pipBtn.style.display = '';
    pipBtn.addEventListener('click', (e) => { e.stopPropagation(); _openPiP(); });
  }

  _modal.querySelector('#pomo-stats-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    _openStatsModal();
  });

  // One delegated listener — the control buttons are re-rendered per state.
  _modal.querySelector('#pomo-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) _handleAction(btn.dataset.action);
  });

  const bind = (id, key, min, max) => {
    const inp = _modal.querySelector(id);
    inp.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, parseInt(inp.value, 10) || DEFAULTS[key]));
      inp.value = v;
      _cfg[key] = v;
      _save();
      if (!_run) _render();
    });
  };
  bind('#pomo-cfg-work', 'work', 1, 180);
  bind('#pomo-cfg-short', 'short', 1, 60);
  bind('#pomo-cfg-long', 'long', 1, 120);
  bind('#pomo-cfg-rounds', 'rounds', 1, 12);
  _modal.querySelector('#pomo-cfg-ntfy').addEventListener('change', (e) => {
    _cfg.ntfy = !!e.target.checked;
    _save();
  });

  _modal.querySelector('#pomo-manual-add').addEventListener('click', async () => {
    const inp = _modal.querySelector('#pomo-manual-mins');
    const mins = parseInt(inp.value, 10);
    if (!mins || mins <= 0) { inp.focus(); return; }
    await _logSeconds(mins * 60, { note: 'Manual' });
    inp.value = '';
  });

  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

function _controlsHtml() {
  const btn = (action, label, primary) =>
    `<button type="button" class="pomo-btn${primary ? ' pomo-primary' : ''}" data-action="${action}">${label}</button>`;
  if (!_run || _run.phase === 'ready') return btn('start', 'Start', true);
  if (_run.phase === 'overtime') {
    const extra = _fmt(Date.now() - _run.since);
    return btn('bank', `+ Add ${extra}`, true) + btn('break', 'Break', false);
  }
  const paused = _run.remainingMs != null;
  return btn(paused ? 'resume' : 'pause', paused ? 'Resume' : 'Pause', true)
       + btn('reset', 'Reset', false);
}

/** Shared display state for the modal and the PiP popout. */
function _view() {
  const rounds = Math.max(1, _cfg.rounds);
  let label, timeText, frac, overtime = false;
  if (!_run) {
    label = 'Ready to focus';
    timeText = _fmt(_phaseMs('work'));
    frac = 0;
  } else if (_run.phase === 'ready') {
    label = `Ready · Round ${_run.round}/${rounds}`;
    timeText = _fmt(_phaseMs('work'));
    frac = 0;
  } else if (_run.phase === 'overtime') {
    label = `Focus done · Round ${_run.round}/${rounds} · extra time running`;
    timeText = '+' + _fmt(Date.now() - _run.since);
    frac = 1;
    overtime = true;
  } else {
    const paused = _run.remainingMs != null;
    const remaining = paused ? _run.remainingMs : Math.max(0, _run.endsAt - Date.now());
    label = `${PHASE_LABEL[_run.phase]} · Round ${_run.round}/${rounds}${paused ? ' · paused' : ''}`;
    timeText = _fmt(remaining);
    frac = Math.min(1, 1 - remaining / _phaseMs(_run.phase));
  }
  return { label, timeText, frac, overtime };
}

function _render() {
  if (!_modal || !_open) return;
  const phaseEl = _modal.querySelector('#pomo-phase');
  const timeEl = _modal.querySelector('#pomo-time');
  const ring = _modal.querySelector('#pomo-ring-fg');
  const { label, timeText, frac, overtime } = _view();

  phaseEl.textContent = label;
  timeEl.textContent = timeText;
  if (ring) {
    ring.style.strokeDashoffset = (_RING_C * (1 - frac)).toFixed(2);
    ring.classList.toggle('overtime', overtime);
  }

  const controls = _modal.querySelector('#pomo-controls');
  const html = _controlsHtml();
  if (controls._lastHtml !== html) {
    controls.innerHTML = html;
    controls._lastHtml = html;
  }
}

// ── Picture-in-Picture popout (Document PiP, Chromium/PWA only) ──

async function _openPiP() {
  if (!('documentPictureInPicture' in window)) return;
  if (_pip && !_pip.closed) { try { _pip.focus(); } catch (_) {} return; }
  let win;
  try {
    win = await window.documentPictureInPicture.requestWindow({ width: 250, height: 290 });
  } catch (e) {
    console.warn('PiP request failed:', e);
    return;
  }
  _pip = win;
  // Copy the app's stylesheets so the ring/time/button classes render
  // identically (incl. theme CSS variables). Standard Document-PiP pattern.
  for (const sheet of document.styleSheets) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('');
      const style = win.document.createElement('style');
      style.textContent = css;
      win.document.head.appendChild(style);
    } catch (e) {
      if (sheet.href) {
        const link = win.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        win.document.head.appendChild(link);
      }
    }
  }
  // Theme state lives in classes/inline vars on <html>/<body> — mirror them.
  try {
    win.document.documentElement.className = document.documentElement.className;
    win.document.documentElement.setAttribute('style', document.documentElement.getAttribute('style') || '');
    win.document.body.className = document.body.className;
  } catch (_) {}
  win.document.body.style.background = 'var(--bg)';
  win.document.body.style.color = 'var(--fg)';
  win.document.body.innerHTML = `
    <div class="pomo-pip-body">
      <div class="pomo-phase" id="pip-phase"></div>
      <div class="pomo-ring-wrap">
        <svg class="pomo-ring" viewBox="0 0 200 200" aria-hidden="true">
          <circle class="pomo-ring-bg" cx="100" cy="100" r="${_RING_R}"/>
          <circle class="pomo-ring-fg" id="pip-ring-fg" cx="100" cy="100" r="${_RING_R}"
            stroke-dasharray="${_RING_C.toFixed(2)}" stroke-dashoffset="${_RING_C.toFixed(2)}"/>
        </svg>
        <div class="pomo-time" id="pip-time"></div>
      </div>
      <div class="pomo-controls" id="pip-controls"></div>
    </div>`;
  // Same delegated control pattern as the modal — actions run in this module.
  win.document.getElementById('pip-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) _handleAction(btn.dataset.action);
  });
  win.addEventListener('pagehide', () => { _pip = null; });
  _renderPiP();
}

function _renderPiP() {
  if (!_pip || _pip.closed) return;
  const doc = _pip.document;
  const phaseEl = doc.getElementById('pip-phase');
  const timeEl = doc.getElementById('pip-time');
  const ring = doc.getElementById('pip-ring-fg');
  const controls = doc.getElementById('pip-controls');
  if (!phaseEl || !timeEl) return;
  const { label, timeText, frac, overtime } = _view();
  phaseEl.textContent = label;
  timeEl.textContent = timeText;
  if (ring) {
    ring.style.strokeDashoffset = (_RING_C * (1 - frac)).toFixed(2);
    ring.classList.toggle('overtime', overtime);
  }
  if (controls) {
    const html = _controlsHtml();
    if (controls._lastHtml !== html) {
      controls.innerHTML = html;
      controls._lastHtml = html;
    }
  }
}

function _syncInputs() {
  _modal.querySelector('#pomo-cfg-work').value = _cfg.work;
  _modal.querySelector('#pomo-cfg-short').value = _cfg.short;
  _modal.querySelector('#pomo-cfg-long').value = _cfg.long;
  _modal.querySelector('#pomo-cfg-rounds').value = _cfg.rounds;
  _modal.querySelector('#pomo-cfg-ntfy').checked = !!_cfg.ntfy;
}

// ── Public API ──

function openPomodoro() {
  const modal = _getModal();
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
  _open = true;
  Modals.register('pomodoro-modal', {
    sidebarBtnId: 'tool-pomodoro-btn',
    closeFn: () => _doClosePomodoro(),
    restoreFn: () => { if (!_open) openPomodoro(); },
  });
  _catchUp();
  if (_isTicking()) _ensureTicking();
  _syncInputs();
  _render();
  _refreshStats();
}

function _doClosePomodoro() {
  if (_modal) {
    _modal.style.display = 'none';
    _modal.classList.add('hidden');
  }
  _open = false;
  // NOTE: the timer keeps ticking while the window is closed — closing the
  // window must not eat a running focus phase.
}

function closePomodoro() {
  if (!_open && !Modals.isMinimized('pomodoro-modal')) return;
  // A live session (running, paused or overtime) minimizes to a dock chip
  // instead of vanishing — the timer used to keep ticking invisibly. The
  // chip's × still fully closes (timer keeps running by design, see
  // _doClosePomodoro), and a 'ready'/idle window closes as before.
  if (_isLive() && !Modals.isMinimized('pomodoro-modal')) {
    _minimizeToChip();
    return;
  }
  if (Modals.isRegistered('pomodoro-modal')) Modals.close('pomodoro-modal');
  else _doClosePomodoro();
}

function isPomodoroOpen() {
  // Treat minimized as "not open" so the toolbar toggle restores via Modals.toggle.
  if (Modals.isMinimized('pomodoro-modal')) return false;
  return _open;
}

/**
 * Snapshot of the running timer for external displays (dock chip, PiP).
 * Returns null when idle, else { phase, round, paused, remainingMs|overtimeMs }.
 */
function getPomodoroState() {
  if (!_run) return null;
  if (_run.phase === 'overtime') {
    return { phase: 'overtime', round: _run.round, paused: false, overtimeMs: Date.now() - _run.since };
  }
  if (_run.phase === 'ready') {
    return { phase: 'ready', round: _run.round, paused: false, remainingMs: _phaseMs('work') };
  }
  const paused = _run.remainingMs != null;
  return {
    phase: _run.phase,
    round: _run.round,
    paused,
    remainingMs: paused ? _run.remainingMs : Math.max(0, _run.endsAt - Date.now()),
  };
}

const pomodoroModule = { openPomodoro, closePomodoro, isPomodoroOpen, getPomodoroState };
export { openPomodoro, closePomodoro, isPomodoroOpen, getPomodoroState };
export default pomodoroModule;
