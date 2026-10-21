// Beat library for the simple four-door room. Pure logic: no THREE, no DOM.
// A beat is a short timed script: { duration, steps:[{at, event}], cleanup }.
// BeatPlanner picks the next beat by weight, tension and a dread budget.
// ScareDirector plays the script through its normal event queue.

export const SIDES = Object.freeze(['left', 'right', 'front', 'back']);
export const FLASH_LIMIT_HZ = 3;
export const MAX_HEAVY_IN_ROW = 2;
export const BASE_FIGURES = Object.freeze(['bellwether', 'lark', 'ratchet', 'maestro']);
export const WITHERED_FIGURES = Object.freeze(BASE_FIGURES.map((id) => `withered-${id}`));
export const WITHERED_AFTER = 90;
const EPS = 1e-9;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

function helpers(rng) {
  const roll = () => {
    const v = Number(rng());
    return Number.isFinite(v) ? Math.min(1 - EPS, Math.max(0, v)) : 0;
  };
  return {
    roll,
    between: ([lo, hi]) => lo + (hi - lo) * roll(),
    int: (lo, hi) => lo + Math.min(hi - lo, Math.floor(roll() * (hi - lo + 1))),
    pick: (list) => list[Math.min(list.length - 1, Math.floor(roll() * list.length))],
  };
}

// Light transitions caused by an event, as times relative to the event start.
// Used by the 3 Hz safety test and by anyone who wants to budget flashes.
export function lightTransitions(ev) {
  switch (ev?.type) {
    case 'lights': return [0];
    case 'flicker': return [0, ev.seconds];
    case 'hall-light': return [0, ev.seconds];
    case 'light-pattern':
      if (ev.pattern === 'stutter') {
        const n = Math.max(1, Math.round(ev.seconds * 2)); // 2 Hz
        return Array.from({ length: n }, (_, i) => (i * ev.seconds) / n);
      }
      return [0, ev.seconds]; // sag, cut-return: out, then back
    default: return [];
  }
}

const sub = (side, ev) => ({ side, ...ev });

// ---- beat definitions ---------------------------------------------------
// duration is the exact [min, max] the build() can return.
const defs = [
  // LIGHT
  {
    name: 'stutter', category: 'light', min: 0, max: 0.8, weight: 1.0, cooldown: 25, dread: 0.1, duration: [2.4, 3.4],
    build(r) {
      const s = r.between([2, 3]);
      return { duration: s + 0.4, steps: [{ at: 0, event: { type: 'light-pattern', pattern: 'stutter', seconds: s } }] };
    },
  },
  {
    name: 'sag', category: 'light', min: 0, max: 0.7, weight: 0.9, cooldown: 35, dread: 0.1, duration: [3.5, 5],
    build(r) {
      const s = r.between([3, 4.5]);
      return { duration: s + 0.5, steps: [{ at: 0, event: { type: 'light-pattern', pattern: 'sag', seconds: s } }] };
    },
  },
  {
    name: 'cut-and-return', category: 'light', min: 0.15, max: 1, weight: 0.8, cooldown: 40, dread: 0.2, duration: [3.95, 6.8],
    build(r, ctx) {
      const dark = r.between([0.4, 1]);
      const gap = r.between([0.25, 0.5]);
      const glow = r.between([3, 5]);
      return {
        duration: dark + gap + glow + 0.3,
        steps: [
          { at: 0, event: { type: 'light-pattern', pattern: 'cut-return', seconds: dark } },
          { at: dark + gap, event: { type: 'hall-light', side: ctx.side, level: 0.35, seconds: glow } },
        ],
        cleanup: [{ from: dark + gap, to: dark + gap + glow, event: { type: 'hall-light', side: ctx.side, level: 0, seconds: 0.3 } }],
      };
    },
  },
  {
    name: 'hall-light', category: 'light', min: 0, max: 0.9, weight: 0.9, cooldown: 30, dread: 0.1, duration: [4.5, 7.5],
    build(r, ctx) {
      const s = r.between([4, 7]);
      return {
        duration: s + 0.5,
        steps: [{ at: 0, event: { type: 'hall-light', side: ctx.side, level: 0.3, seconds: s } }],
        cleanup: [{ from: 0, to: s, event: { type: 'hall-light', side: ctx.side, level: 0, seconds: 0.3 } }],
      };
    },
  },
  {
    name: 'flicker', category: 'light', min: 0, max: 1, weight: 0.7, cooldown: 15, dread: 0.05, duration: [1.2, 1.5],
    build(r) {
      const s = r.between([0.5, 0.8]);
      return { duration: s + 0.7, steps: [{ at: 0, event: { type: 'flicker', seconds: s } }] };
    },
  },
  // FAKE-OUTS
  {
    name: 'door-crack', category: 'fake', min: 0.1, max: 1, weight: 1.0, cooldown: 25, dread: 0.2, duration: [2.6, 3.6],
    build(r, ctx) {
      const open = r.between([0.1, 0.2]);
      const hold = r.between([0.8, 1.8]);
      const closeAt = 0.9 + hold;
      return {
        duration: closeAt + 0.5 + 0.4,
        steps: [
          { at: 0, event: { type: 'creak', side: ctx.side } },
          { at: 0, event: { type: 'fake-door', side: ctx.side, open, seconds: 0.9 } },
          { at: closeAt, event: { type: 'fake-door', side: ctx.side, open: 0, seconds: 0.5 } },
        ],
        cleanup: [{ from: 0, to: closeAt + 0.5, event: { type: 'fake-door', side: ctx.side, open: 0, seconds: 0.3 } }],
      };
    },
  },
  {
    name: 'knock', category: 'fake', min: 0.1, max: 1, weight: 1.0, cooldown: 25, dread: 0.2, duration: [2.2, 3.6],
    build(r, ctx) {
      const count = r.int(1, 3);
      return { duration: count * 0.7 + 1.5, steps: [{ at: 0, event: { type: 'knock', side: ctx.side, count } }] };
    },
  },
  {
    name: 'empty-open', category: 'fake', min: 0.3, max: 1, weight: 0.8, cooldown: 45, dread: 0.3, duration: [4.5, 7.5],
    build(r, ctx) {
      const s = r.between([3, 6]);
      return {
        duration: s + 1.5,
        steps: [{ at: 0, event: { type: 'empty-open', side: ctx.side, seconds: s } }],
        cleanup: [{ from: 0, to: s + 1.2, event: { type: 'fake-door', side: ctx.side, open: 0, seconds: 0.3 } }],
      };
    },
  },
  {
    name: 'false-lunge', category: 'fake', min: 0.45, max: 1, weight: 1.0, cooldown: 50, dread: 0.55, duration: [3, 3],
    build(_r, ctx) {
      return { duration: 3, steps: [{ at: 0, event: { type: 'false-lunge', side: ctx.side, id: ctx.figure } }] };
    },
  },
  {
    name: 'glimpse', category: 'fake', min: 0.3, max: 1, weight: 0.9, cooldown: 40, dread: 0.4, duration: [1.8, 2],
    build(r, ctx) {
      const s = r.between([0.3, 0.5]);
      return { duration: s + 1.5, steps: [{ at: 0, event: { type: 'glimpse', side: ctx.side, id: ctx.figure, seconds: s } }] };
    },
  },
  // VISUAL CUES
  cue('eyes', [1.5, 3], { min: 0.25, weight: 0.9, cooldown: 35, dread: 0.3 }),
  cue('shadow-pass', [1.2, 2], { min: 0.25, weight: 0.8, cooldown: 35, dread: 0.3 }),
  cue('wall-shadow', [1.5, 2.5], { min: 0.25, weight: 0.8, cooldown: 40, dread: 0.3 }),
  cue('far-figure', [3, 6], { min: 0.3, weight: 0.7, cooldown: 50, dread: 0.25 }),
  // SOUND ONLY
  {
    name: 'footsteps-behind', category: 'sound', min: 0, max: 1, weight: 1.1, cooldown: 25, dread: 0.15, duration: [3.6, 5.6],
    build(r, ctx) {
      const s = r.between([3, 5]);
      return { duration: s + 0.6, steps: [{ at: 0, event: { type: 'footsteps', from: ctx.from, to: ctx.to, seconds: s } }] };
    },
  },
  simple('whisper', 'sound', 'whisper', 3, { weight: 0.9, cooldown: 30, dread: 0.15 }),
  simple('breath', 'sound', 'breath', 3, { weight: 1.0, cooldown: 15, dread: 0.1 }),
  simple('creak', 'sound', 'creak', 2, { weight: 0.9, cooldown: 15, dread: 0.1 }),
  {
    name: 'silence', category: 'sound', release: true, min: 0, max: 1, weight: 0.8, cooldown: 30, dread: -0.35, duration: [2, 3.5],
    build(r) {
      const s = r.between([1.5, 3]);
      return { duration: s + 0.5, steps: [{ at: 0, event: { type: 'silence', side: null, seconds: s } }] };
    },
  },
  {
    name: 'heartbeat-spike', category: 'sound', min: 0.4, max: 1, weight: 0.8, cooldown: 35, dread: 0.3, duration: [2, 3.5],
    build(r) {
      const s = r.between([1.5, 3]);
      return { duration: s + 0.5, steps: [{ at: 0, event: { type: 'heartbeat-spike', seconds: s } }] };
    },
  },
  // RELEASE (quiet gap, no events)
  {
    name: 'rest', category: 'release', release: true, min: 0, max: 1, weight: 0.5, cooldown: 0, dread: -0.2, duration: [3, 6],
    build(r) {
      return { duration: r.between([3, 6]), steps: [] };
    },
  },
];

function cue(name, secs, o) {
  return {
    name, category: 'cue', min: o.min, max: 1, weight: o.weight, cooldown: o.cooldown, dread: o.dread,
    duration: [secs[0] + 0.8, secs[1] + 0.8],
    build(r, ctx) {
      const s = r.between(secs);
      return { duration: s + 0.8, steps: [{ at: 0, event: { type: name, side: ctx.side, seconds: s } }] };
    },
  };
}

function simple(name, category, type, duration, o) {
  return {
    name, category, min: 0, max: 1, weight: o.weight, cooldown: o.cooldown, dread: o.dread, duration: [duration, duration],
    build(_r, ctx) {
      return { duration, steps: [{ at: 0, event: { type, side: ctx.side } }] };
    },
  };
}

for (const d of defs) d.heavy = d.dread >= 0.3;
export const BEATS = Object.freeze(Object.fromEntries(defs.map((d) => [d.name, Object.freeze(d)])));
const isFakeOrLight = (d) => d.category === 'fake' || d.category === 'light';

// ---- event contract -----------------------------------------------------
const sideOk = (v) => SIDES.includes(v);
const secs = (v) => Number.isFinite(v) && v > 0;
export const EVENT_SHAPES = Object.freeze({
  'fake-door': (e) => sideOk(e.side) && e.open >= 0 && e.open <= 1 && secs(e.seconds),
  knock: (e) => sideOk(e.side) && Number.isInteger(e.count) && e.count >= 1 && e.count <= 3,
  'empty-open': (e) => sideOk(e.side) && secs(e.seconds),
  'false-lunge': (e) => sideOk(e.side) && typeof e.id === 'string',
  glimpse: (e) => sideOk(e.side) && typeof e.id === 'string' && e.seconds >= 0.3 && e.seconds <= 0.5,
  eyes: (e) => sideOk(e.side) && secs(e.seconds),
  'shadow-pass': (e) => sideOk(e.side) && secs(e.seconds),
  'wall-shadow': (e) => sideOk(e.side) && secs(e.seconds),
  'far-figure': (e) => sideOk(e.side) && secs(e.seconds),
  'hall-light': (e) => sideOk(e.side) && e.level >= 0 && e.level <= 1 && secs(e.seconds),
  'light-pattern': (e) => ['stutter', 'sag', 'cut-return'].includes(e.pattern) && secs(e.seconds),
  footsteps: (e) => sideOk(e.from) && sideOk(e.to) && e.from !== e.to && secs(e.seconds),
  whisper: (e) => sideOk(e.side),
  silence: (e) => (e.side === null || sideOk(e.side)) && secs(e.seconds),
  'heartbeat-spike': (e) => secs(e.seconds),
  flicker: (e) => secs(e.seconds),
  creak: (e) => sideOk(e.side),
  breath: (e) => sideOk(e.side),
});
export function validBeatEvent(e) {
  const check = EVENT_SHAPES[e?.type];
  return Boolean(check && check(e));
}

// ---- planner ------------------------------------------------------------
function categoryBias(category, t) {
  switch (category) {
    case 'sound': return 1 + 1.5 * (1 - t);
    case 'light': return 1 + 1.0 * (1 - t);
    case 'fake': return 0.4 + 1.8 * t;
    case 'cue': return 0.4 + 1.5 * t;
    default: return 1;
  }
}

export class BeatPlanner {
  #h;
  #dread = 0;
  #heavyRun = 0;
  #nonFL = 0;
  #flLimit = 3;
  #forceRelease = false;
  #lastBeat = null;
  #lastSide = null;
  #lastFigure = null;
  #lastElapsed = 0;
  #lastRelease = 0;
  #used = new Map();

  constructor({ rng = Math.random } = {}) {
    this.#h = helpers(typeof rng === 'function' ? rng : Math.random);
    this.#flLimit = this.#drawLimit();
  }

  reset() {
    this.#dread = 0;
    this.#heavyRun = 0;
    this.#nonFL = 0;
    this.#forceRelease = false;
    this.#lastBeat = null;
    this.#lastSide = null;
    this.#lastFigure = null;
    this.#lastElapsed = 0;
    this.#lastRelease = 0;
    this.#used.clear();
    this.#flLimit = this.#drawLimit();
  }

  get dread() {
    return this.#dread;
  }

  // The director calls this when a real scare starts: heavy, and a release must follow.
  noteScare(elapsed = this.#lastElapsed) {
    this.#dread = clamp01(this.#dread + 0.6);
    this.#heavyRun += 1;
    this.#forceRelease = true;
    this.#lastElapsed = Math.max(this.#lastElapsed, Number.isFinite(elapsed) ? elapsed : 0);
  }

  // The director enforced a quiet gap itself (the wait after a real scare): counts as the release.
  noteQuietGap(elapsed = this.#lastElapsed) {
    this.#forceRelease = false;
    this.#heavyRun = 0;
    this.#dread = clamp01(this.#dread - 0.3);
    this.#lastRelease = Number.isFinite(elapsed) ? elapsed : this.#lastRelease;
  }

  #drawLimit() {
    return this.#h.int(2, 4); // 2..4 non-fake/light beats, then one is forced: every 3rd to 5th
  }

  next({ tension = 0, state = 'BUILD', elapsed = 0, lastBeat, sinceRelease, weights, maxDuration = Infinity } = {}) {
    const now = Number.isFinite(elapsed) ? elapsed : 0;
    this.#dread = clamp01(this.#dread - Math.max(0, now - this.#lastElapsed) * 0.04);
    this.#lastElapsed = Math.max(this.#lastElapsed, now);
    const t = (state === 'RELIEF' || state === 'WAIT' ? 0.35 : 1) * clamp01(tension);
    const last = lastBeat === undefined ? this.#lastBeat : lastBeat;
    const w = weights && typeof weights === 'object' ? weights : {};
    const since = Number.isFinite(sinceRelease) ? sinceRelease : now - this.#lastRelease;
    const forceFL = !this.#forceRelease && this.#nonFL >= this.#flLimit;

    const eligible = (d, relax) => {
      if (d.name === last) return false;
      if (!(d.duration[0] <= maxDuration)) return false;
      if (w[d.name] === 0 || w[d.category] === 0) return false;
      if (this.#forceRelease && !d.release) return false;
      if (forceFL && !isFakeOrLight(d)) return false;
      if (this.#heavyRun >= MAX_HEAVY_IN_ROW && d.heavy) return false;
      if (relax < 1 && now - (this.#used.get(d.name) ?? -Infinity) < d.cooldown) return false;
      if (relax < 2 && (t < d.min || t > d.max)) return false;
      if (relax < 3 && !d.release && this.#dread + d.dread > 1) return false;
      return true;
    };

    let pool = [];
    for (let relax = 0; relax <= 3 && !pool.length; relax += 1) {
      pool = defs.filter((d) => eligible(d, relax));
    }
    if (!pool.length && forceFL) pool = defs.filter((d) => d.name !== last && d.release && d.duration[0] <= maxDuration);
    if (!pool.length) return null;

    const weighed = pool.map((d) => {
      let wt = d.weight * categoryBias(d.category, t);
      if (d.release) wt *= 1 + 3 * this.#dread + (since > 45 ? 2 : 0);
      const o1 = Number(w[d.name]);
      const o2 = Number(w[d.category]);
      if (Number.isFinite(o1) && o1 >= 0) wt *= o1;
      if (Number.isFinite(o2) && o2 >= 0) wt *= o2;
      return { d, wt: wt > 0 ? wt : 0 };
    });
    let total = weighed.reduce((s, x) => s + x.wt, 0);
    if (!(total > 0)) {
      for (const x of weighed) x.wt = 1;
      total = weighed.length;
    }
    const mix = { sound: 0, light: 0, fake: 0, cue: 0, release: 0 };
    for (const x of weighed) mix[x.d.category] += x.wt / total;

    let roll = this.#h.roll() * total;
    let chosen = weighed[weighed.length - 1].d;
    for (const x of weighed) {
      roll -= x.wt;
      if (roll < 0) { chosen = x.d; break; }
    }

    const ctx = this.#context(chosen, now);
    const built = chosen.build(this.#h, ctx);
    this.#commit(chosen, now, ctx);
    return {
      name: chosen.name,
      category: chosen.category,
      heavy: chosen.heavy,
      release: Boolean(chosen.release),
      dread: this.#dread,
      mix,
      side: ctx.side,
      duration: built.duration,
      steps: built.steps,
      cleanup: built.cleanup ?? [],
    };
  }

  #context(d, now) {
    const h = this.#h;
    const sides = SIDES.filter((s) => s !== this.#lastSide);
    const side = h.pick(sides);
    const from = h.pick(SIDES);
    const to = h.pick(SIDES.filter((s) => s !== from));
    const figures = now >= WITHERED_AFTER ? [...BASE_FIGURES, ...WITHERED_FIGURES] : BASE_FIGURES;
    const pool = figures.filter((id) => id !== this.#lastFigure);
    return { side, from, to, figure: h.pick(pool.length ? pool : figures) };
  }

  #commit(d, now, ctx) {
    this.#lastBeat = d.name;
    this.#lastSide = ctx.side;
    if (d.name === 'false-lunge' || d.name === 'glimpse') this.#lastFigure = ctx.figure;
    this.#used.set(d.name, now);
    this.#dread = clamp01(this.#dread + d.dread);
    this.#heavyRun = d.heavy ? this.#heavyRun + 1 : 0;
    if (d.release) {
      this.#forceRelease = false;
      this.#lastRelease = now;
    }
    if (isFakeOrLight(d)) {
      this.#nonFL = 0;
      this.#flLimit = this.#drawLimit();
    } else {
      this.#nonFL += 1;
    }
  }
}
