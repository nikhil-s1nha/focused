import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveMultiplier, MULTIPLIER_MIN, MULTIPLIER_MAX } from "../public/adaptive-pacing.mjs";

test("neutral outside a running session", () => {
  assert.equal(adaptiveMultiplier(null), 1);
  assert.equal(adaptiveMultiplier({ phase: "ready", tension: 0.9 }), 1);
  assert.equal(adaptiveMultiplier({ phase: "ended", tension: 0.9 }), 1);
});

test("higher tension makes the night harder, relief eases it", () => {
  const relief = adaptiveMultiplier({ phase: "running", tension: 0 });
  const peak = adaptiveMultiplier({ phase: "running", tension: 1 });
  assert.ok(peak > relief);
  assert.ok(Math.abs(relief - 0.8) < 1e-9);
  assert.ok(Math.abs(peak - 1.7) < 1e-9);
});

test("stays inside the clamp and tolerates bad tension", () => {
  for (const tension of [-5, 0.5, 2, NaN, undefined]) {
    const m = adaptiveMultiplier({ phase: "running", tension });
    assert.ok(m >= MULTIPLIER_MIN && m <= MULTIPLIER_MAX, `tension ${tension} -> ${m}`);
  }
});
