# Änderungen gegenüber dem Original-Repo

Diese Version ist der Original-Repo (Stand `79211b9`) plus die hier aufgelisteten Änderungen.
Alle Tests laufen: `npm test` → 139 Tests, 0 Fehler (inkl. End-to-End gegen ein echtes Chromium).

## 1. Neuer Interaktionsmodus: Zufall mit Seed (`interactionMode: "random"`)

Bisher gab es nur ein festes Interaktionsskript, das bei jedem Durchlauf identisch abgespult wurde.
Jetzt kann der Core die Aktionen selbst erzeugen – aber **reproduzierbar**: derselbe Seed ergibt
denselben Ablauf. Das ist kein "Humanmodus", der Zuschauerverhalten nachahmt, sondern ein
Last- und Recovery-Test: unregelmäßige Pausen, Sprünge und Videowechsel, die den Player
belasten und zeigen, wie schnell er wieder stabil spielt.

Neue Datei `desktop/core/src/randomInteractions.ts`:

- `mulberry32(seed)` – kleiner, deterministischer PRNG (kein `Math.random()`).
- `seedForLoop(baseSeed, loop)` – jeder Durchlauf einer Session bekommt einen eigenen,
  aus dem Basis-Seed abgeleiteten Seed. Session A und Session B mit Seed 7 spielen also
  denselben ersten Durchlauf.
- `normalizeRandomConfig(raw)` – prüft und begrenzt alle Zufallsparameter, unbekannte
  Felder werden abgelehnt (statt stillschweigend ignoriert).
- `generateRandomSteps(cfg, maxRuntimeSec, seed, allowVideoSwitch)` – baut die Schrittfolge:
  Abstände, Pausen, Sprünge; Videowechsel nur bei Playlist/Channel.
- `formatRandomPlan(cfg, maxRuntimeSec, seed, allowVideoSwitch, baseSeed)` – menschenlesbarer Plan (`0:30 pause 3`, …).
- `planFromRequest(raw)` – dieselbe Rechnung aus einem rohen Request-Objekt, damit die
  Vorschau exakt dem Plan der späteren Session entspricht.

Standardwerte (alles in `LIMITS` hart begrenzt):

| Parameter | Standard | Zulässig |
|---|---|---|
| Aktionen pro Durchlauf | 6 | 1–20 |
| Abstand zwischen Aktionen | 20–90 s | 2–900 s |
| Pause | 3–15 s | 1–120 s |
| Sprung | 10–60 s | 1–600 s |
| Anteil Pausen / Sprünge | 40 % / 40 % | 0–100 % |
| Seed | 1 | 0–2147483647 |

Der Default-Seed ist 1, damit die Plan-Vorschau im Dashboard ohne weitere Angabe genau dem
Ablauf der dann gestarteten Session entspricht.

## 2. Plan-Vorschau: `POST /api/interaction-plan`

Vor dem Start einer Session kann man sich den Zufallsplan ansehen, ohne eine Session zu
starten (im Dashboard: Button „Plan anzeigen“).

```bash
curl -X POST http://127.0.0.1:7777/api/interaction-plan \
  -H "x-tb-token: $TB_TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=xyz&list=PL1","minutes":30,"interactionSeed":1234,"random":{"events":4}}'
```

Antwort: `{ ok: true, seed, runtimeSec, steps: [...], plan: "Zufallsmodus (Seed 1234, …)" }`.

## 3. Session-Ergebnisse protokollieren den Modus

- `SessionRunner.interactionMeta` liefert `{ interactionMode, interactionSeed }`.
- Das `stopped`-Event gibt die Meta weiter, `SummaryStore.finish()` schreibt sie in die
  Zusammenfassung.
- `export/summaries.csv` hat zwei neue Spalten: `interactionMode`, `interactionSeed`.
  Damit ist nachvollziehbar, welcher Ablauf zu welcher Messung gehört – Voraussetzung, um
  zwei Läufe überhaupt vergleichen zu können.

## 4. Dashboard

- Modus-Auswahl „Skript“ / „Zufall“ bei Session und Zeitplan.
- Felder für die Zufallsparameter (leer = Standardwert, der Core prüft und begrenzt).
- Seed-Feld (0–2147483647).
- „Plan anzeigen“ zeigt den berechneten Ablauf vor dem Start.

## 5. Robustheit: saubere 413 statt abgebrochener Verbindung

`readBody()` lehnte zu große Bodies sofort ab, während der Client noch schrieb – der Client
bekam dadurch je nach Timing `ECONNRESET`/`EPIPE` statt einer lesbaren 413. Jetzt wird der
Body verworfen, aber weiter gelesen (max. 4 MB), die Antwort geht erst nach Ende des
Requests raus. Speicher bleibt dabei auf die Limitgröße begrenzt.

## 6. Tests

- `desktop/core/test/randomInteractions.test.ts` (9 Tests): Determinismus, Limits,
  Abstände, kein Videowechsel bei einfacher Video-URL, Plan-Text, Validierung,
  Vorschau == Session-Plan.
- `desktop/core/test/server.test.ts`: +2 Tests (`/api/interaction-plan` ohne Token 401,
  ungültiger Body 400, gleicher Seed == gleicher Plan, keine Session gestartet;
  Zufallsmodus als Session-Eingabe).
- `desktop/core/test/session.e2e.test.ts`: +1 End-to-End-Test, der den Zufallsmodus zwei Mal
  mit demselben Seed gegen einen echten Chromium laufen lässt und die gemessenen
  Recovery-Zeiten prüft.


## 7. Nachkontrolle der neuen Funktionen (Korrekturen)

Eine Review-Runde über den Zufallsmodus fand sechs Fehler, die jetzt behoben und getestet sind:

1. **Vorschau zeigte einen anderen Plan als die Session.** Die Vorschau rechnete mit dem
   Basis-Seed, die Session mit dem Durchlauf-Seed `seedForLoop(seed, 1)`. Beide nutzen jetzt
   denselben Seed; der Plan-Text nennt beide (`Seed 1234 (Durchlauf-Seed 2458331741)`).
2. **Seed-Mischung war zu schwach.** `baseSeed + loop * 0x9e3779b9` ließ Seeds kollidieren
   (z. B. `seedForLoop(1,1) == seedForLoop(1640531528,2)`). Jetzt werden Seed und Durchlaufnummer
   mehrfach vermischt (XOR, Verschiebung, Multiplikation) – ein Test prüft auf Kollisionen über 30 Seed-/Durchlauf-Kombinationen.
3. **Unvollständige Zufalls-Einstellungen.** Der Runner hat die Einstellungen nicht
   normalisiert: fehlende Felder (z. B. `pauseShare`) landeten als `undefined` in der
   Zufallsrechnung. Jetzt normalisiert `session.ts` die Werte, bevor gewürfelt wird.
4. **Pausen unter der Mindestlänge.** Kurz vor Laufzeitende wurde die Pause auf den
   Restseconds gekürzt, auch unter die eingestellte Untergrenze. Jetzt endet der Plan
   stattdessen, wenn kein Platz für die kleinste Pause ist.
5. **Abstände vom Beginn statt vom Ende einer Aktion.** Ein Sprung oder Videowechsel braucht
   Zeit bis die Wiedergabe wieder läuft. Der nächste Schritt startet jetzt erst nach dieser
   Erholzeit (20 s für Sprünge, 35 s bei Videowechseln), sodass die Zeitachse nicht driftet
   und keine am Ende "übersprungenen" Schritte entstehen.
6. **Seed 0 wurde abgelehnt.** `validate.ts` und das Dashboard erlauben Seed 0, die
   Plan-Vorschau verlangte mindestens 1. Jetzt ist 0 überall erlaubt.
7. **Skript im Zufallsmodus.** Wer im Zufallsmodus startete, bekam trotzdem eine
   400-Fehlermeldung, wenn im ausgeblendeten Skriptfeld noch ein alter Text stand und die
   Laufzeit zu kurz war. Im Zufallsmodus wird das Skript jetzt weder gesendet noch geprüft.
8. **Laufzeit der Vorschau.** Ohne Minuten-Eingabe nahm die Vorschau 30 Minuten an, die
   Session bekam den Einstellungsstandard. Die Vorschau nutzt jetzt denselben Standard.
9. **Nachvollziehbarkeit der Ergebnisse.** Die Zusammenfassung und die *Summaries CSV*
   enthalten zusätzlich `plannedRuntimeSec` und `randomConfig` (Aktionen, Abstände, Pausen,
   Sprünge, Anteile). Im Skriptmodus wird kein Seed mehr eingetragen – der war dort sinnlos.
10. **Plan-Vorschau und URLs.** Die Vorschau akzeptiert nur zulässige YouTube-URLs, genau wie
    der Session-Start.

## Bekannte Grenzen / bewusste Entscheidungen

- Der Zufallsmodus weiß nichts über die tatsächliche Videolänge: Sprünge werden am Player
  versucht; schlägt der Sprung fehl, wird die Aktion als `skipped` protokolliert, die
  Session läuft weiter.
- Seeds größer als 2147483647 werden abgelehnt, weil die Seed-Mischung mit 32 Bit arbeitet.
- Pausen und Sprünge sind **keine** Simulation echten Zuschauerverhaltens und beeinflussen
  keine YouTube-Metrik; sie dienen ausschließlich der Belastung des Players.
