# Odysseus Roadmap — lebt in /app/data/dev/ROADMAP.md

Alessio trägt hier Bugs/Ideen ein (oder diktiert sie dem Entwickler: „trag in die Roadmap ein: …").
Der Entwickler liest sie bei JEDEM Start und arbeitet oben nach unten.

Marker: `[?]` under consideration · `[ ]` planned · `[~]` in progress · `[!]` ready to test · `[x]` done.
Status NUR über `dev.sh roadmap-status <rm-id> <marker>` setzen — die stabile ID steht auf einer
Folgezeile, ein sed trifft den falschen Eintrag.

Aufgeräumt am 2026-07-31: ausgelieferte Runden stehen unten als je eine Zeile; die Details dazu
im Setup-Repo (README 6a–6l) und in der Git-Historie. Sicherung der alten Fassung:
`data/backups/ROADMAP-2026-07-31-vor-aufraeumen.md`.

## v4.17 (Runde 2026-08-19 — Skills erreichen das Modell wieder)

- [!] Skill-Auswahl: deutsche Anfragen verloren Skills und Werkzeuge
      **Beschreibung:** Der Absichts-Erkenner kennt nur englische Muster, also galt
      JEDE deutsche Nachricht als `low_signal`. Daran hingen zwei Riegel: Skills
      wurden komplett aus dem Prompt gestrichen (`suppress_skills`), und der
      skill-eigene Werkzeug-Include lief nie. Beides gated jetzt auf
      `_casual_low_signal_turn` statt `low_signal`.
      **Version:** v4.17
- [!] Skills können MCP-Werkzeuge anfordern (`unlocks_toolsets`)
      **Beschreibung:** `requires_toolsets` ist ein GATE — es versteckt die Skill,
      wenn ein Name fehlt, und geprüft wird nur gegen native Tools. Eine Skill, die
      dort ein MCP-Tool eintrug, löschte sich damit selbst aus dem Index. Neues Feld
      `unlocks_toolsets` fügt nur hinzu und versteckt nie; MCP-Namen werden über den
      MCP-Manager auf die laufende Server-ID aufgelöst.
      **Version:** v4.17
- [!] MCP-Server-Erkennung: Tippfehler und mehrwortige Namen
      **Beschreibung:** Verglichen wurde der volle Servername als Teilstring. In der
      Session vom 19.08. stand nie „remnote", sondern „rmenote"/„remntoe" — die
      Erkennung löste kein einziges Mal aus. Jetzt zusätzlich Namens-Token und ein
      Vertipper gleicher Länge. Einfügen/Löschen bleibt abgelehnt, sonst würde
      „remote" auf „remnote" matchen.
      **Version:** v4.17
- [!] Skill-Extraktor: Duplikat-Check war toter Code
      **Beschreibung:** Verglichen wurde `skill["title"]` — ein Feld, das das Schema
      nicht mehr ausgibt. Also immer Vergleich gegen "" und nie ein Treffer: jede
      Extraktion wurde geschrieben. Ergebnis waren 23 RemNote-Skills, die sich
      gegenseitig aus den drei Relevanz-Plätzen verdrängten. Jetzt Vergleich gegen
      name/description (title bleibt für Altlasten) plus Erkennung umformulierter
      Duplikate.
      **Version:** v4.17

## v4.1 (offenes Paket)
- [?] Bug (Altbestand): chat.js und chatRenderer.js werden DOPPELT
      <!-- ody:id=rm-e7e7df2e-efc -->
      **Beschreibung:** geladen — einmal als Root-Script-Tag mit ?v=20260630…-Query,
      einmal nackt über Imports anderer Module = ZWEI Modul-Instanzen
      (Seiteneffekte laufen doppelt). Fix wäre: stale ?v=-Queries von
      den Tags entfernen (Verhalten vorher prüfen!). Die
      modulepreload-Liste bildet den Ist-Zustand ab (beide URLs).
      **Version:** v4
- [?] Tests (Altbestand, schlagen schon auf dev fehl):
      <!-- ody:id=rm-a4e5227f-d3b -->
      **Beschreibung:** test_email_linkify_security_js (href-Escaping),
      test_security_regressions::test_email_thread_rendering_sanitizes_
      body_html, test_preset_local_storage_js,
      test_security_regressions::test_gmail_mcp_preset_uses_contained_
      oauth_paths — prüfen: echte Regression oder veralteter Test.
      (Volle Suite auf Windows-PC hat zusätzlich ~129 Umgebungs-Fails
      — maßgeblich ist der Lauf im Container.)
      **Version:** v4
- [?] Aus v3.6 weiter offen: RemNote-Puffer-Flush-Task in der UI
      <!-- ody:id=rm-6807d51d-0e8 -->
      **Beschreibung:** anlegen; vager Agent-Modus-Bug (Repro sammeln).
      **Version:** v4
- [?] **Feature:** preis verglaich von api, also wie integlietn, wie interligent in pyhsi wie viel kosten das modell, also zwischen gemini claude und chapgt (2026-07-22)
      <!-- ody:id=rm-18e2110b-4ca -->
      **Version:** v4
- [?] **Feature:** developer road map delit butten fals ich eine feuter nicht machen will
      <!-- ody:id=rm-ea3ed91d-6f2 -->
      **Version:** v4
- [ ] **Check-Ritual findet keine undefinierten Variablen**: `node --check`
      <!-- ody:id=rm-bd587e07-14e -->
      **Beschreibung:** prüft nur Syntax — der `modal is not defined`-Bug lebte deshalb
      unbemerkt im Repo. Vorschlag: ESLint mit `no-undef` (nur diese Regel,
      keine Style-Diskussion) in `dev.sh check` aufnehmen. Ein Lauf hätte
      diesen Bug und seine Geschwister sofort gezeigt.
      **Version:** v4
- [ ] **Keine Tests für notesRichEditor**: der Roundtrip md → Editor-HTML
      <!-- ody:id=rm-1da50488-6e7 -->
      **Beschreibung:** → md ist gut automatisierbar (Stabilität über N Zyklen, Mathe/
      Checkboxen/Fences verbatim). Wäre die billigste Absicherung gegen
      Datenverlust in Notizen.
      **Version:** v4
- [ ] **Mobile ungetestet** in dieser Runde: Insel-Quellbearbeitung und
      <!-- ody:id=rm-29a3957b-016 -->
      **Beschreibung:** die Dock-Anker auf Touch (Desktop im Browser verifiziert, 30+ Checks
      grün). Screenshots vom Handy willkommen.
      chat.js/chatRenderer.js, die 4 Alt-Test-Fails. Nicht angefasst.
      **Version:** v4
- [ ] **Abstände** (Alessio: „die ui mehr platz von unten haben auch auf
      <!-- ody:id=rm-5153a73d-a6c -->
      **Beschreibung:** dem handy oben und unten"): Composer klebte am Viewport-Rand → 10 px
      Luft; auf Mobile wird die Notch-Safe-Area zur ÄUSSEREN Lücke statt
      das Eingabefeld dicker zu machen, plus etwas mehr Luft zur
      Titelzeile. Abhaken nach Beta-Test.
      **Version:** v4
- [?] **Feature:** Testpunkte direkt an der Roadmap-Karte abhaken (Alessio 2026-07-31)
      <!-- ody:id=rm-v41-testpunkte -->
      **Beschreibung:** Statt einer PDF/Datei pro Runde trägt jede Karte ihre eigenen
      Testpunkte. Der Agent füllt sie beim Erreichen von [!], Alessio hakt sie an der
      Karte ab. Neues Detailfeld (**Test:** pro Zeile, analog zu Akzeptanzkriterien),
      Fortschritts-Chip (3/5), Häkchen wird in ROADMAP.md persistiert.
      **Ziel:** Übersichtlicher als eine separate Datei, die man suchen muss.
      **Version:** v4.1
- [?] **Feature:** Server-Live-Ansicht auch für Nicht-Admins
      <!-- ody:id=rm-v41-serverview-nonadmin -->
      **Beschreibung:** Die CPU-/RAM-/Disk-Karte ist seit v3.10 für Admins da. Offen
      bleibt eine reduzierte, rollenbasierte Ansicht.
      **Version:** v4.1
- [?] **Bug:** numpy 2.4.6 aus data/local überschattet 2.5.1 aus dem Image
      <!-- ody:id=rm-v41-numpy-shadow -->
      **Beschreibung:** /app/.local steht vor den System-site-packages im sys.path des
      App-Users (27 aktive Mappings, alle numpy). Letzter aktiver Rest des
      Cookbook-Unfalls vom 08.07. Fix: numpy* aus data/local löschen, Container
      neu starten, Smoke-Test. NICHT mitten in einer Runde.
      **Version:** v4.1

## Eingang (unsortiert — Alessio wirft hier rein)

## Später / Ideen-Speicher
- [?] Selbst-Loop-Retry: der Odysseus-Entwickler baut eine Runde bevorzugt selbst.
      <!-- ody:id=rm-later-selfloop -->
      **Version:** später

## Ausgeliefert — RELEASED (Details im Setup-Repo README 6a–6l)
- [x] **v4.0** (2026-07-31) Developer-Cycle mit zwei Tracks, Downgrade-Sicherheit + Gate D,
      Anbieter-Parität ChatGPT/Gemini (Bilder, Tools, Skills), Roadmap-Board mit 5 Zuständen.
- [x] **v3.10** (2026-07-29) Developer-Live-Status, Roadmap-Versionen, Notes-Tags, Pomodoro-PiP.
- [x] **v3.9** (2026-07-28) Notes-WYSIWYG, Developer als Hauptseite, Roadmap-Build-Pipeline,
      RemNote-Hauptseite mit Offline-Puffer, Get-better-Aktion, Chip-Dock, Quote-Ask-LaTeX.
- [x] **v3.8** (2026-07-23) SRS-/Flashcard-Modul, separate Accounts, Pomodoro-UI-Redesign,
      Upstream-Merge-Check als Runden-Routine.
- [x] **v3.7** (2026-07-22) Code-Qualitäts-Runde, modulepreload, Notes-Sortierung,
      Fenster-Positionen, Pomodoro-Presets + Wasser-Tracker, Skill-Paket.
- [x] **v3.6** (2026-07-21) Notes-Master-Detail, Shopping & Recipes, Delegate, ntfy,
      PDF-Markierungen, Simple-UI-Modus, i18n EN/DE.
- [x] **v3.5** (2026-07-17) Parallele Tool-Calls, Kontext-Kompaktierung, Quote-and-Ask,
      Korrektur-Memories, Persona „Entwickler".
- [x] **v3.4** (2026-07-16) Switcher-Warnung bei alten Zielen.
- [x] **v3.3** (2026-07-16) Beta-Start/Stop-Knöpfe, Version-Switcher, Reload-Banner.
- [x] **v3.2** (2026-07-16) Entwickler-Seite, Projekt-Panel, Pomodoro-Statistik, Task-Fixes.
- [x] **v3.1** (2026-07-15) Versionierung + Kanal-Badge, System-Karte, Anthropic-Caching.
- [x] **v3.0** (2026-07-14) Self-Improvement-Workflow (WP5), LaTeX, Pomodoro, Projekte.
