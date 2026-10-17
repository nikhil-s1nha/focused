// FNAF2-style mode (original characters). Pure logic: no THREE, no DOM.
// Constants are documented in notes/fnaf-modes-2-3.md.

export const C2 = Object.freeze({
  STEP: 0.1,               // fixed sim step (s)
  BASE_HOUR: 45,           // reference seconds/hour for AI cadence scaling
  MOVE_INTERVAL: 5,        // AI movement opportunity period (ref seconds)
  AI_MAX: 20,
  FLASH_DRAIN: 0.9,        // battery %/s while held
  FLASH_REPEL: 2.5,        // s of light on a hall character before it retreats
  WITHERED_REPEL_MULT: 2,
  GRACE_BASE: 3.5,         // office grace before jumpscare if mask off
  GRACE_JITTER: 1.5,
  WITHERED_GRACE_MULT: 0.75,
  MASK_LEAVE: 2.5,         // continuous mask seconds for intruder to leave
  VENT_ENTER: 5,           // s at vent mouth (unlit) before entering office
  VENT_REPEL: 1.5,         // s of vent light before retreat
  WIND_RATE: 0.18,         // box fraction/s while winding
  UNWIND_BASE: 0.006,      // box fraction/s (ref) at ai 0+
  UNWIND_PER_AI: 0.0012,
  PUPPET_GRACE: 8,         // s from empty box to escape jumpscare
  PUPPET_SAFE: 0.15,       // winding above this cancels countdown
  LOW_WARN: 0.25,
  CAMERA_STATIC_COOLDOWN: 1.0,
  CALL_START: 2, CALL_LEN: 25,
});

export const CAMS2 = ['stage', 'party', 'main', 'hall', 'parts', 'ventL-far', 'ventR-far', 'prize'];

const HALL_ROUTE = ['stage', 'party', 'main', 'hall'];
const VL_ROUTE = ['stage', 'parts', 'ventL-far', 'ventL'];
const VR_ROUTE = ['stage', 'parts', 'ventR-far', 'ventR'];

// levels: night 1..6
export const CHARS2 = Object.freeze({
  bramble:   { route: HALL_ROUTE, kind: 'hall', withered: false, levels: [0, 2, 3, 5, 6, 8] },
  pip:       { route: HALL_ROUTE, kind: 'hall', withered: false, levels: [0, 0, 4, 5, 6, 8] },
  cinder:    { route: ['parts', 'main', 'hall'], kind: 'hall', withered: true, levels: [0, 0, 0, 4, 6, 9] },
  quill:     { route: ['parts', 'party', 'hall'], kind: 'hall', withered: true, levels: [0, 0, 2, 3, 5, 8] },
  nimbus:    { route: VL_ROUTE, kind: 'ventL', withered: false, levels: [0, 1, 3, 5, 7, 9] },
  tallow:    { route: ['parts', 'ventL-far', 'ventL'], kind: 'ventL', withered: true, levels: [0, 0, 0, 3, 5, 8] },
  sprocket:  { route: VR_ROUTE, kind: 'ventR', withered: false, levels: [0, 1, 3, 5, 7, 9] },
  wick:      { route: ['parts', 'ventR-far', 'ventR'], kind: 'ventR', withered: true, levels: [0, 0, 0, 3, 5, 8] },
  jackalope: { route: ['prize'], kind: 'puppet', withered: false, levels: [2, 4, 6, 8, 10, 12] },
});
export const WHO2 = Object.keys(CHARS2);

export class Fnaf2Mode {
  constructor({ night = 1, rng = Math.random, now = () => 0, secondsPerHour = 45, ai = null } = {}) {
    this.night = night; this.rng = rng; this.now = now;
    this.secondsPerHour = secondsPerHour;
    this.k = secondsPerHour / C2.BASE_HOUR; // AI cadence scale (<1 = faster)
    this.mult = 1;
    this.base = {};
    for (const [id, c] of Object.entries(CHARS2)) {
      if (night >= 1 && night <= 6) this.base[id] = c.levels[night - 1];
      else this.base[id] = 0; // custom night: only given levels
    }
    if (ai) for (const [id, n] of Object.entries(ai)) if (id in this.base) this.base[id] = clamp(n, 0, C2.AI_MAX);
    this.reset();
  }

  reset() {
    this.events = []; this.acc = 0; this.elapsed = 0; this.running = false;
    this.dead = false; this.won = false; this.scare = null; this.hour = 0;
    this.mask = false; this.camera = false; this.cam = 'stage'; this.flash = false;
    this.battery = 100; this.ventLight = null; this.winding = false;
    this.box = 1; this.escapeIn = null; this.boxState = 'ok';
    this.lastStatic = -99; this.moveClock = 0; this.callState = 0;
    this.ch = {};
    for (const [id, c] of Object.entries(CHARS2)) {
      this.ch[id] = { room: c.route[0], idx: 0, inOffice: false, grace: 0, leave: 0, repel: 0, ventT: 0, ventLit: 0 };
    }
  }

  start() { this.reset(); this.running = true; this.emit({ type: 'hour', hour: 0, label: '12 AM' }); }
  emit(e) { this.events.push(e); }
  consumeEvents() { const e = this.events; this.events = []; return e; }
  setAiLevelMultiplier(x) { this.mult = Math.max(0, Number(x) || 0); }
  setAiLevel(who, n) { if (who in this.base) this.base[who] = clamp(Number(n) || 0, 0, C2.AI_MAX); }
  level(id) { return Math.min(C2.AI_MAX, Math.round(this.base[id] * this.mult)); }

  update(dt, input = {}) {
    if (!this.running || this.dead || this.won) return;
    this.in = input;
    this.acc += Math.max(0, dt);
    while (this.acc >= C2.STEP - 1e-9 && this.running && !this.dead && !this.won) {
      this.acc -= C2.STEP;
      this.step(C2.STEP, input);
    }
  }

  step(dt, input) {
    // --- inputs: mask and camera are mutually exclusive; mask wins.
    const wantMask = !!input.mask;
    const wantCam = !!input.camera && !wantMask;
    if (wantMask !== this.mask) { this.mask = wantMask; this.emit({ type: 'cue', id: wantMask ? 'mask-on' : 'mask-off' }); }
    if (wantCam !== this.camera) {
      this.camera = wantCam;
      this.emit({ type: 'cue', id: wantCam ? 'camera-up' : 'camera-down' });
      if (this.elapsed - this.lastStatic >= C2.CAMERA_STATIC_COOLDOWN) { this.lastStatic = this.elapsed; this.emit({ type: 'static', intensity: 0.5 }); }
    }
    if (input.cam && CAMS2.includes(input.cam)) this.cam = input.cam;
    this.flash = !!input.flashlight && !this.mask && !this.camera && this.battery > 0;
    this.ventLight = (!this.mask && !this.camera && (input.ventLight === 'left' || input.ventLight === 'right')) ? input.ventLight : null;
    this.winding = !!input.windMusicBox && this.camera && this.cam === 'prize';

    this.elapsed += dt;
    if (this.flash) { this.battery = Math.max(0, this.battery - C2.FLASH_DRAIN * dt); if (this.battery === 0) this.emit({ type: 'cue', id: 'flashlight-dead' }); }

    this.phone();
    this.musicBox(dt);
    this.moveClock += dt;
    const interval = C2.MOVE_INTERVAL * this.k;
    if (this.moveClock >= interval) { this.moveClock -= interval; this.opportunities(); }
    this.presence(dt);
    this.hours();
  }

  phone() {
    if (this.night > 6 || this.night < 1) return;
    if (this.callState === 0 && this.elapsed >= C2.CALL_START) { this.callState = 1; this.emit({ type: 'phone-call-start', id: `night${this.night}` }); }
    else if (this.callState === 1 && this.elapsed >= C2.CALL_START + C2.CALL_LEN) { this.callState = 2; this.emit({ type: 'phone-call-end', id: `night${this.night}` }); }
  }

  musicBox(dt) {
    const lvl = this.level('jackalope');
    if (this.winding) this.box = Math.min(1, this.box + C2.WIND_RATE * dt);
    else if (lvl > 0) this.box = Math.max(0, this.box - (C2.UNWIND_BASE + C2.UNWIND_PER_AI * lvl) / this.k * dt);
    let st = 'ok';
    if (this.box <= 0) st = 'empty'; else if (this.box <= C2.LOW_WARN) st = 'low';
    if (st !== this.boxState) { this.boxState = st; if (st !== 'ok') this.emit({ type: 'cue', id: 'musicbox', state: st }); }
    if (this.box <= 0 && this.escapeIn === null) this.escapeIn = C2.PUPPET_GRACE;
    if (this.escapeIn !== null) {
      if (this.box > C2.PUPPET_SAFE) { this.escapeIn = null; this.emit({ type: 'cue', id: 'musicbox', state: 'wound' }); }
      else {
        this.escapeIn -= dt;
        if (this.escapeIn <= 0) { this.ch.jackalope.inOffice = true; this.ch.jackalope.room = 'office'; this.jumpscare('jackalope', 'musicbox'); }
      }
    }
  }

  opportunities() {
    for (const id of WHO2) {
      const def = CHARS2[id], s = this.ch[id], lvl = this.level(id);
      if (def.kind === 'puppet' || lvl <= 0 || s.inOffice || s.ventT > 0) continue;
      const last = def.route.length - 1;
      if (s.idx >= last) continue; // waiting at the final room (hall end / vent mouth)
      // flashlight on the hallway holds back characters about to step into it
      if (def.kind === 'hall' && s.idx === last - 1 && this.flash) continue;
      if (Math.floor(this.rng() * C2.AI_MAX) + 1 <= lvl) {
        const from = s.room; s.idx++; s.room = def.route[s.idx];
        this.emit({ type: 'move', who: id, from, to: s.room });
      }
    }
  }

  presence(dt) {
    for (const id of WHO2) {
      const def = CHARS2[id], s = this.ch[id];
      if (def.kind === 'puppet') continue;
      if (def.kind === 'hall') this.hallLogic(id, def, s, dt);
      else this.ventLogic(id, def, s, dt);
      if (this.dead) return;
      if (s.inOffice) this.officeLogic(id, def, s, dt);
      if (this.dead) return;
    }
  }

  // Hall characters: reaching 'hall' (final room) means standing in the hallway.
  // Flashlight held repels them back; otherwise they enter the office after a delay.
  hallLogic(id, def, s, dt) {
    if (s.inOffice || s.idx < def.route.length - 1) return;
    if (this.flash) {
      s.repel += dt;
      const need = C2.FLASH_REPEL * (def.withered ? C2.WITHERED_REPEL_MULT : 1);
      if (s.repel >= need) { s.repel = 0; s.ventT = 0; this.retreat(id, def, s); }
    } else {
      s.repel = Math.max(0, s.repel - dt);
      s.ventT += dt; // reused as hallway dwell timer
      if (s.ventT >= C2.VENT_ENTER) this.enterOffice(id, def, s);
    }
  }

  ventLogic(id, def, s, dt) {
    if (s.inOffice || s.idx < def.route.length - 1) return;
    const side = def.kind === 'ventL' ? 'left' : 'right';
    if (this.ventLight === side) {
      s.ventLit += dt; s.ventT = Math.max(0, s.ventT - dt);
      if (s.ventLit >= C2.VENT_REPEL) { s.ventLit = 0; s.ventT = 0; this.retreat(id, def, s); }
    } else {
      s.ventLit = 0; s.ventT += dt;
      if (s.ventT >= C2.VENT_ENTER) this.enterOffice(id, def, s);
    }
  }

  retreat(id, def, s) {
    const from = s.room; s.idx = Math.max(0, s.idx - 1); s.room = def.route[s.idx]; s.ventT = 0; s.ventLit = 0;
    this.emit({ type: 'move', who: id, from, to: s.room, reason: 'repelled' });
  }

  enterOffice(id, def, s) {
    const from = s.room;
    s.inOffice = true; s.room = 'office'; s.ventT = 0; s.leave = 0;
    s.grace = (C2.GRACE_BASE + this.rng() * C2.GRACE_JITTER) * (def.withered ? C2.WITHERED_GRACE_MULT : 1);
    this.emit({ type: 'move', who: id, from, to: 'office', via: def.kind });
    this.emit({ type: 'cue', id: 'intruder', who: id });
  }

  officeLogic(id, def, s, dt) {
    if (this.mask) {
      s.leave += dt;
      if (s.leave >= C2.MASK_LEAVE) {
        s.inOffice = false; s.leave = 0; s.ventT = 0; s.idx = 0; s.room = def.route[0];
        this.emit({ type: 'move', who: id, from: 'office', to: s.room, reason: 'left' });
      }
    } else {
      s.leave = 0; s.grace -= dt;
      if (s.grace <= 0) this.jumpscare(id, 'mask-off');
    }
  }

  jumpscare(who, reason) {
    if (this.dead) return;
    this.dead = true; this.running = false; this.scare = who;
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

  snapshot() {
    const chars = {};
    for (const id of WHO2) { const s = this.ch[id]; chars[id] = { room: s.room, level: this.level(id), inOffice: s.inOffice, withered: CHARS2[id].withered, kind: CHARS2[id].kind, grace: s.inOffice ? Math.max(0, s.grace) : 0 }; }
    const view = this.camera ? WHO2.filter((id) => this.ch[id].room === this.cam) : [];
    return {
      mode: 'fnaf2', night: this.night, running: this.running, dead: this.dead, won: this.won, scare: this.scare,
      hour: this.hour, elapsed: this.elapsed, progress: Math.min(1, this.elapsed / (6 * this.secondsPerHour)),
      secondsPerHour: this.secondsPerHour,
      mask: this.mask, camera: this.camera, cam: this.cam,
      flashlight: { on: this.flash, battery: this.battery },
      ventLight: this.ventLight,
      musicbox: { id: 'musicbox', value: this.box, state: this.boxState, winding: this.winding, escapeIn: this.escapeIn },
      characters: chars,
      office: WHO2.filter((id) => this.ch[id].inOffice),
      hall: WHO2.filter((id) => CHARS2[id].kind === 'hall' && this.ch[id].room === 'hall'),
      cameraView: view,
      multiplier: this.mult,
    };
  }
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
export default Fnaf2Mode;
