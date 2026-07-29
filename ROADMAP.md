# Odysseus Roadmap — lebt in /app/data/dev/ROADMAP.md

Alessio trägt hier Bugs/Ideen ein (oder diktiert sie dem Entwickler: „trag in die Roadmap ein: …"). Der Entwickler liest sie bei JEDEM Start, arbeitet oben nach unten, hakt Erledigtes ab ([x]) und sortiert Neues ein.

## v3.1.0 — RELEASED 2026-07-15 (Prod @ e56818e)
- [x] Versionierung (APP_VERSION 3.1.0) + Kanal-Badge in der Sidebar
- [x] System-Karte in Settings mit "Update"-Knopf (feat/system-status-card)
- [x] Create-Folder-Button im Projekt-Ordner-Picker (feat/create-folder-button)
- [x] Projekt-Standard-Modell inkl. Dropdown-Fix für Gemini (feat/project-default-model)
- [x] Anthropic-History-Caching (feat/anthropic-history-caching) — größter Kostenhebel
- [x] Fix: Stale Pending-Draft schluckte Sends (fix/pending-chat-precedence)
- [x] Fix: Workspace-Pill klebte nach Projekt-Chat (fix/workspace-switch-leak)
- [x] Fix: Queued Task-Runs überleben Foreground-Aktivität (fix/queued-task-abort)

## v3.2.0 — RELEASED 2026-07-16 (Prod @ b76be32)
- [x] Entwickler-Seite, Projekt-Panel, Entwickler-Werkzeuge und Tool-Output-Trunkierung
- [x] Chroma-Collection-Präfix pro Instanz, Kalender-API-Base-Fix und E-Mail-Papierkorb
- [x] Pomodoro-Einzel-Einträge/Statistik/Skip-Break und stabile manuelle Task-Runs

## v3.3 — RELEASED 2026-07-16
- [x] Beta-Start/Stop auf der Entwickler-Seite und Version-Switcher mit Reload-Banner
- [x] SSH-Quoting-Hotfix und Warnung für alte Switch-Ziele
- [x] Entwickler-Persona als Builder-Projekt-Template

## v3.5 — RELEASED 2026-07-17 (Prod @ c496c42)
- [x] Parallele Tool-Calls, Kontext-Kompaktierung und Claude-5-Kontextfenster-Fix
- [x] Projekt-Chat-Sortierung, Endpoint-Umbenennung und Quote-and-Ask
- [x] Korrektur-Memories, einklappbare Roadmap und ask_user-Options-Fix

## v3.6 — RELEASED 2026-07-21 (Prod @ c0a708d)
- [x] Projekt-Preset-Scope, E-Mail-Stale-Serve und ask_user-Options-Layout
- [x] Notes für schmale Panels, TickTick-UI und Projekt-von-Neuem-Chat-Fix
- [x] Pomodoro-Sounds, Hauptnavigation, vorzeitiges Buchen und Kalender-Logging
- [x] Roadmap-Screenshots, Sidebar-Dot-Fix, PDF-Markierungen und PDF-Textmarker
- [x] Delegate-Worker, Ntfy-Integration, Shopping-&-Recipes-Modul und globale Chat-Suche
- [x] Simple-UI-Modus, deutsche Kernoberfläche, Persona-Skills/-Prompt-Dateien und Mobile-Politur
- [x] Persistente PDF-Markierungen und PC-Terminal-Zugriff als umgesetzt dokumentiert

## v3.7 — RELEASED 2026-07-22 (Prod @ b4dbb84)
- [x] Model-Picker-/Modell-Call-Refactors, Button-min-height, E-Mail-Filter-Tabelle und serverseitige Projekt-Presets
- [x] Notes-Event-Delegation, zentraler Upload-Bild-Regex und Prefs-Store-Refactor
- [x] Vollständiger eager-modulepreload
- [x] Sortierbare Todos, Fenster-Positions-Restore und Listen-Umbenennung
- [x] Pomodoro-Presets/Trink-Tracker, Skill-Paket und Sticky-Session-Tools-Fix

## v3.8 — RELEASED 2026-07-23 (Prod @ 93789ad)
- [x] SRS-/Flashcard-Modul als eigener machbarer RemNote-Kern
- [x] Separate Accounts als eigene Beta-Runde
- [x] Pomodoro-UI-Redesign
- [x] Upstream-Merge-Check als Runden-Routine

## v3.9.0 — RELEASED 2026-07-28 (Prod @ 3427f75)

### Ausgeliefert
- [x] **Get better:** Nachrichtenaktion neben Rewrite, Explain,
      Generate from here und Fork. Startet im Hintergrund einen Fork mit
      vordefiniertem Verbesserungsauftrag und analysiert Halluzinationen,
      unnötige Nachfragen und Tool-Aufrufe, um konkrete Skill- und
      Entwicklerverbesserungen vorzuschlagen.
- [x] **Developer als Hauptseite:** steht für Admins direkt in der Sidebar
      wie Shopping und RemNote. Roadmap und Deployment-Steuerung verwenden
      ein eigenes großes, dockbares Fenster; Settings → Developer leitet
      dorthin weiter. Der bestehende Panel-Code wird verschoben statt
      dupliziert.
- [x] **Roadmap-Build-Pipeline:** Listen-/Board-Ansicht, strukturierte
      Feature-Definitionen, Modellwahl, verknüpfte Builder-Chats,
      Build-Status und Beta-Abnahme.
- [x] **RemNote-Hauptseite und Offline-Puffer:** Bridge-Status, gepufferte
      Karten, erneutes Senden, Bearbeiten und Debug-Informationen direkt
      in Odysseus.
- [x] **Notes-WYSIWYG:** Markdown-Roundtrip, Listen und Checklisten,
      Überschriften, Trennlinien, Live-LaTeX-Inseln und filterbewusstes
      Quick-Add.
- [x] **Chat-/UI-Politur:** Quote-and-Ask übernimmt wieder die originale
      LaTeX-Quelle, New Chat löst das aktive Projekt korrekt und minimierte
      Fensterchips sind sortierbar und an benannte Positionen andockbar.
- [x] **Release-Prüfung:** Beta #35/#36 auf Desktop und Mobile geprüft;
      17 fokussierte Tests sowie Syntaxchecks grün. Gesamtlauf:
      4610 bestanden, 3 übersprungen; 9 bekannte unabhängige Alt-Fehler
      unverändert.

### Chat-Chaining & Token-Effizienz
- [ ] **Chat-Chaining / kompakte Delegation:** Chats bzw. spezialisierte Worker können Aufgaben übernehmen; an den Hauptchat gehen nur Ergebnis, Belege und ein kompaktes Hand-off statt des vollständigen Verlaufs zurück.
- [ ] **Token-Budget & Kontext-Effizienz:** Budgets pro Aufgabe, komprimierte Übergaben, Code-/Projekt-Map, gezielte Ausgaben, Caching häufiger Architektur-/Git-/Testinformationen und günstige Worker für Extraktion, Suche und Review. **Erste Ausbaustufe gebaut:** Delegate-Worker begrenzt Task- und Antwortbudget, kürzt große Hand-offs transparent und zeigt beide Budgets in Settings → Delegate Worker; weiter offen: projektweite Maps/Caches und Worker-Routing.

### Weiter offen nach Release
- [ ] **RemNote-Puffer-Flush als Scheduled Task:** den vorhandenen Task über die UI anlegen (kein Code; Prompt im Setup-Repo).
- [ ] **Agent-Modus-Bug:** Neuer Chat mit aktivem Agent-Modus meldet gelegentlich „kein Agent-Modus"; Reproduktion mit Screenshot, Wortlaut und Ablauf sammeln.
- [ ] **Doppelte Chat-Module:** `chat.js` und `chatRenderer.js` werden einmal über Root-Script-Tags mit Query und zusätzlich per Import geladen; Verhalten prüfen und doppelte Modulinstanzen entfernen.
- [ ] **Altbestand-Tests prüfen:** `test_email_linkify_security_js`, `test_security_regressions::test_email_thread_rendering_sanitizes_body_html`, `test_preset_local_storage_js` und `test_security_regressions::test_gmail_mcp_preset_uses_contained_oauth_paths` — echte Regression oder veraltete Tests klären.

### Neue Features
- [ ] **Server-Live-Ansicht:** nicht nur für Admins eine sichere Live-Ansicht des Hosts (CPU, RAM usw.).
- [ ] **Modell-/API-Preisvergleich:** Kosten und Eignung der integrierten Modelle/Anbieter (z. B. Gemini, Claude, ChatGPT) transparent vergleichen, besonders für Physik/Mathe.
- [x] **RemNote-Offlinespeicher:** als RemNote-Hauptseite mit Bridge-Status,
      Offline-Puffer und gezieltem erneutem Senden umgesetzt.

## v3.10 — IN ARBEIT 2026-07-29

- [~] **Developer-Live-Status und Roadmap-Politur:** CPU/RAM/Hoststatus sicher
      und live anzeigen (5-Sekunden-Aktualisierung plus Refresh), Board-/Listen-
      Werkzeugleiste dynamisch gestalten und die Erledigt-Spalte auf die letzten
      zehn Einträge begrenzen.
- [~] **Roadmap-Versionen und Workflow:** Zielversion pro Eintrag bearbeitbar
      machen, alle geplanten Einträge gesammelt einer Version zuweisen und einen
      gestarteten Build sofort als „In Arbeit“ markieren.
- [~] **Minimierte Fenster im Chat halten:** frei verschiebbare Fensterchips
      ausschließlich innerhalb des Chatbereichs platzieren, bei Layoutänderungen
      neu begrenzen und Abstände sowie Reaktionszeit beim Minimieren korrigieren.
- [~] **Notes-Tags auswählbar machen:** vorhandene Tags als Mehrfachauswahl und
      Chips anbieten sowie neue Tags direkt hinzufügen, ohne das kompatible
      gespeicherte Label-Format zu verändern.
- [~] **Kompakter Pomodoro-Fokusmodus nach TickTick:** Always-on-top-PiP als
      kleines Fokusfenster mit Start/Pause, Restzeit, Tages-/Wochenfokus und
      einklappbarer Minimalansicht; bei fehlender Fensterpositionierungs-
      Berechtigung einen kompakten Browser-Fallback verwenden.

## Später / Ideen-Speicher
- [ ] **Selbst-Loop-Retry:** Odysseus-Entwickler soll eine Runde bevorzugt selbst bauen lassen; zuvor verworfen, weil der Selbst-Loop die Arbeit wirklich selbst leisten soll.

## Eingang (unsortiert — Alessio wirft hier rein)
