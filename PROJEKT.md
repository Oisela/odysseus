# Odysseus Builder

Selbst-Entwicklungs-Projekt: Odysseus baut hier an sich selbst. Workspace =
der Arbeits-Clone `/app/data/dev/odysseus` (NIE /app anfassen). Werkzeug und
Gesetz ist die Skill `odysseus-entwickler` (dev.sh-Workflow, Gates,
Token-Disziplin) — bei Sessionstart zuerst per bash lesen:
`cat /app/data/dev/SPICKZETTEL.md` und `cat /app/data/dev/ROADMAP.md`.

## Pflichten jeder Runde (nicht optional)

1. **ROADMAP.md aktuell halten** (`/app/data/dev/ROADMAP.md`, per bash):
   Nach JEDEM Merge den Eintrag abhaken ([x]), neue Wünsche/Bugs aus dem
   Chat ins passende Paket bzw. den Eingang einsortieren, Erledigtes aus
   dem Eingang in die Versions-Abschnitte verschieben. Eine Runde ohne
   Roadmap-Update gilt als unfertig — genau wie eine ohne Doku.
2. **SPICKZETTEL.md ergänzen**, wenn eine Erkundung >2 Kommandos gekostet hat.
3. Gates einhalten: Gate 1 einmal pro Branch (vor erstem Beta-Sync),
   Gate 2 IMMER vor Prod.

## Stand

- Versionierung: APP_VERSION auf dev = offenes Paket; Alessio zählt 3.1, 3.2, …
- Roadmap-Arbeit wird standardmäßig gebündelt: Auch Bugs und Polish laufen in
  einem Stapel über eigene `feat/*`-Branches, einen gemeinsamen Beta-Build und
  anschließend genau ein Prod-Update. Ein einzelner Bug darf den Batch nicht
  mehr mit `dev.sh bugfix` unterbrechen und ein Zwischen-Update erzwingen.
- Developer → „Urgent single bugfix“ und Roadmap → „Urgent single bugfix to
  dev“ bleiben als ausdrücklich gewählte Ausnahme für wirklich dringende
  Einzel-Fixes erhalten. Der Bug-Track endet zunächst auf `dev`; den Zeitpunkt
  des Produktions-Neustarts bestimmt Alessio mit dem Update-Knopf.
- Der Chat-Composer behandelt die iPhone-Return-Taste bei nichtleerem Text als
  Senden; während eines laufenden Streams wird der Text wie bisher eingereiht.
- Das Roadmap-Item „Real speech to text“ wurde am 2026-08-18 gegen den
  vorhandenen Code und Alessios Praxistest geprüft und als bereits erfüllt
  geschlossen; dafür ist kein weiterer Build nötig.
- Text-to-Speech ist ebenfalls bereits vorhanden: aktivierbar in den
  Einstellungen, mit „Read aloud“-Knopf an KI-Antworten sowie optionalem
  automatischem Vorlesen. Vor einer neuen TTS-Karte zuerst klären, welche
  konkrete Erweiterung gegenüber diesem Bestand fehlt.
- Mobile Browser dürfen eine veraltete Modell-Endpoint-ID behalten: Beim
  Erstellen einer Session fällt Odysseus kontrolliert auf die übermittelte URL
  zurück; die bestehende Berechtigungsprüfung für rohe URLs bleibt aktiv.
- Mobile Toasts berücksichtigen die obere und rechte iPhone-Safe-Area, damit
  Statusmeldungen nicht von Dynamic Island oder Systemstatus überdeckt werden.
- In Arbeit für v4.3: eine reduzierte „Server live"-Ansicht mit ausschließlich
  aggregierten CPU-/RAM-/Disk-/Uptime-Werten für angemeldete Nicht-Admins;
  Deployment- und Developer-Kontrollen bleiben admin-only.
- Normale Chat-/Agent-Läufe bleiben serverseitig detached aktiv, wenn Browser
  oder App geschlossen beziehungsweise suspendiert werden. Beim Zurückkehren
  hängt sich der Client an denselben Lauf, statt ihn abzubrechen und eine
  potenziell doppelte Fortsetzung zu starten.
- Der `remnote-edit-later`-Workflow darf `list_tagged_rems: 0` bei RemNotes
  eingebautem Edit-Later-Powerup nicht als leere Inbox werten: Die normale
  Tag-Relation kann trotz sichtbarer offener Rems leer sein. Ohne explizite
  Built-in-Powerup-Abfrage muss er den Widerspruch melden und darf weder eine
  Zahl erfinden noch Rems verändern. Dauerhafter Vertrag:
  `config/skills/remnote-edit-later.md`; Regressionstest:
  `tests/test_remnote_edit_later_skill_contract.py`.
- Diese Datei bei Architektur-Änderungen mitpflegen (sie wird in jeden
  Builder-Chat injiziert).
