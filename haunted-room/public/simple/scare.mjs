// Pure scare director for the simple four-door room.
// No THREE, no DOM. Deterministic given an injected rng and the update dt/input.
//
// Usage: start(), then update(dt, input) every frame, then consumeEvents().
// Every event is plain data; nothing here moves the camera.

import { BeatPlanner } from './beats.mjs';

export const SIDES = Object.freeze(['left', 'right', 'front', 'back']);
export const BASE_FIGURES = Object.freeze(['bellwether', 'lark', 'ratchet', 'maestro', 'momo', 'pennywise']);
export const WITHERED_FIGURES = Object.freeze(BASE_FIGURES.filter(id => id !== 'momo' && id !== 'pennywise').map((id) => `withered-${id}`));
const STATES = Object.freeze(['BUILD', 'PEAK', 'RELIEF', 'WAIT']);

export const TIMING = Object.freeze({
  silence: 0.8, // FNAF beat before the hit
  lights: 0.5, // lights cut to near black
  approach: 0.4, // figure stands in the doorway, unobserved, before it lunges
  grace: 2.2, // how long a stare holds the figure before it reaches the player (caught)
  lunge: 0.22, // fast: the face arrives before the player can react
  stinger: 0.4, // then recover
  gapShort: [4, 8], // gap at full pressure (BUILD/PEAK with tension 1)
  gapLong: [14, 24], // gap at no pressure (RELIEF/WAIT)
  gapEscalation: 0.2, // gaps shrink by up to this fraction over the session
  ambient: [4, 8], // seconds between beats (scaled 1.2x at no pressure down to 0.6x at full)
  postScare: [3, 5], // enforced quiet gap after a real scare: it is the release
  witheredAfter: 90, // elapsed seconds before withered variants join the pool
  doubleAfter: 60, // elapsed seconds before double scares become possible
  doubleChance: [0.2, 0.45], // chance of a double scare, low to high pressure
  doubleGap: [0.4, 0.9], // gap before the second door, measured after recover
});

const EPS = 1e-9;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const lerp = (a, b, t) => a + (b - a) * t;

function sanitizeInput(input) {
  const i = input && typeof input === 'object' ? input : {};
  return {
    tension: clamp01(i.tension),
    state: STATES.includes(i.state) ? i.state : 'WAIT',
    observed: SIDES.includes(i.observed) ? i.observed : null,
  };
}

export class ScareDirector {
  #rng;
  #variableTiming;
  #duration;
  #phase = 'idle'; // idle | running | ended
  #elapsed = 0;
  #input = sanitizeInput(null);
  #queue = [];
  #scare = null; // { side, stage, timer, id, state }
  #hold = false; // true: gap and beat clocks stop (calibration); trigger() still works
  #gap = null; // seconds until the next scare (null while a scare runs)
  #beatWait = null; // seconds until the next beat
  #beat = null; // { name, steps, idx, clock, duration, cleanup }
  #planner;
  #weights = {};
  #lastBeat = null;
  #lastSide = null;
  #lastId = null;
  #scaresSoFar = 0;
  #intensity = null; // hard override 0..1 for testing
  #endReason = null;
  #pending = []; // triggered scares waiting for the current one to finish

  constructor({ rng = Math.random, durationSeconds = 120, variableTiming = false } = {}) {
    this.#variableTiming = variableTiming;
    this.#rng = typeof rng === 'function' ? rng : Math.random;
    this.#planner = new BeatPlanner({ rng: () => this.#roll() });
    this.#duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 120;
  }

  start() {
    if (this.#phase === 'running') return;
    this.reset();
    this.#phase = 'running';
  }

  reset() {
    this.#phase = 'idle';
    this.#elapsed = 0;
    this.#input = sanitizeInput(null);
    this.#queue = [];
    this.#scare = null;
    this.#gap = null;
    this.#beatWait = null;
    this.#beat = null;
    this.#lastBeat = null;
    this.#planner.reset();
    this.#lastSide = null;
    this.#lastId = null;
    this.#scaresSoFar = 0;
    this.#endReason = null;
    this.#pending = [];
  }

  // Test-button hook: queue a scare now. Works while running (between scares or not).
  // Returns false when the session is not running.
  trigger(side = null, id = null, opts = {}) {
    if (this.#phase !== 'running') return false;
    const request = {
      side: SIDES.includes(side) ? side : null,
      id: [...BASE_FIGURES, ...WITHERED_FIGURES].includes(id) ? id : null,
      forceCaught: opts?.forceCaught === true,
      skipTelegraph: opts?.skipTelegraph === true,
    };
    if (this.#scare) this.#pending.push(request);
    else this.#startScare(request);
    return true;
  }

  // Weight overrides for the beat planner: { [beatName | category]: multiplier >= 0 }. 0 disables.
  setBeatWeights(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) if (Number.isFinite(v) && v >= 0) out[k] = v;
    }
    this.#weights = out;
  }

  setIntensity(value) {
    this.#intensity = value === null || value === undefined ? null : clamp01(Number(value));
  }

  // While held, no automatic scares or beats start; only trigger() does. Elapsed time still runs.
  setHold(value) {
    this.#hold = !!value;
  }

  consumeEvents() {
    const out = this.#queue;
    this.#queue = [];
    return out;
  }

  snapshot() {
    const s = this.#scare;
    return {
      phase: this.#phase,
      elapsed: this.#elapsed,
      duration: this.#duration,
      nextGap: s || this.#phase !== 'running' ? null : this.#gap,
      activeScare: s ? { side: s.side, stage: s.stage, figureId: s.id, state: s.state } : null,
      scaresSoFar: this.#scaresSoFar,
      endReason: this.#endReason,
      lastBeat: this.#lastBeat,
      activeBeat: this.#beat ? this.#beat.name : null,
      dread: this.#planner.dread,
    };
  }

  update(dt, input) {
    if (this.#phase !== 'running') return;
    this.#input = sanitizeInput(input);
    if (!this.#scare) {
      // Draws happen here so the gap reflects the tension the player is actually giving.
      if (this.#gap === null) this.#gap = this.#drawGap();
      if (this.#beatWait === null) this.#beatWait = this.#drawAmbient();
    }
    this.#applyLook();

    let left = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (let guard = 0; this.#phase === 'running'; guard += 1) {
      if (this.#elapsed >= this.#duration - EPS) {
        this.#finish();
        break;
      }
      if (left <= 0 || guard > 100000) break;
      const s = this.#scare;
      let slice = Math.min(left, this.#duration - this.#elapsed);
      if (s) slice = Math.min(slice, s.timer);
      else if (this.#beat) {
        const b = this.#beat;
        const next = b.idx < b.steps.length ? Math.min(b.steps[b.idx].at, b.duration) : b.duration;
        slice = Math.min(slice, Math.max(next - b.clock, 1e-6));
        if (this.#gap > EPS) slice = Math.min(slice, this.#gap);
      } else if (!this.#hold) slice = Math.min(slice, this.#gap, this.#beatWait);
      if (!(slice > 0)) break;
      this.#advance(slice);
      left -= slice;
    }
  }

  // ---- internals -------------------------------------------------------

  #emit(event) {
    this.#queue.push(event);
  }

  #advance(slice) {
    this.#elapsed = Math.min(this.#duration, this.#elapsed + slice);
    const s = this.#scare;
    if (s) {
      s.timer -= slice;
      if (s.timer <= EPS) this.#advanceStage();
      return;
    }
    if (this.#hold && !this.#beat) return;
    this.#gap = Math.max(0, this.#gap - slice);
    if (this.#beat) {
      this.#beat.clock += slice;
      this.#runBeat();
    } else {
      this.#beatWait -= slice;
    }
    // A scare waits for the beat in progress; beats are chosen to fit before the gap ends.
    if (!this.#beat && this.#gap <= EPS) this.#startScare();
    else if (!this.#beat && this.#beatWait <= EPS) this.#startBeat();
  }

  #startBeat() {
    const input = this.#intensity !== null
      ? { tension: this.#intensity, state: 'BUILD' }
      : this.#input;
    const plan = this.#planner.next({
      tension: input.tension,
      state: input.state,
      elapsed: this.#elapsed,
      weights: this.#weights,
      maxDuration: this.#gap - 0.3,
    });
    if (!plan) {
      this.#beatWait = 1;
      return;
    }
    this.#lastBeat = plan.name;
    this.#beat = {
      name: plan.name,
      steps: [...plan.steps].sort((a, b) => a.at - b.at),
      idx: 0,
      clock: 0,
      duration: plan.duration,
      cleanup: plan.cleanup,
    };
    this.#runBeat();
  }

  #runBeat() {
    const b = this.#beat;
    while (b.idx < b.steps.length && b.steps[b.idx].at <= b.clock + EPS) {
      this.#emit({ ...b.steps[b.idx].event });
      b.idx += 1;
    }
    if (b.clock >= b.duration - EPS) {
      this.#beat = null;
      this.#beatWait = this.#drawAmbient();
    }
  }

  // Close anything a beat left open (a cracked door, a hall glow) when it is cut short.
  #cancelBeat() {
    const b = this.#beat;
    if (!b) return;
    this.#beat = null;
    for (const c of b.cleanup) {
      if (b.clock >= c.from - EPS && b.clock < c.to && b.idx > 0) this.#emit({ ...c.event });
    }
  }

  #startScare(request = {}) {
    this.#cancelBeat();
    this.#planner.noteScare(this.#elapsed);
    const side = request.side ?? this.#chooseSide();
    const silence = request.skipTelegraph ? 0.2 : this.#variableTiming ? this.#between([.25, .85]) : TIMING.silence;
    this.#scare = {
      side,
      stage: 'silence',
      darkLead: !this.#variableTiming || this.#roll() < .3,
      lights: this.#variableTiming ? this.#between([.15, .45]) : TIMING.lights,
      approach: this.#variableTiming ? this.#between([.18, .38]) : TIMING.approach,
      lunge: this.#variableTiming ? this.#between([.10, .16]) : TIMING.lunge,
      timer: silence,
      id: null,
      requestedId: request.id ?? null,
      forced: request.forceCaught === true,
      state: null,
    };
    this.#gap = null;
    this.#scaresSoFar += 1;
    if (!this.#variableTiming || this.#roll() < .45) this.#emit({ type: 'silence', side, seconds: silence });
  }

  #advanceStage() {
    const s = this.#scare;
    switch (s.stage) {
      case 'silence':
        s.stage = 'lights';
        s.timer = s.lights;
        if (s.darkLead) this.#emit({ type: 'lights', level: 0.05, seconds: s.lights });
        return;
      case 'lights':
        this.#emit({ type: 'door', side: s.side, open: 1 });
        this.#enterFigure();
        return;
      case 'figure':
        if (s.state === 'hold' || s.forced) this.#caught();
        else this.#startLunge();
        return;
      case 'lunge':
        s.stage = 'stinger';
        s.timer = TIMING.stinger;
        this.#emit({ type: 'stinger' });
        return;
      case 'stinger':
        this.#emit({ type: 'recover', side: s.side });
        this.#closeScare();
        return;
      default:
        return;
    }
  }

  #enterFigure() {
    const s = this.#scare;
    s.stage = 'figure';
    s.id = s.requestedId ?? this.#pickFigure();
    this.#emit({ type: 'figure', side: s.side, id: s.id });
    if (!s.forced && this.#input.observed === s.side) {
      s.state = 'hold';
      s.timer = TIMING.grace;
      this.#emit({ type: 'hold', side: s.side });
    } else {
      s.state = 'approach';
      s.timer = s.approach;
    }
  }

  // Player looks at or away from the figure's door between updates.
  #applyLook() {
    const s = this.#scare;
    if (!s || s.stage !== 'figure' || s.forced) return;
    const looking = this.#input.observed === s.side;
    if (s.state === 'approach' && looking) {
      this.#emit({ type: 'retreat', side: s.side });
      this.#emit({ type: 'recover', side: s.side });
      this.#closeScare();
    } else if (s.state === 'hold' && !looking) {
      this.#startLunge();
    }
  }

  #startLunge() {
    const s = this.#scare;
    s.stage = 'lunge';
    s.timer = s.lunge;
    this.#emit({ type: 'lunge', side: s.side, id: s.id, seconds: s.lunge });
  }

  #caught() {
    const s = this.#scare;
    this.#emit({ type: 'caught', side: s.side, id: s.id });
    this.#emit({ type: 'end', reason: 'caught' });
    this.#scare = null;
    this.#phase = 'ended';
    this.#endReason = 'caught';
  }

  #closeScare() {
    const s = this.#scare;
    this.#lastSide = s.side;
    this.#lastId = s.id;
    this.#scare = null;
    const doubleChance =
      this.#elapsed >= TIMING.doubleAfter
        ? lerp(TIMING.doubleChance[0], TIMING.doubleChance[1], this.#pressure())
        : 0;
    if (doubleChance > 0 && this.#roll() < doubleChance) {
      this.#gap = this.#between(TIMING.doubleGap);
    } else {
      this.#gap = this.#drawGap();
    }
    this.#beatWait = Math.max(this.#beatWait ?? 0, this.#between(TIMING.postScare));
    this.#planner.noteQuietGap(this.#elapsed);
    if (this.#pending.length) {
      this.#startScare(this.#pending.shift());
    }
  }

  #finish() {
    this.#cancelBeat();
    if (this.#scare) {
      this.#emit({ type: 'recover', side: this.#scare.side });
      this.#scare = null;
    }
    this.#elapsed = this.#duration;
    this.#pending = [];
    this.#emit({ type: 'end', reason: 'survived' });
    this.#phase = 'ended';
    this.#endReason = 'survived';
  }

  #chooseSide() {
    let pool = SIDES.filter((side) => side !== this.#lastSide);
    const away = pool.filter((side) => side !== this.#input.observed);
    if (away.length) pool = away;
    return this.#pick(pool);
  }

  #pickFigure() {
    const base = this.#elapsed >= TIMING.witheredAfter
      ? [...BASE_FIGURES, ...WITHERED_FIGURES]
      : [...BASE_FIGURES];
    const pool = base.filter((id) => id !== this.#lastId);
    return this.#pick(pool.length ? pool : base);
  }

  // Tension only drives pressure while the room is actually building.
  #pressure() {
    if (this.#intensity !== null) return this.#intensity;
    if (this.#input.state === 'RELIEF' || this.#input.state === 'WAIT') return 0;
    return this.#input.tension;
  }

  #drawGap() {
    const p = this.#pressure();
    const shrink = 1 - TIMING.gapEscalation * Math.min(1, this.#elapsed / this.#duration);
    const lo = lerp(TIMING.gapLong[0], TIMING.gapShort[0], p) * shrink;
    const hi = lerp(TIMING.gapLong[1], TIMING.gapShort[1], p) * shrink;
    return this.#between([lo, hi]);
  }

  #drawAmbient() {
    const scale = lerp(1.2, 0.6, this.#pressure());
    return this.#between(TIMING.ambient) * scale;
  }

  #roll() {
    const v = Number(this.#rng());
    return Number.isFinite(v) ? Math.min(1 - EPS, Math.max(0, v)) : 0;
  }

  #between([lo, hi]) {
    return lo + (hi - lo) * this.#roll();
  }

  #pick(list) {
    return list[Math.min(list.length - 1, Math.floor(this.#roll() * list.length))];
  }
}
