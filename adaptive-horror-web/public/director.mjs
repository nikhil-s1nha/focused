export const CONFIG = Object.freeze({
  low: 0.3, high: 0.75, minimumQuality: 0.5,
  staleMs: 3000, dwellMs: 4000, reliefMs: 8000,
  smoothingSeconds: 1.5, maximumTension: 0.85
});

export function validSignal(value) {
  return value && value.type === 'signal' &&
    ['manual', 'synthetic', 'internal_test', 'shorted_input', 'hardware'].includes(value.source) &&
    Number.isFinite(value.intensity) && value.intensity >= 0 && value.intensity <= 1 &&
    Number.isFinite(value.signal_quality) && value.signal_quality >= 0 && value.signal_quality <= 1 &&
    Number.isFinite(value.timestamp) &&
    (value.calibrated === undefined || typeof value.calibrated === 'boolean');
}

export class Director {
  constructor(config = CONFIG) {
    this.config = config;
    this.state = 'BUILD'; this.tension = 0.25; this.intensity = 0.5;
    this.dwell = 0; this.relief = 0;
  }
  update(signal, receivedAt, now, deltaSeconds) {
    const c = this.config;
    const dt = Math.max(0, Math.min(0.25, deltaSeconds));
    const usable = validSignal(signal) && signal.calibrated !== false && signal.signal_quality >= c.minimumQuality &&
      now - receivedAt <= c.staleMs && now >= receivedAt;
    if (!usable) {
      this.state = 'WAIT'; this.dwell = 0; this.relief = 0;
      this.tension = Math.max(0.15, this.tension - dt * 0.1);
      return {state: this.state, tension: this.tension, intensity: this.intensity, usable};
    }
    this.intensity += (signal.intensity - this.intensity) * (1 - Math.exp(-dt / c.smoothingSeconds));
    if (this.state === 'WAIT') this.state = 'BUILD';
    if (this.state === 'RELIEF') {
      this.relief += dt * 1000;
      this.tension = Math.max(0.15, this.tension - dt * 0.12);
      if (this.relief >= c.reliefMs) { this.state = 'BUILD'; this.dwell = 0; }
    } else {
      const outside = this.intensity > c.high || this.intensity < c.low;
      const direction = this.intensity > c.high ? 'high' : this.intensity < c.low ? 'low' : null;
      if (direction !== this.lastDirection) this.dwell = 0;
      this.lastDirection = direction;
      this.dwell = outside ? this.dwell + dt * 1000 : 0;
      if (this.dwell >= c.dwellMs) {
        if (direction === 'high') { this.state = 'RELIEF'; this.relief = 0; }
        else { this.state = 'PEAK'; this.tension = Math.min(c.maximumTension, this.tension + dt * 0.05); }
      } else this.state = this.state === 'PEAK' && direction === 'low' ? 'PEAK' : 'BUILD';
    }
    return {state: this.state, tension: this.tension, intensity: this.intensity, usable};
  }
}
