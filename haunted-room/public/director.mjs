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
});
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
export class Director {
  constructor(config = {}) {
    this.config = { ...CONFIG, ...config };
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
  }
  start() {
    this.reset();
    this.phase = "running";
  }
  receive(message, now) {
    if (!validSignal(message)) return false;
    this.input = { ...message };
    this.receivedAt = now;
    return true;
  }
  step(dt, now) {
    const c = this.config;
    dt = Math.max(0, Math.min(dt, 0.1));
    if (this.phase !== "running") return this.snapshot(now);
    this.elapsed += dt;
    if (this.elapsed >= c.duration) {
      this.phase = "ended";
      this.state = "RELIEF";
      this.tension = 0;
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
      this.tension = Math.max(0, this.tension - c.waitRate * dt);
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
      if (this.reliefLeft <= 0) {
        this.state = "BUILD";
        this.lowTime = 0;
        this.highTime = 0;
      }
    } else if (this.highTime >= c.dwell) {
      this.state = "RELIEF";
      this.reliefLeft = c.reliefSeconds;
      this.highTime = 0;
      this.lowTime = 0;
    } else if (this.lowTime >= c.dwell) {
      this.tension = Math.min(c.maxTension, this.tension + c.buildRate * dt);
      this.state = this.tension >= c.maxTension * 0.8 ? "PEAK" : "BUILD";
    }
    return this.snapshot(now);
  }
  snapshot(now) {
    return {
      phase: this.phase,
      state: this.state,
      tension: this.tension,
      intensity: this.value,
      source: this.input?.source ?? "none",
      quality: this.input?.signal_quality ?? 0,
      fresh: !!this.input && now - this.receivedAt <= this.config.freshness,
      remaining: Math.max(0, this.config.duration - this.elapsed),
    };
  }
}
