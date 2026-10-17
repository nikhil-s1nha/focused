// music-box.mjs — a wind-up music box playing an ORIGINAL lullaby.
// The melody below was composed for this project (A minor with chromatic
// lower-neighbor tones); it is not a transcription of any existing tune.
// Fully synthesized (no samples, no autoplay): nothing is created until
// setEnabled(true) is called from a user gesture. Imports cleanly in Node;
// pass { AudioContextImpl, rng } to inject stubs for tests.
//
// Tension mapping:
//   tension 0    -> sweet, ~72 BPM, no dropouts
//   tension 1    -> tempo drags to ~40 BPM, notes drop out (p = 0.55 * tension),
//                   pitch wavers (+-15 cents * tension)
//   state PEAK   -> may grind to a halt mid-phrase (the silence is the scare)
//   state RELIEF -> clears halts/cuts, music returns
//   state WAIT   -> fades out, scheduling pauses
//   encounter id containing "scare"/"lunge" -> instant hard cut

const MASTER_CAP = 0.35; // hard ceiling on master gain
const LOOKAHEAD = 0.3; // seconds of audio-clock horizon per scheduler tick
const TICK_MS = 100;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// Original 24-note lullaby in A minor. Chromatic lower neighbors (D#5, G#4)
// give it the slightly-wrong music-box feel. beats are quarter-note units.
export const MELODY = Object.freeze(
  [
    [69, 1], [72, 1], [76, 1], [75, 0.5], [76, 1.5], [71, 1], [72, 1], [69, 2],
    [67, 1], [69, 1], [71, 1], [68, 0.5], [69, 1.5], [64, 1], [65, 1], [64, 2],
    [69, 1], [76, 1], [77, 1], [76, 1], [74, 0.5], [72, 0.5], [71, 1], [69, 2],
  ].map(([midi, beats]) => Object.freeze({ midi, beats })),
);

export class MusicBox {
  constructor({ AudioContextImpl = null, rng = Math.random } = {}) {
    const globalCtor =
      typeof globalThis.AudioContext === "function"
        ? globalThis.AudioContext
        : typeof globalThis.webkitAudioContext === "function"
          ? globalThis.webkitAudioContext
          : null;
    this.ContextClass = AudioContextImpl ?? globalCtor;
    this.rng = rng;
    this.ctx = null;
    this.graph = null;
    this.timer = null;
    this.enabled = false;
    this.volume = 0.7;
    this.tension = 0;
    this.state = "BUILD";
    this.paused = false;
    this.halted = false; // PEAK grind-to-halt
    this.cut = false; // scare hard cut
    this.noteIndex = 0;
    this.nextNoteTime = 0;
    this.live = []; // currently sounding sources: { node, until }
    this.stats = { slots: 0, scheduled: 0, dropped: 0 };
    this.lastEncounterId = null;
  }

  // Must be called from a user gesture. Returns false when no AudioContext
  // implementation is available (e.g. plain Node without an injected stub).
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
      this.nextNoteTime = this.ctx.currentTime + 0.15;
      if (this.timer === null) this.#loop();
      return true;
    }
    this.enabled = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    if (this.graph)
      this.#setParam(this.graph.master.gain, this.volume * MASTER_CAP, 0.05);
    return this.volume;
  }

  // Drives behavior from a Director snapshot ({ tension, state, paused,
  // encounter }). An encounter whose id contains "scare" or "lunge" hard-cuts.
  update(snapshot) {
    if (!snapshot) return;
    this.tension = clamp01(snapshot.tension);
    if (typeof snapshot.state === "string") this.state = snapshot.state;
    this.paused = !!snapshot.paused;
    const eid = snapshot.encounter?.id ?? null;
    if (eid && eid !== this.lastEncounterId && /scare|lunge/i.test(eid))
      this.hardCut();
    this.lastEncounterId = eid;
    if (this.state === "RELIEF") {
      this.halted = false;
      this.cut = false;
    }
    this.#applyBus();
  }

  // Instant silence: stop every sounding note and zero the note bus now.
  hardCut() {
    this.cut = true;
    if (!this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    for (const s of this.live) {
      try {
        s.node.stop?.(now);
      } catch {
        /* already stopped */
      }
    }
    this.live.length = 0;
    if (typeof this.graph.bus.gain.setValueAtTime === "function")
      this.graph.bus.gain.setValueAtTime(0, now);
    else this.graph.bus.gain.value = 0;
  }

  // Lookahead scheduler. Runs every TICK_MS via setTimeout; tests may call it
  // directly after advancing a stub context's currentTime.
  tick() {
    if (!this.enabled || !this.ctx || !this.graph) return;
    const now = this.ctx.currentTime;
    if (this.live.length) this.live = this.live.filter((s) => s.until > now);
    if (!this.#playing()) {
      // Keep the clock pegged so resuming never bursts a backlog of notes.
      this.nextNoteTime = Math.max(this.nextNoteTime, now + 0.2);
      return;
    }
    const spb = 60 / (72 - 32 * this.tension); // 72 BPM calm -> 40 BPM terror
    while (this.nextNoteTime < now + LOOKAHEAD) {
      // At PEAK the mechanism can seize mid-phrase.
      if (this.state === "PEAK" && this.rng() < 0.08 + this.tension * 0.12) {
        this.halted = true;
        this.#applyBus();
        break;
      }
      const note = MELODY[this.noteIndex];
      this.stats.slots += 1;
      if (this.rng() < this.tension * 0.55) this.stats.dropped += 1;
      else {
        this.#pluck(note, this.nextNoteTime);
        this.stats.scheduled += 1;
      }
      this.nextNoteTime += note.beats * spb;
      this.noteIndex = (this.noteIndex + 1) % MELODY.length;
    }
  }

  dispose() {
    this.enabled = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const s of this.live) {
        try {
          s.node.stop?.(now);
        } catch {
          /* already stopped */
        }
      }
    }
    this.live.length = 0;
    this.graph = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && typeof ctx.close === "function" && ctx.state !== "closed") {
      const p = ctx.close();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }

  #playing() {
    return (
      this.enabled &&
      !this.cut &&
      !this.halted &&
      !this.paused &&
      this.state !== "WAIT"
    );
  }

  #setParam(param, value, timeConstant = 0.2) {
    if (!param) return;
    if (this.ctx && typeof param.setTargetAtTime === "function")
      param.setTargetAtTime(value, this.ctx.currentTime, timeConstant);
    else param.value = value;
  }

  // Note bus fades out in WAIT/pause/halt and back in when playing resumes.
  #applyBus() {
    if (!this.graph || this.cut) return;
    this.#setParam(this.graph.bus.gain, this.#playing() ? 1 : 0, 0.6);
  }

  #build() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.volume * MASTER_CAP;
    master.connect(ctx.destination);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(master);
    // A touch of feedback-delay "echo" for the tines, when supported.
    let delay = null;
    if (typeof ctx.createDelay === "function") {
      delay = ctx.createDelay(1);
      if (delay.delayTime) delay.delayTime.value = 0.31;
      const fb = ctx.createGain();
      fb.gain.value = 0.28;
      const wet = ctx.createGain();
      wet.gain.value = 0.2;
      bus.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(wet);
      wet.connect(master);
    }
    this.graph = { master, bus, delay };
  }

  #strike(param, peak, t, decay) {
    if (
      typeof param.setValueAtTime === "function" &&
      typeof param.exponentialRampToValueAtTime === "function"
    ) {
      param.setValueAtTime(peak, t);
      param.exponentialRampToValueAtTime(0.0001, t + decay);
    } else {
      param.value = peak;
    }
  }

  // Plucked bell/celesta voice: sine fundamental + a 4x partial with a fast
  // exponential decay, slight random detune, tension-scaled pitch waver.
  #pluck(note, t) {
    const ctx = this.ctx;
    const freq = 440 * Math.pow(2, (note.midi - 69) / 12);
    const waver = Math.sin(t * 2.2) * 15 * this.tension; // slow LFO, in cents
    const cents = (this.rng() * 2 - 1) * 6 + waver;
    const voices = [
      { mult: 1, peak: 0.5, decay: 1.4 },
      { mult: 4, peak: 0.11, decay: 0.45 },
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * v.mult;
      if (osc.detune) osc.detune.value = cents + (v.mult > 1 ? 3 : 0);
      const env = ctx.createGain();
      env.gain.value = 0;
      this.#strike(env.gain, v.peak, t, v.decay);
      osc.connect(env);
      env.connect(this.graph.bus);
      osc.start?.(t);
      osc.stop?.(t + v.decay + 0.1);
      this.live.push({ node: osc, until: t + v.decay + 0.1 });
    }
  }

  #loop() {
    this.timer = setTimeout(() => {
      this.tick();
      if (this.enabled) this.#loop();
      else this.timer = null;
    }, TICK_MS);
    // Never keep a Node process (tests) alive on our account.
    this.timer?.unref?.();
  }
}
