// i18n.js — lightweight UI translation layer (v3.6).
//
// English stays the single source of truth in markup and modules; this file
// swaps exact known UI strings (text nodes, placeholders, titles) at load
// time and — via a MutationObserver — inside dynamically created windows.
// Only UI chrome is touched (buttons, labels, headers, section titles …),
// never user content. Switching language reloads the page, so there is no
// reverse-translation logic to maintain. Strings not in the dictionary
// simply stay English — extend `DE` as surfaces get promoted to "core".
//
// The chosen language is a per-account server pref (`ui_language`) with a
// localStorage boot cache, same pattern as ui_visibility.

const LANG_KEY = 'odysseus-ui-language';

const DE = {
  // ── Sidebar sections & core nav ──
  'Projects': 'Projekte',
  'Chats': 'Chats',
  'Email': 'Email',
  'Notes': 'Notizen',
  'Pomodoro': 'Pomodoro',
  'Shopping': 'Einkaufen',
  'Models': 'Modelle',
  'Tools': 'Werkzeuge',
  'New Chat': 'Neuer Chat',
  'New chat': 'Neuer Chat',
  'Search': 'Suche',
  'Settings': 'Einstellungen',
  'Show sidebar': 'Seitenleiste zeigen',
  'Toggle sidebar': 'Seitenleiste umschalten',
  'Open notes': 'Notizen öffnen',
  'Open pomodoro timer': 'Pomodoro-Timer öffnen',
  'Open shopping list & recipes': 'Einkaufsliste & Rezepte öffnen',
  'Open email inbox': 'Email-Posteingang öffnen',

  // ── Tools list ──
  'Brain': 'Brain',
  'Calendar': 'Kalender',
  'Compare': 'Vergleichen',
  'Cookbook': 'Cookbook',
  'Deep Research': 'Deep Research',
  'Gallery': 'Galerie',
  'Library': 'Bibliothek',
  'Tasks': 'Aufgaben',
  'Theme': 'Design',
  'document': 'Dokument',

  // ── Welcome / chat input ──
  'New chat ready.': 'Neuer Chat bereit.',
  'Pick a model if you want, or just type.': 'Wähle ein Modell — oder tippe einfach los.',
  'Message Odysseus...': 'Nachricht an Odysseus…',
  'Message Odysseus…': 'Nachricht an Odysseus…',
  'Nobody': 'Nobody',
  'Agent': 'Agent',
  'Chat': 'Chat',
  'Send': 'Senden',
  'Stop': 'Stopp',

  // ── Chat top bar / export dropdown ──
  'Odysseus Chat': 'Odysseus Chat',
  'More': 'Mehr',
  'Rename': 'Umbenennen',
  'Copy Chat': 'Chat kopieren',
  'PDF': 'PDF',
  'Save to Documents': 'In Dokumente speichern',

  // ── Common buttons & labels ──
  'Save': 'Speichern',
  'Cancel': 'Abbrechen',
  'Delete': 'Löschen',
  'Edit': 'Bearbeiten',
  'Close': 'Schliessen',
  'Add': 'Hinzufügen',
  'Clear': 'Leeren',
  'Remove': 'Entfernen',
  'Back': 'Zurück',
  'New': 'Neu',
  'Open': 'Öffnen',
  'Done': 'Fertig',
  'All': 'Alle',
  'None': 'Keine',
  'Today': 'Heute',
  'Yesterday': 'Gestern',
  'This week': 'Diese Woche',
  'Archive': 'Archiv',
  'Toggle': 'Umschalten',
  'Minimize': 'Minimieren',
  'Copy': 'Kopieren',
  'Download': 'Herunterladen',
  'Select': 'Auswählen',
  'Tags': 'Tags',
  'Title': 'Titel',
  'Name': 'Name',
  'Loading…': 'Lädt…',
  'Loading...': 'Lädt…',

  // ── Shopping & Recipes ──
  'Recipes': 'Rezepte',
  '+ New recipe': '+ Neues Rezept',
  'Add to shopping list': 'Zur Einkaufsliste',
  'Nothing to buy — add items above or open a recipe.': 'Nichts zu kaufen — oben etwas eintragen oder ein Rezept öffnen.',
  '+ Add an item (duplicates merge)': '+ Artikel hinzufügen (Doppelte verschmelzen)',
  'Recipe title': 'Rezept-Titel',
  'Instructions (markdown works)…': 'Anleitung (Markdown funktioniert)…',
  'e.g. 200ml Milch': 'z. B. 200ml Milch',
  'Ingredients': 'Zutaten',
  'Instructions': 'Anleitung',
  'ingredient': 'Zutat',
  'ingredients': 'Zutaten',
  'Check off': 'Abhaken',
  'Uncheck': 'Abwählen',
  'Photo': 'Foto',
  'No recipes yet — create your first one.': 'Noch keine Rezepte — leg das erste an.',

  // ── Notes ──
  'Take a note...': 'Notiz schreiben…',
  'Search notes…': 'Notizen durchsuchen…',
  'Add a to-do…': 'To-do hinzufügen…',
  '+ Add a to-do · Shift+Enter = note': '+ To-do hinzufügen · Shift+Enter = Notiz',
  '+ Add a to-do': '+ To-do hinzufügen',
  'Enter = to-do · Shift+Enter = note': 'Enter = To-do · Shift+Enter = Notiz',
  'To-dos': 'To-dos',
  'Manual': 'Manuell',
  'Due date': 'Fälligkeit',
  'Newest': 'Neueste',
  'Sort order': 'Sortierung',
  'Drag to reorder': 'Ziehen zum Sortieren',
  'Click again to rename': 'Nochmal klicken zum Umbenennen',
  'Show less': 'Weniger anzeigen',
  '+ Add item': '+ Eintrag hinzufügen',
  'Item...': 'Eintrag…',
  'List name…': 'Listenname…',
  'Description (optional)': 'Beschreibung (optional)',
  'Lists': 'Listen',
  'All notes': 'Alle Notizen',
  'Due today': 'Heute fällig',
  'Reminder': 'Erinnerung',
  'View archive': 'Archiv ansehen',
  'Toggle view': 'Ansicht wechseln',

  // ── Pomodoro ──
  'Focus': 'Fokus',
  'Break': 'Pause',
  'Start': 'Start',
  'Pause': 'Pause',
  'Resume': 'Weiter',
  'Reset': 'Zurücksetzen',
  'End': 'Beenden',
  'Skip': 'Überspringen',
  'Rounds': 'Runden',
  'Focus statistics': 'Fokus-Statistik',
  'Log manually': 'Manuell eintragen',
  'Total focus': 'Fokus gesamt',
  'Total pomos': 'Pomos gesamt',
  'Sound on phase end': 'Ton am Phasenende',
  'Water': 'Wasser',
  'I drank a glass': 'Ein Glas getrunken',
  'Remove a glass (mis-click)': 'Ein Glas entfernen (verklickt)',
  'Presets — one click sets the durations': 'Presets — ein Klick stellt die Dauern um',
  'Save the current durations (settings below) as a preset': 'Aktuelle Dauern (Einstellungen unten) als Preset speichern',
  'Delete preset': 'Preset löschen',
  'Preset name…': 'Preset-Name…',

  // ── Email (core) ──
  'Search by name or text': 'Nach Name oder Text suchen',
  'Inbox': 'Posteingang',
  'Reply': 'Antworten',
  'Forward': 'Weiterleiten',
  'emails': 'Emails',

  // ── Settings nav ──
  'Add Models': 'Modelle hinzufügen',
  'Added Models': 'Hinzugefügte Modelle',
  'AI Defaults': 'KI-Standards',
  'Integrations': 'Integrationen',
  'Reminders': 'Erinnerungen',
  'Appearance': 'Aussehen',
  'Shortcuts': 'Tastenkürzel',
  'Account': 'Konto',
  'Agent Tools': 'Agent-Werkzeuge',
  'Users': 'Benutzer',
  'System': 'System',
  'Developer': 'Entwickler',
  'Prepare current chat': 'Aktuellen Chat vorbereiten',
  'Attach the current chat to the Builder project and enable Agent mode plus Shell':
    'Aktuellen Chat dem Builder-Projekt zuordnen und Agent-Modus sowie Shell aktivieren',
  'Developer chat ready — Agent mode and Shell are active.':
    'Entwickler-Chat bereit — Agent-Modus und Shell sind aktiv.',
  'Developer chat ready — Builder project, Agent mode and Shell are active.':
    'Entwickler-Chat bereit — Builder-Projekt, Agent-Modus und Shell sind aktiv.',
  'Could not prepare this chat': 'Dieser Chat konnte nicht vorbereitet werden',
  'Could not start a developer chat': 'Entwickler-Chat konnte nicht gestartet werden',

  // ── Appearance / UI mode / Language ──
  'UI mode': 'UI-Modus',
  'Language': 'Sprache',
  'Simple': 'Einfach',
  'Full': 'Voll',
  'Sidebar': 'Seitenleiste',
  'Chat area': 'Chat-Bereich',
  'Input bar': 'Eingabezeile',
  'Brand name': 'Markenname',
  'Simple hides everything except chat, notes, calendar and shopping — the switches below stay available to bring individual pieces back. Full restores the defaults. Stored per account (applies on every device).':
    'Einfach blendet alles aus ausser Chat, Notizen, Kalender und Einkaufen — mit den Schaltern darunter lässt sich Einzelnes zurückholen. Voll stellt die Standards wieder her. Wird pro Konto gespeichert (gilt auf jedem Gerät).',
  'UI language for this account. Core surfaces are translated; rare corners stay English.':
    'Sprache der Oberfläche für dieses Konto. Die Kern-Oberfläche ist übersetzt; seltene Ecken bleiben Englisch.',
};

let _lang = 'en';
try { _lang = localStorage.getItem(LANG_KEY) || 'en'; } catch (_) {}

export function t(s) {
  return (_lang === 'de' && DE[s]) || s;
}

export function getUILang() { return _lang; }

export async function setUILang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch (_) {}
  try {
    await fetch('/api/prefs/ui_language', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: lang }),
    });
  } catch (_) {}
  // Reload instead of live-retranslating: no reverse-translation state to
  // keep, and every module re-renders in the new language from scratch.
  location.reload();
}

// UI-chrome roots whose descendant text nodes may be translated. User
// content (chat messages, note bodies, session names …) lives outside
// these — with the deliberate exception of exact dictionary hits inside
// generic buttons/labels, which is the accepted tradeoff of this layer.
const ROOTS = [
  'button', 'label', 'option', 'h1', 'h2', 'h3', 'h4', 'h5', 'th', 'summary',
  '.section-title', '.list-item', '.vis-label', '.vis-hint', '.modal-header',
  '.welcome-sub', '.welcome-tip', '.shopping-done-head', '.shopping-empty',
  '.settings-nav-item', '.export-dropdown-item', '.notes-header-btn-label',
].join(', ');

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SVG', 'CODE', 'PRE']);

function _translateTextNodes(rootEl) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('svg')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const hit = DE[trimmed];
    if (hit) n.nodeValue = raw.replace(trimmed, hit);
  }
}

function _translateAttrs(scope) {
  scope.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((el) => {
    const hit = DE[el.getAttribute('placeholder')];
    if (hit) el.setAttribute('placeholder', hit);
  });
  scope.querySelectorAll('[title]').forEach((el) => {
    const hit = DE[el.getAttribute('title')];
    if (hit) el.setAttribute('title', hit);
  });
}

export function applyI18n(scope) {
  if (_lang !== 'de') return;
  const root = scope || document.body;
  if (!root || root.nodeType !== 1) return;
  if (root.matches && root.matches(ROOTS)) _translateTextNodes(root);
  root.querySelectorAll(ROOTS).forEach(_translateTextNodes);
  _translateAttrs(root);
  if (root.matches && (root.matches('input[placeholder], textarea[placeholder]') || root.hasAttribute('title'))) {
    _translateAttrs(root.parentElement || root);
  }
}

function _startObserver() {
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === 1) applyI18n(node);
      });
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

async function _reconcileWithServer() {
  try {
    const r = await fetch('/api/prefs/ui_language', { credentials: 'same-origin' });
    if (!r.ok) return;
    const d = await r.json();
    const server = d && typeof d.value === 'string' ? d.value : null;
    if (server && server !== _lang) {
      try { localStorage.setItem(LANG_KEY, server); } catch (_) {}
      location.reload();
    }
  } catch (_) {}
}

// Boot: module scripts run after DOM parse, so the static markup is ready.
if (_lang === 'de') {
  applyI18n(document.body);
  _startObserver();
}
_reconcileWithServer();

// Non-module consumers (settings.js wiring, console debugging)
window.t = t;
window.getUILang = getUILang;
window.setUILang = setUILang;
window.applyI18n = applyI18n;
