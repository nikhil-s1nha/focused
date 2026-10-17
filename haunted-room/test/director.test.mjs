import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG,
  Director,
  ENCOUNTERS,
  validSignal,
} from "../public/director.mjs";
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
test("encounters fire deterministically and respect cooldowns and gap", () => {
  const a = new Director({ duration: 300 });
  const b = new Director({ duration: 300 });
  a.start();
  b.start();
  run(a, 90, 0);
  run(b, 90, 0);
  const fired = a.getSession().events.filter((e) => e.type === "encounter");
  assert.ok(fired.length >= 3);
  assert.deepEqual(
    fired,
    b.getSession().events.filter((e) => e.type === "encounter"),
  );
  for (let i = 1; i < fired.length; i++)
    assert.ok(fired[i].t - fired[i - 1].t >= CONFIG.globalGap - 0.11);
  const lastByType = {};
  for (const e of fired) {
    assert.ok(["BUILD", "PEAK"].includes(e.state));
    assert.ok(e.intensity >= 0 && e.intensity <= 1);
    const base = ENCOUNTERS.find((x) => x.id === e.id).cooldown;
    if (lastByType[e.id] != null)
      assert.ok(e.t - lastByType[e.id] >= base * 0.4 - 0.11);
    lastByType[e.id] = e.t;
  }
});
test("no encounters fire during WAIT or RELIEF", () => {
  const d = new Director({ duration: 300 });
  d.start();
  for (let i = 0; i < 800; i++) {
    const s = d.step(0.05, d.elapsed); // no signal at all -> WAIT
    assert.equal(s.encounter, null);
  }
  assert.equal(
    d.getSession().events.filter((e) => e.type === "encounter").length,
    0,
  );
  for (let i = 0; i < 60 * 20; i++) {
    const now = d.elapsed;
    d.receive(message(1), now);
    const s = d.step(0.05, now); // high input -> BUILD/RELIEF cycles
    if (s.state === "RELIEF" || s.state === "WAIT")
      assert.equal(s.encounter, null);
  }
  for (const e of d.getSession().events.filter((x) => x.type === "encounter"))
    assert.ok(["BUILD", "PEAK"].includes(e.state));
});
test("adaptive memory escalates encounters followed by rising tension", () => {
  const d = new Director({ duration: 300 });
  d.start();
  run(d, 14, 0); // first encounter ~8s; tension still rising at ~12s
  const session = d.getSession();
  const fired = session.events.find((e) => e.type === "encounter");
  assert.ok(fired);
  const response = session.events.find((e) => e.type === "encounter-response");
  assert.ok(response.delta > 0);
  assert.equal(response.escalated, true);
  assert.ok(d.memory[fired.id].weight > 1);
  assert.ok(d.memory[fired.id].cooldownScale < 1);
  assert.ok(session.encounterStats[fired.id].avgResponse > 0);
});
test("adaptive memory deprioritizes encounters followed by falling tension", () => {
  const d = new Director({ duration: 300 });
  d.start();
  let fired = null;
  while (!fired && d.elapsed < 30) {
    const now = d.elapsed;
    d.receive(message(0), now);
    const s = d.step(0.05, now);
    if (s.encounter) fired = s.encounter.id;
  }
  assert.ok(fired);
  run(d, 5, 0, 0.1); // dropout -> WAIT, tension collapses inside the window
  assert.ok(d.memory[fired].weight < 1);
  assert.ok(d.memory[fired].cooldownScale > 1);
  const response = d
    .getSession()
    .events.find((e) => e.type === "encounter-response");
  assert.ok(response.delta < 0);
  assert.equal(response.escalated, false);
});
test("peak dwell is capped and eases before re-escalating", () => {
  const d = new Director({ duration: 300 });
  d.start();
  run(d, 35, 0);
  const events = d.getSession().events;
  const cap = events.findIndex((e) => e.type === "peak-cap");
  assert.ok(cap >= 0);
  const after = events.slice(cap + 1);
  assert.ok(
    after.some((e) => e.type === "state" && e.from === "PEAK" && e.to === "BUILD"),
  );
  assert.equal(d.state, "PEAK"); // pacing dips, then re-escalates
});
test("pause freezes elapsed and timers; resume continues", () => {
  const d = new Director();
  d.start();
  for (let i = 0; i < 100; i++) {
    const now = d.elapsed;
    d.receive(message(0.5), now);
    d.step(0.05, now);
  }
  const elapsed = d.elapsed;
  const tension = d.tension;
  assert.equal(d.pause(5), true);
  assert.equal(d.pause(5), false);
  assert.equal(d.snapshot(5).paused, true);
  assert.equal(d.receive(message(0.2), 6), false);
  for (let i = 0; i < 40; i++) d.step(0.05, 6 + i * 0.05);
  assert.equal(d.elapsed, elapsed);
  assert.equal(d.tension, tension);
  assert.equal(d.resume(20), true);
  assert.equal(d.snapshot(20).paused, false);
  d.step(0.05, 20);
  assert.ok(d.elapsed > elapsed);
  assert.equal(d.snapshot(20.05).fresh, true); // freshness survived the pause
  const types = d.getSession().events.map((e) => e.type);
  assert.ok(types.includes("pause") && types.includes("resume"));
});
test("duration config, elapsed and progress are reported", () => {
  const d = new Director({ duration: 60 });
  d.start();
  run(d, 30, 0.5);
  const s = d.snapshot(d.elapsed);
  assert.ok(Math.abs(s.elapsed - 30) < 0.01);
  assert.ok(Math.abs(s.progress - 0.5) < 0.01);
  run(d, 31, 0.5);
  assert.equal(d.phase, "ended");
  assert.equal(d.snapshot(d.elapsed).progress, 1);
  assert.equal(d.getSession().endedReason, "completed");
  assert.equal(new Director({ duration: NaN }).config.duration, 120);
});
test("getSession returns a serializable summary without raw signals", () => {
  const d = new Director({ duration: 300 });
  d.start();
  run(d, 40, 0);
  d.pause(d.elapsed);
  d.resume(d.elapsed);
  const s = d.getSession();
  assert.equal(s.duration, 300);
  assert.equal(s.endedReason, null);
  assert.ok(s.peakTension > 0.5);
  assert.ok(Array.isArray(s.events) && s.events[0].type === "start");
  const stateTotal = Object.values(s.timeInState).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(stateTotal - s.elapsed) < 0.5);
  for (const e of s.events) {
    assert.ok(Number.isFinite(e.t) && Number.isFinite(e.tension));
    for (const k of Object.keys(e))
      assert.ok(!["signal_quality", "timestamp", "raw", "samples"].includes(k));
    for (const v of Object.values(e)) assert.ok(!Array.isArray(v));
  }
  for (const id of Object.keys(s.encounterStats)) {
    assert.ok(Number.isFinite(s.encounterStats[id].count));
    assert.ok(Number.isFinite(s.encounterStats[id].avgResponse));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test("end(reason) ends a running session with that reason; no-op otherwise", () => {
  const d = new Director();
  assert.equal(d.end("caught"), false, "not running yet");
  d.start();
  d.step(1, 1);
  assert.equal(d.end("caught"), true);
  assert.equal(d.phase, "ended");
  assert.equal(d.getSession().endedReason, "caught");
  assert.equal(d.snapshot(2).tension, 0);
  assert.equal(d.end("again"), false);
  assert.equal(d.getSession().endedReason, "caught");
});
