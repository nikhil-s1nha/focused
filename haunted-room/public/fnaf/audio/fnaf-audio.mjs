// FnafAudio — fully synthesized FNAF sound set that composes with AudioEngine.
// Re-uses the engine's AudioContext, master cap and limiter by routing through
// its master bus (engine.graph.master). Nothing exists until the engine has been
// enabled via setEnabled(true) from a user gesture; before that every method is a
// no-op. All sounds original. Jumpscare/sting loudness is capped (VR comfort).
import { JINGLES, midiToHz, scheduleJingle } from "./jingles.mjs";

const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const clamp01 = (v) => clamp(v, 0, 1);
export const BUS_GAIN = 0.8; // fnaf bus sits under the engine master (<=0.4)
export const MAX_LEVEL = 0.5; // per-voice peak ceiling, jumpscare included
export const SCARE_ATTACK = 0.012; // no instant-peak transients

export const SOUND_NAMES = Object.freeze({
  office: ["fan", "doorSlam", "lightBuzz", "monitorUp", "monitorDown", "cameraBlip",
    "cameraStatic", "doorBang", "powerOut", "sixAM", "hourChime", "phoneRing",
    "callStart", "radioCrackle"],
  animatronic: ["footsteps", "ventCrawl", "ventBang", "pans", "laugh", "breathing",
    "maskBreath", "musicBoxTick", "powerOutJingle", "eyes", "jumpscare",
    "victimSting", "gameOver", "murmur", "scream"],
});
export const ALL_SOUNDS = Object.freeze([...SOUND_NAMES.office, ...SOUND_NAMES.animatronic]);
const LOOPING = new Set(["fan", "lightBuzz", "cameraStatic", "maskBreath", "musicBoxTick"]);

export const AMBIENCE_PROFILES = Object.freeze({
  office1: { base: 48, cutoff: 180, level: 0.05, lfo: 0.08, thumpEvery: [9, 20], clank: 0.3 },
  office2: { base: 52, cutoff: 220, level: 0.06, lfo: 0.1, thumpEvery: [7, 16], clank: 0.45 },
  office3: { base: 44, cutoff: 260, level: 0.07, lfo: 0.13, thumpEvery: [5, 12], clank: 0.6 },
  bedroom4: { base: 38, cutoff: 150, level: 0.04, lfo: 0.06, thumpEvery: [12, 26], clank: 0.1 },
  blackout: { base: 32, cutoff: 110, level: 0.07, lfo: 0.05, thumpEvery: [14, 30], clank: 0.2 },
});

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export class FnafAudio {
  constructor(engine, { rng = Math.random } = {}) {
    this.engine = engine;
    this.rng = rng;
    this.bus = null;
    this.loops = new Map(); // key -> {nodes, gain, pos}
    this.ambience = null; // {name, nodes}
    this.nextThump = 0;
    this.noise = null;
    this.stats = { played: 0, lastLevel: 0, peakLevel: 0, thumps: 0 };
    this.lastPlayed = null; // {name, pan, level}
  }
  get ready() {
    const e = this.engine;
    return !!(e && e.enabled && e.ctx && e.graph && e.graph.master);
  }
  has(name) { return ALL_SOUNDS.includes(name); }
  names() { return [...ALL_SOUNDS]; }

  #init() {
    if (!this.ready) return false;
    const ctx = this.engine.ctx;
    if (this.bus && this.busCtx === ctx) return true;
    this.busCtx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = BUS_GAIN;
    this.bus.connect(this.engine.graph.master);
    this.noise = this.#noiseBuffer(1.5, 4242);
    this.loops.clear();
    this.ambience = null;
    return true;
  }
  #noiseBuffer(sec, seed) {
    const ctx = this.engine.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * sec));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const r = lcg(seed);
    for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    return buf;
  }
  // Positional resolution using the engine's listener tracking.
  #resolve(opts = {}) {
    let pan = 0, att = 1;
    if (opts.side === "left") pan = -0.85;
    else if (opts.side === "right") pan = 0.85;
    else if (opts.side === "center") pan = 0;
    const p = opts.position;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      const l = this.engine.listener || { x: 0, z: 0 };
      const dx = p.x - l.x, dz = p.z - l.z;
      const dist = Math.hypot(dx, dz);
      pan = clamp(dx / 3.5, -1, 1);
      att = 1 / (1 + 0.35 * Math.max(0, dist - 1));
    }
    return { pan, att };
  }
  // out chain: gain -> panner -> bus. Returns {gain, input}.
  #chain(level, pan) {
    const ctx = this.engine.ctx;
    const g = ctx.createGain();
    g.gain.value = 1;
    let tail = g;
    if (typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      if (p.pan) p.pan.value = pan;
      g.connect(p);
      p.connect(this.bus);
      tail = p;
    } else g.connect(this.bus);
    return { gain: g, panner: tail, level: Math.min(MAX_LEVEL, level) };
  }
  #env(param, peak, t0, attack, hold, release) {
    param.setValueAtTime?.(0.0001, t0);
    param.linearRampToValueAtTime?.(peak, t0 + attack);
    param.setValueAtTime?.(peak, t0 + attack + hold);
    param.linearRampToValueAtTime?.(0.0001, t0 + attack + hold + release);
    if (typeof param.linearRampToValueAtTime !== "function") param.value = peak;
  }
  #osc(type, f0, f1, t0, dur, dest) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f0;
    if (f1 != null && f1 !== f0) o.frequency.exponentialRampToValueAtTime?.(f1, t0 + dur);
    o.connect(dest);
    o.start?.(t0);
    o.stop?.(t0 + dur + 0.05);
    return o;
  }
  #noiseSrc(t0, dur, freq, q, type, dest, loop = false) {
    const ctx = this.engine.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop || dur > 1.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (f.Q) f.Q.value = q;
    s.connect(f);
    f.connect(dest);
    s.start?.(t0);
    if (!loop) s.stop?.(t0 + dur + 0.05);
    return { src: s, filter: f };
  }
  #thud(c, t0, f, level, dur = 0.3) {
    const g = this.engine.ctx.createGain();
    g.connect(c.gain);
    this.#env(g.gain, level, t0, 0.004, 0.01, dur);
    this.#osc("sine", f, f * 0.4, t0, dur + 0.02, g);
    const n = this.engine.ctx.createGain();
    n.connect(c.gain);
    this.#env(n.gain, level * 0.5, t0, 0.003, 0.005, 0.08);
    this.#noiseSrc(t0, 0.1, 900, 0.8, "lowpass", n);
  }
  #bell(c, t0, midi, level, dur) {
    const g = this.engine.ctx.createGain();
    g.connect(c.gain);
    this.#env(g.gain, level, t0, 0.003, 0.01, dur);
    this.#osc("sine", midiToHz(midi), null, t0, dur, g);
    const h = this.engine.ctx.createGain();
    h.gain.value = 0.25;
    h.connect(g);
    this.#osc("sine", midiToHz(midi) * 2.76, null, t0, dur * 0.5, h);
  }

  /**
   * play(name, {position|side, intensity, who, variant, wind, duration}).
   * Returns true when scheduled. No-op (false) before the engine is enabled.
   */
  play(name, opts = {}) {
    if (!this.has(name) || !this.#init()) return false;
    const ctx = this.engine.ctx;
    const t0 = ctx.currentTime;
    const intensity = clamp01(opts.intensity ?? 0.6);
    const { pan, att } = this.#resolve(opts);
    const level = Math.min(MAX_LEVEL, (0.08 + 0.3 * intensity) * att);
    const key = LOOPING.has(name) ? `${name}:${opts.side || "c"}` : null;
    if (key && this.loops.has(key)) return true; // already looping
    const c = this.#chain(level, pan);
    const L = c.level;
    let dur = 0.5;
    let loop = null;
    const rng = this.rng;
    switch (name) {
      case "fan": {
        this.#env(c.gain.gain, L * 0.35, t0, 1.5, 1e6, 0);
        loop = [this.#noiseSrc(t0, 0, 380, 0.7, "bandpass", c.gain, true).src,
          this.#osc("sine", 58, null, t0, 1e6, c.gain)];
        break;
      }
      case "lightBuzz": {
        this.#env(c.gain.gain, L * 0.3, t0, 0.05, 1e6, 0);
        loop = [this.#osc("sawtooth", 120, null, t0, 1e6, c.gain),
          this.#osc("square", 240, null, t0, 1e6, c.gain)];
        break;
      }
      case "cameraStatic": {
        this.#env(c.gain.gain, L * 0.4, t0, 0.05, 1e6, 0);
        loop = [this.#noiseSrc(t0, 0, 3000, 0.4, "highpass", c.gain, true).src];
        break;
      }
      case "maskBreath": {
        this.#env(c.gain.gain, L * 0.5, t0, 0.3, 1e6, 0);
        const n = this.#noiseSrc(t0, 0, 500, 1.2, "bandpass", c.gain, true);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.35;
        const d = ctx.createGain();
        d.gain.value = 200;
        lfo.connect(d);
        if (n.filter.frequency) d.connect(n.filter.frequency);
        lfo.start?.(t0);
        loop = [n.src, lfo];
        break;
      }
      case "musicBoxTick": {
        const wind = clamp01(opts.wind ?? 1);
        this.#env(c.gain.gain, L * 0.35 * (0.3 + wind * 0.7), t0, 0.2, 1e6, 0);
        const tick = ctx.createGain(); tick.gain.value = 0.2; tick.connect(c.gain);
        const depth = ctx.createGain(); depth.gain.value = 0.2; depth.connect(tick.gain);
        loop = [this.#osc("triangle", midiToHz(96), null, t0, 1e6, tick),
          this.#osc("square", 2 + 6 * wind, null, t0, 1e6, depth)];
        break;
      }
      case "doorSlam":
        this.#thud(c, t0, 130, L * 1.2, 0.35);
        this.#osc("square", 420, 160, t0, 0.18, (() => { const g = ctx.createGain(); g.connect(c.gain); this.#env(g.gain, L * 0.3, t0, 0.003, 0.01, 0.2); return g; })());
        dur = 0.6; break;
      case "doorBang": {
        const n = opts.count === 3 ? 3 : 2;
        for (let i = 0; i < n; i++) this.#thud(c, t0 + i * 0.28, 85, L * 1.3, 0.4);
        dur = 0.28 * n + 0.5; break;
      }
      case "monitorUp":
      case "monitorDown": {
        const up = name === "monitorUp";
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.5, t0, 0.01, 0.1, 0.3);
        this.#osc("sawtooth", up ? 90 : 900, up ? 1000 : 60, t0, 0.42, g);
        dur = 0.5; break;
      }
      case "cameraBlip": {
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.4, t0, 0.004, 0.04, 0.05);
        this.#osc("square", 1400, 900, t0, 0.1, g);
        dur = 0.15; break;
      }
      case "powerOut": {
        this.#thud(c, t0, 70, L * 1.2, 0.6);
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.5, t0 + 0.1, 0.05, 0.3, 1.8);
        this.#osc("sawtooth", 440, 40, t0 + 0.1, 2.2, g);
        dur = 2.4; break;
      }
      case "sixAM": {
        [72, 76, 79, 84].forEach((m, i) => this.#bell(c, t0 + i * 0.35, m, L * 0.5, 2.5));
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.6, t0 + 1.4, 0.6, 1.8, 1.8);
        this.#noiseSrc(t0 + 1.4, 4.2, 2200, 0.6, "bandpass", g);
        dur = 6; break;
      }
      case "hourChime":
        this.#bell(c, t0, 79, L * 0.6, 2.0);
        this.#bell(c, t0 + 0.02, 67, L * 0.4, 2.2);
        dur = 2.3; break;
      case "phoneRing": {
        for (let i = 0; i < 2; i++) {
          const g = ctx.createGain(); g.connect(c.gain);
          this.#env(g.gain, L * 0.35, t0 + i * 0.5, 0.01, 0.34, 0.05);
          this.#osc("sine", 440, null, t0 + i * 0.5, 0.4, g);
          this.#osc("sine", 480, null, t0 + i * 0.5, 0.4, g);
        }
        dur = 1.1; break;
      }
      case "callStart": {
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.4, t0, 0.002, 0.005, 0.04);
        this.#osc("square", 1800, 700, t0, 0.05, g);
        dur = 0.1; break;
      }
      case "radioCrackle": {
        for (let i = 0; i < 8; i++) {
          const g = ctx.createGain(); g.connect(c.gain);
          const at = t0 + rng() * 0.8;
          this.#env(g.gain, L * 0.3 * (0.3 + rng()), at, 0.002, 0.004, 0.03 + rng() * 0.03);
          this.#noiseSrc(at, 0.1, 2500 + rng() * 2500, 1, "bandpass", g);
        }
        dur = 1; break;
      }
      case "footsteps": {
        const steps = Math.round(clamp(opts.count ?? 3, 1, 8));
        for (let i = 0; i < steps; i++) this.#thud(c, t0 + i * (0.5 + rng() * 0.12), 60 + rng() * 20, L * 0.8, 0.22);
        dur = steps * 0.6 + 0.3; break;
      }
      case "ventCrawl": {
        for (let i = 0; i < 5; i++) this.#thud(c, t0 + i * 0.22, 240 + rng() * 120, L * 0.35, 0.1);
        dur = 1.3; break;
      }
      case "ventBang":
        this.#thud(c, t0, 300, L * 1.2, 0.3);
        this.#osc("square", 700, 300, t0, 0.2, (() => { const g = ctx.createGain(); g.connect(c.gain); this.#env(g.gain, L * 0.3, t0, 0.003, 0.02, 0.25); return g; })());
        dur = 0.6; break;
      case "pans": {
        for (let i = 0; i < 6; i++) {
          const at = t0 + rng() * 1.4;
          this.#bell(c, at, 80 + Math.floor(rng() * 12), L * 0.3, 0.35);
        }
        dur = 2; break;
      }
      case "laugh":
        dur = this.#laugh(c, t0, L); break;
      case "breathing": {
        const v = opts.variant || opts.side || "hall";
        const f = { left: 520, right: 520, closet: 380, hall: 460 }[v] ?? 460;
        for (let i = 0; i < 3; i++) {
          const g = ctx.createGain(); g.connect(c.gain);
          this.#env(g.gain, L * 0.45, t0 + i * 1.6, 0.6, 0.2, 0.8);
          this.#noiseSrc(t0 + i * 1.6, 1.7, f, 1.4, "bandpass", g);
        }
        dur = 5; break;
      }
      case "powerOutJingle": {
        const j = JINGLES["power-out"];
        const notes = scheduleJingle(j, { tempoScale: opts.tempoScale ?? 1 });
        const lvl = L * 0.55;
        for (const n of notes) this.#bell(c, t0 + n.at, n.midi, lvl, Math.max(0.4, n.dur));
        const last = notes[notes.length - 1];
        dur = last.at + last.dur + 0.5;
        if (opts.eyes !== false) this.play("eyes", { ...opts, intensity: 0.5 });
        break;
      }
      case "eyes": {
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.2, t0, 0.5, 0.4, 0.8);
        this.#osc("sine", 1680, null, t0, 1.8, g);
        this.#osc("sine", 1692, null, t0, 1.8, g);
        dur = 1.8; break;
      }
      case "scream": {
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L*.55, t0, .035, .45, .7);
        const pitch = 420 + rng()*300;
        for (const ratio of [1,1.027,2.04]) this.#osc("sawtooth",pitch*ratio,pitch*ratio*.42,t0,1.2,g);
        this.#noiseSrc(t0,1.2,1600+rng()*1800,.65,"bandpass",g);
        dur=1.25; break;
      }
      case "jumpscare": {
        // Dissonant cluster + noise, ~1 s, soft attack, capped well under MAX_LEVEL.
        const lvl = Math.min(MAX_LEVEL * 0.8, 0.12 + 0.3 * intensity);
        c.level = lvl;
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, lvl, t0, SCARE_ATTACK, 0.45, 0.5);
        for (const f of [233, 247, 311, 466, 622, 740]) this.#osc("sawtooth", f, f * 0.93, t0, 1, g);
        const n = ctx.createGain(); n.gain.value = 0.6; n.connect(g);
        this.#noiseSrc(t0, 1, 2500, 0.5, "bandpass", n);
        dur = 1; break;
      }
      case "victimSting": {
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.6, t0, 0.01, 0.1, 0.9);
        for (const f of [196, 208, 294]) this.#osc("triangle", f, f * 0.8, t0, 1, g);
        dur = 1.1; break;
      }
      case "gameOver": {
        const g = ctx.createGain(); g.connect(c.gain);
        this.#env(g.gain, L * 0.5, t0, 0.1, 2.5, 1.5);
        this.#noiseSrc(t0, 4.2, 1800, 0.4, "highpass", g);
        this.#osc("sine", 110, 55, t0, 4, g);
        dur = 4.2; break;
      }
      case "murmur":
        dur = this.#murmur(c, t0, L, clamp(opts.duration ?? 2, 0.2, 30)); break;
    }
    if (loop) this.loops.set(key, { nodes: loop, gain: c.gain, panner: c.panner, pos: opts.position || null, name });
    this.stats.played++;
    this.stats.lastLevel = L;
    this.stats.peakLevel = Math.max(this.stats.peakLevel, L);
    this.lastPlayed = { name, pan, level: L, duration: dur };
    return true;
  }
  #laugh(c, t0, L) {
    // Formant gurgle: pulsed "ha ha ha" with falling pitch and vowel formants.
    const ctx = this.engine.ctx;
    const hits = 5;
    for (let i = 0; i < hits; i++) {
      const at = t0 + i * 0.22;
      const g = ctx.createGain(); g.connect(c.gain);
      this.#env(g.gain, L * 0.5 * (1 - i * 0.08), at, 0.02, 0.06, 0.12);
      const base = 150 - i * 7 + this.rng() * 6;
      for (const [fc, q] of [[700, 6], [1150, 8]]) {
        const f = ctx.createBiquadFilter();
        f.type = "bandpass"; f.frequency.value = fc; if (f.Q) f.Q.value = q;
        f.connect(g);
        this.#osc("sawtooth", base, base * 0.85, at, 0.22, f);
      }
    }
    return hits * 0.22 + 0.2;
  }
  #murmur(c, t0, L, dur) {
    const ctx = this.engine.ctx;
    const syll = 0.17;
    const n = Math.max(1, Math.floor(dur / syll));
    const vowels = [[600, 1000], [400, 1700], [500, 800], [300, 2200]];
    for (let i = 0; i < n; i++) {
      const at = t0 + i * syll;
      if (this.rng() < 0.12) continue; // small pauses
      const g = ctx.createGain(); g.connect(c.gain);
      this.#env(g.gain, L * 0.12, at, 0.03, 0.05, 0.08);
      const v = vowels[Math.floor(this.rng() * vowels.length)];
      const base = 105 + this.rng() * 25;
      for (const fc of v) {
        const f = ctx.createBiquadFilter();
        f.type = "bandpass"; f.frequency.value = fc; if (f.Q) f.Q.value = 5;
        f.connect(g);
        this.#osc("sawtooth", base, null, at, syll, f);
      }
    }
    return n * syll;
  }

  /** Stop a looping sound (all variants when side omitted) or let a one-shot ring out. */
  stop(name, opts = {}) {
    let stopped = false;
    for (const [key, l] of [...this.loops]) {
      if (l.name !== name || (opts.side && key !== `${name}:${opts.side}`)) continue;
      this.#killLoop(l);
      this.loops.delete(key);
      stopped = true;
    }
    return stopped;
  }
  #killLoop(l) {
    const ctx = this.engine.ctx;
    const t = ctx ? ctx.currentTime : 0;
    const p = l.gain.gain;
    p.cancelScheduledValues?.(t);
    p.setValueAtTime?.(p.value, t);
    p.linearRampToValueAtTime?.(0.0001, t + 0.15);
    if (typeof p.linearRampToValueAtTime !== "function") p.value = 0;
    for (const n of l.nodes) {
      try { n.stop?.(t + 0.2); } catch { /* already stopped */ }
    }
  }
  isLooping(name) { return [...this.loops.values()].some((l) => l.name === name); }

  /** Ambience: slow-modulated low drone + scheduled distant thumps/clanks. */
  setAmbience(profile) {
    if (!this.#init()) return false;
    const p = AMBIENCE_PROFILES[profile];
    if (!p) return false;
    if (this.ambience?.name === profile) return true;
    this.#stopAmbience();
    const ctx = this.engine.ctx;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.linearRampToValueAtTime?.(p.level, t0 + 2);
    if (typeof g.gain.linearRampToValueAtTime !== "function") g.gain.value = p.level;
    g.connect(this.bus);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = p.cutoff;
    f.connect(g);
    const a = this.#osc("sine", p.base, null, t0, 1e6, f);
    const b = this.#osc("sine", p.base * 1.503, null, t0, 1e6, f);
    const nz = this.#noiseSrc(t0, 0, p.cutoff, 0.7, "lowpass", f, true);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = p.lfo;
    const d = ctx.createGain(); d.gain.value = p.level * 0.4;
    lfo.connect(d);
    if (g.gain) d.connect(g.gain);
    lfo.start?.(t0);
    this.ambience = { name: profile, p, nodes: [a, b, nz.src, lfo], gain: g };
    this.nextThump = t0 + this.#thumpDelay(p);
    return true;
  }
  #thumpDelay(p) {
    const [lo, hi] = p.thumpEvery;
    return lo + this.rng() * (hi - lo);
  }
  #stopAmbience() {
    const a = this.ambience;
    if (!a) return;
    this.#killLoop({ nodes: a.nodes, gain: a.gain });
    this.ambience = null;
  }
  #distant(p) {
    const clank = this.rng() < p.clank;
    const side = this.rng() < 0.5 ? "left" : "right";
    // Quiet, far: low intensity through the normal chain.
    const ok = clank ? this.play("ventBang", { side, intensity: 0.05 }) : this.play("footsteps", { side, intensity: 0.05, count: 1 });
    if (ok) this.stats.thumps++;
  }

  /** Per-frame: listener tracking, ambience events, loop re-panning, state-driven loops. */
  update(snapshot, camera = null) {
    if (!this.ready) return;
    this.#init();
    const e = this.engine;
    const cp = camera && camera.position;
    if (cp && Number.isFinite(cp.x) && Number.isFinite(cp.z)) {
      e.listener.x = cp.x; e.listener.z = cp.z;
    }
    const now = e.ctx.currentTime;
    if (this.ambience && now >= this.nextThump) {
      this.#distant(this.ambience.p);
      this.nextThump = now + this.#thumpDelay(this.ambience.p);
    }
    for (const l of this.loops.values()) {
      if (l.pos && l.panner?.pan) {
        l.panner.pan.value = this.#resolve({ position: l.pos }).pan;
      }
    }
    if (snapshot && typeof snapshot === "object") {
      if (snapshot.maskOn === true) this.play("maskBreath", { intensity: 0.5 });
      else if (snapshot.maskOn === false) this.stop("maskBreath");
      if (snapshot.paused) this.stop("cameraStatic");
    }
  }

  /** Map a FNAF engine event to sounds. See notes/fnaf-audio.md. Returns true if handled. */
  handleEvent(ev) {
    if (!ev || typeof ev.type !== "string") return false;
    const side = ev.side === "left" || ev.side === "right" ? ev.side : undefined;
    const pos = ev.position;
    const base = { side, position: pos, intensity: ev.intensity };
    switch (ev.type) {
      case "move": return this.play(ev.room === "kitchen" ? "pans" : ev.vent ? "ventCrawl" : "footsteps", base);
      case "door-knock": return this.play("doorBang", { ...base, count: ev.count });
      case "jumpscare": return this.play("jumpscare", { ...base, intensity: ev.intensity ?? 0.8 });
      case "power-warning": return this.play("hourChime", { ...base, intensity: 0.4 });
      case "power-out": this.play("powerOut", base); return this.play("powerOutJingle", base);
      case "hour": return this.play("hourChime", base);
      case "night-win": return this.play("sixAM", base);
      case "static": return this.play("cameraStatic", base);
      case "phone-call-start": this.play("phoneRing", base); return this.play("callStart", base);
      case "phone-call-end": return this.play("callStart", { ...base, intensity: 0.3 });
      case "cue": return this.#cueEvent(ev, base);
      default: return false;
    }
  }
  #cueEvent(ev, base) {
    const map = { breathing: "breathing", laugh: "laugh", eyes: "eyes", "vent-bang": "ventBang", "vent-crawl": "ventCrawl",
      pans: "pans", "door-slam": "doorSlam", "light-buzz": "lightBuzz", "monitor-up": "monitorUp", "monitor-down": "monitorDown",
      "camera-switch": "cameraBlip", "victim-sting": "victimSting", "game-over": "gameOver", "radio-crackle": "radioCrackle",
      "music-box": "musicBoxTick" };
    const n = map[ev.name];
    return n ? this.play(n, { ...base, variant: ev.variant, wind: ev.wind }) : false;
  }

  dispose() {
    for (const l of this.loops.values()) this.#killLoop(l);
    this.loops.clear();
    this.#stopAmbience();
    try { this.bus?.disconnect?.(); } catch { /* ok */ }
    this.bus = null;
  }
}

/**
 * SubtitlePlayer — length-matched murmur + subtitle events for phone calls.
 * `manifest` maps a line id to a pre-generated audio file URL (e.g. ElevenLabs
 * output, added later); `playFile(url, line)` is an injected loader that returns
 * a promise<boolean>. If the manifest has no entry or loading fails, it falls
 * back to the synthesized murmur.
 */
export class SubtitlePlayer {
  constructor(audio, { onSubtitle = () => {}, manifest = {}, playFile = null } = {}) {
    this.audio = audio; this.onSubtitle = onSubtitle; this.manifest = manifest; this.playFile = playFile;
    this.current = null;
  }
  async play(line) {
    if (!line || typeof line.text !== "string") return false;
    const duration = Number.isFinite(line.duration) && line.duration > 0 ? line.duration : 2;
    this.current = { text: line.text, duration, id: line.id ?? null };
    this.onSubtitle({ type: "show", text: line.text, duration, id: line.id ?? null });
    const url = line.id != null ? this.manifest[line.id] : null;
    let played = false;
    if (url && this.playFile) {
      try { played = (await this.playFile(url, line)) === true; } catch { played = false; }
    }
    if (!played) this.audio.play("murmur", { duration, intensity: 0.5, side: "center" });
    return true;
  }
  stop() {
    if (!this.current) return;
    this.onSubtitle({ type: "hide", id: this.current.id });
    this.current = null;
  }
}
