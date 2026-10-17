import test from "node:test";
import assert from "node:assert/strict";
import { ScareDirector, SIDES, BASE_FIGURES, WITHERED_FIGURES } from "../public/simple/scare.mjs";

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The beat library also emits side:null silence beats; only scare silences carry a side.
const scareSilence = (e) => e.type === "silence" && e.side !== null;

const BUILD_HIGH = { tension: 0.6, state: "BUILD", observed: null };

// Runs a whole session with a fixed or snapshot-driven input. Each event carries the
// end-of-update elapsed time, which is what the timing assertions use.
function session({ seed = 1, duration = 120, dt = 0.05, seconds = duration + 1, input = BUILD_HIGH } = {}) {
  const dir = new ScareDirector({ rng: rngFrom(seed), durationSeconds: duration });
  dir.start();
  const trace = [];
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    dir.update(dt, typeof input === "function" ? input(dir.snapshot()) : input);
    const t = dir.snapshot().elapsed;
    for (const event of dir.consumeEvents()) trace.push({ event, t });
  }
  return { dir, trace, events: trace.map((x) => x.event) };
}

// Step-by-step driver for reactive tests where the player's gaze depends on what happened.
function reactive(seed, duration = 120) {
  const dir = new ScareDirector({ rng: rngFrom(seed), durationSeconds: duration });
  dir.start();
  const state = { observed: null, events: [] };
  const tick = (dt = 0.05) => {
    dir.update(dt, { tension: 0.5, state: "BUILD", observed: state.observed });
    const got = dir.consumeEvents();
    state.events.push(...got);
    return got;
  };
  const until = (pred, max = 4000) => {
    for (let i = 0; i < max; i += 1) {
      const got = tick();
      const hit = got.find(pred);
      if (hit) return hit;
    }
    throw new Error("timed out waiting for event");
  };
  return { dir, state, tick, until };
}

function firstGap(seed, input) {
  const dir = new ScareDirector({ rng: rngFrom(seed) });
  dir.start();
  dir.update(0, input);
  return dir.snapshot().nextGap;
}

test("same seed and same inputs give the same event list", () => {
  const input = (snap) => ({ tension: 0.7, state: "BUILD", observed: Math.floor(snap.elapsed / 7) % 2 ? "left" : null });
  const a = session({ seed: 42, input }).events;
  const b = session({ seed: 42, input }).events;
  const c = session({ seed: 43, input }).events;
  assert.ok(a.length > 0);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test("gap length responds to tension and to relief/wait", () => {
  let high = 0;
  let low = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const h = firstGap(seed, { tension: 1, state: "BUILD", observed: null });
    const l = firstGap(seed, { tension: 0, state: "RELIEF", observed: null });
    const w = firstGap(seed, { tension: 0.9, state: "WAIT", observed: null });
    assert.ok(h >= 4 && h <= 8, `high tension gap ${h}`);
    assert.ok(l >= 14 && l <= 24, `relief gap ${l}`);
    assert.ok(w >= 14 && w <= 24, `wait gap ${w}`);
    high += h;
    low += l;
  }
  assert.ok(high / 200 < (low / 200) * 0.5);
});

test("an observed door holds the figure and looking away lets it lunge", () => {
  const r = reactive(3);
  const silence = r.until(scareSilence);
  r.state.observed = silence.side; // player looks at the door before the figure arrives
  r.until((e) => e.type === "hold");
  const heldFor = [];
  for (let i = 0; i < 30; i += 1) heldFor.push(...r.tick()); // 1.5 s of staring
  assert.ok(!heldFor.some((e) => e.type === "lunge" || e.type === "caught" || e.type === "retreat"));
  assert.equal(r.dir.snapshot().activeScare.state, "hold");
  r.state.observed = null;
  const lunge = r.until((e) => e.type === "lunge");
  assert.equal(lunge.side, silence.side);
  const holds = r.state.events.filter((e) => e.type === "hold");
  assert.equal(holds.length, 1, "hold is emitted once");
});

test("looking back at an approaching figure makes it retreat and cancels the scare", () => {
  const r = reactive(5);
  const figure = r.until((e) => e.type === "figure");
  r.state.observed = figure.side;
  r.until((e) => e.type === "retreat");
  const idx = r.state.events.findIndex((e) => e.type === "retreat");
  assert.equal(r.state.events[idx + 1].type, "recover");
  for (let i = 0; i < 60; i += 1) r.tick(); // 3 s more, still staring at the door
  assert.ok(!r.state.events.some((e) => e.type === "lunge" || e.type === "caught"));
  assert.equal(r.dir.snapshot().activeScare, null);
});

test("staring the whole way ends in the caught path and the session", () => {
  const r = reactive(7);
  const silence = r.until(scareSilence);
  r.state.observed = silence.side;
  r.until((e) => e.type === "end");
  const caught = r.state.events.find((e) => e.type === "caught");
  assert.deepEqual(caught, { type: "caught", side: silence.side, id: caught.id });
  assert.ok(BASE_FIGURES.includes(caught.id) || WITHERED_FIGURES.includes(caught.id));
  const end = r.state.events.find((e) => e.type === "end");
  assert.equal(end.reason, "caught");
  assert.equal(r.dir.snapshot().phase, "ended");
  assert.deepEqual(r.tick(), []);
  assert.ok(!r.state.events.some((e) => e.type === "lunge"));
});

test("a lunge never happens while the player observes that door", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const dir = new ScareDirector({ rng: rngFrom(seed) });
    dir.start();
    const roll = rngFrom(seed + 1000);
    let observed = null;
    let ended = false;
    for (let i = 0; i < 2600 && !ended; i += 1) {
      if (roll() < 0.05) observed = roll() < 0.5 ? null : SIDES[Math.floor(roll() * 4)];
      dir.update(0.05, { tension: 0.8, state: "BUILD", observed });
      for (const e of dir.consumeEvents()) {
        if (e.type === "lunge") assert.notEqual(observed, e.side, `seed ${seed} lunged while observed`);
        if (e.type === "caught") assert.equal(observed, e.side, `seed ${seed} caught while not observed`);
        if (e.type === "end") ended = true;
      }
    }
  }
});

test("silence to lunge stays under 2.5 seconds", () => {
  const { trace } = session({ seed: 9, seconds: 120 });
  let silenceT = null;
  let checked = 0;
  for (const { event, t } of trace) {
    if (scareSilence(event)) silenceT = t;
    if (event.type === "lunge") {
      const gap = t - silenceT;
      assert.ok(gap >= 1.6 && gap <= 2.5, `silence->lunge ${gap}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "expected at least one lunge in the session");
});

test("session ends at its duration with one survived end event", () => {
  const dir = new ScareDirector({ rng: rngFrom(11), durationSeconds: 10 });
  dir.start();
  const events = [];
  for (let i = 0; i < 240; i += 1) {
    dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
    events.push(...dir.consumeEvents());
  }
  const ends = events.filter((e) => e.type === "end");
  assert.deepEqual(ends, [{ type: "end", reason: "survived" }]);
  assert.equal(events[events.length - 1].type, "end");
  assert.equal(dir.snapshot().phase, "ended");
  assert.equal(dir.snapshot().elapsed, 10);
  dir.update(5, BUILD_HIGH);
  assert.deepEqual(dir.consumeEvents(), []);
});

test("no duplicate event objects, one silence per scare, consumeEvents clears", () => {
  const { dir, events } = session({ seed: 21, seconds: 180, duration: 180 });
  assert.equal(new Set(events).size, events.length, "an event object was queued twice");
  const silences = events.filter(scareSilence).length;
  assert.equal(silences, dir.snapshot().scaresSoFar);
  assert.equal(events.filter((e) => e.type === "end").length, 1);
  assert.deepEqual(dir.consumeEvents(), []);
});

test("the same door is never used twice in a row, nor the same figure", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const { events } = session({ seed, seconds: 180, duration: 180 });
    const sides = events.filter(scareSilence).map((e) => e.side);
    const ids = events.filter((e) => e.type === "figure").map((e) => e.id);
    for (let i = 1; i < sides.length; i += 1) assert.notEqual(sides[i], sides[i - 1]);
    for (let i = 1; i < ids.length; i += 1) assert.notEqual(ids[i], ids[i - 1]);
  }
});

test("flicker beats are at least 0.3 s long and at most 0.5 Hz", () => {
  let flickers = 0;
  for (let seed = 1; seed <= 30; seed += 1) {
    const { trace } = session({ seed, seconds: 120 });
    const times = [];
    for (const { event, t } of trace) {
      if (event.type !== "flicker") continue;
      assert.ok(event.seconds >= 0.3, `flicker too short: ${event.seconds}`);
      times.push(t);
    }
    flickers += times.length;
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] - times[i - 1] >= 1.9, `flickers ${times[i - 1]} and ${times[i]} too close`);
    }
  }
  assert.ok(flickers > 0, "expected some flicker beats across the seeds");
});

test("withered figures only appear after the threshold", () => {
  let withered = 0;
  for (let seed = 1; seed <= 10; seed += 1) {
    const { trace } = session({ seed, duration: 200, seconds: 200 });
    for (const { event, t } of trace) {
      if (event.type === "figure" && event.id.startsWith("withered-")) {
        withered += 1;
        assert.ok(t >= 89.9, `withered figure at ${t}s`);
      }
    }
  }
  assert.ok(withered > 0);
});

test("reset returns to idle and the session can start again", () => {
  const dir = new ScareDirector({ rng: rngFrom(13), durationSeconds: 60 });
  dir.start();
  for (let i = 0; i < 400; i += 1) dir.update(0.05, BUILD_HIGH);
  dir.reset();
  const snap = dir.snapshot();
  assert.equal(snap.phase, "idle");
  assert.equal(snap.elapsed, 0);
  assert.equal(snap.scaresSoFar, 0);
  assert.equal(snap.endReason, null);
  assert.deepEqual(dir.consumeEvents(), []);
  dir.update(5, BUILD_HIGH);
  assert.equal(dir.snapshot().elapsed, 0, "idle director does not advance");
  dir.start();
  const events = [];
  for (let i = 0; i < 400; i += 1) {
    dir.update(0.05, BUILD_HIGH);
    events.push(...dir.consumeEvents());
  }
  assert.ok(events.some(scareSilence));
});

test("trigger queues a scare on the given side and figure while running", () => {
  const dir = new ScareDirector({ rng: rngFrom(31) });
  dir.start();
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  assert.equal(dir.trigger("back", "lark"), true);
  const events = [];
  for (let i = 0; i < 80; i += 1) {
    dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
    events.push(...dir.consumeEvents());
    if (events.some((e) => e.type === "recover")) break;
  }
  const silence = events.find(scareSilence);
  assert.equal(silence.side, "back");
  assert.equal(events.find((e) => e.type === "figure").id, "lark");
  assert.ok(events.some((e) => e.type === "lunge" && e.side === "back"));
  assert.ok(!events.some((e) => e.type === "caught"));
});

test("trigger with forceCaught ends in caught even when the player looks elsewhere", () => {
  const dir = new ScareDirector({ rng: rngFrom(32) });
  dir.start();
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  dir.trigger("left", null, { forceCaught: true });
  const events = [];
  for (let i = 0; i < 200 && dir.snapshot().phase === "running"; i += 1) {
    dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
    events.push(...dir.consumeEvents());
  }
  assert.ok(events.some((e) => e.type === "caught" && e.side === "left"));
  assert.deepEqual(events[events.length - 1], { type: "end", reason: "caught" });
  assert.ok(!events.some((e) => e.type === "lunge"));
});

test("trigger with skipTelegraph shortens the silence beat to 0.2 s", () => {
  const dir = new ScareDirector({ rng: rngFrom(33) });
  dir.start();
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  dir.trigger("front", "maestro", { skipTelegraph: true });
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  const silence = dir.consumeEvents().find(scareSilence);
  assert.equal(silence.seconds, 0.2);
  const events = [];
  let silenceT = dir.snapshot().elapsed;
  let lungeT = null;
  for (let i = 0; i < 80 && lungeT === null; i += 1) {
    dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
    for (const e of dir.consumeEvents()) {
      events.push(e);
      if (e.type === "lunge") lungeT = dir.snapshot().elapsed;
    }
  }
  assert.ok(lungeT !== null);
  assert.ok(lungeT - silenceT < 1.2);
});

test("trigger queued during a running scare plays after it and returns false before start", () => {
  const idle = new ScareDirector({ rng: rngFrom(34) });
  assert.equal(idle.trigger("left"), false);

  const dir = new ScareDirector({ rng: rngFrom(35) });
  dir.start();
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  dir.trigger("left");
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  dir.trigger("right");
  const sides = [];
  for (let i = 0; i < 300; i += 1) {
    dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
    for (const e of dir.consumeEvents()) if (scareSilence(e)) sides.push(e.side);
  }
  assert.deepEqual(sides.slice(0, 2), ["left", "right"]);
  assert.equal(dir.snapshot().scaresSoFar >= 2, true);
});

test("trigger with invalid side or id falls back to a valid random choice", () => {
  const dir = new ScareDirector({ rng: rngFrom(36) });
  dir.start();
  dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
  dir.trigger("ceiling", "nobody");
  const events = [];
  for (let i = 0; i < 80; i += 1) {
    dir.update(0.05, { tension: 0, state: "WAIT", observed: null });
    events.push(...dir.consumeEvents());
    if (events.some((e) => e.type === "recover")) break;
  }
  const silence = events.find(scareSilence);
  const figure = events.find((e) => e.type === "figure");
  assert.ok(SIDES.includes(silence.side));
  assert.ok(BASE_FIGURES.includes(figure.id) || WITHERED_FIGURES.includes(figure.id));
});

test("hold stops automatic scares and beats but trigger still works", () => {
  const dir = new ScareDirector({ rng: rngFrom(7), durationSeconds: 120 });
  dir.start();
  dir.setHold(true);
  const events = [];
  for (let i = 0; i < 600; i += 1) {
    dir.update(0.1, { tension: 1, state: "BUILD", observed: null });
    events.push(...dir.consumeEvents());
  }
  assert.equal(events.length, 0, "no automatic events while held");
  assert.ok(dir.snapshot().elapsed >= 59.9, "session time keeps running while held");
  assert.equal(dir.trigger("left", "bellwether", { skipTelegraph: true }), true);
  for (let i = 0; i < 40; i += 1) {
    dir.update(0.1, { tension: 1, state: "BUILD", observed: null });
    events.push(...dir.consumeEvents());
  }
  assert.ok(events.some((e) => e.type === "lunge"), "a triggered scare still plays while held");
  dir.setHold(false);
});
