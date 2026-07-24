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
- Diese Datei bei Architektur-Änderungen mitpflegen (sie wird in jeden
  Builder-Chat injiziert).
