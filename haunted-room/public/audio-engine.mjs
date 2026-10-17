// AudioEngine — fully synthesized WebAudio layer for the haunted room.
// No assets, no autoplay: nothing is created until setEnabled(true) is called
// from a user gesture. Imports cleanly in Node (no top-level window/AudioContext
// references); pass { contextClass } to inject a stub for tests.

const MASTER_CAP = 0.4; // hard ceiling on master gain: headset-safe loudness

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// Static stereo placement per encounter type, matching the room layout
// (doorway on the left/back, window on the right, lamp overhead).
const ENCOUNTER_PAN = Object.freeze({
  "shadow-corridor": -0.7,
  "shadow-window": 0.7,
  "lamp-flicker": 0,
  "door-creak": -0.5,
  "radio-static": 0.45,
});

function setParam(ctx, param, value, timeConstant = 0.2) {
  if (!param) return;
  if (typeof param.setTargetAtTime === "function") {
    param.setTargetAtTime(value, ctx.currentTime, timeConstant);
  } else {
    param.value = value;
  }
}

export class AudioEngine {
  constructor({ contextClass = null } = {}) {
    const globalCtor =
      typeof globalThis.AudioContext === "function"
        ? globalThis.AudioContext
        : typeof globalThis.webkitAudioContext === "function"
          ? globalThis.webkitAudioContext
          : null;
    this.ContextClass = contextClass ?? globalCtor;
    this.masterCap = MASTER_CAP;
    this.ctx = null;
    this.graph = null;
    this.enabled = false;
    this.volume = 0.7;
    this.lastEncounter = null; // { id, t } of the encounter last seen in update()
  }
  // Must be called from a user gesture. Creates/resumes the context on true,
  // suspends on false. Returns false when no AudioContext is available.
  async setEnabled(on) {
    if (on) {
      if (!this.ContextClass) return false;
      if (!this.ctx) {
        this.ctx = new this.ContextClass();
        this.#build();
      }
      if (this.ctx.state !== "running" && typeof this.ctx.resume === "function")
        await this.ctx.resume();
      this.enabled = true;
      return true;
    }
    this.enabled = false;
    this.lastEncounter = null;
    if (
      this.ctx &&
      this.ctx.state === "running" &&
      typeof this.ctx.suspend === "function"
    )
      await this.ctx.suspend();
    return true;
  }
  setVolume(v) {
    this.volume = clamp01(v);
    if (this.ctx && this.graph)
      setParam(this.ctx, this.graph.master.gain, this.volume * MASTER_CAP, 0.05);
    return this.volume;
  }
  // Drives the layered drone from a Director snapshot and fires sparse one-shot
  // cues when snapshot.encounter changes. `camera` is accepted so callers can
  // pass the XR camera; spatialization currently uses fixed per-type panning.
  update(snapshot, camera = null) {
    if (!this.enabled || !this.ctx || !this.graph || !snapshot) return;
    void camera;
    const g = this.graph;
    const t = clamp01(snapshot.tension);
    const calm =
      snapshot.paused ||
      snapshot.state === "WAIT" ||
      snapshot.state === "RELIEF" ||
      snapshot.phase !== "running";
    // Drone bed: gain, filter cutoff and detune follow tension; everything
    // eases down in WAIT/RELIEF and while paused.
    setParam(this.ctx, g.droneGain.gain, calm ? 0.04 + t * 0.03 : 0.08 + t * 0.2, 0.6);
    setParam(this.ctx, g.filter.frequency, calm ? 120 : 140 + t * 760, 0.5);
    setParam(this.ctx, g.osc.detune, t * 28, 0.5);
    // Subtle shimmer only at PEAK.
    setParam(
      this.ctx,
      g.shimmerGain.gain,
      !calm && snapshot.state === "PEAK" ? 0.04 + t * 0.05 : 0,
      0.8,
    );
    const e = snapshot.encounter;
    if (
      e &&
      (!this.lastEncounter ||
        this.lastEncounter.id !== e.id ||
        e.t < this.lastEncounter.t)
    ) {
      this.#cue(e);
    }
    this.lastEncounter = e ? { id: e.id, t: e.t } : null;
  }
  dispose() {
    this.enabled = false;
    this.lastEncounter = null;
    if (this.graph) {
      for (const node of Object.values(this.graph)) {
        try {
          node.stop?.();
        } catch {
          /* already stopped */
        }
        try {
          node.disconnect?.();
        } catch {
          /* already disconnected */
        }
      }
      this.graph = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && typeof ctx.close === "function" && ctx.state !== "closed") {
      const p = ctx.close();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }
  #build() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.volume * MASTER_CAP;
    master.connect(ctx.destination);
    // Low drone bed: two sines plus looped noise through a lowpass filter.
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 140;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 54;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 27;
    const noise = ctx.createBufferSource();
    noise.buffer = this.#noiseBuffer(1.5, 22222);
    noise.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.25;
    osc.connect(filter);
    sub.connect(filter);
    noise.connect(noiseGain);
    noiseGain.connect(filter);
    filter.connect(droneGain);
    droneGain.connect(master);
    // High shimmer layer, silent except at PEAK.
    const shimmer = ctx.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.value = 1680;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0;
    shimmer.connect(shimmerGain);
    shimmerGain.connect(master);
    for (const s of [osc, sub, noise, shimmer]) s.start?.();
    this.graph = {
      master,
      droneGain,
      filter,
      osc,
      sub,
      noise,
      noiseGain,
      shimmer,
      shimmerGain,
    };
  }
  // Deterministic LCG noise so output is reproducible (no Math.random).
  #noiseBuffer(seconds, seed) {
    const rate = this.ctx.sampleRate || 48000;
    const len = Math.max(1, Math.floor(seconds * rate));
    const buffer = this.ctx.createBuffer(1, len, rate);
    const data = buffer.getChannelData(0);
    let s = seed >>> 0;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = (s / 2147483648 - 1) * 0.8;
    }
    return buffer;
  }
  // Gain node (optionally behind a stereo panner) routed into the master bus.
  #tail(pan) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    if (typeof ctx.createStereoPanner === "function") {
      const panner = ctx.createStereoPanner();
      if (panner.pan) panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      panner.connect(this.graph.master);
    } else if (typeof ctx.createPanner === "function") {
      const panner = ctx.createPanner();
      panner.setPosition?.(pan * 2, 0, -1);
      gain.connect(panner);
      panner.connect(this.graph.master);
    } else {
      gain.connect(this.graph.master);
    }
    return gain;
  }
  #envelope(param, peak, at, attack, decay) {
    if (typeof param.setValueAtTime === "function") {
      param.setValueAtTime(0, at);
      param.linearRampToValueAtTime?.(peak, at + attack);
      if (typeof param.exponentialRampToValueAtTime === "function")
        param.exponentialRampToValueAtTime(0.001, at + attack + decay);
      else param.linearRampToValueAtTime?.(0, at + attack + decay);
    } else {
      param.value = peak;
    }
  }
  #cue(encounter) {
    const pan = ENCOUNTER_PAN[encounter.id] ?? 0;
    const level = 0.12 + 0.2 * clamp01(encounter.intensity);
    switch (encounter.id) {
      case "shadow-corridor":
      case "shadow-window":
        this.#footsteps(level, pan, encounter.intensity);
        break;
      case "door-creak":
        this.#knock(level, pan, 2, 150);
        break;
      case "lamp-flicker":
        this.#knock(level * 0.6, pan, 1, 620);
        break;
      case "radio-static":
        this.#static(level, pan);
        break;
      default:
        this.#knock(level * 0.5, pan, 1, 220);
    }
  }
  // Rhythmic filtered noise bursts, panned by encounter position.
  #footsteps(level, pan, intensity) {
    const ctx = this.ctx;
    const steps = 3 + Math.round(clamp01(intensity) * 3);
    const gap = 0.34;
    const gain = this.#tail(pan);
    const src = ctx.createBufferSource();
    src.buffer = this.#noiseBuffer(steps * gap + 0.4, 7777);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    src.connect(filter);
    filter.connect(gain);
    const t0 = ctx.currentTime + 0.05;
    for (let i = 0; i < steps; i++)
      this.#envelope(gain.gain, level, t0 + i * gap, 0.015, 0.14);
    src.start?.(t0);
    src.stop?.(t0 + steps * gap + 0.4);
  }
  // Pitched-down sine thump with fast decay.
  #knock(level, pan, count, startFreq) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const t0 = ctx.currentTime + 0.03;
    for (let i = 0; i < count; i++) {
      const at = t0 + i * 0.5;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = startFreq;
      osc.frequency.setValueAtTime?.(startFreq, at);
      osc.frequency.exponentialRampToValueAtTime?.(
        Math.max(40, startFreq * 0.3),
        at + 0.18,
      );
      osc.connect(gain);
      this.#envelope(gain.gain, level, at, 0.008, 0.22);
      osc.start?.(at);
      osc.stop?.(at + 0.45);
    }
  }
  // Bandpassed noise sputter for the radio.
  #static(level, pan) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const src = ctx.createBufferSource();
    src.buffer = this.#noiseBuffer(1.6, 31337);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1500;
    if (filter.Q) filter.Q.value = 0.8;
    src.connect(filter);
    filter.connect(gain);
    const t0 = ctx.currentTime + 0.03;
    for (let i = 0; i < 4; i++) {
      const wobble = 0.5 + 0.5 * ((Math.imul(i + 1, 2654435761) >>> 8) % 100) / 100;
      this.#envelope(gain.gain, level * wobble, t0 + i * 0.38, 0.02, 0.2);
    }
    src.start?.(t0);
    src.stop?.(t0 + 1.7);
  }
}
