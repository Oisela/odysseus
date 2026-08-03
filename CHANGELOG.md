# Changelog

Alle wichtigen Änderungen dieses Odysseus-Forks werden hier in
veröffentlichungsnaher Form dokumentiert.

## [Unreleased]

### Behoben

- Die Return-Taste der iPhone-Tastatur sendet nichtleere Chatnachrichten nun
  wie der Send-Button; während eines laufenden Streams bleibt das Einreihen
  weiterer Nachrichten erhalten.
- Veraltete Modell-Endpoint-IDs aus mobilen Browserdaten blockieren das
  Erstellen eines Chats nicht mehr; der sichere URL-Fallback bleibt weiterhin
  an die bestehende Endpoint-Berechtigungsprüfung gebunden.
- Mobile Statusmeldungen halten Abstand zur iPhone-Safe-Area und werden nicht
  mehr von Dynamic Island oder Statussymbolen überdeckt.

## [3.10.0-beta] - 2026-07-29

### Hinzugefügt

- Live-Status für CPU, Load, RAM, Datenträger und Uptime auf der
  Developer-Hauptseite.
- Bearbeitbare Roadmap-Zielversionen und Sammelzuweisung für geplante
  Einträge.
- Auswählbare Notes-Tags mit Chips und direktem Anlegen neuer Tags.
- Kompaktes Always-on-top-Pomodoro-Fokusfenster mit Statistiken und
  Minimalansicht.
- Sicherer Tailscale-HTTPS-Zugang für die getrennte Beta-Instanz.

### Geändert

- Roadmap-Werkzeugleiste responsiv überarbeitet.
- Erledigt-Spalte auf die letzten zehn Einträge begrenzt.
- Ein gestarteter Roadmap-Build wechselt sofort auf „In Arbeit“.
- Minimierte Fensterchips bleiben innerhalb des Chatbereichs und werden bei
  Layoutänderungen neu begrenzt.
- Modal-Auto-Wiring von periodischem Polling auf DOM-Beobachtung umgestellt.
- Pomodoro-PiP zentriert, verdichtet und visuell vereinheitlicht.

### Behoben

- Fehlender Abstand zwischen Developer-Titel und Fenstersteuerung.
- Langsame beziehungsweise doppelte Reaktion beim Minimieren.
- Frei positionierte Chip-Gruppen wurden nach dem Begrenzen nochmals um ihre
  halbe Breite verschoben und konnten dadurch unter die Sidebar ragen.
  Freie Dock-Koordinaten verwenden nun keine Zentrier-Transformation mehr;
  lange Chip-Titel werden innerhalb der Chatbreite gekürzt.
- Beim Zurückandocken konnten zuvor abgetrennte Einzelchips als absolute
  Elemente hinter der Sidebar liegen bleiben. Der Home-Dock baut die Gruppe
  nun vollständig neu auf und repariert verwaiste Chips beim nächsten
  Layout-Sync automatisch.
- Falsche Roadmap-WIP-Zustände nach fehlgeschlagenem Builder-Chat.
- Verlust bekannter Tags nach dem Wechsel ins Archiv.
- Unsortierte Erledigt-Ausgabe bei weniger als zehn Einträgen.
- Zu häufige oder parallele Host-Metrik-Abfragen.
- Ausfall eingebauter MCP-Server nach ungepinnter Installation von `mcp 2.x`;
  Odysseus bleibt bis zur API-Migration auf `mcp<2`.
- Nicht erreichbare beziehungsweise unverschlüsselte Beta-Portführung; Beta
  wird nun über Tailscale Serve mit HTTPS bereitgestellt.

### Validierung

- 45 relevante UI-, Backend- und MCP-Regressionstests auf dem aktuellen
  Beta-Stand `639e268` grün.
- Der zuletzt vollständige Lauf auf `f31ad16` bestand 4.641 Tests und
  übersprang 4; nach den beiden abschließenden Dock-Fixes wurde gezielt die
  aktuelle 45-Test-Suite erneut ausgeführt.
- Sechs unabhängige Alt-/Umgebungstests bleiben zur separaten Prüfung offen.

Details: [v3.10-Beta-Dokumentation](docs/v3.10-beta.md).
