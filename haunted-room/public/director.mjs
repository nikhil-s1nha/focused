export const CONFIG = Object.freeze({
  duration: 120,
  smoothing: 1.5,
  low: 0.3,
  high: 0.75,
  dwell: 4,
  reliefSeconds: 8,
  freshness: 3,
  minQuality: 0.5,
  maxTension: 0.85,
  buildRate: 0.055,
  reliefRate: 0.14,
  waitRate: 0.2,
  // Encounter scheduling (all deterministic, no randomness source).
  globalGap: 8, // minimum seconds between any two encounters
  encounterLength: 4, // seconds an encounter stays active in the snapshot
  responseWindow: 4, // seconds after firing over which tension response is measured
  peakHold: 10, // max seconds dwelling at PEAK before a forced easing setback
  peakRelease: 0.7, // setback eases tension down to maxTension * peakRelease
  maxEvents: 500,
});

// Supported session duration presets (seconds). Any finite positive
// config.duration is accepted for tests/tools; the UI should offer these.
export const DURATIONS = Object.freeze([60, 120, 180, 300]);

// Encounter catalogue. `cooldown` is the per-type base cooldown in seconds
// (scaled by adaptive memory, floor 0.4x / ceiling 1.6x); `base` seeds the
// encounter intensity before memory boost and tension contribution.
export const ENCOUNTERS = Object.freeze([
  Object.freeze({ id: "shadow-corridor", cooldown: 45, base: 0.8 }),
  Object.freeze({ id: "shadow-window", cooldown: 36, base: 0.65 }),
  Object.freeze({ id: "lamp-flicker", cooldown: 20, base: 0.35 }),
  Object.freeze({ id: "door-creak", cooldown: 24, base: 0.45 }),
  Object.freeze({ id: "radio-static", cooldown: 30, base: 0.5 }),
]);

export function validSignal(m) {
  return (
    m?.type === "signal" &&
    ["hardware", "synthetic", "manual"].includes(m.source) &&
    [m.intensity, m.signal_quality].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 1,
    ) &&
    Number.isFinite(m.timestamp)
  );
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Deterministic integer hash -> [0,1). Seeded from elapsed time, tension and
// encounter count so scheduling is reproducible for identical input feeds.
function hash01(seed) {
  let x = Math.imul(seed | 0, 0x85ebca6b) ^ 0x9e3779b9;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export class Director {
  constructor(config = {}) {
    this.config = { ...CONFIG, ...config };
    if (
      !Number.isFinite(this.config.duration) ||
      this.config.duration <= 0
    ) {
      this.config.duration = CONFIG.duration;
    }
    this.reset();
  }
  reset() {
    this.elapsed = 0;
    this.tension = 0.12;
    this.value = 0.5;
    this.state = "WAIT";
    this.phase = "ready";
    this.lowTime = 0;
    this.highTime = 0;
    this.reliefLeft = 0;
    this.input = null;
    this.receivedAt = -Infinity;
    // Pause
    this.paused = false;
    this.pausedAt = 0;
    // Peak pacing
    this.peakDwell = 0;
    this.setback = false;
    // Encounters + adaptive memory
    this.encounter = null; // { id, intensity, startedAt }
    this.lastEncounterAt = 0;
    this.fireCount = 0;
    this.lastFired = {};
    this.memory = {};
    this.encounterStats = {};
    for (const e of ENCOUNTERS) {
      this.lastFired[e.id] = -Infinity;
      this.memory[e.id] = { weight: 1, cooldownScale: 1, boost: 0 };
      this.encounterStats[e.id] = { count: 0, responses: 0, totalResponse: 0 };
    }
    this.pending = []; // [{ id, at, baseTension }]
    // Session timeline (derived values only, never raw signal packets)
    this.events = [];
    this.timeInState = { BUILD: 0, PEAK: 0, RELIEF: 0, WAIT: 0 };
    this.peakTension = this.tension;
    this.endedReason = null;
  }
  start() {
    this.reset();
    this.phase = "running";
    this.logEvent("start");
  }
  pause(now) {
    if (this.phase !== "running" || this.paused) return false;
    this.paused = true;
    this.pausedAt = now;
    this.logEvent("pause");
    return true;
  }
  resume(now) {
    if (this.phase !== "running" || !this.paused) return false;
    this.paused = false;
    // Shift the input receipt time so freshness is frozen across the pause.
    if (this.input && Number.isFinite(this.receivedAt)) {
      this.receivedAt += now - this.pausedAt;
    }
    this.logEvent("resume");
    return true;
  }
  // Externally end a running session (e.g. caught by the Attendant). Mirrors
  // the natural ending; touches no signal handling. Returns false if not running.
  end(reason = "ended") {
    if (this.phase !== "running") return false;
    this.paused = false;
    this.phase = "ended";
    this.state = "RELIEF";
    this.tension = 0;
    this.encounter = null;
    this.endedReason = String(reason);
    this.logEvent("end", { reason: this.endedReason });
    return true;
  }
  receive(message, now) {
    if (this.paused || !validSignal(message)) return false;
    this.input = { ...message };
    this.receivedAt = now;
    return true;
  }
  step(dt, now) {
    const c = this.config;
    dt = Math.max(0, Math.min(dt, 0.1));
    if (this.phase !== "running" || this.paused) return this.snapshot(now);
    const prevState = this.state;
    this.elapsed += dt;
    this.timeInState[this.state] += dt;
    this.settleEncounters();
    if (this.elapsed >= c.duration) {
      this.phase = "ended";
      this.state = "RELIEF";
      this.tension = 0;
      this.encounter = null;
      this.endedReason = "completed";
      this.logEvent("end", { reason: "completed" });
      return this.snapshot(now);
    }
    const usable =
      this.input &&
      now - this.receivedAt <= c.freshness &&
      this.input.signal_quality >= c.minQuality;
    if (!usable) {
      this.state = "WAIT";
      this.lowTime = 0;
      this.highTime = 0;
      this.reliefLeft = 0;
      this.encounter = null;
      this.setback = false;
      this.peakDwell = 0;
      this.tension = Math.max(0, this.tension - c.waitRate * dt);
      if (this.state !== prevState)
        this.logEvent("state", { from: prevState, to: this.state });
      return this.snapshot(now);
    }
    this.value +=
      (this.input.intensity - this.value) * (1 - Math.exp(-dt / c.smoothing));
    if (this.state === "WAIT") this.state = "BUILD";
    this.lowTime = this.value < c.low ? this.lowTime + dt : 0;
    this.highTime = this.value > c.high ? this.highTime + dt : 0;
    if (this.state === "RELIEF") {
      this.reliefLeft -= dt;
      this.tension = Math.max(0.05, this.tension - c.reliefRate * dt);
      this.peakDwell = 0;
      this.setback = false;
      if (this.reliefLeft <= 0) {
        this.state = "BUILD";
        this.lowTime = 0;
        this.highTime = 0;
      }
    } else {
      if (this.state === "PEAK") {
        this.peakDwell += dt;
        if (!this.setback && this.peakDwell >= c.peakHold) {
          // Capped PEAK dwell: force a scheduled drift toward RELIEF-eligible
          // easing so pacing varies instead of escalating forever.
          this.setback = true;
          this.logEvent("peak-cap");
        }
      }
      if (this.setback) {
        const floor = c.maxTension * c.peakRelease;
        this.tension = Math.max(floor, this.tension - c.reliefRate * dt);
        if (this.tension <= floor + 1e-9) {
          this.setback = false;
          this.peakDwell = 0;
        }
        this.state = this.tension >= c.maxTension * 0.8 ? "PEAK" : "BUILD";
      } else if (this.highTime >= c.dwell) {
        this.state = "RELIEF";
        this.reliefLeft = c.reliefSeconds;
        this.highTime = 0;
        this.lowTime = 0;
        this.encounter = null;
        this.peakDwell = 0;
      } else if (this.lowTime >= c.dwell) {
        this.tension = Math.min(c.maxTension, this.tension + c.buildRate * dt);
        this.state = this.tension >= c.maxTension * 0.8 ? "PEAK" : "BUILD";
      }
    }
    if (
      (this.state === "BUILD" || this.state === "PEAK") &&
      !this.encounter &&
      this.elapsed - this.lastEncounterAt >= c.globalGap
    ) {
      this.scheduleEncounter();
    }
    if (this.state !== prevState)
      this.logEvent("state", { from: prevState, to: this.state });
    this.peakTension = Math.max(this.peakTension, this.tension);
    return this.snapshot(now);
  }
  // Fires at most one encounter: deterministic weighted pick among types whose
  // (memory-scaled) cooldown has elapsed. Only ever called in BUILD/PEAK.
  scheduleEncounter() {
    const mem = this.memory;
    const eligible = ENCOUNTERS.filter(
      (e) =>
        this.elapsed - this.lastFired[e.id] >=
        e.cooldown * mem[e.id].cooldownScale,
    );
    if (!eligible.length) return;
    const total = eligible.reduce((s, e) => s + mem[e.id].weight, 0);
    const seed =
      Math.round(this.elapsed * 97) +
      Math.round(this.tension * 1013) +
      this.fireCount * 7919;
    let r = hash01(seed) * total;
    let pick = eligible[eligible.length - 1];
    for (const e of eligible) {
      r -= mem[e.id].weight;
      if (r < 0) {
        pick = e;
        break;
      }
    }
    const intensity = clamp01(
      pick.base + mem[pick.id].boost + this.tension * 0.2,
    );
    this.encounter = { id: pick.id, intensity, startedAt: this.elapsed };
    this.lastFired[pick.id] = this.elapsed;
    this.lastEncounterAt = this.elapsed;
    this.fireCount += 1;
    this.encounterStats[pick.id].count += 1;
    this.pending.push({
      id: pick.id,
      at: this.elapsed,
      baseTension: this.tension,
    });
    this.logEvent("encounter", { id: pick.id, intensity: r3(intensity) });
  }
  // Expires the active encounter and settles adaptive-memory responses: if
  // tension ROSE over the response window the type escalates (higher weight,
  // shorter cooldown, stronger next intensity); if it FELL it is deprioritized.
  settleEncounters() {
    const c = this.config;
    if (
      this.encounter &&
      this.elapsed - this.encounter.startedAt >= c.encounterLength
    ) {
      this.encounter = null;
    }
    while (
      this.pending.length &&
      this.elapsed - this.pending[0].at >= c.responseWindow
    ) {
      const p = this.pending.shift();
      const delta = this.tension - p.baseTension;
      const m = this.memory[p.id];
      let escalated = false;
      if (delta > 0.01) {
        escalated = true;
        m.weight = Math.min(3, m.weight * 1.5);
        m.cooldownScale = Math.max(0.4, m.cooldownScale * 0.6);
        m.boost = Math.min(0.4, m.boost + 0.15);
      } else if (delta < -0.01) {
        m.weight = Math.max(0.25, m.weight * 0.6);
        m.cooldownScale = Math.min(1.6, m.cooldownScale * 1.25);
        m.boost = Math.max(0, m.boost - 0.1);
      }
      const stat = this.encounterStats[p.id];
      stat.responses += 1;
      stat.totalResponse += delta;
      this.logEvent("encounter-response", {
        id: p.id,
        delta: r3(delta),
        escalated,
      });
    }
  }
  logEvent(type, data = {}) {
    if (this.events.length >= this.config.maxEvents) this.events.splice(1, 1);
    this.events.push({
      t: r2(this.elapsed),
      type,
      state: this.state,
      tension: r3(this.tension),
      ...data,
    });
  }
  getSession() {
    const encounterStats = {};
    for (const e of ENCOUNTERS) {
      const s = this.encounterStats[e.id];
      encounterStats[e.id] = {
        count: s.count,
        avgResponse: s.responses ? r3(s.totalResponse / s.responses) : 0,
      };
    }
    const timeInState = {};
    for (const k of Object.keys(this.timeInState))
      timeInState[k] = r2(this.timeInState[k]);
    return {
      duration: this.config.duration,
      elapsed: r2(this.elapsed),
      endedReason: this.endedReason,
      peakTension: r3(this.peakTension),
      timeInState,
      encounterStats,
      events: this.events.map((e) => ({ ...e })),
    };
  }
  snapshot(now) {
    const effNow = this.paused ? this.pausedAt : now;
    return {
      phase: this.phase,
      state: this.state,
      tension: this.tension,
      intensity: this.value,
      source: this.input?.source ?? "none",
      quality: this.input?.signal_quality ?? 0,
      fresh: !!this.input && effNow - this.receivedAt <= this.config.freshness,
      remaining: Math.max(0, this.config.duration - this.elapsed),
      paused: this.paused,
      elapsed: this.elapsed,
      progress: Math.min(1, this.elapsed / this.config.duration),
      encounter: this.encounter
        ? {
            id: this.encounter.id,
            intensity: this.encounter.intensity,
            t: r2(this.elapsed - this.encounter.startedAt),
          }
        : null,
    };
  }
}
