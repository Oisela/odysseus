# Changelog

Alle wichtigen Änderungen dieses Odysseus-Forks werden hier in
veröffentlichungsnaher Form dokumentiert.

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
- Falsche Roadmap-WIP-Zustände nach fehlgeschlagenem Builder-Chat.
- Verlust bekannter Tags nach dem Wechsel ins Archiv.
- Unsortierte Erledigt-Ausgabe bei weniger als zehn Einträgen.
- Zu häufige oder parallele Host-Metrik-Abfragen.
- Ausfall eingebauter MCP-Server nach ungepinnter Installation von `mcp 2.x`;
  Odysseus bleibt bis zur API-Migration auf `mcp<2`.
- Nicht erreichbare beziehungsweise unverschlüsselte Beta-Portführung; Beta
  wird nun über Tailscale Serve mit HTTPS bereitgestellt.

### Validierung

- 40 direkt betroffene Regressionstests plus MCP-Pin-Test grün.
- 4.641 Tests im Gesamtlauf bestanden, 4 übersprungen.
- Sechs unabhängige Alt-/Umgebungstests bleiben zur separaten Prüfung offen.

Details: [v3.10-Beta-Dokumentation](docs/v3.10-beta.md).
