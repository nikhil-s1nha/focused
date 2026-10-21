import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioEngine } from "../public/audio-engine.mjs";
import { MELODY } from "../public/music-box.mjs";
import {
  FnafAudio, SubtitlePlayer, ALL_SOUNDS, SOUND_NAMES, AMBIENCE_PROFILES, MAX_LEVEL, SCARE_ATTACK,
} from "../public/fnaf/audio/fnaf-audio.mjs";
import { POWER_OUT_JINGLE, scheduleJingle, jingleDuration, midiToHz } from "../public/fnaf/audio/jingles.mjs";

class FakeParam {
  constructor(v = 0) { this.value = v; this.max = v; this.ramps = []; }
  _set(v) { this.value = v; if (v > this.max) this.max = v; }
  setValueAtTime(v) { this._set(v); }
  linearRampToValueAtTime(v) { this.ramps.push(v); this._set(v); }
  exponentialRampToValueAtTime(v) { this._set(v); }
  setTargetAtTime(v) { this._set(v); }
  cancelScheduledValues() {}
}
class FakeNode {
  constructor(kind) {
    this.kind = kind; this.gain = new FakeParam(1); this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0); this.Q = new FakeParam(1); this.pan = new FakeParam(0);
    this.threshold = new FakeParam(); this.knee = new FakeParam(); this.ratio = new FakeParam();
    this.attack = new FakeParam(); this.release = new FakeParam();
    this.connections = []; this.started = 0; this.stopped = 0; this.type = "";
  }
  connect(t) { this.connections.push(t); return t; }
  disconnect() { this.connections = []; }
  start() { this.started++; }
  stop() { this.stopped++; }
}
function makeCtx() {
  const instances = [];
  class Ctx {
    constructor() {
      this.state = "suspended"; this.currentTime = 0; this.sampleRate = 8000;
      this.destination = new FakeNode("destination"); this.created = []; instances.push(this);
    }
    async resume() { this.state = "running"; }
    async suspend() { this.state = "suspended"; }
    async close() { this.state = "closed"; }
    _m(k) { const n = new FakeNode(k); this.created.push(n); return n; }
    createGain() { return this._m("gain"); }
    createOscillator() { return this._m("osc"); }
    createBiquadFilter() { return this._m("filter"); }
    createStereoPanner() { return this._m("panner"); }
    createBufferSource() { return this._m("buffer-source"); }
    createDynamicsCompressor() { return this._m("compressor"); }
    createBuffer(c, len, rate) { const d = new Float32Array(len); return { length: len, sampleRate: rate, getChannelData: () => d }; }
  }
  return { Ctx, instances };
}
function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
async function setup(rng) {
  const { Ctx, instances } = makeCtx();
  const engine = new AudioEngine({ contextClass: Ctx });
  const fa = new FnafAudio(engine, { rng });
  return { engine, fa, instances, ctx: () => instances[0] };
}
const lastPan = (ctx) => ctx.created.filter((n) => n.kind === "panner").at(-1);

test("registry lists every required office and animatronic sound", () => {
  const required = ["fan", "doorSlam", "lightBuzz", "monitorUp", "monitorDown", "cameraBlip", "cameraStatic", "doorBang",
    "powerOut", "sixAM", "hourChime", "phoneRing", "callStart", "radioCrackle", "footsteps", "ventCrawl", "ventBang", "pans",
    "laugh", "breathing", "maskBreath", "musicBoxTick", "powerOutJingle", "eyes", "jumpscare", "victimSting", "gameOver"];
  for (const n of required) assert.ok(ALL_SOUNDS.includes(n), n);
  assert.equal(new Set(ALL_SOUNDS).size, ALL_SOUNDS.length);
  assert.equal(SOUND_NAMES.office.length + SOUND_NAMES.animatronic.length, ALL_SOUNDS.length);
  assert.deepEqual(Object.keys(AMBIENCE_PROFILES).sort(), ["bedroom4", "blackout", "office1", "office2", "office3"]);
});

test("everything is a no-op before the engine is enabled", async () => {
  const { fa, instances } = await setup(seeded(1));
  for (const n of ALL_SOUNDS) assert.equal(fa.play(n), false, n);
  assert.equal(fa.setAmbience("office1"), false);
  assert.equal(fa.handleEvent({ type: "jumpscare" }), false);
  fa.update({}, null); fa.stop("fan"); fa.dispose();
  assert.equal(instances.length, 0);
});

test("every registered sound plays once enabled and unknown names are rejected", async () => {
  const { engine, fa } = await setup(seeded(2));
  await engine.setEnabled(true);
  for (const n of ALL_SOUNDS) assert.equal(fa.play(n, { duration: 1 }), true, n);
  assert.equal(fa.play("nope"), false);
  assert.equal(fa.stats.played >= ALL_SOUNDS.length, true);
  await engine.setEnabled(false);
  assert.equal(fa.play("doorSlam"), false); // disabled again -> no-op
});

test("panning: side and position map to stereo pan; attenuation grows with distance", async () => {
  const { engine, fa, ctx } = await setup(seeded(3));
  await engine.setEnabled(true);
  fa.play("doorSlam", { side: "left" });
  assert.ok(lastPan(ctx()).pan.value < -0.5);
  fa.play("doorSlam", { side: "right" });
  assert.ok(lastPan(ctx()).pan.value > 0.5);
  fa.play("doorSlam", { side: "center" });
  assert.equal(lastPan(ctx()).pan.value, 0);
  engine.listener.x = 0; engine.listener.z = 2;
  fa.play("footsteps", { position: { x: 3, z: 1 }, intensity: 0.5 });
  const near = fa.lastPlayed;
  assert.ok(near.pan > 0);
  fa.play("footsteps", { position: { x: 3, z: -5 }, intensity: 0.5 });
  assert.ok(fa.lastPlayed.level < near.level);
  // listener follows camera passed to update
  fa.update({}, { position: { x: 3, z: -5 } });
  assert.equal(engine.listener.x, 3);
  fa.play("footsteps", { position: { x: 3, z: -5 } });
  assert.ok(Math.abs(fa.lastPlayed.pan) < 0.01);
});

test("loops start once, are idempotent, and stop with a fade", async () => {
  const { engine, fa } = await setup(seeded(4));
  await engine.setEnabled(true);
  assert.equal(fa.isLooping("fan"), false);
  fa.play("fan");
  fa.play("fan");
  assert.equal(fa.loops.size, 1);
  fa.play("lightBuzz", { side: "left" });
  fa.play("lightBuzz", { side: "right" });
  assert.equal(fa.loops.size, 3);
  const nodes = [...fa.loops.values()].find((l) => l.name === "fan").nodes;
  assert.ok(nodes.every((n) => n.started >= 1));
  assert.equal(fa.stop("lightBuzz", { side: "left" }), true);
  assert.equal(fa.loops.size, 2);
  assert.equal(fa.stop("fan"), true);
  assert.ok(nodes.every((n) => n.stopped >= 1));
  assert.equal(fa.stop("fan"), false);
  fa.update({ maskOn: true });
  assert.ok(fa.isLooping("maskBreath"));
  fa.update({ maskOn: false });
  assert.equal(fa.isLooping("maskBreath"), false);
});

test("limiter safety: shares engine master/limiter; levels and envelopes stay capped", async () => {
  const { engine, fa, ctx } = await setup(seeded(5));
  await engine.setEnabled(true);
  engine.setVolume(1);
  for (const n of ALL_SOUNDS) fa.play(n, { intensity: 1, duration: 1 });
  assert.ok(engine.graph.limiter, "engine limiter present");
  assert.ok(engine.graph.master.gain.value <= 0.4 + 1e-9);
  assert.ok(engine.graph.master.connections.includes(engine.graph.limiter));
  assert.ok(fa.bus.connections.includes(engine.graph.master));
  assert.ok(fa.stats.peakLevel <= MAX_LEVEL);
  for (const node of ctx().created) if (node.kind === "gain") {
    for (const r of node.gain.ramps) assert.ok(r <= MAX_LEVEL + 1e-9, `ramp ${r}`);
  }
});

test("jumpscare is capped below other peaks and has a non-instant attack", async () => {
  const { engine, fa, ctx } = await setup(seeded(6));
  await engine.setEnabled(true);
  fa.play("jumpscare", { intensity: 1 });
  assert.ok(fa.lastPlayed.level <= MAX_LEVEL * 0.8 + 1e-9);
  assert.ok(fa.lastPlayed.duration <= 1.01);
  assert.ok(SCARE_ATTACK >= 0.01);
  for (const node of ctx().created) if (node.kind === "gain") assert.ok(node.gain.max <= 1);
  fa.play("jumpscare", { intensity: 5 });
  assert.ok(fa.lastPlayed.level <= MAX_LEVEL);
});

test("determinism: same seed gives identical node graphs", async () => {
  const run = async (seed) => {
    const { engine, fa, ctx } = await setup(seeded(seed));
    await engine.setEnabled(true);
    fa.play("laugh"); fa.play("radioCrackle"); fa.play("footsteps"); fa.play("murmur", { duration: 2 });
    return ctx().created.filter((n) => n.kind === "osc" || n.kind === "gain").map((n) => `${n.kind}:${n.frequency.value}:${n.gain.value}`).join("|");
  };
  assert.equal(await run(11), await run(11));
  assert.notEqual(await run(11), await run(12));
});

test("ambience profiles start, switch, and schedule distant thumps with injected rng", async () => {
  const { engine, fa, instances } = await setup(seeded(7));
  await engine.setEnabled(true);
  assert.equal(fa.setAmbience("nope"), false);
  for (const p of Object.keys(AMBIENCE_PROFILES)) assert.equal(fa.setAmbience(p), true, p);
  fa.setAmbience("office2");
  const first = fa.nextThump;
  assert.ok(first > 0);
  const before = fa.stats.thumps;
  fa.update({}); // not due
  assert.equal(fa.stats.thumps, before);
  instances[0].currentTime = first + 0.1;
  fa.update({});
  assert.equal(fa.stats.thumps, before + 1);
  assert.ok(fa.nextThump > instances[0].currentTime);
  assert.equal(fa.lastPlayed.level < 0.12, true); // distant => quiet
});

test("jingle note data is valid, original, and distinct from the music box melody", () => {
  const n = POWER_OUT_JINGLE.notes;
  assert.ok(n.length >= 12);
  for (const x of n) {
    assert.ok(Number.isInteger(x.midi) && x.midi >= 48 && x.midi <= 96);
    assert.ok(x.beats > 0 && x.beats <= 4);
  }
  assert.ok(Object.isFrozen(n));
  const jm = n.map((x) => x.midi).join(","), mm = MELODY.map((x) => x.midi).join(",");
  assert.notEqual(jm, mm);
  let shared = 0;
  for (let i = 0; i + 3 < n.length; i++) for (let j = 0; j + 3 < MELODY.length; j++)
    if (n.slice(i, i + 4).every((x, k) => x.midi === MELODY[j + k].midi && x.beats === MELODY[j + k].beats)) shared++;
  assert.equal(shared, 0);
  const sch = scheduleJingle(POWER_OUT_JINGLE);
  assert.equal(sch.length, n.length);
  assert.ok(sch.every((s, i) => i === 0 || s.at > sch[i - 1].at));
  assert.ok(Math.abs(jingleDuration(POWER_OUT_JINGLE) - (sch.at(-1).at + sch.at(-1).dur)) < 1e-9);
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(scheduleJingle(POWER_OUT_JINGLE, { dropRng: () => 0, dropP: 0.5 }).length === 0);
});

test("power-out jingle plays with the eyes cue", async () => {
  const { engine, fa } = await setup(seeded(8));
  await engine.setEnabled(true);
  const before = fa.stats.played;
  fa.play("powerOutJingle", { side: "center" });
  assert.equal(fa.stats.played, before + 2); // jingle + eyes
});

test("handleEvent maps engine events to sounds", async () => {
  const { engine, fa } = await setup(seeded(9));
  await engine.setEnabled(true);
  const cases = [
    [{ type: "move" }, "footsteps"], [{ type: "move", room: "kitchen" }, "pans"], [{ type: "move", vent: true }, "ventCrawl"],
    [{ type: "door-knock", side: "left" }, "doorBang"], [{ type: "jumpscare" }, "jumpscare"],
    [{ type: "power-warning" }, "hourChime"], [{ type: "power-out" }, "powerOutJingle"], [{ type: "hour" }, "hourChime"],
    [{ type: "night-win" }, "sixAM"], [{ type: "static" }, "cameraStatic"], [{ type: "phone-call-start" }, "callStart"],
    [{ type: "phone-call-end" }, "callStart"], [{ type: "cue", name: "laugh" }, "laugh"], [{ type: "cue", name: "breathing", variant: "closet" }, "breathing"],
  ];
  for (const [ev, last] of cases) {
    assert.equal(fa.handleEvent(ev), true, ev.type);
    assert.equal(fa.lastPlayed.name, last, ev.type);
  }
  assert.equal(fa.handleEvent({ type: "cue", name: "unknown" }), false);
  assert.equal(fa.handleEvent({ type: "bogus" }), false);
  assert.equal(fa.handleEvent(null), false);
});

test("SubtitlePlayer emits subtitles, length-matches murmur, and prefers manifest files", async () => {
  const { engine, fa } = await setup(seeded(10));
  await engine.setEnabled(true);
  const events = [];
  const sp = new SubtitlePlayer(fa, { onSubtitle: (e) => events.push(e) });
  assert.equal(await sp.play({ text: "Hello?", duration: 3 }), true);
  assert.equal(events[0].type, "show");
  assert.equal(events[0].text, "Hello?");
  assert.equal(fa.lastPlayed.name, "murmur");
  assert.ok(Math.abs(fa.lastPlayed.duration - 3) < 0.2);
  sp.stop();
  assert.equal(events.at(-1).type, "hide");
  assert.equal(await sp.play({ text: 1 }), false);
  // manifest hit
  const files = [];
  const sp2 = new SubtitlePlayer(fa, { manifest: { n1: "/v/n1.mp3" }, playFile: async (u) => (files.push(u), true) });
  const played = fa.stats.played;
  await sp2.play({ id: "n1", text: "x", duration: 2 });
  assert.deepEqual(files, ["/v/n1.mp3"]);
  assert.equal(fa.stats.played, played); // no synthesized fallback
  // manifest failure falls back
  const sp3 = new SubtitlePlayer(fa, { manifest: { n2: "/bad" }, playFile: async () => { throw new Error("x"); } });
  await sp3.play({ id: "n2", text: "y", duration: 2 });
  assert.equal(fa.stats.played, played + 1);
});

test("dispose stops loops and ambience cleanly", async () => {
  const { engine, fa } = await setup(seeded(13));
  await engine.setEnabled(true);
  fa.play("fan"); fa.setAmbience("office1");
  fa.dispose();
  assert.equal(fa.loops.size, 0);
  assert.equal(fa.ambience, null);
});
