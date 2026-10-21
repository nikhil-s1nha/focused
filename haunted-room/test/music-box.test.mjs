import { test } from "node:test";
import assert from "node:assert/strict";
import { MusicBox, MELODY } from "../public/music-box.mjs";

class FakeParam {
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(v) {
    this.value = v;
  }
  linearRampToValueAtTime(v) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v) {
    this.value = v;
  }
  setTargetAtTime(v) {
    this.value = v;
  }
}
class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.gain = new FakeParam(1);
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
    this.delayTime = new FakeParam(0);
    this.connections = [];
    this.type = "";
    this.startCalls = [];
    this.stopCalls = [];
  }
  connect(target) {
    this.connections.push(target);
    return target;
  }
  disconnect() {
    this.connections = [];
  }
  start(t = 0) {
    this.startCalls.push(t);
  }
  stop(t = 0) {
    this.stopCalls.push(t);
  }
}
function makeFakeContext() {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = new FakeNode("destination");
      this.created = [];
      instances.push(this);
    }
    async resume() {
      this.state = "running";
    }
    async suspend() {
      this.state = "suspended";
    }
    async close() {
      this.state = "closed";
    }
    _make(kind) {
      const n = new FakeNode(kind);
      this.created.push(n);
      return n;
    }
    createGain() {
      return this._make("gain");
    }
    createOscillator() {
      return this._make("osc");
    }
    createDelay() {
      return this._make("delay");
    }
  }
  return { FakeAudioContext, instances };
}
// Deterministic LCG rng for statistical tests.
const makeRng = (seed = 1) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};
const snap = (over = {}) => ({
  tension: 0,
  state: "BUILD",
  paused: false,
  encounter: null,
  ...over,
});
// Advance the stub audio clock and drive the scheduler directly.
const drive = (box, ctx, seconds, step = 0.1) => {
  const end = ctx.currentTime + seconds;
  while (ctx.currentTime < end - 1e-9) {
    ctx.currentTime = Math.min(end, ctx.currentTime + step);
    box.tick();
  }
};
const oscs = (ctx) => ctx.created.filter((n) => n.kind === "osc");
const master = (ctx) =>
  ctx.created.find(
    (n) => n.kind === "gain" && n.connections.includes(ctx.destination),
  );

test("melody is a well-formed original score", () => {
  assert.ok(MELODY.length >= 16 && MELODY.length <= 32);
  for (const n of MELODY) {
    assert.ok(Number.isFinite(n.midi) && n.midi >= 48 && n.midi <= 96);
    assert.ok(n.beats > 0);
  }
});

test("no audio nodes exist before setEnabled(true); update/setVolume are no-ops", () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext });
  box.update(snap({ tension: 0.8, state: "PEAK" }));
  box.setVolume(0.4);
  box.tick();
  assert.equal(instances.length, 0);
  assert.equal(box.ctx, null);
  box.dispose();
});

test("setEnabled(true) without any AudioContext returns false", async () => {
  const box = new MusicBox(); // Node: no global AudioContext
  assert.equal(await box.setEnabled(true), false);
  assert.equal(box.enabled, false);
  box.dispose();
});

test("notes schedule at ~72 BPM at tension 0, following the melody rhythm", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: () => 0.99 });
  await box.setEnabled(true);
  const ctx = instances[0];
  assert.equal(ctx.state, "running");
  box.update(snap({ tension: 0 }));
  drive(box, ctx, 10);
  // Each note starts a fundamental + a 4x partial at the same time.
  const starts = [...new Set(oscs(ctx).flatMap((o) => o.startCalls))].sort(
    (a, b) => a - b,
  );
  assert.ok(starts.length >= 8);
  const spb = 60 / 72;
  for (let i = 1; i < Math.min(starts.length, 8); i++) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(
      Math.abs(gap - MELODY[i - 1].beats * spb) < 1e-6,
      `gap ${i} was ${gap}`,
    );
  }
  // Fundamental and partial frequencies are a true 4x pair.
  const pair = oscs(ctx).filter((o) => o.startCalls[0] === starts[0]);
  assert.equal(pair.length, 2);
  const [a, b] = pair.map((o) => o.frequency.value).sort((x, y) => x - y);
  assert.ok(Math.abs(b - 4 * a) < 1e-6);
  assert.equal(box.stats.dropped, 0); // no dropouts when calm
  box.dispose();
});

test("high tension drags the tempo and drops notes out", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const calm = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: makeRng(7) });
  await calm.setEnabled(true);
  calm.update(snap({ tension: 0 }));
  drive(calm, instances[0], 20);
  const tense = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: makeRng(7) });
  await tense.setEnabled(true);
  tense.update(snap({ tension: 0.9 }));
  drive(tense, instances[1], 20);
  // Slower tempo => fewer note slots consumed in the same wall-clock window.
  assert.ok(
    calm.stats.slots > tense.stats.slots * 1.3,
    `calm ${calm.stats.slots} vs tense ${tense.stats.slots}`,
  );
  // Dropouts appear only under tension (p = 0.55 * 0.9 here).
  assert.equal(calm.stats.dropped, 0);
  assert.ok(tense.stats.dropped / tense.stats.slots > 0.3);
  assert.ok(tense.stats.scheduled < tense.stats.slots);
  calm.dispose();
  tense.dispose();
});

test("PEAK can grind the box to a halt; RELIEF restores it", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: makeRng(3) });
  await box.setEnabled(true);
  const ctx = instances[0];
  box.update(snap({ tension: 0.85, state: "PEAK" }));
  drive(box, ctx, 60);
  assert.equal(box.halted, true); // seized mid-phrase
  const frozen = box.stats.slots;
  drive(box, ctx, 5);
  assert.equal(box.stats.slots, frozen); // silence holds
  box.update(snap({ tension: 0.2, state: "RELIEF" }));
  assert.equal(box.halted, false);
  drive(box, ctx, 3);
  assert.ok(box.stats.slots > frozen); // music returns
  box.dispose();
});

test("scare encounter hard-cuts instantly and silences the bus", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: () => 0.99 });
  await box.setEnabled(true);
  const ctx = instances[0];
  box.update(snap({ tension: 0.3 }));
  drive(box, ctx, 2);
  assert.ok(box.live.length > 0); // notes are sounding
  const sounding = box.live.map((s) => s.node);
  box.update(
    snap({
      tension: 0.9,
      state: "PEAK",
      encounter: { id: "attendant-scare", intensity: 1, t: 0.05 },
    }),
  );
  assert.equal(box.cut, true);
  // Every live source got an extra immediate stop call.
  assert.ok(sounding.every((o) => o.stopCalls.length === 2));
  const bus = master(ctx).connections.length
    ? ctx.created.find(
        (n) => n.kind === "gain" && n.connections.includes(master(ctx)),
      )
    : null;
  assert.equal(bus.gain.value, 0);
  const frozen = box.stats.slots;
  drive(box, ctx, 3);
  assert.equal(box.stats.slots, frozen); // stays silent after the cut
  // Same encounter id on later frames must not matter; RELIEF restores.
  box.update(snap({ tension: 0.2, state: "RELIEF" }));
  assert.equal(box.cut, false);
  drive(box, ctx, 3);
  assert.ok(box.stats.slots > frozen);
  box.dispose();
});

test("WAIT fades the bus out and pauses scheduling without a backlog", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: () => 0.99 });
  await box.setEnabled(true);
  const ctx = instances[0];
  box.update(snap({ tension: 0 }));
  drive(box, ctx, 3);
  const before = box.stats.slots;
  box.update(snap({ state: "WAIT" }));
  drive(box, ctx, 10);
  assert.equal(box.stats.slots, before);
  box.update(snap({ state: "BUILD", tension: 0 }));
  const t0 = ctx.currentTime;
  drive(box, ctx, 1);
  // No burst: resumed notes schedule at/after the resume time.
  const late = [...new Set(oscs(ctx).flatMap((o) => o.startCalls))].filter(
    (t) => t >= t0,
  );
  assert.ok(late.length > 0 && late.length < 4);
  box.dispose();
});

test("master volume is hard-capped at 0.35", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext });
  await box.setEnabled(true);
  const m = master(instances[0]);
  box.setVolume(1);
  assert.ok(m.gain.value <= 0.35 + 1e-9);
  box.setVolume(5);
  assert.ok(m.gain.value <= 0.35 + 1e-9);
  box.setVolume(0.5);
  assert.ok(Math.abs(m.gain.value - 0.175) < 1e-9);
  box.setVolume(-1);
  assert.equal(m.gain.value, 0);
  box.dispose();
});

test("dispose cancels the scheduler timer and closes the context", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext });
  await box.setEnabled(true);
  assert.notEqual(box.timer, null);
  const ctx = instances[0];
  box.dispose();
  assert.equal(box.timer, null);
  assert.equal(box.ctx, null);
  assert.equal(box.enabled, false);
  assert.equal(ctx.state, "closed");
  box.update(snap()); // must not throw after dispose
  box.tick();
  box.dispose(); // idempotent
});

/* ----------------------- FNAF wind-down + muffled mode ---------------------- */

// Context variant that also supports lowpass filters (for setMuffled).
function makeFilterContext() {
  const { FakeAudioContext, instances } = makeFakeContext();
  class FilterAudioContext extends FakeAudioContext {
    createBiquadFilter() {
      return this._make("filter");
    }
  }
  return { FilterAudioContext, instances };
}

test("setWind: low wind slows the tempo, drops notes and sags pitch flat", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const wound = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: makeRng(11) });
  await wound.setEnabled(true);
  wound.update(snap({ tension: 0 }));
  assert.equal(wound.setWind(1), 1);
  drive(wound, instances[0], 20);
  const slack = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: makeRng(11) });
  await slack.setEnabled(true);
  slack.update(snap({ tension: 0 }));
  assert.equal(slack.setWind(0.2), 0.2);
  drive(slack, instances[1], 20);
  // Slower: fewer melody slots consumed in the same window.
  assert.ok(
    wound.stats.slots > slack.stats.slots * 1.3,
    `wound ${wound.stats.slots} vs slack ${slack.stats.slots}`,
  );
  // Degraded: dropouts appear with zero tension, purely from the slack spring.
  assert.equal(wound.stats.dropped, 0);
  assert.ok(slack.stats.dropped / slack.stats.slots > 0.2);
  // Flat: every scheduled note detunes below zero cents.
  const slackOscs = instances[1].created.filter((n) => n.kind === "osc");
  assert.ok(slackOscs.length > 0);
  assert.ok(
    slackOscs.every((o) => o.detune.value < 0),
    "slack spring sags flat",
  );
  wound.dispose();
  slack.dispose();
});

test("setWind degradation is deterministic for the same rng seed", async () => {
  const run = async () => {
    const { FakeAudioContext, instances } = makeFakeContext();
    const box = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: makeRng(99) });
    await box.setEnabled(true);
    box.update(snap({ tension: 0.4 }));
    box.setWind(0.5);
    drive(box, instances[0], 25);
    const starts = oscs(instances[0])
      .flatMap((o) => o.startCalls)
      .sort((a, b) => a - b);
    const out = { starts, stats: { ...box.stats } };
    box.dispose();
    return out;
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a.stats, b.stats, "identical slot/drop/schedule counts");
  assert.deepEqual(a.starts, b.starts, "identical note schedule");
  assert.ok(a.stats.dropped > 0, "degradation actually occurred");
});

test("setWind(0) stops the box; rewinding restores it", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const box = new MusicBox({ AudioContextImpl: FakeAudioContext, rng: () => 0.99 });
  await box.setEnabled(true);
  const ctx = instances[0];
  box.update(snap({ tension: 0 }));
  drive(box, ctx, 3);
  const before = box.stats.slots;
  assert.ok(before > 0);
  box.setWind(0);
  drive(box, ctx, 10);
  assert.equal(box.stats.slots, before, "fully unwound: silence");
  box.setWind(1);
  drive(box, ctx, 3);
  assert.ok(box.stats.slots > before, "rewound: music returns");
  box.dispose();
});

test("setMuffled toggles the lowpass voicing when the context supports it", async () => {
  const { FilterAudioContext, instances } = makeFilterContext();
  const box = new MusicBox({ AudioContextImpl: FilterAudioContext, rng: () => 0.99 });
  await box.setEnabled(true);
  const ctx = instances[0];
  const tone = ctx.created.find((n) => n.kind === "filter");
  assert.ok(tone, "tone filter in the chain");
  assert.ok(tone.connections.includes(master(ctx)), "tone feeds the master");
  assert.ok(tone.frequency.value > 10000, "open by default");
  assert.equal(box.setMuffled(true), true);
  assert.ok(tone.frequency.value < 1000, "muffled pulls the cutoff down");
  assert.equal(box.setMuffled(false), false);
  assert.ok(tone.frequency.value > 10000, "restores");
  // Notes still schedule and route through the bus with the filter present.
  box.update(snap({ tension: 0 }));
  drive(box, ctx, 3);
  assert.ok(box.stats.scheduled > 0);
  box.dispose();
});

test("setMuffled/setWind are safe before setEnabled and after dispose", () => {
  const box = new MusicBox();
  assert.equal(box.setMuffled(true), true);
  assert.equal(box.setWind(0.4), 0.4);
  assert.equal(box.setWind(-3), 0, "clamped");
  assert.equal(box.setWind(7), 1, "clamped");
  box.dispose();
  box.setMuffled(false);
  box.setWind(1);
});
