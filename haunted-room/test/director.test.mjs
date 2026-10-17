import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, validSignal } from "../public/director.mjs";
const message = (intensity, signal_quality = 1) => ({
  type: "signal",
  source: "manual",
  intensity,
  signal_quality,
  timestamp: Date.now() / 1000,
});
function run(d, seconds, intensity, quality = 1) {
  for (let i = 0; i < seconds * 20; i++) {
    const now = d.elapsed;
    d.receive(message(intensity, quality), now);
    d.step(0.05, now);
  }
}
test("validation rejects mislabeled or malformed values", () => {
  assert.ok(validSignal(message(0.5)));
  for (const m of [
    message(NaN),
    message(2),
    message(0.5, -1),
    { ...message(0.5), source: "EEG" },
  ])
    assert.equal(validSignal(m), false);
});
test("sustained low builds and caps tension", () => {
  const d = new Director();
  d.start();
  run(d, 35, 0);
  assert.equal(d.state, "PEAK");
  assert.ok(d.tension <= 0.85);
});
test("high input enters relief and reduces tension", () => {
  const d = new Director();
  d.start();
  run(d, 25, 0);
  const before = d.tension;
  run(d, 10, 1);
  assert.equal(d.state, "RELIEF");
  assert.ok(d.tension < before);
});
test("poor quality and dropouts never escalate", () => {
  const d = new Director();
  d.start();
  run(d, 20, 0);
  const before = d.tension;
  run(d, 2, 0, 0.1);
  assert.equal(d.state, "WAIT");
  assert.ok(d.tension < before);
  d.step(0.1, d.elapsed + 4);
  assert.equal(d.state, "WAIT");
});
test("start/reset and ending are deterministic", () => {
  const d = new Director({ duration: 2 });
  d.start();
  run(d, 3, 0);
  assert.equal(d.phase, "ended");
  assert.equal(d.tension, 0);
  d.reset();
  assert.equal(d.phase, "ready");
  assert.equal(d.input, null);
});
