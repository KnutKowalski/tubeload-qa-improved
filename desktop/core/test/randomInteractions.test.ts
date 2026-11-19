import { test } from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "../src/errors";
import { LIMITS } from "../src/limits";
import {
  formatRandomPlan,
  generateRandomSteps,
  normalizeRandomConfig,
  planFromRequest,
  RANDOM_DEFAULTS,
  seedForLoop,
} from "../src/randomInteractions";
import { parseSessionInput } from "../src/validate";

const RUNTIME = 1800;

test("Zufallsplan ist deterministisch: gleicher Seed, gleicher Ablauf", () => {
  const a = generateRandomSteps(RANDOM_DEFAULTS, RUNTIME, 42, false);
  const b = generateRandomSteps(RANDOM_DEFAULTS, RUNTIME, 42, false);

  assert.deepEqual(a, b);

  const c = generateRandomSteps(RANDOM_DEFAULTS, RUNTIME, 43, false);
  assert.notDeepEqual(a, c);
});

test("Zufallsplan hält Laufzeit, Abstände und Limits ein", () => {
  const cfg = normalizeRandomConfig({
    events: 20,
    minGapSec: 30,
    maxGapSec: 120,
    minPauseSec: 5,
    maxPauseSec: 30,
    minSeekSec: 10,
    maxSeekSec: 120,
    pauseShare: 50,
    seekShare: 50,
  });

  for (const seed of [1, 7, 99, 123456]) {
    const steps = generateRandomSteps(cfg, RUNTIME, seed, true);

    assert.ok(steps.length <= cfg.events, `mehr Schritte als erlaubt (${steps.length})`);

    let prevEnd = -1;

    for (const s of steps) {
      assert.ok(s.at >= 1 && s.at <= RUNTIME, `Schritt bei ${s.at} s außerhalb der Laufzeit`);

      if (s.action === "pause") {
        assert.ok(s.value! >= cfg.minPauseSec && s.value! <= cfg.maxPauseSec, `Pause ${s.value} s außerhalb der Grenzen`);
        assert.ok(s.at + s.value! <= RUNTIME, "Pause reicht über die Laufzeit hinaus");
      }

      if (s.action === "seek") {
        assert.ok(s.value !== undefined && s.value !== 0, "Sprung ohne Wert");
        assert.ok(Math.abs(s.value!) >= cfg.minSeekSec && Math.abs(s.value!) <= cfg.maxSeekSec, `Sprung ${s.value} s außerhalb der Grenzen`);
      }

      if (prevEnd >= 0) {
        assert.ok(s.at >= prevEnd + LIMITS.minInteractionGapSec, "Schritte kommen zu dicht");
      }

      prevEnd = s.at + (s.action === "pause" ? s.value! : 0);
    }
  }
});

test("Ohne Playlist oder Kanal gibt es keine Videowechsel", () => {
  const cfg = normalizeRandomConfig({ events: 20, pauseShare: 0, seekShare: 0 });

  const noSwitch = generateRandomSteps(cfg, RUNTIME, 5, false);
  const withSwitch = generateRandomSteps(cfg, RUNTIME, 5, true);

  assert.ok(noSwitch.every((s) => s.action !== "next" && s.action !== "previous"));
  assert.ok(withSwitch.some((s) => s.action === "next" || s.action === "previous"));
});

test("Kurze Laufzeit erzeugt weniger Aktionen als gewünscht", () => {
  const steps = generateRandomSteps(normalizeRandomConfig({ events: 20, minGapSec: 60, maxGapSec: 60 }), 120, 3, false);

  assert.ok(steps.length >= 1 && steps.length < 20);
  assert.ok(steps.every((s) => s.at <= 120));
});

test("Seed pro Durchlauf ist berechenbar und unterschiedlich", () => {
  const base = 12345;

  assert.equal(seedForLoop(base, 1), seedForLoop(base, 1));
  assert.notEqual(seedForLoop(base, 1), seedForLoop(base, 2));

  assert.deepEqual(
    generateRandomSteps(RANDOM_DEFAULTS, RUNTIME, seedForLoop(base, 2), false),
    generateRandomSteps(RANDOM_DEFAULTS, RUNTIME, seedForLoop(base, 2), false)
  );
});

test("normalizeRandomConfig: Standards, Grenzen und Fehler", () => {
  assert.deepEqual(normalizeRandomConfig(undefined), RANDOM_DEFAULTS);
  assert.deepEqual(normalizeRandomConfig({}), RANDOM_DEFAULTS);

  assert.equal(normalizeRandomConfig({ events: 3 }).events, 3);
  assert.throws(() => normalizeRandomConfig({ events: 999 }), ValidationError);

  assert.throws(() => normalizeRandomConfig({ maxGapSec: 10, minGapSec: 30 }), ValidationError);
  assert.throws(() => normalizeRandomConfig({ maxPauseSec: 2, minPauseSec: 5 }), ValidationError);
  assert.throws(() => normalizeRandomConfig({ pauseShare: 60, seekShare: 60 }), ValidationError);
  assert.throws(() => normalizeRandomConfig({ events: "sechs" }), ValidationError);
  assert.throws(() => normalizeRandomConfig({ notAField: 1 }), ValidationError);
  assert.throws(() => normalizeRandomConfig(5), ValidationError);
});

test("Plan-Text enthält Seed, Einstellungen und jeden Schritt", () => {
  const plan = formatRandomPlan(RANDOM_DEFAULTS, 600, 7, false);

  assert.ok(plan.includes("Seed 7"));

  const lines = plan.split("\n");

  assert.ok(lines.length >= 2, "Plan ohne Schritte");
  assert.ok(lines[1].match(/^\d+:\d\d (pause \d+|seek [+-]\d+|next|previous)$/));
});

test("planFromRequest: Laufzeit, Seed und Videowechsel aus der URL", () => {
  const video = planFromRequest({ minutes: 20, interactionSeed: 11 });

  assert.equal(video.runtimeSec, 1200);
  assert.equal(video.seed, 11);
  assert.ok(video.steps.every((s) => s.action !== "next" && s.action !== "previous"));

  const playlist = planFromRequest({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
    maxRuntimeSec: 900,
  });

  assert.equal(playlist.runtimeSec, 900);
  assert.equal(playlist.seed, 1);
  assert.ok(playlist.steps.length > 0);

  assert.throws(() => planFromRequest(null), ValidationError);
  assert.throws(() => planFromRequest({ minutes: 30, random: { nope: 1 } }), ValidationError);
  assert.throws(() => planFromRequest({ interactionSeed: 9_999_999_999 }), ValidationError);
});

test("planFromRequest liefert denselben Plan wie die Session-Eingabe", () => {
  const raw = {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    maxRuntimeSec: 1200,
    interactionMode: "random",
    interactionSeed: 77,
    random: { events: 5, minGapSec: 20, maxGapSec: 60 },
  };

  const input = parseSessionInput(raw, { loops: 3, runtimeSec: 1800 });
  const preview = planFromRequest(raw);

  assert.equal(input.interactionMode, "random");
  assert.equal(input.interactionSeed, 77);
  assert.equal(preview.loopSeed, seedForLoop(77, 1), "die Vorschau nutzt den Seed von Durchlauf 1");

  assert.deepEqual(
    generateRandomSteps(input.random, input.maxRuntimeSec, seedForLoop(77, 1), false),
    preview.steps,
    "die Vorschau zeigt genau den Plan, den die Session später ausführt"
  );
  assert.ok(preview.plan.includes("Seed 77 (Durchlauf-Seed"), "der Plan nennt Basis- und Durchlauf-Seed");
});

test("Seed 0 ist erlaubt, fremde URLs werden abgelehnt", () => {
  const zero = planFromRequest({ minutes: 10, interactionSeed: 0 });

  assert.equal(zero.seed, 0);
  assert.equal(zero.loopSeed, seedForLoop(0, 1));
  assert.ok(zero.steps.length > 0);

  assert.throws(() => planFromRequest({ url: "https://example.com/watch?v=1" }), ValidationError);
  assert.throws(() => planFromRequest({ interactionSeed: -1 }), ValidationError);
});

test("seedForLoop kollidiert nicht: verschiedene Seeds, verschiedene Durchlauf-Seeds", () => {
  // Einfache Addition würde diese beiden Seeds auf denselben Wert laufen lassen.
  assert.notEqual(seedForLoop(1, 1), seedForLoop(1640531528, 2));

  const seen = new Set<number>();

  for (const base of [0, 1, 7, 42, 123456789, 2147483647]) {
    for (const loop of [1, 2, 3, 4, 5]) {
      seen.add(seedForLoop(base, loop));
    }
  }

  assert.equal(seen.size, 30, "keine Seed-Kollisionen");
});
