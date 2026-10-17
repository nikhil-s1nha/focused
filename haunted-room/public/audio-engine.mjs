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
    this.listener = { x: 0, z: 2 }; // player rig start; updated from camera
    this.duckedUntil = 0; // audio-clock time the current duck() releases at
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
    // Track the listener's floor position for positional one-shot cues.
    const p = camera && camera.position;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      this.listener.x = p.x;
      this.listener.z = p.z;
    }
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
    // Detuned saw layer thickens in as danger rises; detune spreads wider.
    setParam(this.ctx, g.sawGain.gain, calm ? 0 : t * 0.07, 0.8);
    setParam(this.ctx, g.sawB.detune, 8 + t * 22, 0.8);
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
  /**
   * One-shot synthesized cue. Returns true when a sound was scheduled.
   *   cue("footstep", { position: {x,z}, intensity, pitch })
   * Names: footstep, thump, knock, breath, static, powerWarning,
   *        blackoutPowerDown, stinger, eyes, cameraSwitch, monitorUp, monitorDown,
   *        powerCritical, lightFlicker, blackout.
   * `position` pans/attenuates relative to the listener (tracked in update);
   * a plain `pan` (-1..1) can be passed instead. Nothing plays before
   * setEnabled(true) — the opt-in contract holds for cues too.
   */
  cue(name, opts = {}) {
    if (!this.enabled || !this.ctx || !this.graph) return false;
    const intensity = clamp01(opts.intensity ?? 0.6);
    let pan = Math.max(-1, Math.min(1, Number.isFinite(opts.pan) ? opts.pan : 0));
    let att = 1;
    const pos = opts.position;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
      const dx = pos.x - this.listener.x;
      const dz = pos.z - this.listener.z;
      const dist = Math.hypot(dx, dz);
      pan = Math.max(-1, Math.min(1, dx / 3.5));
      att = 1 / (1 + 0.35 * Math.max(0, dist - 1)); // distant = quieter
    }
    const level = (0.1 + 0.26 * intensity) * att;
    switch (name) {
      case "footstep":
        this.#footstep(level, pan, clamp01(opts.pitch ?? 0.5));
        return true;
      case "thump":
        this.#knock(level * 1.2, pan, 1, 92);
        return true;
      case "knock":
        this.#knock(level, pan, opts.count === 3 ? 3 : 2, 180);
        return true;
      case "breath":
        this.#breath(level, pan);
        return true;
      case "static":
        this.#static(level, pan);
        return true;
      case "powerWarning":
        this.#powerWarning(level, pan);
        return true;
      case "blackoutPowerDown":
        this.#powerDown(level * 1.3, pan);
        return true;
      case "stinger":
        this.#stinger(Math.min(1, level * 3 + 0.3), pan);
        return true;
      case "eyes":
        this.#eyes(level * 0.25, pan);
        return true;
      case "cameraSwitch":
        this.#blip(level * 0.6, pan, [1400, 900], 0.09, "square");
        return true;
      case "monitorUp":
        this.#blip(level * 0.7, pan, [90, 1100], 0.45, "sawtooth");
        return true;
      case "monitorDown":
        this.#blip(level * 0.7, pan, [900, 60], 0.4, "sawtooth");
        return true;
      case "powerCritical":
        this.#powerWarning(level * 1.15, pan, 3, 147);
        return true;
      case "lightFlicker":
        this.#blip(level * 0.5, pan, [120, 100], 0.22, "sawtooth");
        return true;
      case "blackout":
        this.#powerDown(level * 1.5, pan);
        this.#knock(level * 1.3, pan, 1, 70);
        return true;
      default:
        return false;
    }
  }
  /**
   * The silence trick: smoothly pull the whole continuous bed (drone +
   * shimmer) to near-silence for `seconds`, then restore. One-shot cues keep
   * routing straight to the master, so a stinger lands into the silence.
   */
  duck(seconds = 2) {
    if (!this.ctx || !this.graph) return false;
    const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 2;
    const g = this.graph.bed.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues?.(now);
    g.setValueAtTime?.(typeof g.value === "number" ? g.value : 1, now);
    g.linearRampToValueAtTime?.(0.001, now + 0.3); // drop fast but smooth
    g.setValueAtTime?.(0.001, now + s);
    g.linearRampToValueAtTime?.(1, now + s + 1.2); // creep back
    if (typeof g.linearRampToValueAtTime !== "function") g.value = 0.001;
    this.duckedUntil = now + s;
    return true;
  }
  dispose() {
    this.enabled = false;
    this.lastEncounter = null;
    if (this.graph) {
      for (const node of Object.values(this.graph)) {
        if (!node) continue;
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
    // Clipping safety: a limiter-tuned compressor sits after the master cap
    // when the context supports one (stingers hit hard but never clip).
    let limiter = null;
    if (typeof ctx.createDynamicsCompressor === "function") {
      limiter = ctx.createDynamicsCompressor();
      if (limiter.threshold) limiter.threshold.value = -12;
      if (limiter.knee) limiter.knee.value = 4;
      if (limiter.ratio) limiter.ratio.value = 16;
      if (limiter.attack) limiter.attack.value = 0.002;
      if (limiter.release) limiter.release.value = 0.14;
      master.connect(limiter);
      limiter.connect(ctx.destination);
    } else {
      master.connect(ctx.destination);
    }
    // Duckable bed bus: the continuous dread layers live behind it, so
    // duck() can pull the whole bed to near-silence while one-shot cues
    // (the stinger) still route straight into the master.
    const bed = ctx.createGain();
    bed.gain.value = 1;
    bed.connect(master);
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
    // Detuned saw pair: thickens the drone as tension rises (sawGain is
    // driven in update()); lowpassed by the shared drone filter.
    const sawA = ctx.createOscillator();
    sawA.type = "sawtooth";
    sawA.frequency.value = 54;
    const sawB = ctx.createOscillator();
    sawB.type = "sawtooth";
    sawB.frequency.value = 54.6; // slow beating against sawA
    const sawGain = ctx.createGain();
    sawGain.gain.value = 0;
    sawA.connect(sawGain);
    sawB.connect(sawGain);
    sawGain.connect(filter);
    osc.connect(filter);
    sub.connect(filter);
    noise.connect(noiseGain);
    noiseGain.connect(filter);
    filter.connect(droneGain);
    droneGain.connect(bed);
    // Slow LFO breathing on the drone bed (~9 s cycle).
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.11;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.02;
    lfo.connect(lfoDepth);
    if (droneGain.gain && typeof lfoDepth.connect === "function")
      lfoDepth.connect(droneGain.gain);
    // High shimmer layer, silent except at PEAK.
    const shimmer = ctx.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.value = 1680;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0;
    shimmer.connect(shimmerGain);
    shimmerGain.connect(bed);
    for (const s of [osc, sub, noise, shimmer, sawA, sawB, lfo]) s.start?.();
    this.graph = {
      master,
      limiter,
      bed,
      droneGain,
      filter,
      osc,
      sub,
      noise,
      noiseGain,
      sawA,
      sawB,
      sawGain,
      lfo,
      lfoDepth,
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
  // Single heavy, distant footstep: lowpassed noise thud + sub-sine knock.
  // pitch 0..1 picks the surface voicing (low = heavier, closer to the slab).
  #footstep(level, pan, pitch) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const src = ctx.createBufferSource();
    src.buffer = this.#noiseBuffer(0.5, 40503 + Math.round(pitch * 97));
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 160 + pitch * 320;
    src.connect(filter);
    filter.connect(gain);
    const t0 = ctx.currentTime + 0.02;
    this.#envelope(gain.gain, level, t0, 0.01, 0.22);
    src.start?.(t0);
    src.stop?.(t0 + 0.5);
    // Weight under the step: a short pitched-down sub thump.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const f0 = 46 + pitch * 26;
    osc.frequency.value = f0;
    osc.frequency.setValueAtTime?.(f0, t0);
    osc.frequency.exponentialRampToValueAtTime?.(Math.max(28, f0 * 0.55), t0 + 0.12);
    const sub = this.#tail(pan);
    osc.connect(sub);
    this.#envelope(sub.gain, level * 0.8, t0, 0.006, 0.16);
    osc.start?.(t0);
    osc.stop?.(t0 + 0.35);
  }
  // Filtered-noise breathing: two slow swells through a vowel-ish bandpass.
  #breath(level, pan) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const src = ctx.createBufferSource();
    src.buffer = this.#noiseBuffer(3.2, 90210);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 420;
    if (filter.Q) filter.Q.value = 1.4;
    src.connect(filter);
    filter.connect(gain);
    const t0 = ctx.currentTime + 0.05;
    this.#envelope(gain.gain, level * 0.8, t0, 0.55, 0.75); // inhale
    this.#envelope(gain.gain, level, t0 + 1.5, 0.45, 0.9); // closer exhale
    src.start?.(t0);
    src.stop?.(t0 + 3.3);
  }
  // Low double-beep power warning (sine, deliberately dull — not an alarm).
  #powerWarning(level, pan, beeps = 2, freq = 196) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const t0 = ctx.currentTime + 0.02;
    for (let i = 0; i < beeps; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      this.#envelope(gain.gain, level * 0.8, t0 + i * 0.42, 0.015, 0.2);
      osc.start?.(t0 + i * 0.42);
      osc.stop?.(t0 + i * 0.42 + 0.3);
    }
  }
  // Short pitch-swept blip (CRT switch, console up/down, ballast buzz).
  #blip(level, pan, [from, to], seconds, type = "sine") {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const t0 = ctx.currentTime + 0.02;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = from;
    osc.frequency.setValueAtTime?.(from, t0);
    osc.frequency.exponentialRampToValueAtTime?.(to, t0 + seconds);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    osc.connect(filter);
    filter.connect(gain);
    this.#envelope(gain.gain, level, t0, 0.01, seconds);
    osc.start?.(t0);
    osc.stop?.(t0 + seconds + 0.1);
  }
  // Descending whine: everything electrical sagging to nothing.
  #powerDown(level, pan) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const t0 = ctx.currentTime + 0.02;
    osc.frequency.value = 520;
    osc.frequency.setValueAtTime?.(520, t0);
    osc.frequency.exponentialRampToValueAtTime?.(34, t0 + 1.6);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.frequency.setValueAtTime?.(900, t0);
    filter.frequency.exponentialRampToValueAtTime?.(90, t0 + 1.6);
    osc.connect(filter);
    filter.connect(gain);
    this.#envelope(gain.gain, level, t0, 0.03, 1.7);
    osc.start?.(t0);
    osc.stop?.(t0 + 1.9);
  }
  // Jumpscare sting: dissonant detuned-saw cluster + white-noise burst.
  // Loud relative to the bed, but always behind the master cap + limiter.
  #stinger(level, pan) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const t0 = ctx.currentTime + 0.01;
    // Minor-second / tritone cluster — maximally wrong on purpose.
    for (const f of [466.16, 493.88, 659.26, 932.33]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      if (osc.detune) osc.detune.value = f > 600 ? 18 : -14;
      osc.connect(gain);
      osc.start?.(t0);
      osc.stop?.(t0 + 1.3);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = this.#noiseBuffer(1.2, 66613);
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 900;
    noise.connect(filter);
    filter.connect(gain);
    noise.start?.(t0);
    noise.stop?.(t0 + 1.25);
    this.#envelope(gain.gain, Math.min(1, level), t0, 0.005, 1.1);
  }
  // Faint "eyes in the dark" shimmer: a beating high sine pair, barely there.
  #eyes(level, pan) {
    const ctx = this.ctx;
    const gain = this.#tail(pan);
    const t0 = ctx.currentTime + 0.03;
    for (const f of [2350, 2362]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start?.(t0);
      osc.stop?.(t0 + 1.8);
    }
    this.#envelope(gain.gain, level, t0, 0.7, 1.0);
  }
}
