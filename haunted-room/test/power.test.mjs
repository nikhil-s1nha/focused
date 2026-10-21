import { test } from "node:test";
import assert from "node:assert/strict";
import { PowerSystem, POWER_CONFIG } from "../public/power.mjs";

// Advance in small frame-sized slices like the render loop would.
const run = (p, seconds, dt = 0.05) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) p.update(dt);
};
const approx = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~ ${b}`);

test("power: initial contract — full charge, idle until start()", () => {
  const p = new PowerSystem();
  assert.equal(p.getLevel(), 1);
  assert.deepEqual(p.consumeEvents(), []);
  run(p, 30);
  assert.equal(p.getLevel(), 1); // no drain before start
  const s = p.getState();
  assert.equal(s.percent, 100);
  assert.equal(s.running, false);
  assert.equal(s.blackout, false);
  assert.equal(s.blackoutElapsed, 0);
  assert.deepEqual(s.activeLoads, []);
  assert.equal(s.drainRate, 0);
  assert.equal(s.secondsRemaining, Infinity);
});

test("power: passive drain math is exact and frame-rate independent", () => {
  const a = new PowerSystem();
  a.start();
  run(a, 100, 0.016);
  approx(a.getLevel(), 1 - POWER_CONFIG.passiveDrain * 100, 1e-9);
  // Same result with one giant update (internally sliced).
  const b = new PowerSystem();
  b.start();
  b.update(100);
  approx(b.getLevel(), a.getLevel(), 1e-9);
  // Invalid dt is ignored, never corrupts the level.
  b.update(NaN);
  b.update(-5);
  b.update(0);
  b.update(Infinity);
  approx(b.getLevel(), a.getLevel(), 1e-9);
});

test("power: named loads stack on top of passive drain", () => {
  const p = new PowerSystem();
  p.start();
  p.setLoad("monitor", true);
  approx(
    p.getDrainRate(),
    POWER_CONFIG.passiveDrain + POWER_CONFIG.loadDrains.monitor,
  );
  p.setLoad("floodlight", true);
  approx(
    p.getDrainRate(),
    POWER_CONFIG.passiveDrain +
      POWER_CONFIG.loadDrains.monitor +
      POWER_CONFIG.loadDrains.floodlight,
  );
  assert.deepEqual(p.getState().activeLoads.sort(), ["floodlight", "monitor"]);
  assert.equal(p.isLoadActive("monitor"), true);
  // Setting the same load twice doesn't double it.
  p.setLoad("monitor", true);
  approx(
    p.getDrainRate(),
    POWER_CONFIG.passiveDrain +
      POWER_CONFIG.loadDrains.monitor +
      POWER_CONFIG.loadDrains.floodlight,
  );
  run(p, 10);
  approx(p.getLevel(), 1 - p.getDrainRate() * 10, 1e-9);
  // Turning a load off restores the lower rate.
  p.setLoad("floodlight", false);
  assert.equal(p.isLoadActive("floodlight"), false);
  approx(
    p.getDrainRate(),
    POWER_CONFIG.passiveDrain + POWER_CONFIG.loadDrains.monitor,
  );
  // Unknown load names drain at the default rate; junk names are ignored.
  p.setLoad("mystery-lamp", true);
  approx(
    p.getDrainRate(),
    POWER_CONFIG.passiveDrain +
      POWER_CONFIG.loadDrains.monitor +
      POWER_CONFIG.defaultLoadDrain,
  );
  p.setLoad("", true);
  p.setLoad(null, true);
  assert.equal(p.getState().activeLoads.length, 2);
});

test("power: session tuning — careful survives 120s, careless blacks out", () => {
  // Passive only: survives the whole 120s session with charge to spare.
  const careful = new PowerSystem();
  careful.start();
  run(careful, 120);
  assert.ok(careful.getLevel() > 0.5, `careful ended at ${careful.getLevel()}`);
  assert.equal(careful.getState().blackout, false);
  // Monitor held up the entire session: dies before the 120s mark.
  const careless = new PowerSystem();
  careless.start();
  careless.setLoad("monitor", true);
  careless.setLoad("floodlight", true);
  let blackoutAt = null;
  for (let t = 0; t < 120; t += 0.05) {
    careless.update(0.05);
    if (blackoutAt == null && careless.getState().blackout) blackoutAt = t;
  }
  assert.ok(blackoutAt != null, "careless usage must black out before 120s");
  assert.ok(blackoutAt > 30, "but not insultingly fast");
});

test("power: warning/critical/blackout fire exactly once, in order", () => {
  const p = new PowerSystem();
  p.start();
  p.setLoad("monitor", true);
  p.setLoad("floodlight", true);
  const seen = [];
  for (let t = 0; t < 200; t += 0.05) {
    p.update(0.05);
    for (const e of p.consumeEvents()) if (e.type !== "flicker") seen.push(e);
  }
  assert.deepEqual(seen, [
    { type: "warning", level: POWER_CONFIG.warningLevel },
    { type: "critical", level: POWER_CONFIG.criticalLevel },
    { type: "blackout" },
  ]);
  // Level is clamped at exactly 0 and stays there.
  assert.equal(p.getLevel(), 0);
  run(p, 10);
  assert.equal(p.getLevel(), 0);
  assert.deepEqual(p.consumeEvents(), []); // nothing fires twice
});

test("power: a huge dt step still emits every threshold event once", () => {
  const p = new PowerSystem();
  p.start();
  p.setLoad("floodlight", true);
  p.update(500); // one giant step straight past every threshold
  const types = p.consumeEvents().map((e) => e.type);
  assert.deepEqual(
    types.filter((t) => t !== "flicker"),
    ["warning", "critical", "blackout"],
  );
  assert.equal(p.getLevel(), 0);
});

test("power: blackout turns everything off and times the sequence", () => {
  const p = new PowerSystem();
  p.start();
  p.setLoad("monitor", true);
  p.setLoad("floodlight", true);
  // Frame-sized steps until the lights go out, like the render loop would.
  for (let i = 0; i < 20000 && !p.getState().blackout; i++) p.update(0.05);
  p.consumeEvents();
  const s0 = p.getState();
  assert.equal(s0.blackout, true);
  assert.deepEqual(s0.activeLoads, []); // loads force-cleared
  assert.equal(s0.drainRate, 0);
  // setLoad is a no-op after blackout.
  p.setLoad("monitor", true);
  assert.deepEqual(p.getState().activeLoads, []);
  // blackoutElapsed grows with simulated time for the power-out sequence.
  assert.ok(p.getBlackoutElapsed() < 0.06); // at most the detecting frame
  const base = p.getBlackoutElapsed();
  run(p, 7.5);
  approx(p.getBlackoutElapsed(), base + 7.5, 1e-6);
  approx(p.getState().blackoutElapsed, base + 7.5, 1e-6);
  assert.equal(p.getLevel(), 0);
  assert.deepEqual(p.consumeEvents(), []);
});

test("power: reset restores full charge and re-arms every event", () => {
  const p = new PowerSystem();
  p.start();
  p.setLoad("floodlight", true);
  p.update(500);
  p.consumeEvents();
  p.reset();
  assert.equal(p.getLevel(), 1);
  const s = p.getState();
  assert.equal(s.running, false);
  assert.equal(s.blackout, false);
  assert.equal(s.blackoutElapsed, 0);
  assert.deepEqual(s.activeLoads, []);
  assert.deepEqual(p.consumeEvents(), []);
  // The whole session can play out again, events included.
  p.start();
  p.setLoad("floodlight", true);
  p.update(500);
  const types = p.consumeEvents().map((e) => e.type);
  assert.deepEqual(
    types.filter((t) => t !== "flicker"),
    ["warning", "critical", "blackout"],
  );
});

test("power: flicker events — only below threshold, deterministic cadence", () => {
  const rng = () => 0.5; // injected: gap = minGap + 0.5 * jitter, every time
  const gap = POWER_CONFIG.flickerMinGap + 0.5 * POWER_CONFIG.flickerJitter;
  const p = new PowerSystem({ rng });
  p.start();
  // Well above the threshold: no flickers at all.
  run(p, 60);
  assert.ok(p.getLevel() > POWER_CONFIG.flickerThreshold);
  assert.equal(
    p.consumeEvents().filter((e) => e.type === "flicker").length,
    0,
  );
  // Drop just below the threshold, then run 30s and count flickers.
  const q = new PowerSystem({ rng });
  q.start();
  q.update((1 - 0.24) / POWER_CONFIG.passiveDrain); // level ~0.24
  q.consumeEvents();
  run(q, 30);
  const flickers = q
    .consumeEvents()
    .filter((e) => e.type === "flicker");
  // The timer may already be armed from the threshold crossing, so the count
  // over 30s lands within one event of the pure cadence.
  const cadence = 30 / gap; // ~9.2
  assert.ok(
    flickers.length >= Math.floor(cadence) - 1 &&
      flickers.length <= Math.ceil(cadence) + 1,
    `expected ~${cadence.toFixed(1)} flickers at ${gap}s cadence, got ${flickers.length}`,
  );
  for (const f of flickers) {
    assert.ok(f.level > 0 && f.level < POWER_CONFIG.flickerThreshold);
  }
  // Identical seeds => identical event streams (full determinism).
  const mk = () => {
    const sys = new PowerSystem({ seed: 1234 });
    sys.start();
    sys.setLoad("monitor", true);
    const events = [];
    for (let t = 0; t < 150; t += 0.05) {
      sys.update(0.05);
      events.push(...sys.consumeEvents());
    }
    return events;
  };
  assert.deepEqual(mk(), mk());
});

test("power: step(now) clock API — injected time, pause-safe", () => {
  let now = 100;
  const p = new PowerSystem({ now: () => now });
  p.start();
  p.step(); // arms the clock (no drain on first sample)
  assert.equal(p.getLevel(), 1);
  now = 110;
  p.step();
  approx(p.getLevel(), 1 - POWER_CONFIG.passiveDrain * 10, 1e-9);
  // Explicit now argument wins over the injected clock.
  p.step(120);
  approx(p.getLevel(), 1 - POWER_CONFIG.passiveDrain * 20, 1e-9);
  // Backwards / equal clocks never credit charge back.
  p.step(90);
  p.step(90);
  const lvl = p.getLevel();
  p.step(90);
  assert.equal(p.getLevel(), lvl);
  // stop() + resume: the gap while stopped is not billed.
  const q = new PowerSystem();
  q.start();
  q.step(0);
  q.step(10);
  const before = q.getLevel();
  q.stop();
  q.step(500); // ignored while stopped? clock re-arms on resume
  q.start();
  q.step(1000);
  q.step(1005);
  approx(q.getLevel(), before - POWER_CONFIG.passiveDrain * 5, 1e-9);
});

test("power: getState secondsRemaining estimates honestly", () => {
  const p = new PowerSystem();
  p.start();
  p.setLoad("monitor", true);
  const s = p.getState();
  approx(s.secondsRemaining, 1 / (POWER_CONFIG.passiveDrain + POWER_CONFIG.loadDrains.monitor));
  run(p, 10);
  const s2 = p.getState();
  assert.ok(s2.secondsRemaining < s.secondsRemaining);
  assert.equal(s2.percent, Math.round(p.getLevel() * 100));
});

test("power: custom drain configuration via options", () => {
  const p = new PowerSystem({
    passiveDrain: 0.01,
    loadDrains: { lantern: 0.02 },
  });
  p.start();
  p.setLoad("lantern", true);
  approx(p.getDrainRate(), 0.03);
  // House defaults for named loads survive a partial loadDrains override.
  p.setLoad("monitor", true);
  approx(p.getDrainRate(), 0.03 + POWER_CONFIG.loadDrains.monitor);
  p.update(10);
  approx(p.getLevel(), 1 - (0.03 + POWER_CONFIG.loadDrains.monitor) * 10, 1e-9);
});
