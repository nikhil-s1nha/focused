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
