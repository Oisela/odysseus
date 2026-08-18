// static/js/voiceRecorder.js

/**
 * Voice recording with optional Speech-to-Text transcription.
 *
 * STT providers:
 *   "disabled"       — record audio as file attachment (original behavior)
 *   "browser"        — use Web Speech API for real-time transcription
 *   "local"          — send recording to server /api/stt/transcribe (Whisper)
 *   "endpoint:<id>"  — send recording to server /api/stt/transcribe (API)
 *
 * Dictation prefers text. When browser recognition returns no result or a
 * server transcription fails, keep the audio only in memory and offer an
 * explicit attachment fallback instead of silently adding a voice file.
 */

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingInterval = null;

// Browser STT state
let _recognition = null;
let _browserTranscript = '';
// Input content at dictation start — live results render as base + finals +
// interim, so pre-typed text survives and interim words replace themselves.
let _liveBase = '';

// Cached STT provider + language — refreshed on settings change
let _sttProvider = 'disabled';
let _sttLanguage = '';

/**
 * Fetch current STT provider from server settings
 */
async function refreshSttProvider() {
  try {
    const res = await fetch('/api/stt/stats', { credentials: 'same-origin' });
    if (res.ok) {
      const stats = await res.json();
      _sttProvider = stats.provider || 'disabled';
      _sttLanguage = stats.language || '';
      // Notify the send button to update its icon
      if (window._updateSendBtnIcon) window._updateSendBtnIcon();
    }
  } catch (e) {
    console.warn('Failed to fetch STT stats:', e);
  }
}

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * Reset UI state after recording ends
 */
function _resetRecordingUI() {
  isRecording = false;
  window.dispatchEvent(new CustomEvent('odysseus:recording-state', { detail: { recording: false } }));
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  // Reset send button via global callback
  const sendBtn = document.querySelector('.send-btn');
  if (sendBtn) {
    sendBtn.classList.remove('recording');
    sendBtn.dataset.mode = '';
  }
  if (window._updateSendBtnIcon) {
    setTimeout(window._updateSendBtnIcon, 50);
  }
}

/**
 * Start browser speech recognition alongside recording
 */
function startBrowserSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  _browserTranscript = '';
  const input = document.getElementById('message');
  _liveBase = input ? input.value.trim() : '';
  _recognition = new SpeechRecognition();
  _recognition.continuous = true;
  // Live dictation: interim results stream into the input while speaking
  // and replace themselves until they finalize.
  _recognition.interimResults = true;
  // Use the configured STT language (Settings → stt_language, e.g. "de-DE");
  // empty string keeps the browser's own default, as before.
  _recognition.lang = _sttLanguage;

  _recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        _browserTranscript += event.results[i][0].transcript + ' ';
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    _renderLiveTranscript(interim);
  };

  _recognition.onerror = (e) => {
    console.warn('Browser STT error:', e.error);
  };

  // Chrome ends continuous recognition after a silence pause — restart it
  // while the mic is still recording so live dictation doesn't silently stop.
  // stopBrowserSTT nulls _recognition before stop(), so this won't refire then.
  _recognition.onend = function () {
    if (_recognition === this && isRecording) {
      try { this.start(); } catch (e) { /* already restarting */ }
    }
  };

  _recognition.start();
}

/** Paint base + finalized + interim text into the chat input (live view). */
function _renderLiveTranscript(interim) {
  const input = document.getElementById('message');
  if (!input) return;
  const parts = [_liveBase, _browserTranscript.trim(), (interim || '').trim()].filter(Boolean);
  input.value = parts.join(' ');
  // Auto-resize; the send button ignores input while dataset.mode==='recording'.
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function stopBrowserSTT() {
  if (_recognition) {
    try { _recognition.stop(); } catch (e) { /* ignore */ }
    _recognition = null;
  }
  return _browserTranscript.trim();
}

/**
 * Send audio to server for transcription
 */
async function transcribeOnServer(audioBlob) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');

  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || 'Transcription failed');
  }

  const data = await res.json();
  return data.text || '';
}

/**
 * Insert transcribed text into the chat input
 */
function insertTranscription(text, showToast) {
  if (!text) return;
  const input = document.getElementById('message');
  if (!input) return;

  const existing = input.value.trim();
  input.value = existing ? existing + ' ' + text : text;

  // Trigger auto-resize and icon update
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();

  if (showToast) showToast('Transcribed');
}

/**
 * Dictation should not unexpectedly turn into a file attachment. Preserve the
 * recording as an explicit fallback, but let the user decide whether to add it.
 */
function offerAudioFallback(audioBlob, onFileCreated, showToast, reason) {
  const attach = window.confirm(`${reason}\n\nAttach the voice recording instead?`);
  if (!attach) {
    if (showToast) showToast('Voice recording discarded');
    return;
  }
  const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
  if (onFileCreated) onFileCreated(audioFile);
}

/**
 * Start voice recording
 */
export function startRecording(onFileCreated, showToast, showError) {
  // Check for secure context (getUserMedia requires HTTPS or localhost)
  if (!window.isSecureContext) {
    if (showError) showError('Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.');
    _resetRecordingUI();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (showError) showError('Microphone not supported in this browser.');
    _resetRecordingUI();
    return;
  }

  audioChunks = [];

  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const provider = _sttProvider;

        if (provider === 'browser') {
          const transcript = stopBrowserSTT();
          if (transcript) {
            // Live dictation already painted the text — settle it (drop any
            // dangling interim words) instead of inserting a second copy.
            _renderLiveTranscript('');
            const input = document.getElementById('message');
            if (input) input.focus();
            if (showToast) showToast('Transcribed');
          } else {
            // Nothing recognized — restore the pre-dictation input and make
            // the audio-file fallback explicit rather than attaching it.
            _renderLiveTranscript('');
            offerAudioFallback(audioBlob, onFileCreated, showToast, 'No speech was transcribed.');
          }
        } else if (provider === 'local' || provider.startsWith('endpoint:')) {
          // Show "Transcribing..." feedback
          if (showToast) showToast('Transcribing...', 5000);
          try {
            const transcript = await transcribeOnServer(audioBlob);
            if (transcript) {
              insertTranscription(transcript, showToast);
            } else {
              if (showToast) showToast('No speech detected');
            }
          } catch (e) {
            console.error('STT transcription error:', e);
            offerAudioFallback(
              audioBlob,
              onFileCreated,
              showToast,
              'Transcription failed: ' + e.message,
            );
          }
        } else {
          // STT disabled — attach audio file
          const audioFile = new File([audioBlob], `voice-message-${Date.now()}.webm`, { type: 'audio/webm' });
          if (onFileCreated) onFileCreated(audioFile);
        }

        _resetRecordingUI();
      };

      mediaRecorder.start();
      isRecording = true;
      window.dispatchEvent(new CustomEvent('odysseus:recording-state', { detail: { recording: true } }));
      recordingStartTime = new Date();

      // Start browser STT if that's the provider
      if (_sttProvider === 'browser') {
        startBrowserSTT();
      }

      if (showToast) {
        showToast('Recording...');
      }
    })
    .catch(error => {
      console.error('Microphone access error:', error);
      if (showError) {
        if (error.name === 'NotAllowedError') {
          showError('Microphone access denied. Check browser permissions.');
        } else if (error.name === 'NotFoundError') {
          showError('No microphone found.');
        } else {
          showError('Microphone error: ' + error.message);
        }
      }
      _resetRecordingUI();
    });
}

/**
 * Stop voice recording
 */
export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    // isRecording will be set to false in _resetRecordingUI called from onstop
  } else {
    _resetRecordingUI();
  }
}

/**
 * Check if currently recording
 */
export function getIsRecording() {
  return isRecording;
}

/**
 * Initialize recording state
 */
export function init() {
  isRecording = false;
  refreshSttProvider();
}

const voiceRecorderModule = {
  startRecording,
  stopRecording,
  getIsRecording,
  init,
  refreshSttProvider,
  get _sttProvider() { return _sttProvider; },
  set _sttProvider(v) { _sttProvider = v; },
};

export default voiceRecorderModule;
