// Adaptive profile for the simple four-door room. Pure logic: no THREE, no DOM.
// Deterministic given injected time (monotonic seconds) and rng.
//
// Idea: run a few scripted scares (calibration), measure the signal's response
// to each, derive a personal baseline/reactivity, then adapt later scares.
//
// HONESTY: the input is an experimental EEG-derived response proxy. This module
// measures "response of the signal to a stimulus" only. It does not detect fear
// or emotion, and nothing here is a validated classifier.

export const CONFIG = Object.freeze({
  calibrationScares: 3, // scripted scares before adapting
  firstScareAt: 8, // seconds after start for the first scripted scare
  calibrationGap: 11, // seconds between scripted scare requests (quiet baseline in between)
  calibrationJitter: 0, // +/- seconds of rng jitter on the gap after the first scare (0 = none)
  lungeTimeout: 8, // give up on a requested scare if no lunge is reported by then
  preWindow: 3, // seconds of baseline before the lunge
  preGuard: 0, // seconds before the lunge excluded from baseline (telegraph contamination)
  postStart: 0.3, // response window starts this long after the lunge
  postEnd: 3.0, // ... and ends this long after the lunge
  minQuality: 0.5, // samples below this quality are unusable
  minPreSamples: 10, // usable samples required in the baseline window
  minPostSamples: 8, // usable samples required in the response window
  minUsableFraction: 0.6, // usable / received samples required per window
  sdFloor: 0.02, // floor for baseline sd in the z metric
  direction: 'any', // 'any' | 'up' | 'down' passed to responseMetric
  memorySeconds: 14, // rolling sample memory (no raw log is kept beyond this)
  neutralResponse: 3, // z used as "typical" when calibration is unusable
  targetResponse: 3, // desired response z (blended with the person's calibration median)
  personalWeight: 0.5, // 0 = absolute target only, 1 = target is the calibration median
  emaAlpha: 0.4, // EMA weight for each new scare z
  band: 0.25, // relative deadband around the target
  gain: 0.35, // controller step per real scare
  calibrationDriveGain: 0.5, // how much calibration reactivity seeds the controller
  driveDecay: 0.15, // drive decays toward 0 inside the deadband
  habituationSlope: -0.5, // z-per-scare slope at or below this counts as habituating
  varietyGain: 0.5, // extra visual/fake weight when habituating
  tensionWeight: 0.35, // weight of the live Director tension in effectiveTension
  baseTension: 0.5, // profile-side tension before drive
  tensionSwing: 0.4, // how far drive moves the profile-side tension
  intensitySwing: 0.3,
  gapSwing: 0.4,
  minGapScale: 0.6,
  maxGapScale: 1.6,
  minIntensityScale: 0.7,
  maxIntensityScale: 1.3, // hard safety cap regardless of signal
  minWeight: 0.5,
  maxWeight: 2,
  minRealScareGap: 3.5, // seconds: average scare-rate cap, exported as directives.minGap
  maxDecisions: 60,
});

export const BEAT_GROUPS = Object.freeze(['light', 'fake', 'visual', 'sound', 'real']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (finite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, num(v, lo)));
const clamp01 = (v) => clamp(v, 0, 1);
const r3 = (v) => Math.round(v * 1000) / 1000;

function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
// Least-squares slope of values against their index.
function slope(a) {
  const n = a.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(a);
  let num_ = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num_ += (i - mx) * (a[i] - my);
    den += (i - mx) ** 2;
  }
  return den > 0 ? num_ / den : 0;
}

// PLACEHOLDER: replace with the validated spike metric.
// Z-score style: max absolute change of the post window versus the mean of the
// pre window, divided by max(preSd, floor). direction: 'any' | 'up' | 'down'.
// Inputs are plain number arrays; returns a finite number >= 0.
export function responseMetric({ pre, post, direction = 'any', floor = CONFIG.sdFloor } = {}) {
  const a = (Array.isArray(pre) ? pre : []).filter(finite);
  const b = (Array.isArray(post) ? post : []).filter(finite);
  if (!a.length || !b.length) return 0;
  const m = mean(a);
  const denom = Math.max(sd(a), finite(floor) && floor > 0 ? floor : 1e-6);
  let change = 0;
  for (const v of b) {
    const d = v - m;
    const c = direction === 'up' ? d : direction === 'down' ? -d : Math.abs(d);
    if (c > change) change = c;
  }
  const z = change / denom;
  return finite(z) ? z : 0;
}

export class AdaptiveProfile {
  #rng;
  #cfg;
  #phase = 'idle';
  #samples = []; // rolling window only: { t, v, ok }
  #t0 = null;
  #now = 0;
  #requested = 0; // scripted scares requested
  #nextAt = null;
  #lastRequestT = null;
  #awaiting = null; // { requestT } scripted scare requested but no lunge yet
  #pending = []; // lunge windows waiting to close: { t, calibration, index }
  #calib = []; // per calibration scare: { z|null, valid, preMean, preSd, quality, reason }
  #profile = null;
  #drive = 0;
  #ema = null;
  #adaptZs = [];
  #variety = 0;
  #live = 0.5;
  #lastLunge = null;
  #tooFast = 0;
  #decisions = [];
  #notes = [];
  #directives = null;

  constructor({ rng = Math.random, config = {} } = {}) {
    this.#rng = typeof rng === 'function' ? rng : Math.random;
    this.#cfg = { ...CONFIG };
    for (const [k, v] of Object.entries(config ?? {})) {
      if (k in CONFIG && typeof CONFIG[k] === typeof v && (typeof v !== 'number' || Number.isFinite(v))) {
        this.#cfg[k] = v;
      }
    }
    this.reset();
  }

  get phase() {
    return this.#phase;
  }

  reset() {
    this.#phase = 'idle';
    this.#samples = [];
    this.#t0 = null;
    this.#now = 0;
    this.#requested = 0;
    this.#nextAt = null;
    this.#lastRequestT = null;
    this.#awaiting = null;
    this.#pending = [];
    this.#calib = [];
    this.#profile = null;
    this.#drive = 0;
    this.#ema = null;
    this.#adaptZs = [];
    this.#variety = 0;
    this.#live = 0.5;
    this.#lastLunge = null;
    this.#tooFast = 0;
    this.#decisions = [];
    this.#notes = [];
    this.#directives = null;
  }

  start() {
    this.reset();
    this.#phase = this.#cfg.calibrationScares > 0 ? 'calibrating' : 'adapting';
    if (this.#phase === 'adapting') this.#finishCalibration();
  }

  end() {
    if (this.#phase !== 'idle') this.#phase = 'ended';
  }

  // Called every frame with monotonic seconds. Keeps only a short rolling window.
  sample(t, { intensity, quality, fresh } = {}) {
    if (!finite(t)) return;
    this.#now = Math.max(this.#now, t);
    if (this.#t0 === null && this.#phase !== 'idle') this.#t0 = t;
    const ok =
      fresh === true &&
      finite(intensity) &&
      finite(quality) &&
      quality >= this.#cfg.minQuality;
    this.#samples.push({ t, v: finite(intensity) ? clamp01(intensity) : 0, ok });
    const cutoff = t - this.#cfg.memorySeconds;
    let i = 0;
    while (i < this.#samples.length && this.#samples[i].t < cutoff) i += 1;
    if (i) this.#samples.splice(0, i);
  }

  // The app calls this when the lunge starts; anchors the response window.
  scareLunge(t, side = null) {
    if (this.#phase !== 'calibrating' && this.#phase !== 'adapting') return;
    if (!finite(t)) return;
    this.#now = Math.max(this.#now, t);
    const calibration = this.#phase === 'calibrating';
    if (!calibration && this.#lastLunge !== null && t - this.#lastLunge < this.#cfg.minRealScareGap * 0.5) {
      this.#tooFast += 1;
    }
    this.#lastLunge = t;
    this.#awaiting = null;
    this.#pending.push({ t, side, calibration, index: calibration ? this.#calib.length + this.#pending.filter((p) => p.calibration).length : null });
  }

  update(dt, t, live = {}) {
    if (finite(t)) this.#now = Math.max(this.#now, t);
    const now = this.#now;
    if (finite(live?.tension)) this.#live = clamp01(live.tension);
    if (this.#phase === 'idle' || this.#phase === 'ended') {
      this.#directives = this.#build(null);
      return this.#directives;
    }
    if (this.#t0 === null) this.#t0 = now;
    this.#closeWindows(now);

    let trigger = null;
    if (this.#phase === 'calibrating') {
      if (this.#awaiting && now - this.#awaiting.requestT > this.#cfg.lungeTimeout) {
        this.#calib.push({ z: null, valid: false, reason: 'no lunge reported' });
        this.#addNote('A scripted scare produced no lunge; response discarded.');
        this.#awaiting = null;
      }
      if (this.#requested === 0 && this.#nextAt === null) this.#nextAt = this.#t0 + this.#cfg.firstScareAt;
      const busy = this.#awaiting || this.#pending.length;
      if (this.#requested < this.#cfg.calibrationScares && !busy && now >= this.#nextAt) {
        trigger = { kind: 'calibration', side: null, skipTelegraph: false };
        this.#requested += 1;
        this.#lastRequestT = now;
        this.#awaiting = { requestT: now };
        const j = this.#cfg.calibrationJitter;
        const jitter = j > 0 ? (clamp01(this.#rng()) * 2 - 1) * j : 0;
        this.#nextAt = now + Math.max(1, this.#cfg.calibrationGap + jitter);
      }
      if (
        this.#requested >= this.#cfg.calibrationScares &&
        !this.#awaiting &&
        !this.#pending.length
      ) {
        this.#finishCalibration();
      }
    }
    this.#directives = this.#build(trigger);
    return this.#directives;
  }

  // Derived-only summary of the calibration/profile.
  profile() {
    return this.#profile ? JSON.parse(JSON.stringify(this.#profile)) : null;
  }

  // Derived-only JSON for the session summary. Never contains raw samples.
  export() {
    return {
      phase: this.#phase,
      calibration: this.#calib.map((c) => ({
        z: c.z === null ? null : r3(c.z),
        valid: c.valid,
        reason: c.reason ?? null,
      })),
      baseline: this.#profile ? this.#profile.baseline : null,
      reactivity: this.#profile ? this.#profile.reactivity : null,
      habituation: this.#profile ? this.#profile.habituation : null,
      quality: this.#profile ? this.#profile.quality : null,
      confidence: this.#profile ? this.#profile.confidence : null,
      neutral: this.#profile ? this.#profile.neutral : null,
      adaptation: {
        scares: this.#adaptZs.length,
        zs: this.#adaptZs.map(r3),
        ema: this.#ema === null ? null : r3(this.#ema),
        drive: r3(this.#drive),
      },
      decisions: this.#decisions.map((d) => ({ ...d })),
      notes: [...this.#notes],
      disclaimer: 'Response of an experimental signal proxy to the stimulus; not fear or emotion detection.',
    };
  }

  // ---- internals -------------------------------------------------------

  #addNote(s) {
    if (!this.#notes.includes(s)) this.#notes.push(s);
  }

  #decide(entry) {
    this.#decisions.push(entry);
    if (this.#decisions.length > this.#cfg.maxDecisions) this.#decisions.shift();
  }

  #window(from, to) {
    const all = this.#samples.filter((s) => s.t >= from && s.t < to);
    const good = all.filter((s) => s.ok);
    return { values: good.map((s) => s.v), total: all.length, good: good.length };
  }

  // Measure one scare. Returns { z, valid, reason, preMean, preSd, quality }.
  #measure(lungeT) {
    const c = this.#cfg;
    const pre = this.#window(lungeT - c.preWindow, lungeT - c.preGuard);
    const post = this.#window(lungeT + c.postStart, lungeT + c.postEnd + 1e-9);
    const total = pre.total + post.total;
    const quality = total ? (pre.good + post.good) / total : 0;
    const bad = (w, min) => w.good < min || w.total === 0 || w.good / w.total < c.minUsableFraction;
    let reason = null;
    if (bad(pre, c.minPreSamples)) reason = 'baseline window unusable (low quality, stale or missing samples)';
    else if (bad(post, c.minPostSamples)) reason = 'response window unusable (low quality, stale or missing samples)';
    if (reason) return { z: null, valid: false, reason, quality };
    const z = responseMetric({ pre: pre.values, post: post.values, direction: c.direction, floor: c.sdFloor });
    return { z, valid: true, reason: null, quality, preMean: mean(pre.values), preSd: sd(pre.values) };
  }

  #closeWindows(now) {
    const end = this.#cfg.postEnd;
    const still = [];
    for (const p of this.#pending) {
      if (now < p.t + end) {
        still.push(p);
        continue;
      }
      const m = this.#measure(p.t);
      if (p.calibration) {
        this.#calib.push(m);
        if (!m.valid) this.#addNote(`Calibration scare discarded: ${m.reason}.`);
      } else {
        this.#adaptAfterScare(m, p.t);
      }
    }
    this.#pending = still;
  }

  #finishCalibration() {
    const c = this.#cfg;
    const valid = this.#calib.filter((x) => x.valid);
    const zs = valid.map((x) => x.z);
    const quality = this.#calib.length ? mean(this.#calib.map((x) => clamp01(x.quality ?? 0))) : 0;
    const planned = Math.max(1, c.calibrationScares);
    const confidence = clamp01((valid.length / planned) * quality * (valid.length >= 2 ? 1 : 0.6));
    const neutral = valid.length === 0;
    this.#profile = {
      baseline: neutral
        ? { mean: null, sd: null }
        : { mean: r3(mean(valid.map((x) => x.preMean))), sd: r3(mean(valid.map((x) => x.preSd))) },
      reactivity: neutral ? null : r3(median(zs)),
      habituation: valid.length >= 2 ? r3(slope(zs)) : 0,
      quality: r3(quality),
      confidence: r3(neutral ? 0 : confidence),
      neutral,
      validScares: valid.length,
    };
    if (neutral) {
      this.#addNote('Calibration unusable; adapting with neutral defaults.');
    } else if (confidence < 0.4) {
      this.#addNote('Low-confidence calibration; adaptation is cautious.');
    }
    if (!neutral && this.#profile.habituation <= c.habituationSlope) {
      this.#variety = 1;
      this.#addNote('Response shrank across calibration scares; adding variety.');
    }
    if (!neutral) {
      const react = this.#profile.reactivity;
      const seed = clamp((c.targetResponse - react) / c.targetResponse, -1, 1);
      this.#drive = clamp(seed * c.calibrationDriveGain * confidence, -1, 1);
    }
    this.#decide({ kind: 'calibrated', neutral, drive: r3(this.#drive) });
    this.#phase = 'adapting';
  }

  #target() {
    const c = this.#cfg;
    const p = this.#profile;
    if (!p || p.neutral || p.reactivity === null) return Math.max(0.1, c.neutralResponse);
    const w = c.personalWeight * p.confidence;
    return Math.max(0.1, c.targetResponse * (1 - w) + p.reactivity * w);
  }

  #adaptAfterScare(m, lungeT) {
    const c = this.#cfg;
    if (!m.valid) {
      this.#addNote(`Scare response discarded: ${m.reason}.`);
      this.#decide({ kind: 'discard', reason: m.reason });
      return;
    }
    this.#adaptZs.push(m.z);
    this.#ema = this.#ema === null ? m.z : this.#ema + c.emaAlpha * (m.z - this.#ema);
    const target = this.#target();
    const err = clamp((target - this.#ema) / target, -1, 1); // + weak response, - strong
    let action;
    if (Math.abs(err) < c.band) {
      this.#drive *= 1 - c.driveDecay;
      action = 'hold';
    } else {
      this.#drive = clamp(this.#drive + c.gain * err, -1, 1);
      action = err > 0 ? 'strengthen' : 'soften';
    }
    // Live habituation: slope of the most recent real-scare z values.
    const recent = this.#adaptZs.slice(-4);
    const hab = recent.length >= 3 ? slope(recent) : 0;
    if (hab <= c.habituationSlope) this.#variety = clamp01(this.#variety + 0.5);
    else this.#variety = clamp01(this.#variety - 0.1);
    this.#decide({ kind: 'adapt', z: r3(m.z), ema: r3(this.#ema), target: r3(target), action, drive: r3(this.#drive), variety: r3(this.#variety) });
  }

  #build(trigger) {
    const c = this.#cfg;
    const calibrating = this.#phase === 'calibrating';
    const active = this.#phase === 'adapting';
    const d = active ? clamp(this.#drive, -1, 1) : 0;
    const w = Object.fromEntries(BEAT_GROUPS.map((g) => [g, 1]));
    if (calibrating) {
      for (const g of BEAT_GROUPS) w[g] = c.minWeight;
    } else if (active) {
      const up = Math.max(0, d);
      const down = Math.max(0, -d);
      w.fake *= 1 + 0.8 * up - 0.4 * down;
      w.visual *= 1 + 0.8 * up - 0.4 * down;
      w.light *= 1 - 0.4 * up + 0.8 * down;
      w.sound *= 1 - 0.4 * up + 0.8 * down;
      w.real *= 1 + 0.3 * up - 0.4 * down;
      w.visual *= 1 + c.varietyGain * this.#variety;
      w.fake *= 1 + c.varietyGain * this.#variety;
    }
    for (const g of BEAT_GROUPS) w[g] = r3(clamp(w[g], c.minWeight, c.maxWeight));

    let effectiveTension;
    if (calibrating) effectiveTension = 0;
    else if (active) {
      const prof = clamp01(c.baseTension - c.tensionSwing * d); // weak response (d>0) -> more tension
      effectiveTension = clamp01(c.tensionWeight * this.#live + (1 - c.tensionWeight) * prof);
    } else effectiveTension = clamp01(this.#live);

    return {
      phase: this.#phase,
      trigger,
      suppressOthers: calibrating, // app should not run its own scares/beats during calibration
      effectiveTension: r3(effectiveTension),
      gapScale: r3(clamp(calibrating ? c.maxGapScale : 1 - c.gapSwing * d, c.minGapScale, c.maxGapScale)),
      intensityScale: r3(clamp(1 + c.intensitySwing * d, c.minIntensityScale, c.maxIntensityScale)),
      minGap: c.minRealScareGap, // app must keep real scares at least this far apart
      beatWeights: w,
      notes: [...this.#notes],
    };
  }
}
