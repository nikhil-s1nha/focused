// FNAF4-style mode "The Bedroom" (original characters). Pure logic: no THREE, no DOM.
// Mechanics replicated: listen for breathing at a door, hold the door shut, flashlight checks that must
// not linger on a character in the doorway, small ones in the closet, a hall stalker. Constants documented in
// notes/fnaf4-progress.md. Seated/fixed-view friendly: the player only chooses a facing direction.

export const C4 = Object.freeze({
  STEP: 0.1,               // fixed sim step (s)
  BASE_HOUR: 60,           // reference seconds/hour for AI cadence scaling (timers marked scaled use k)
  AI_MAX: 20,
  HOLD_NEED: 1.75,         // s the door must be held shut while someone is there (not scaled)
  HOLD_NEED_NIGHTMARE: 2.0,
  EARLY_TOLERANCE: 0.25,   // a tap shorter than this is ignored (no scare), longer-but-early release = caught
  WASTE_MIN: 0.75,         // s of holding an empty door that counts as a wasted close
  WASTE_HEAT: 1.0,         // heat added per wasted close
  HOLD_HEAT_PER_SEC: 0.15, // extra heat per second of holding an empty door beyond WASTE_MIN
  HEAT_MAX: 6, HEAT_DECAY: 0.05,
  HEAT_WEIGHT: Object.freeze({ hall: 1.5, left: 0.5, right: 0.5, closet: 0 }), // level bonus per heat point
  FLASH_SCARE: 1.5,        // s of light on a character in the doorway before it attacks
  FLASH_DECAY: 0.5,        // lit-time decay factor/s when light is off it
  NEAR_DWELL_MIN: 3, NEAR_DWELL_MAX: 6, // s at stage 1 before reaching the door (scaled)
  COOLDOWN: 3,             // s after being turned away before a character may try again (scaled)
  MAX_CONCURRENT: 2,       // comfort cap on simultaneously approaching door characters
  SMALL_INTERVAL: 6,       // s between small-one arrival rolls (scaled)
  SMALL_MAX: 4,
  FLASH_SMALL: 0.7,        // s of flashlight at the open closet to chase off one small one
  SMALL_SWARM: 6,          // s with all four present before the swarm attacks ('flash' rule only)
  SMALL_LEAVE: 7,          // s before a small one wanders off by itself ('ignore' rule only)
  AGITATE_COOLDOWN: 10,
  NIGHTMARE_TIMEOUT_MULT: 0.8,
  CALL_START: 2,
  CALL_LEN: Object.freeze({ 1: 60, 2: 50, 3: 40, 4: 35, 5: 30, 6: 25 }),
});

export const DOORS4 = Object.freeze(['left', 'right', 'closet', 'hall']);
export const FACINGS4 = Object.freeze([...DOORS4, 'bed']);
// Large characters (one per door). Original names/designs.
export const CHARS4 = Object.freeze({
  hollowjaw: { door: 'left',   interval: 4.0, timeout: 7.0, levels: [3, 2, 4, 6, 8, 12], nightmare: 'hollowjaw-n' },
  gristle:   { door: 'right',  interval: 4.0, timeout: 7.0, levels: [1, 2, 3, 6, 8, 12], nightmare: 'gristle-n' },
  marrow:    { door: 'closet', interval: 5.0, timeout: 6.0, levels: [0, 0, 3, 5, 8, 11], nightmare: 'marrow-n' },
  sable:     { door: 'hall',   interval: 3.5, timeout: 5.0, levels: [0, 0, 1, 3, 5, 9],  nightmare: 'sable-n' },
});
export const SMALL_NAMES = Object.freeze(['nib', 'tuck', 'wisp', 'pinch']);
export const SMALL_LEVELS = Object.freeze([0, 3, 4, 5, 7, 10]);
export const WHO4 = Object.freeze([...Object.keys(CHARS4), 'small']);
const DOOR_OWNER = Object.freeze(Object.fromEntries(Object.entries(CHARS4).map(([id, c]) => [c.door, id])));
export const smallRule = (night) => (night === 6 ? 'ignore' : 'flash');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const roomName = (door, stage) => `${door}-${['far', 'near', 'door'][stage]}`;

export class Fnaf4Mode {
  constructor({ night = 1, rng = Math.random, now = () => 0, secondsPerHour = 45, ai = null, smallRule: rule = null } = {}) {
    this.night = night; this.rng = rng; this.now = now;
    this.secondsPerHour = secondsPerHour;
    this.k = secondsPerHour / C4.BASE_HOUR;
    this.nightmare = night === 6;
    this.rule = rule || smallRule(night);
    this.mult = 1;
    this.base = {};
    for (const [id, c] of Object.entries(CHARS4)) this.base[id] = night >= 1 && night <= 6 ? c.levels[night - 1] : 0;
    this.base.small = night >= 1 && night <= 6 ? SMALL_LEVELS[night - 1] : 0;
    if (ai) for (const [id, n] of Object.entries(ai)) if (id in this.base) this.base[id] = clamp(Number(n) || 0, 0, C4.AI_MAX);
    this.reset();
  }

  reset() {
    this.events = []; this.acc = 0; this.elapsed = 0; this.running = false;
    this.dead = false; this.won = false; this.scare = null; this.deathReason = null; this.hour = 0; this.callState = 0;
    this.facing = null; this.holding = false; this.flash = false; this.heat = 0;
    this.d = {};
    let i = 0;
    for (const door of DOORS4) {
      this.d[door] = { stage: 0, clock: i++ * 0.7, dwell: 0, wait: 0, timeout: 0, holdT: 0, lit: 0, cooldown: 0, held: false, cleared: false };
    }
    this.small = { present: [], clock: 0, flashT: 0, swarm: 0, age: {}, agitateCd: 0 };
  }

  start() { this.reset(); this.running = true; this.emit({ type: 'hour', hour: 0, label: '12 AM' }); }
  emit(e) { this.events.push(e); }
  consumeEvents() { const e = this.events; this.events = []; return e; }
  setAiLevelMultiplier(x) { this.mult = Math.max(0, Number(x) || 0); }
  setAiLevel(who, n) { if (who in this.base) this.base[who] = clamp(Number(n) || 0, 0, C4.AI_MAX); }
  level(id) { return Math.min(C4.AI_MAX, Math.round(this.base[id] * this.mult)); }
  doorLevel(door) {
    const id = DOOR_OWNER[door];
    const bonus = this.heat * (C4.HEAT_WEIGHT[door] || 0);
    return Math.min(C4.AI_MAX, Math.round((this.base[id] + bonus) * this.mult));
  }
  holdNeed() { return this.nightmare ? C4.HOLD_NEED_NIGHTMARE : C4.HOLD_NEED; }

  update(dt, input = {}) {
    if (!this.running || this.dead || this.won) return;
    this.acc += Math.max(0, dt);
    while (this.acc >= C4.STEP - 1e-9 && this.running && !this.dead && !this.won) {
      this.acc -= C4.STEP;
      this.step(C4.STEP, input);
    }
  }

  step(dt, input) {
    const facing = FACINGS4.includes(input.facing) ? input.facing : null;
    const isDoor = DOORS4.includes(facing);
    const wantHold = !!input.hold && isDoor;
    // release of previous hold (hold dropped or facing changed)
    if (this.holding && (!wantHold || facing !== this.facing)) { this.release(this.facing); if (this.dead) return; }
    if (wantHold && !(this.holding && facing === this.facing)) {
      this.holding = true; this.d[facing].held = true; this.d[facing].holdT = 0; this.d[facing].cleared = false;
      this.emit({ type: 'cue', id: 'door-close', door: facing });
    }
    if (!wantHold) this.holding = false;
    this.facing = facing;
    this.flash = !!input.flashlight && isDoor && !wantHold;

    this.elapsed += dt;
    this.heat = Math.max(0, this.heat - C4.HEAT_DECAY * dt);
    this.phone();
    if (this.holding) this.holdStep(dt);
    for (const door of DOORS4) { this.doorStep(door, dt); if (this.dead) return; }
    this.smallStep(dt);
    if (this.dead) return;
    this.hours();
  }

  holdStep(dt) {
    const s = this.d[this.facing];
    s.holdT += dt;
    if (s.stage >= 1 && s.holdT >= this.holdNeed()) {
      this.turnAway(this.facing, 'door-held');
      s.holdT = 0; s.cleared = true;
    } else if (s.stage === 0 && s.holdT > C4.WASTE_MIN) {
      this.heat = Math.min(C4.HEAT_MAX, this.heat + C4.HOLD_HEAT_PER_SEC * dt);
    }
  }

  release(door) {
    const s = this.d[door];
    this.holding = false; s.held = false;
    this.emit({ type: 'cue', id: 'door-open', door });
    if (s.stage === 2 && s.holdT > C4.EARLY_TOLERANCE && s.holdT < this.holdNeed()) {
      this.jumpscare(DOOR_OWNER[door], 'released-early');
      return;
    }
    if (s.stage === 0 && s.holdT >= C4.WASTE_MIN) {
      this.heat = Math.min(C4.HEAT_MAX, this.heat + C4.WASTE_HEAT);
      this.emit({ type: 'cue', id: 'wasted-close', door, heat: this.heat });
    }
    s.holdT = 0; s.cleared = false;
  }

  turnAway(door, reason) {
    const s = this.d[door], id = DOOR_OWNER[door];
    const from = roomName(door, s.stage);
    s.stage = 0; s.wait = 0; s.lit = 0; s.dwell = 0; s.cooldown = C4.COOLDOWN * this.k;
    this.emit({ type: 'move', who: id, from, to: roomName(door, 0), reason });
  }

  concurrent() { return DOORS4.filter((x) => this.d[x].stage >= 1).length; }

  doorStep(door, dt) {
    const s = this.d[door], def = CHARS4[DOOR_OWNER[door]], id = DOOR_OWNER[door];
    if (s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - dt);
    if (s.stage === 0) {
      s.clock += dt;
      const interval = def.interval * this.k;
      if (s.clock >= interval) {
        s.clock -= interval;
        const lvl = this.doorLevel(door);
        if (s.cooldown <= 0 && lvl > 0 && this.concurrent() < C4.MAX_CONCURRENT && Math.floor(this.rng() * C4.AI_MAX) + 1 <= lvl) {
          s.stage = 1; s.wait = 0;
          s.dwell = (C4.NEAR_DWELL_MIN + this.rng() * (C4.NEAR_DWELL_MAX - C4.NEAR_DWELL_MIN)) * this.k;
          this.emit({ type: 'move', who: id, from: roomName(door, 0), to: roomName(door, 1) });
          this.emit({ type: 'cue', id: 'creak', door, who: id });
        }
      }
      return;
    }
    if (s.stage === 1) {
      s.wait += dt;
      if (s.wait >= s.dwell) this.arrive(door, id, def, s);
      return;
    }
    // stage 2: at the door, breathing audible
    if (s.held) return; // timeout paused while the door is held shut
    if (this.flash && this.facing === door) {
      s.lit += dt;
      if (s.lit >= C4.FLASH_SCARE) { this.jumpscare(id, 'flashlit'); return; }
    } else s.lit = Math.max(0, s.lit - C4.FLASH_DECAY * dt);
    s.wait += dt;
    if (s.wait >= s.timeout) this.jumpscare(id, 'door-open');
  }

  arrive(door, id, def, s) {
    s.stage = 2; s.wait = 0; s.lit = 0; s.holdT = s.held ? 0 : s.holdT;
    s.timeout = (def.timeout + this.rng() * 1.5) * (this.nightmare ? C4.NIGHTMARE_TIMEOUT_MULT : 1);
    this.emit({ type: 'move', who: id, from: roomName(door, 1), to: roomName(door, 2) });
    this.emit({ type: 'cue', id: 'breathing', door, who: id });
  }

  smallStep(dt) {
    const sm = this.small, lvl = this.level('small');
    sm.agitateCd = Math.max(0, sm.agitateCd - dt);
    sm.clock += dt;
    const interval = C4.SMALL_INTERVAL * this.k;
    if (sm.clock >= interval) {
      sm.clock -= interval;
      if (lvl > 0 && sm.present.length < C4.SMALL_MAX && Math.floor(this.rng() * C4.AI_MAX) + 1 <= lvl) {
        const name = SMALL_NAMES.find((n) => !sm.present.includes(n));
        sm.present.push(name); sm.age[name] = 0;
        this.emit({ type: 'move', who: name, from: 'closet-shelf', to: 'closet' });
        this.emit({ type: 'cue', id: 'skitter', door: 'closet', who: name });
      }
    }
    const closetLit = this.flash && this.facing === 'closet' && sm.present.length > 0;
    if (this.rule === 'ignore') {
      for (const n of [...sm.present]) {
        sm.age[n] += dt;
        if (sm.age[n] >= C4.SMALL_LEAVE) { this.removeSmall(n, 'wandered-off'); }
      }
      if (closetLit && sm.agitateCd <= 0) {
        sm.agitateCd = C4.AGITATE_COOLDOWN;
        const c = this.d.closet;
        if (c.stage < 2) {
          if (c.stage === 0) this.emit({ type: 'move', who: 'marrow', from: roomName('closet', 0), to: roomName('closet', 1) });
          this.arrive('closet', 'marrow', CHARS4.marrow, c);
          this.emit({ type: 'cue', id: 'agitated', door: 'closet' });
        }
      }
      return;
    }
    if (closetLit) {
      sm.flashT += dt;
      if (sm.flashT >= C4.FLASH_SMALL) { sm.flashT = 0; this.removeSmall(sm.present[sm.present.length - 1], 'flashed'); }
    } else sm.flashT = 0;
    if (sm.present.length >= C4.SMALL_MAX) {
      sm.swarm += dt;
      if (sm.swarm >= C4.SMALL_SWARM) this.jumpscare('nib', 'swarm');
    } else sm.swarm = 0;
  }

  removeSmall(name, reason) {
    const sm = this.small;
    sm.present = sm.present.filter((n) => n !== name); delete sm.age[name];
    this.emit({ type: 'move', who: name, from: 'closet', to: 'closet-shelf', reason });
  }

  phone() {
    if (this.night < 1 || this.night > 6) return;
    const id = `night${this.night}`, len = C4.CALL_LEN[this.night];
    if (this.callState === 0 && this.elapsed >= C4.CALL_START) { this.callState = 1; this.emit({ type: 'phone-call-start', id }); }
    else if (this.callState === 1 && this.elapsed >= C4.CALL_START + len) { this.callState = 2; this.emit({ type: 'phone-call-end', id }); }
  }

  jumpscare(who, reason) {
    if (this.dead) return;
    this.dead = true; this.running = false; this.scare = who; this.deathReason = reason;
    if (this.callState === 1) { this.callState = 2; this.emit({ type: 'phone-call-end', id: `night${this.night}`, interrupted: true }); }
    this.emit({ type: 'jumpscare', who, reason });
  }

  hours() {
    const h = Math.min(6, Math.floor(this.elapsed / this.secondsPerHour));
    while (this.hour < h) {
      this.hour++;
      this.emit({ type: 'hour', hour: this.hour, label: this.hour === 6 ? '6 AM' : `${this.hour} AM` });
    }
    if (this.hour >= 6 && !this.won && !this.dead) { this.won = true; this.running = false; this.emit({ type: 'night-win', night: this.night }); }
  }

  audioCues() {
    const cues = [];
    for (const door of DOORS4) {
      const s = this.d[door];
      if (s.stage === 1) cues.push({ pos: door, kind: 'creak', gain: 0.3 });
      else if (s.stage === 2) {
        if (s.held) cues.push({ pos: door, kind: 'breathing', gain: 0.5, muffled: true });
        else if (this.facing === door) cues.push({ pos: door, kind: 'breathing', gain: 1, muffled: false });
      }
    }
    if (this.small.present.length) cues.push({ pos: 'closet', kind: 'skitter', gain: Math.min(0.5, 0.15 * this.small.present.length) });
    return cues;
  }

  snapshot() {
    const chars = {}, doors = {};
    for (const door of DOORS4) {
      const s = this.d[door], id = DOOR_OWNER[door];
      chars[id] = {
        door, stage: s.stage, room: roomName(door, s.stage), level: this.doorLevel(door), atDoor: s.stage === 2,
        lit: s.lit, variant: this.nightmare ? CHARS4[id].nightmare : id,
        timeLeft: s.stage === 2 && !s.held ? Math.max(0, s.timeout - s.wait) : 0,
      };
      doors[door] = { closed: s.held, holdProgress: s.held ? Math.min(1, s.holdT / this.holdNeed()) : 0, occupant: s.stage === 2 ? id : null };
    }
    return {
      mode: 'fnaf4', night: this.night, running: this.running, dead: this.dead, won: this.won, scare: this.scare, deathReason: this.deathReason,
      hour: this.hour, elapsed: this.elapsed, progress: Math.min(1, this.elapsed / (6 * this.secondsPerHour)),
      secondsPerHour: this.secondsPerHour,
      facing: this.facing, holding: this.holding,
      holdProgress: this.holding ? doors[this.facing].holdProgress : 0,
      flashlight: { on: this.flash },
      doors, characters: chars,
      small: { names: [...this.small.present], count: this.small.present.length, rule: this.rule, level: this.level('small'), swarm: this.small.swarm },
      audioCues: this.audioCues(),
      heat: this.heat, nightmare: this.nightmare, multiplier: this.mult,
    };
  }
}

export default Fnaf4Mode;
