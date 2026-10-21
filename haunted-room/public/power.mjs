// power.mjs — the draining-resource half of the surveillance loop. Pure
// logic: zero THREE/DOM dependency, deterministic with injected time + rng,
// fully Node-testable.
//
// Tuning intent (120-second active session):
//   * passive drain 0.35 %/s  => ~42% spent by the end doing nothing.
//   * "monitor" load +0.65 %/s => monitor held up the whole time dies at ~100s.
//   * "floodlight" load +0.90 %/s => careless stacking dies around the minute
//     mark. Careful, intermittent usage survives the full 120s with margin.
//
// Event contract (consumeEvents()):
//   {type:"warning",  level:0.2}   once per session, crossing 20%
//   {type:"critical", level:0.1}   once per session, crossing 10%
//   {type:"blackout"}              once per session, at 0%
//   {type:"flicker",  level:n}     repeatedly below 25%, deterministic cadence
//
// After blackout everything is off: loads are cleared, setLoad() is ignored,
// the level stays 0, and getState().blackoutElapsed keeps growing so the
// integration can time the power-out sequence (dark -> music -> eyes -> scare,
// owned by other modules).

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Deterministic default rng (mulberry32-style), matching the house pattern of
// never using Math.random in simulation logic.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const POWER_CONFIG = Object.freeze({
  passiveDrain: 0.0035, // fraction of full charge per second
  loadDrains: Object.freeze({
    monitor: 0.0065,
    floodlight: 0.009,
  }),
  defaultLoadDrain: 0.005, // any load not named in loadDrains
  warningLevel: 0.2,
  criticalLevel: 0.1,
  flickerThreshold: 0.25,
  flickerMinGap: 1.5, // seconds between flickers, plus 0..flickerJitter
  flickerJitter: 3.5,
  maxStep: 0.5, // seconds of simulation per update() slice (stability clamp)
  maxClockJump: 30, // step(now) gaps beyond this are clock discontinuities
});

export class PowerSystem {
  constructor(options = {}) {
    this.config = { ...POWER_CONFIG, ...options };
    this.config.loadDrains = {
      ...POWER_CONFIG.loadDrains,
      ...(options.loadDrains || {}),
    };
    this._now = typeof options.now === "function" ? options.now : null;
    this._rng =
      typeof options.rng === "function"
        ? options.rng
        : makeRng(options.seed ?? 0x9e37);
    this.reset();
  }

  reset() {
    this.level = 1;
    this.running = false;
    this.blackout = false;
    this._clock = 0; // seconds of simulated time since reset
    this._blackoutAt = null; // _clock at the moment of blackout
    this._lastNow = null; // for step(now)
    this._loads = new Set();
    this._events = [];
    this._fired = { warning: false, critical: false, blackout: false };
    this._nextFlickerAt = null;
  }

  /** Begin draining. Level is whatever it currently is (1 after reset). */
  start() {
    this.running = true;
  }

  /** Stop draining without clearing anything (ready/paused). */
  stop() {
    this.running = false;
    this._lastNow = null;
  }

  /** Toggle a named load ("monitor", "floodlight", ...). Ignored after blackout. */
  setLoad(name, on) {
    if (this.blackout || typeof name !== "string" || name.length === 0) return;
    if (on) this._loads.add(name);
    else this._loads.delete(name);
  }

  isLoadActive(name) {
    return this._loads.has(name);
  }

  /** Total drain, fraction of full charge per second, at the current loads. */
  getDrainRate() {
    if (!this.running || this.blackout) return 0;
    let rate = this.config.passiveDrain;
    for (const name of this._loads) {
      const d = this.config.loadDrains[name];
      rate += Number.isFinite(d) ? d : this.config.defaultLoadDrain;
    }
    return rate;
  }

  /** Advance the simulation by dt seconds. */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Slice large steps so threshold crossings and flicker cadence stay exact
    // regardless of caller frame rate.
    let remaining = dt;
    while (remaining > 1e-9) {
      const slice = Math.min(remaining, this.config.maxStep);
      this._advance(slice);
      remaining -= slice;
    }
  }

  /** Alternative clock-driven API: advance to an absolute time in seconds. */
  step(now) {
    const t = Number.isFinite(now) ? now : this._now ? this._now() : null;
    if (t == null) return;
    if (this._lastNow == null) {
      this._lastNow = t;
      return;
    }
    const dt = t - this._lastNow;
    this._lastNow = t;
    // A huge jump is a clock discontinuity (tab suspended, resumed session):
    // re-arm without billing it rather than draining a phantom chunk.
    if (dt > 0 && dt <= this.config.maxClockJump) this.update(dt);
  }

  _advance(dt) {
    this._clock += dt;
    if (!this.running || this.blackout) return;

    this.level = clamp01(this.level - this.getDrainRate() * dt);

    if (!this._fired.warning && this.level <= this.config.warningLevel) {
      this._fired.warning = true;
      this._events.push({ type: "warning", level: this.config.warningLevel });
    }
    if (!this._fired.critical && this.level <= this.config.criticalLevel) {
      this._fired.critical = true;
      this._events.push({ type: "critical", level: this.config.criticalLevel });
    }
    if (this.level <= 0 && !this._fired.blackout) {
      this._fired.blackout = true;
      this.blackout = true;
      this.level = 0;
      this._blackoutAt = this._clock;
      this._loads.clear(); // everything off
      this._nextFlickerAt = null;
      this._events.push({ type: "blackout" });
      return;
    }

    // Low-power flicker cadence: deterministic via the injected rng.
    if (this.level < this.config.flickerThreshold && this.level > 0) {
      if (this._nextFlickerAt == null) {
        this._nextFlickerAt =
          this._clock +
          this.config.flickerMinGap +
          this._rng() * this.config.flickerJitter;
      } else if (this._clock >= this._nextFlickerAt) {
        this._events.push({ type: "flicker", level: this.level });
        this._nextFlickerAt =
          this._clock +
          this.config.flickerMinGap +
          this._rng() * this.config.flickerJitter;
      }
    } else {
      this._nextFlickerAt = null;
    }
  }

  /** Charge remaining, 0..1. */
  getLevel() {
    return this.level;
  }

  /** Drain queued events (each returned exactly once). */
  consumeEvents() {
    if (this._events.length === 0) return [];
    const out = this._events;
    this._events = [];
    return out;
  }

  /** Seconds since blackout (0 until it happens). */
  getBlackoutElapsed() {
    return this.blackout ? this._clock - this._blackoutAt : 0;
  }

  /** UI snapshot. */
  getState() {
    const rate = this.getDrainRate();
    return {
      level: this.level,
      percent: Math.round(this.level * 100),
      running: this.running,
      blackout: this.blackout,
      blackoutElapsed: this.getBlackoutElapsed(),
      activeLoads: [...this._loads],
      drainRate: rate,
      secondsRemaining: rate > 0 ? this.level / rate : Infinity,
    };
  }
}
