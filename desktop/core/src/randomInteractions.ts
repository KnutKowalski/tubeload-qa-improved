import { ValidationError } from "./errors";
import { LIMITS } from "./limits";
import { detectUrlKind, isAllowedYouTubeUrl } from "./url";
import type { InteractionStep, RandomInteractionConfig, UrlKind } from "./types";

/**
 * Zufalls-Interaktionen: Pause, Sprung vor/zurück und Videowechsel erfolgen nicht
 * zu starren Sekunden, sondern in unregelmäßigen Abständen. Der Zufall ist an einen
 * Seed gebunden – dieselben Einstellungen plus derselbe Seed ergeben exakt denselben
 * Ablauf, Lauf für Lauf. Dadurch bleibt die Messung wiederholbar und vergleichbar.
 *
 * Wichtig: Dieser Modus testet, wie schnell die Wiedergabe nach unregelmäßigen
 * Eingriffen wieder stabil läuft. Er ist kein Modus, der "menschliches Zuschauen"
 * simuliert, um Kennzahlen zu verändern: die Laufzeit bleibt durch LIMITS begrenzt,
 * es gibt keine Verlängerung über das Ende des Videos hinaus, und jede Aktion wird
 * einzeln mit ihrer Erholzeit protokolliert.
 */

export const RANDOM_DEFAULTS: RandomInteractionConfig = {
  events: 6,
  minGapSec: 20,
  maxGapSec: 90,
  minPauseSec: 3,
  maxPauseSec: 15,
  minSeekSec: 10,
  maxSeekSec: 60,
  pauseShare: 40,
  seekShare: 40,
};

/** Deterministische PRNG (mulberry32): gleicher Seed -> gleiche Zahlenfolge. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = (Math.imul(t ^ (t >>> 15), t | 1) ^ t) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Jeder Durchlauf eines Laufes bekommt einen eigenen, aber berechenbaren Seed.
 * Die Mischung ist absichtlich eine Lawine (XOR, Shifts, Multiplikation): eine
 * bloße Addition würde Seeds kollidieren lassen, zum Beispiel
 * seedForLoop(1, 1) == seedForLoop(1640531528, 2).
 */
export function seedForLoop(baseSeed: number, loop: number): number {
  let z = ((baseSeed >>> 0) ^ Math.imul(loop, 0x9e3779b9)) >>> 0;

  z = (z ^ (z >>> 16)) >>> 0;
  z = Math.imul(z, 0x45d9f3b) >>> 0;
  z = (z ^ (z >>> 13)) >>> 0;

  return z;
}

function whole(v: unknown, def: number, min: number, max: number, field: string): number {
  if (v === undefined || v === null || v === "") return def;

  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`"${field}" muss eine Zahl sein.`);
  }

  const n = Math.round(v);

  if (n < min || n > max) {
    throw new ValidationError(`"${field}" muss zwischen ${min} und ${max} liegen.`);
  }

  return n;
}

/** Prüft und normalisiert die Zufalls-Einstellungen aus der Dashboard-/API-Eingabe. */
export function normalizeRandomConfig(raw: unknown): RandomInteractionConfig {
  if (raw === undefined || raw === null || raw === "") return { ...RANDOM_DEFAULTS };

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError('"random" muss ein Objekt mit den Zufalls-Werten sein.');
  }

  const o = raw as Record<string, unknown>;

  for (const k of Object.keys(o)) {
    if (
      ![
        "events",
        "minGapSec",
        "maxGapSec",
        "minPauseSec",
        "maxPauseSec",
        "minSeekSec",
        "maxSeekSec",
        "pauseShare",
        "seekShare",
      ].includes(k)
    ) {
      throw new ValidationError(`Unbekanntes Feld "${k}" in "random".`);
    }
  }

  const cfg: RandomInteractionConfig = {
    events: whole(o.events, RANDOM_DEFAULTS.events, 1, LIMITS.maxRandomEvents, "events"),
    minGapSec: whole(o.minGapSec, RANDOM_DEFAULTS.minGapSec, LIMITS.minInteractionGapSec, LIMITS.maxRandomGapSec, "minGapSec"),
    maxGapSec: whole(o.maxGapSec, RANDOM_DEFAULTS.maxGapSec, LIMITS.minInteractionGapSec, LIMITS.maxRandomGapSec, "maxGapSec"),
    minPauseSec: whole(o.minPauseSec, RANDOM_DEFAULTS.minPauseSec, 1, LIMITS.maxPauseSec, "minPauseSec"),
    maxPauseSec: whole(o.maxPauseSec, RANDOM_DEFAULTS.maxPauseSec, 1, LIMITS.maxPauseSec, "maxPauseSec"),
    minSeekSec: whole(o.minSeekSec, RANDOM_DEFAULTS.minSeekSec, 1, LIMITS.maxSeekSec, "minSeekSec"),
    maxSeekSec: whole(o.maxSeekSec, RANDOM_DEFAULTS.maxSeekSec, 1, LIMITS.maxSeekSec, "maxSeekSec"),
    pauseShare: whole(o.pauseShare, RANDOM_DEFAULTS.pauseShare, 0, 100, "pauseShare"),
    seekShare: whole(o.seekShare, RANDOM_DEFAULTS.seekShare, 0, 100, "seekShare"),
  };

  if (cfg.maxGapSec < cfg.minGapSec) {
    throw new ValidationError('"maxGapSec" muss mindestens so groß sein wie "minGapSec".');
  }

  if (cfg.maxPauseSec < cfg.minPauseSec) {
    throw new ValidationError('"maxPauseSec" muss mindestens so groß sein wie "minPauseSec".');
  }

  if (cfg.maxSeekSec < cfg.minSeekSec) {
    throw new ValidationError('"maxSeekSec" muss mindestens so groß sein wie "minSeekSec".');
  }

  if (cfg.pauseShare + cfg.seekShare > 100) {
    throw new ValidationError('"pauseShare" und "seekShare" zusammen dürfen 100 % nicht überschreiten.');
  }

  return cfg;
}

function randInt(rng: () => number, min: number, max: number): number {
  if (max < min) return min;

  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Erzeugt die Schrittfolge für einen Durchlauf. Schritte, die nach Ende der
 * Laufzeit fallen würden, entfallen (die Laufzeit ist die harte Obergrenze).
 * `allowVideoSwitch` ist nur bei Playlists und Kanälen sinnvoll.
 */
export function generateRandomSteps(
  cfg: RandomInteractionConfig,
  maxRuntimeSec: number,
  seed: number,
  allowVideoSwitch: boolean
): InteractionStep[] {
  const rng = mulberry32(seed);
  const steps: InteractionStep[] = [];
  const lastSecond = Math.max(1, maxRuntimeSec - 1);
  const gapFloor = Math.max(LIMITS.minInteractionGapSec, cfg.minGapSec);
  const gapCeil = Math.max(gapFloor, cfg.maxGapSec);

  let at = randInt(rng, 1, Math.min(gapCeil, lastSecond));

  for (let i = 0; i < cfg.events && at <= lastSecond; i++) {
    const roll = rng() * 100;
    let action: InteractionStep["action"];

    if (roll < cfg.pauseShare) action = "pause";
    else if (roll < cfg.pauseShare + cfg.seekShare) action = "seek";
    else action = allowVideoSwitch ? "next" : "seek";

    let value: number | undefined;

    if (action === "pause") {
      // Die Pause darf nicht über die Laufzeit hinausreichen. Ist der Rest zu
      // kurz für die kleinste zulässige Pause, endet der Plan hier - eine
      // gekürzte Pause würde die eingestellte Untergrenze stillschweigend verletzen.
      const room = lastSecond - at;

      if (room < cfg.minPauseSec) break;

      value = randInt(rng, cfg.minPauseSec, Math.min(cfg.maxPauseSec, room));
    } else if (action === "seek") {
      const size = randInt(rng, cfg.minSeekSec, cfg.maxSeekSec);
      value = rng() < 0.5 ? -size : size;
    } else {
      value = undefined;
    }

    steps.push(value === undefined ? { at, action } : { at, action, value });

    // Eine Aktion dauert: die Pause ihre Länge, ein Sprung oder Videowechsel
    // braucht Zeit bis die Wiedergabe wieder läuft. Wird das nicht eingerechnet,
    // startet der nächste Schritt mitten in der laufenden Aktion und die reale
    // Zeitachse driftet gegenüber dem Plan.
    const busy =
      action === "pause"
        ? value ?? 0
        : action === "seek"
          ? LIMITS.interactionRecoveryTimeoutSec
          : LIMITS.interactionRecoveryTimeoutSec + 15; // Videowechsel inklusive Reload

    at += busy + randInt(rng, gapFloor, gapCeil);
  }

  return steps;
}

/** Lesbarer Plan-Text (Anzeige im Dashboard, Nachvollziehbarkeit im Export). */
export function formatRandomPlan(
  cfg: RandomInteractionConfig,
  maxRuntimeSec: number,
  seed: number,
  allowVideoSwitch: boolean,
  baseSeed?: number
): string {
  const steps = generateRandomSteps(cfg, maxRuntimeSec, seed, allowVideoSwitch);

  const seedText = baseSeed === undefined
    ? `Seed ${seed}`
    : `Seed ${baseSeed} (Durchlauf-Seed ${seed})`;

  const head = `Zufallsmodus (${seedText}, ${cfg.events} Aktionen, Abstand ${cfg.minGapSec}–${cfg.maxGapSec} s, Pausen ${cfg.pauseShare} %, Sprünge ${cfg.seekShare} %)`;

  const body = steps
    .map((s) => {
      const clock = `${Math.floor(s.at / 60)}:${String(s.at % 60).padStart(2, "0")}`;

      if (s.action === "seek") return `${clock} seek ${s.value! > 0 ? "+" : ""}${s.value}`;
      if (s.action === "pause") return `${clock} pause ${s.value}`;

      return `${clock} ${s.action}`;
    })
    .join("\n");

  return body ? `${head}\n${body}` : head;
}

/**
 * Plan-Vorschau für das Dashboard: erzeugt genau den Ablauf, den die Session später
 * nutzt, ohne eine Session zu starten. `maxRuntimeSec` (oder `minutes`) begrenzt die
 * Laufzeit, `url`/`kind` entscheiden, ob Videowechsel möglich sind.
 */
export function planFromRequest(raw: unknown): {
  seed: number;
  loopSeed: number;
  runtimeSec: number;
  steps: InteractionStep[];
  plan: string;
} {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("Es wird ein Objekt mit den Zufalls-Werten erwartet.");
  }

  const o = raw as Record<string, unknown>;

  const runtime =
    typeof o.maxRuntimeSec === "number" && Number.isFinite(o.maxRuntimeSec)
      ? o.maxRuntimeSec
      : typeof o.minutes === "number" && Number.isFinite(o.minutes)
        ? o.minutes * 60
        : LIMITS.defaultRuntimeSec;

  const runtimeSec = Math.min(
    Math.max(Math.round(runtime), LIMITS.minRuntimeSec),
    LIMITS.maxRuntimeSec
  );

  let allowSwitch = false;

  if (typeof o.url === "string" && o.url.trim()) {
    // Genau wie bei einer echten Session: nur YouTube-URLs sind erlaubt, sonst
    // würde die Vorschau einen Plan für eine URL zeigen, die beim Start abgelehnt wird.
    if (!isAllowedYouTubeUrl(o.url)) {
      throw new ValidationError("Die URL ist keine zulässige YouTube-URL.");
    }

    const kind = detectUrlKind(o.url);

    allowSwitch = kind === "playlist" || kind === "channel";
  }

  const cfg = normalizeRandomConfig(o.random);
  const seed = whole(o.interactionSeed, 1, 0, LIMITS.maxSeed, "interactionSeed");

  // Die Session nutzt pro Durchlauf einen aus dem Basis-Seed abgeleiteten Seed.
  // Die Vorschau zeigt Durchlauf 1 - sonst wäre sie nicht der tatsächliche Plan.
  const loopSeed = seedForLoop(seed, 1);
  const steps = generateRandomSteps(cfg, runtimeSec, loopSeed, allowSwitch);

  return {
    seed,
    loopSeed,
    runtimeSec,
    steps,
    plan: formatRandomPlan(cfg, runtimeSec, loopSeed, allowSwitch, seed),
  };
}
