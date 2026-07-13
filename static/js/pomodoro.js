/**
 * Pomodoro Module — focus timer under Tools.
 *
 * Work / short-break / long-break cycle with browser notifications and an
 * optional ntfy ping to the phone (via POST /api/notes/pomodoro-notify).
 * Follows the calendar.js tool-window pattern: lazy modal + makeWindowDraggable
 * + modalManager registration. Config and the running phase persist through
 * Storage, so a tab reload resumes the timer (timestamps, not tick counting —
 * background-tab throttling can't drift the clock).
 */

import { makeWindowDraggable } from './windowDrag.js';
import * as Modals from './modalManager.js';
import Storage from './storage.js';

const API_BASE = window.location.origin;

const DEFAULTS = { work: 25, short: 5, long: 15, rounds: 4, ntfy: true };

const PHASE_LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };

let _modal = null;
let _open = false;
let _interval = null;

let _cfg = { ...DEFAULTS };
// Running phase: { phase:'work'|'short'|'long', round:1..rounds,
//   endsAt:ms|null, remainingMs:ms|null (set while paused) }. null = idle.
let _run = null;

(function _load() {
  const saved = Storage.getJSON(Storage.KEYS.POMODORO, null);
  if (saved && typeof saved === 'object') {
    _cfg = { ...DEFAULTS, ...(saved.cfg || {}) };
    const run = saved.run;
    // Resume only a phase that is still meaningful: paused, or ends in the
    // future. A phase that expired while the tab was gone starts over idle.
    if (run && run.phase && (run.remainingMs > 0 || (run.endsAt && run.endsAt > Date.now()))) {
      _run = run;
      _ensureTicking();
    }
  }
})();

function _save() {
  Storage.setJSON(Storage.KEYS.POMODORO, { cfg: _cfg, run: _run });
}

function _phaseMs(phase) {
  const mins = phase === 'work' ? _cfg.work : (phase === 'short' ? _cfg.short : _cfg.long);
  return Math.max(1, Number(mins) || DEFAULTS[phase === 'work' ? 'work' : phase]) * 60000;
}

function _remainingMs() {
  if (!_run) return _phaseMs('work');
  if (_run.remainingMs != null) return _run.remainingMs;      // paused
  return Math.max(0, _run.endsAt - Date.now());
}

function _fmt(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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
  if (!_run || _run.remainingMs != null) return;  // idle or paused
  if (_run.endsAt - Date.now() <= 0) _onPhaseEnd();
  if (_open) _render();
}

function _startPhase(phase, round) {
  _run = { phase, round, endsAt: Date.now() + _phaseMs(phase), remainingMs: null };
  _save();
  _ensureTicking();
  if (_open) _render();
}

function _onPhaseEnd() {
  const ended = _run;
  // Advance: work #N → short (or long every cfg.rounds); any break → work.
  let next, nextRound;
  if (ended.phase === 'work') {
    next = (ended.round % Math.max(1, _cfg.rounds) === 0) ? 'long' : 'short';
    nextRound = ended.round;
  } else {
    next = 'work';
    nextRound = ended.phase === 'long' ? 1 : ended.round + 1;
  }
  const mins = Math.round(_phaseMs(next) / 60000);
  _notify(
    `${PHASE_LABEL[ended.phase]} done`,
    `${PHASE_LABEL[next]} starts now (${mins} min).`
  );
  _startPhase(next, nextRound);
}

function _notify(title, body) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'odysseus-pomodoro' });
    }
  } catch (e) { /* notification API unavailable — ntfy still fires */ }
  if (_cfg.ntfy) {
    // Fire-and-forget phone ping; duplicate pings from a second open tab are
    // an accepted edge case.
    fetch(`${API_BASE}/api/notes/pomodoro-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    }).catch(() => {});
  }
}

// ── Controls ──

function _startOrPause() {
  if (_run && _run.remainingMs == null) {
    // running → pause
    _run.remainingMs = Math.max(0, _run.endsAt - Date.now());
    _run.endsAt = null;
  } else if (_run) {
    // paused → resume
    _run.endsAt = Date.now() + _run.remainingMs;
    _run.remainingMs = null;
    _ensureTicking();
  } else {
    // idle → first focus phase; ask for notification permission on this
    // user gesture so the phase-end alert can fire later.
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) { /* ignore */ }
    _startPhase('work', 1);
    return;
  }
  _save();
  _render();
}

function _reset() {
  _run = null;
  _stopTicking();
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
        <button class="close-btn" id="pomo-close">✖</button>
      </div>
      <div class="modal-body pomo-body">
        <div class="pomo-phase" id="pomo-phase"></div>
        <div class="pomo-time" id="pomo-time"></div>
        <div class="pomo-progress"><div class="pomo-progress-fill" id="pomo-progress-fill"></div></div>
        <div class="pomo-controls">
          <button type="button" class="pomo-btn pomo-primary" id="pomo-start">Start</button>
          <button type="button" class="pomo-btn" id="pomo-reset">Reset</button>
        </div>
        <div class="pomo-settings">
          <label>Focus (min)<input type="number" class="pomo-input" id="pomo-cfg-work" min="1" max="180"></label>
          <label>Rounds<input type="number" class="pomo-input" id="pomo-cfg-rounds" min="1" max="12"></label>
          <label>Break (min)<input type="number" class="pomo-input" id="pomo-cfg-short" min="1" max="60"></label>
          <label>Long break (min)<input type="number" class="pomo-input" id="pomo-cfg-long" min="1" max="120"></label>
          <label class="pomo-ntfy-row"><input type="checkbox" id="pomo-cfg-ntfy"><span>Notify phone (ntfy)</span></label>
        </div>
      </div>
    </div>`;
  document.body.appendChild(_modal);
  _modal.querySelector('#pomo-close').addEventListener('click', closePomodoro);
  _modal.addEventListener('click', (e) => { if (e.target === _modal) closePomodoro(); });
  _modal.querySelector('#pomo-start').addEventListener('click', _startOrPause);
  _modal.querySelector('#pomo-reset').addEventListener('click', _reset);

  const bind = (id, key, min, max) => {
    const inp = _modal.querySelector(id);
    inp.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, parseInt(inp.value, 10) || DEFAULTS[key]));
      inp.value = v;
      _cfg[key] = v;
      _save();
      if (!_run) _render();  // idle display shows the focus length
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

  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });
  return _modal;
}

function _render() {
  if (!_modal || !_open) return;
  const phase = _run ? _run.phase : 'work';
  const label = _run
    ? `${PHASE_LABEL[phase]} · Round ${_run.round}/${Math.max(1, _cfg.rounds)}${_run.remainingMs != null ? ' · paused' : ''}`
    : 'Ready to focus';
  _modal.querySelector('#pomo-phase').textContent = label;
  const remaining = _remainingMs();
  _modal.querySelector('#pomo-time').textContent = _fmt(remaining);
  const total = _phaseMs(phase);
  const pct = _run ? Math.min(100, 100 * (1 - remaining / total)) : 0;
  _modal.querySelector('#pomo-progress-fill').style.width = `${pct}%`;
  _modal.querySelector('#pomo-start').textContent =
    (_run && _run.remainingMs == null) ? 'Pause' : (_run ? 'Resume' : 'Start');
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
    restoreFn: () => {},
  });
  _syncInputs();
  _render();
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
  if (Modals.isRegistered('pomodoro-modal')) Modals.close('pomodoro-modal');
  else _doClosePomodoro();
}

function isPomodoroOpen() {
  // Treat minimized as "not open" so the toolbar toggle restores via Modals.toggle.
  if (Modals.isMinimized('pomodoro-modal')) return false;
  return _open;
}

const pomodoroModule = { openPomodoro, closePomodoro, isPomodoroOpen };
export { openPomodoro, closePomodoro, isPomodoroOpen };
export default pomodoroModule;
