import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../public/audio-engine.mjs";

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
    this.Q = new FakeParam(1);
    this.pan = new FakeParam(0);
    this.connections = [];
    this.buffer = null;
    this.loop = false;
    this.type = "";
    this.startedCount = 0;
    this.stoppedCount = 0;
  }
  connect(target) {
    this.connections.push(target);
    return target;
  }
  disconnect() {
    this.connections = [];
  }
  start() {
    this.startedCount += 1;
  }
  stop() {
    this.stoppedCount += 1;
  }
}
function makeFakeContext() {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.sampleRate = 8000;
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
    createBiquadFilter() {
      return this._make("filter");
    }
    createStereoPanner() {
      return this._make("stereo-panner");
    }
    createBufferSource() {
      return this._make("buffer-source");
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { length, sampleRate: rate, getChannelData: () => data };
    }
  }
  return { FakeAudioContext, instances };
}
const snapshot = (over = {}) => ({
  phase: "running",
  state: "BUILD",
  tension: 0.3,
  paused: false,
  encounter: null,
  ...over,
});
const master = (ctx) =>
  ctx.created.find(
    (n) => n.kind === "gain" && n.connections.includes(ctx.destination),
  );

test("no context or nodes exist before setEnabled(true); update is a no-op", () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const engine = new AudioEngine({ contextClass: FakeAudioContext });
  engine.update(snapshot({ tension: 0.9 }));
  engine.setVolume(0.5);
  assert.equal(instances.length, 0);
  assert.equal(engine.ctx, null);
});
test("setEnabled(true) builds and resumes; setEnabled(false) suspends", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const engine = new AudioEngine({ contextClass: FakeAudioContext });
  assert.equal(await engine.setEnabled(true), true);
  assert.equal(instances.length, 1);
  const ctx = instances[0];
  assert.equal(ctx.state, "running");
  assert.ok(ctx.created.length > 0);
  assert.ok(master(ctx));
  assert.ok(master(ctx).gain.value <= 0.4);
  await engine.setEnabled(false);
  assert.equal(ctx.state, "suspended");
  assert.equal(engine.enabled, false);
  await engine.setEnabled(true);
  assert.equal(ctx.state, "running");
  assert.equal(instances.length, 1); // context is reused, not recreated
});
test("setEnabled(true) without any AudioContext returns false", async () => {
  const engine = new AudioEngine(); // Node: no global AudioContext
  assert.equal(await engine.setEnabled(true), false);
  assert.equal(engine.enabled, false);
});
test("drone gain and filter cutoff follow tension; shimmer only at PEAK", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const engine = new AudioEngine({ contextClass: FakeAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  const filter = ctx.created.find((n) => n.kind === "filter");
  const droneGain = filter.connections[0];
  const shimmerGain = ctx.created
    .filter((n) => n.kind === "osc")
    .find((n) => n.frequency.value === 1680)
    .connections[0];
  engine.update(snapshot({ tension: 0.1 }));
  const lowCut = filter.frequency.value;
  const lowGain = droneGain.gain.value;
  assert.equal(shimmerGain.gain.value, 0);
  engine.update(snapshot({ tension: 0.9, state: "PEAK" }));
  assert.ok(filter.frequency.value > lowCut);
  assert.ok(droneGain.gain.value > lowGain);
  assert.ok(shimmerGain.gain.value > 0);
  engine.update(snapshot({ tension: 0.9, state: "RELIEF" }));
  assert.equal(shimmerGain.gain.value, 0);
  assert.ok(droneGain.gain.value < 0.1); // eases down in RELIEF
});
test("master volume is hard-capped at 0.4", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const engine = new AudioEngine({ contextClass: FakeAudioContext });
  await engine.setEnabled(true);
  const m = master(instances[0]);
  engine.setVolume(1);
  assert.ok(m.gain.value <= 0.4 + 1e-9);
  engine.setVolume(5);
  assert.ok(m.gain.value <= 0.4 + 1e-9);
  engine.setVolume(0.5);
  assert.ok(Math.abs(m.gain.value - 0.2) < 1e-9);
  engine.setVolume(-1);
  assert.equal(m.gain.value, 0);
});
test("encounter changes fire one-shot cues exactly once", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const engine = new AudioEngine({ contextClass: FakeAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  const before = ctx.created.length;
  engine.update(
    snapshot({ encounter: { id: "radio-static", intensity: 0.8, t: 0.05 } }),
  );
  const afterStatic = ctx.created.length;
  assert.ok(afterStatic > before);
  assert.ok(
    ctx.created.slice(before).some((n) => n.kind === "filter" && n.type === "bandpass"),
  );
  // Same active encounter on later frames must not retrigger.
  engine.update(
    snapshot({ encounter: { id: "radio-static", intensity: 0.8, t: 1.2 } }),
  );
  assert.equal(ctx.created.length, afterStatic);
  engine.update(snapshot({ encounter: null }));
  engine.update(
    snapshot({ encounter: { id: "shadow-window", intensity: 0.6, t: 0.05 } }),
  );
  assert.ok(ctx.created.length > afterStatic);
  const panner = ctx.created
    .slice(afterStatic)
    .find((n) => n.kind === "stereo-panner");
  assert.ok(panner);
  assert.ok(panner.pan.value > 0); // window is on the right
  const sources = ctx.created
    .slice(afterStatic)
    .filter((n) => n.kind === "buffer-source");
  assert.ok(sources.every((n) => n.startedCount === 1)); // footsteps scheduled
});
test("dispose stops sources and closes the context", async () => {
  const { FakeAudioContext, instances } = makeFakeContext();
  const engine = new AudioEngine({ contextClass: FakeAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  engine.dispose();
  assert.equal(ctx.state, "closed");
  assert.equal(engine.ctx, null);
  assert.equal(engine.enabled, false);
  engine.update(snapshot()); // must not throw after dispose
  engine.dispose(); // idempotent
});

/* ------------------------- FNAF-layer: cues & duck ------------------------- */

// Enhanced fake: records param call history and supports a compressor node.
function makeRichContext() {
  const instances = [];
  class RichParam {
    constructor(value = 0) {
      this.value = value;
      this.calls = [];
    }
    setValueAtTime(v, t) {
      this.calls.push(["set", v, t]);
      this.value = v;
    }
    linearRampToValueAtTime(v, t) {
      this.calls.push(["linear", v, t]);
      this.value = v;
    }
    exponentialRampToValueAtTime(v, t) {
      this.calls.push(["exp", v, t]);
      this.value = v;
    }
    setTargetAtTime(v, t, tc) {
      this.calls.push(["target", v, t, tc]);
      this.value = v;
    }
    cancelScheduledValues(t) {
      this.calls.push(["cancel", t]);
    }
  }
  class RichNode {
    constructor(kind) {
      this.kind = kind;
      this.gain = new RichParam(1);
      this.frequency = new RichParam(440);
      this.detune = new RichParam(0);
      this.Q = new RichParam(1);
      this.pan = new RichParam(0);
      this.threshold = new RichParam(-24);
      this.knee = new RichParam(30);
      this.ratio = new RichParam(12);
      this.attack = new RichParam(0.003);
      this.release = new RichParam(0.25);
      this.connections = [];
      this.buffer = null;
      this.loop = false;
      this.type = "";
      this.startedCount = 0;
      this.stoppedCount = 0;
    }
    connect(t) {
      this.connections.push(t);
      return t;
    }
    disconnect() {
      this.connections = [];
    }
    start() {
      this.startedCount += 1;
    }
    stop() {
      this.stoppedCount += 1;
    }
  }
  class RichAudioContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = new RichNode("destination");
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
      const n = new RichNode(kind);
      this.created.push(n);
      return n;
    }
    createGain() {
      return this._make("gain");
    }
    createOscillator() {
      return this._make("osc");
    }
    createBiquadFilter() {
      return this._make("filter");
    }
    createStereoPanner() {
      return this._make("stereo-panner");
    }
    createBufferSource() {
      return this._make("buffer-source");
    }
    createDynamicsCompressor() {
      return this._make("compressor");
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { length, sampleRate: rate, getChannelData: () => data };
    }
  }
  return { RichAudioContext, instances };
}

const CUE_NAMES = [
  "footstep",
  "thump",
  "knock",
  "breath",
  "static",
  "powerWarning",
  "blackoutPowerDown",
  "stinger",
  "eyes",
];

test("limiter: master routes through a compressor when the context has one", async () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  const comp = ctx.created.find((n) => n.kind === "compressor");
  assert.ok(comp, "compressor created");
  assert.ok(comp.connections.includes(ctx.destination), "limiter feeds output");
  const m = ctx.created.find(
    (n) => n.kind === "gain" && n.connections.includes(comp),
  );
  assert.ok(m, "master gain feeds the limiter");
  assert.ok(m.gain.value <= 0.4 + 1e-9, "cap still applies before limiter");
  assert.ok(comp.ratio.value >= 10, "limiter-grade ratio");
  engine.dispose();
});

test("cue(): every named cue schedules sound exactly on demand; unknown is false", async () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  for (const name of CUE_NAMES) {
    const before = ctx.created.length;
    assert.equal(engine.cue(name, { intensity: 0.7 }), true, name);
    assert.ok(ctx.created.length > before, `${name} created nodes`);
    const made = ctx.created.slice(before);
    const sources = made.filter(
      (n) => n.kind === "osc" || n.kind === "buffer-source",
    );
    assert.ok(sources.length > 0, `${name} has a source`);
    assert.ok(
      sources.every((s) => s.startedCount === 1),
      `${name} sources started`,
    );
  }
  assert.equal(engine.cue("freddy"), false, "unknown cue name refused");
  assert.equal(engine.cue(), false);
  engine.dispose();
});

test("cue() is a strict no-op before setEnabled(true)", () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  assert.equal(engine.cue("stinger"), false);
  assert.equal(instances.length, 0, "no context was ever created");
});

test("positional cues pan and attenuate relative to the listener", async () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  // Listener defaults to the player rig start (x 0, z 2).
  let before = ctx.created.length;
  engine.cue("footstep", { position: { x: -3, z: -4 }, intensity: 0.8 });
  const leftPan = ctx.created
    .slice(before)
    .find((n) => n.kind === "stereo-panner");
  assert.ok(leftPan.pan.value < -0.5, "far-left step pans left");
  before = ctx.created.length;
  engine.cue("footstep", { position: { x: 3, z: -4 }, intensity: 0.8 });
  const rightPan = ctx.created
    .slice(before)
    .find((n) => n.kind === "stereo-panner");
  assert.ok(rightPan.pan.value > 0.5, "far-right step pans right");
  // Distance attenuates: compare near vs far knock envelope peaks.
  const peak = (made) =>
    Math.max(
      ...made
        .filter((n) => n.kind === "gain")
        .flatMap((n) => n.gain.calls)
        .filter((c) => c[0] === "linear" || c[0] === "set")
        .map((c) => c[1]),
    );
  before = ctx.created.length;
  engine.cue("knock", { position: { x: 0, z: 1 }, intensity: 0.8 });
  const near = peak(ctx.created.slice(before));
  before = ctx.created.length;
  engine.cue("knock", { position: { x: 0, z: -10 }, intensity: 0.8 });
  const far = peak(ctx.created.slice(before));
  assert.ok(far < near * 0.5, `distant knock is quieter (${far} vs ${near})`);
  // update() moves the listener with the camera.
  engine.update(
    { phase: "running", state: "BUILD", tension: 0.2, paused: false },
    { position: { x: -3, y: 1.6, z: -4 } },
  );
  before = ctx.created.length;
  engine.cue("footstep", { position: { x: -3, z: -4 } });
  const onTop = ctx.created
    .slice(before)
    .find((n) => n.kind === "stereo-panner");
  assert.ok(Math.abs(onTop.pan.value) < 0.1, "step at the listener is centered");
  engine.dispose();
});

test("duck(): bed ramps to near-silence and schedules its own restore", async () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  ctx.currentTime = 10;
  const m = ctx.created.find(
    (n) =>
      n.kind === "gain" &&
      n.connections.some((t) => t.kind === "compressor"),
  );
  const bed = ctx.created.find(
    (n) => n.kind === "gain" && n.connections.includes(m) && n.gain.value === 1,
  );
  assert.ok(bed, "bed bus exists");
  assert.equal(engine.duck(3), true);
  assert.equal(engine.duckedUntil, 13);
  const calls = bed.gain.calls;
  const down = calls.find((c) => c[0] === "linear" && c[1] <= 0.001);
  assert.ok(down, "ramps down to near-silence");
  assert.ok(down[2] <= 10.5, "the drop is fast");
  const up = calls.find((c) => c[0] === "linear" && c[1] === 1 && c[2] > 13);
  assert.ok(up, "restore to full bed is scheduled after the hold");
  // duck with no graph is refused, never throws.
  const cold = new AudioEngine({ contextClass: RichAudioContext });
  assert.equal(cold.duck(2), false);
  engine.dispose();
});

test("stinger stays inside the master cap even at full intensity/volume", async () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  await engine.setEnabled(true);
  engine.setVolume(1);
  const ctx = instances[0];
  const before = ctx.created.length;
  engine.cue("stinger", { intensity: 1 });
  const made = ctx.created.slice(before);
  // Every envelope peak scheduled for the stinger is <= 1 pre-master...
  const peaks = made
    .filter((n) => n.kind === "gain")
    .flatMap((n) => n.gain.calls)
    .filter((c) => c[0] === "linear" || c[0] === "set")
    .map((c) => c[1]);
  assert.ok(peaks.length > 0);
  assert.ok(peaks.every((p) => p <= 1 + 1e-9), `peaks ${peaks}`);
  // ...and the master gain itself still respects the 0.4 hard cap.
  const comp = ctx.created.find((n) => n.kind === "compressor");
  const m = ctx.created.find(
    (n) => n.kind === "gain" && n.connections.includes(comp),
  );
  assert.ok(m.gain.value <= 0.4 + 1e-9);
  engine.dispose();
});

test("drone thickens: detuned saw layer rises with tension, silent when calm", async () => {
  const { RichAudioContext, instances } = makeRichContext();
  const engine = new AudioEngine({ contextClass: RichAudioContext });
  await engine.setEnabled(true);
  const ctx = instances[0];
  const saws = ctx.created.filter((n) => n.kind === "osc" && n.type === "sawtooth");
  assert.ok(saws.length >= 2, "two detuned saws exist");
  const sawGain = saws[0].connections[0];
  engine.update(snapshot({ tension: 0.9, state: "PEAK" }));
  assert.ok(sawGain.gain.value > 0.03, "saws thicken under tension");
  engine.update(snapshot({ tension: 0.9, state: "RELIEF" }));
  assert.equal(sawGain.gain.value, 0, "saws vanish in relief");
  engine.dispose();
});
