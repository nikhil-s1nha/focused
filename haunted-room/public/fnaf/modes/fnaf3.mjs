// FNAF3-style mode (original characters). Pure logic: no THREE, no DOM.
// Constants are documented in notes/fnaf-modes-2-3.md.

export const C3 = Object.freeze({
  STEP: 0.1, BASE_HOUR: 45, AI_MAX: 20,
  MOVE_INTERVAL: 6,          // stalker opportunity period (ref s)
  TOWARD_BIAS: 0.7,          // chance a successful move heads toward the lobby
  NEAR_TIME: 4.5,            // s stalker waits in a near-vent before the scare
  SEAL_TRAP: 8,              // max seal hold on a section (s)
  SEAL_COOLDOWN: 15,         // per-section cooldown after a seal ends
  POST_TRAP_PAUSE: 10,       // stalker frozen after being released from a trap
  LURE_DURATION: 10, LURE_COOLDOWN: 8,
  FAULT_INTERVAL: 12,        // system fault roll period (ref s)
  FAULT_MAX_ACTIVE: 2,
  REBOOT: { audio: 5, camera: 7, vent: 8 },
  VENT_FAIL: 30,             // s of ignored vent fault -> forced scare
  VENT_RECOVER: 0.1,         // drain fraction/s recovered when vent OK
  TEMP_FAULT: 20,            // phantom-induced faults auto-clear after (s)
  PHANTOM_INTERVAL: 14, PHANTOM_JITTER: 10, PHANTOM_MAX_ACTIVE: 2,
  PHANTOM_DEADLINE_CAM: 8, PHANTOM_DEADLINE_OFFICE: 6,
  PHANTOM_STRIKES: 3,
  CALL_START: 2, CALL_LEN: 25,
});

export const ROOMS3 = {
  cellar: ['hall1'],
  hall1: ['cellar', 'hall2', 'kitchen'],
  kitchen: ['hall1', 'storage'],
  hall2: ['hall1', 'storage', 'arcade'],
  arcade: ['hall2', 'lobby'],
  storage: ['hall2', 'kitchen', 'lobby'],
  lobby: ['storage', 'arcade', 'ventA-far', 'ventB-far', 'ventC-far'],
  'ventA-far': ['lobby', 'ventA-near'], 'ventA-near': ['ventA-far'],
  'ventB-far': ['lobby', 'ventB-near'], 'ventB-near': ['ventB-far'],
  'ventC-far': ['lobby', 'ventC-near'], 'ventC-near': ['ventC-far'],
};
export const CAMS3 = ['cellar', 'hall1', 'kitchen', 'hall2', 'arcade', 'storage', 'lobby'];
export const LURE_ROOMS = CAMS3.filter((r) => r !== 'lobby' || true);
export const SECTIONS = ['A', 'B', 'C'];
export const SYSTEMS = ['audio', 'camera', 'vent'];
export const PHANTOMS = ['cinderling', 'lanternhead', 'mothlady', 'hollow-jester', 'marrowbird'];
export const WHO3 = ['stalker', 'phantoms', 'faults'];

// levels per night 1..5
const NIGHT = { stalker: [3, 5, 8, 11, 14], phantoms: [3, 5, 7, 10, 13], faults: [2, 4, 6, 9, 12] };
const STALKER_NAME = 'scrapjack';

export class Fnaf3Mode {
  constructor({ night = 1, rng = Math.random, now = () => 0, secondsPerHour = 45, ai = null } = {}) {
    this.night = night; this.rng = rng; this.now = now;
    this.secondsPerHour = secondsPerHour; this.k = secondsPerHour / C3.BASE_HOUR; this.mult = 1;
    this.base = {};
    for (const w of WHO3) this.base[w] = (night >= 1 && night <= 5) ? NIGHT[w][night - 1] : 0;
    if (ai) for (const [w, n] of Object.entries(ai)) if (w in this.base) this.base[w] = clamp(n, 0, C3.AI_MAX);
    this.reset();
  }

  reset() {
    this.events = []; this.acc = 0; this.elapsed = 0; this.running = false; this.dead = false; this.won = false;
    this.scare = null; this.hour = 0; this.callState = 0;
    this.camera = false; this.cam = 'lobby';
    this.pos = 'cellar'; this.moveClock = 0; this.nearT = 0; this.pause = 0;
    this.trap = null; // {section, t}
    this.seals = { A: { t: 0, cd: 0 }, B: { t: 0, cd: 0 }, C: { t: 0, cd: 0 } };
    this.lure = null; this.lureCd = 0;
    this.sys = {}; for (const s of SYSTEMS) this.sys[s] = { fault: false, temp: 0 };
    this.rebooting = null; // {system, t}
    this.faultClock = 0; this.drain = 0;
    this.phantoms = []; this.phantomClock = this.nextPhantom(); this.strikes = 0;
    this.prev = { lure: null, seal: null, reboot: null, dismiss: null };
  }

  start() { this.reset(); this.running = true; this.emit({ type: 'hour', hour: 0, label: '12 AM' }); }
  emit(e) { this.events.push(e); }
  consumeEvents() { const e = this.events; this.events = []; return e; }
  setAiLevelMultiplier(x) { this.mult = Math.max(0, Number(x) || 0); }
  setAiLevel(who, n) { if (who in this.base) this.base[who] = clamp(Number(n) || 0, 0, C3.AI_MAX); }
  level(w) { return Math.min(C3.AI_MAX, Math.round(this.base[w] * this.mult)); }
  nextPhantom() { return (C3.PHANTOM_INTERVAL + this.rng() * C3.PHANTOM_JITTER) * this.k; }

  update(dt, input = {}) {
    if (!this.running || this.dead || this.won) return;
    this.acc += Math.max(0, dt);
    let first = true;
    while (this.acc >= C3.STEP - 1e-9 && this.running && !this.dead && !this.won) {
      this.acc -= C3.STEP;
      this.step(C3.STEP, input, first); first = false;
    }
  }

  step(dt, input, first) {
    this.elapsed += dt;
    const cam = !!input.camera;
    if (cam !== this.camera) { this.camera = cam; this.emit({ type: 'cue', id: cam ? 'camera-up' : 'camera-down' }); if (cam && !this.sys.camera.fault) this.emit({ type: 'static', intensity: 0.4 }); }
    if (input.cam && CAMS3.includes(input.cam)) this.cam = input.cam;

    // edge-triggered actions (act when the value changes to a non-null value)
    const p = this.prev;
    if (input.reboot && input.reboot !== p.reboot) this.requestReboot(input.reboot);
    if (input.seal && input.seal !== p.seal) this.requestSeal(input.seal);
    if (input.lure && input.lure !== p.lure) this.requestLure(input.lure);
    if (input.dismiss && input.dismiss !== p.dismiss) this.requestDismiss(input.dismiss);
    p.reboot = input.reboot || null; p.seal = input.seal || null; p.lure = input.lure || null; p.dismiss = input.dismiss || null;

    this.phone();
    this.tickReboot(dt);
    this.tickSeals(dt);
    this.tickLure(dt);
    this.tickFaults(dt);
    this.tickPhantoms(dt);
    this.tickStalker(dt);
    this.hours();
  }

  phone() {
    if (this.night < 1 || this.night > 5) return;
    if (this.callState === 0 && this.elapsed >= C3.CALL_START) { this.callState = 1; this.emit({ type: 'phone-call-start', id: `night${this.night}` }); }
    else if (this.callState === 1 && this.elapsed >= C3.CALL_START + C3.CALL_LEN) { this.callState = 2; this.emit({ type: 'phone-call-end', id: `night${this.night}` }); }
  }

  // ---- systems -----------------------------------------------------------
  setFault(system, temp = 0) {
    const s = this.sys[system];
    if (s.fault) return false;
    s.fault = true; s.temp = temp;
    this.emit({ type: 'cue', id: 'system-fault', system });
    return true;
  }
  clearFault(system) { this.sys[system].fault = false; this.sys[system].temp = 0; this.emit({ type: 'cue', id: 'system-ok', system }); }

  requestReboot(system) {
    if (!SYSTEMS.includes(system)) return;
    if (this.rebooting) { this.emit({ type: 'cue', id: 'reboot-blocked', system, busy: this.rebooting.system }); return; }
    if (!this.sys[system].fault) return;
    this.rebooting = { system, t: C3.REBOOT[system] };
    this.emit({ type: 'cue', id: 'reboot-start', system });
  }
  tickReboot(dt) {
    if (!this.rebooting) return;
    this.rebooting.t -= dt;
    if (this.rebooting.t <= 0) { const s = this.rebooting.system; this.rebooting = null; this.clearFault(s); this.emit({ type: 'cue', id: 'reboot-done', system: s }); }
  }
  tickFaults(dt) {
    for (const s of SYSTEMS) {
      const st = this.sys[s];
      if (st.fault && st.temp > 0) { st.temp -= dt; if (st.temp <= 0 && !(this.rebooting && this.rebooting.system === s)) this.clearFault(s); }
    }
    const lvl = this.level('faults');
    this.faultClock += dt;
    const iv = C3.FAULT_INTERVAL * this.k;
    if (this.faultClock >= iv) {
      this.faultClock -= iv;
      const active = SYSTEMS.filter((s) => this.sys[s].fault).length;
      if (lvl > 0 && active < C3.FAULT_MAX_ACTIVE && Math.floor(this.rng() * C3.AI_MAX) + 1 <= lvl) {
        const ok = SYSTEMS.filter((s) => !this.sys[s].fault);
        if (ok.length) this.setFault(ok[Math.floor(this.rng() * ok.length) % ok.length]);
      }
    }
    // ventilation fault: drain/blur -> forced scare
    if (this.sys.vent.fault) {
      this.drain = Math.min(1, this.drain + dt / C3.VENT_FAIL);
      if (this.drain >= 1) this.jumpscare(STALKER_NAME, 'ventilation');
    } else this.drain = Math.max(0, this.drain - C3.VENT_RECOVER * dt);
  }

  // ---- seals -------------------------------------------------------------
  requestSeal(sec) {
    if (!SECTIONS.includes(sec)) return;
    const s = this.seals[sec];
    if (s.t > 0 || s.cd > 0) { this.emit({ type: 'cue', id: 'seal-unavailable', section: sec }); return; }
    s.t = C3.SEAL_TRAP;
    this.emit({ type: 'cue', id: 'seal-on', section: sec });
  }
  tickSeals(dt) {
    for (const sec of SECTIONS) {
      const s = this.seals[sec];
      if (s.t > 0) {
        s.t -= dt;
        if (s.t <= 0) { s.t = 0; s.cd = C3.SEAL_COOLDOWN; this.emit({ type: 'cue', id: 'seal-off', section: sec }); this.release(sec); }
      } else if (s.cd > 0) s.cd = Math.max(0, s.cd - dt);
    }
  }
  release(sec) {
    if (this.trap && this.trap.section === sec) {
      const from = this.pos; this.pos = 'lobby'; this.trap = null; this.nearT = 0; this.pause = C3.POST_TRAP_PAUSE;
      this.emit({ type: 'move', who: STALKER_NAME, from, to: 'lobby', reason: 'released' });
    }
  }
  sectionOf(pos) { const m = /^vent([ABC])-/.exec(pos); return m ? m[1] : null; }

  // ---- audio lure --------------------------------------------------------
  requestLure(room) {
    if (!CAMS3.includes(room)) return;
    if (this.sys.audio.fault || this.rebooting?.system === 'audio') { this.emit({ type: 'cue', id: 'lure-failed', room }); return; }
    if (this.lureCd > 0) { this.emit({ type: 'cue', id: 'lure-cooldown', room }); return; }
    this.lure = { room, t: C3.LURE_DURATION }; this.lureCd = C3.LURE_COOLDOWN + C3.LURE_DURATION;
    this.emit({ type: 'cue', id: 'lure', room });
  }
  tickLure(dt) {
    if (this.lureCd > 0) this.lureCd = Math.max(0, this.lureCd - dt);
    if (this.lure) { this.lure.t -= dt; if (this.lure.t <= 0) this.lure = null; }
  }

  // ---- stalker -----------------------------------------------------------
  tickStalker(dt) {
    const lvl = this.level('stalker');
    if (lvl <= 0) return;
    const sec = this.sectionOf(this.pos);
    // trapped by seal?
    if (sec && this.seals[sec].t > 0 && !this.trap) {
      this.trap = { section: sec }; this.nearT = 0;
      this.emit({ type: 'cue', id: 'trapped', section: sec, pos: this.pos });
    }
    if (this.trap) return;
    if (this.pause > 0) { this.pause = Math.max(0, this.pause - dt); return; }
    if (this.pos.endsWith('-near')) {
      this.nearT += dt;
      if (this.nearT >= C3.NEAR_TIME) this.jumpscare(STALKER_NAME, 'vent');
      return;
    }
    this.moveClock += dt;
    const iv = C3.MOVE_INTERVAL * this.k;
    if (this.moveClock < iv) return;
    this.moveClock -= iv;
    const lured = this.lure && this.pos !== this.lure.room;
    if (!lured && Math.floor(this.rng() * C3.AI_MAX) + 1 > lvl) return;
    let to;
    if (lured) to = this.stepToward(this.pos, this.lure.room);
    else if (this.lure && this.pos === this.lure.room) return; // lingering at the sound
    else to = this.wander(this.pos);
    if (!to || to === this.pos) return;
    const from = this.pos; this.pos = to; this.nearT = 0;
    this.emit({ type: 'move', who: STALKER_NAME, from, to, lured: !!lured });
  }
  neighbours(r) { return ROOMS3[r] || []; }
  stepToward(from, target) {
    const prev = new Map([[from, null]]); const q = [from];
    while (q.length) {
      const c = q.shift();
      if (c === target) break;
      for (const n of this.neighbours(c)) if (!prev.has(n)) { prev.set(n, c); q.push(n); }
    }
    if (!prev.has(target)) return from;
    let c = target; while (prev.get(c) !== from && prev.get(c) !== null) c = prev.get(c);
    return c;
  }
  dist(from, target) { return this.pathLen(from, target); }
  pathLen(from, target) {
    const d = new Map([[from, 0]]); const q = [from];
    while (q.length) { const c = q.shift(); if (c === target) return d.get(c); for (const n of this.neighbours(c)) if (!d.has(n)) { d.set(n, d.get(c) + 1); q.push(n); } }
    return Infinity;
  }
  wander(from) {
    const ns = this.neighbours(from);
    // in the lobby, pick a vent section deterministically from rng
    if (from === 'lobby') {
      const open = ns.filter((n) => n.startsWith('vent'));
      return open[Math.floor(this.rng() * open.length) % open.length];
    }
    if (from.endsWith('-far')) return from.replace('-far', '-near');
    const toward = this.rng() < C3.TOWARD_BIAS;
    if (toward) return this.stepToward(from, 'lobby');
    return ns[Math.floor(this.rng() * ns.length) % ns.length];
  }

  // ---- phantoms ----------------------------------------------------------
  tickPhantoms(dt) {
    const lvl = this.level('phantoms');
    for (const ph of [...this.phantoms]) {
      ph.t -= dt;
      if (ph.t <= 0) this.phantomExpired(ph);
      if (this.dead) return;
    }
    if (lvl <= 0) return;
    this.phantomClock -= dt;
    if (this.phantomClock > 0) return;
    this.phantomClock = this.nextPhantom();
    if (this.phantoms.length >= C3.PHANTOM_MAX_ACTIVE) return;
    if (Math.floor(this.rng() * C3.AI_MAX) + 1 > lvl) return;
    const free = PHANTOMS.filter((id) => !this.phantoms.some((p) => p.id === id));
    const id = free[Math.floor(this.rng() * free.length) % free.length];
    const office = this.rng() < 0.4;
    const location = office ? 'office' : CAMS3[Math.floor(this.rng() * CAMS3.length) % CAMS3.length];
    this.phantoms.push({ id, location, t: office ? C3.PHANTOM_DEADLINE_OFFICE : C3.PHANTOM_DEADLINE_CAM });
    this.emit({ type: 'phantom', action: 'appear', id, location });
  }
  requestDismiss(id) {
    const ph = this.phantoms.find((p) => p.id === id);
    if (!ph) return;
    const seeing = ph.location === 'office' ? !this.camera : (this.camera && this.cam === ph.location && !this.sys.camera.fault);
    if (!seeing) { this.emit({ type: 'cue', id: 'dismiss-failed', phantom: id }); return; }
    this.phantoms = this.phantoms.filter((p) => p !== ph);
    this.emit({ type: 'phantom', action: 'dismiss', id, location: ph.location });
  }
  phantomExpired(ph) {
    this.phantoms = this.phantoms.filter((p) => p !== ph);
    this.emit({ type: 'phantom', action: 'expire', id: ph.id, location: ph.location });
    if (ph.location === 'office') {
      this.strikes++;
      if (this.strikes >= C3.PHANTOM_STRIKES) { this.jumpscare(ph.id, 'phantom'); return; }
    }
    const ok = SYSTEMS.filter((s) => !this.sys[s].fault);
    if (ok.length) this.setFault(ok[Math.floor(this.rng() * ok.length) % ok.length], C3.TEMP_FAULT);
  }

  jumpscare(who, reason) {
    if (this.dead) return;
    this.dead = true; this.running = false; this.scare = who;
    this.emit({ type: 'jumpscare', who, reason });
  }

  hours() {
    const h = Math.min(6, Math.floor(this.elapsed / this.secondsPerHour));
    while (this.hour < h) { this.hour++; this.emit({ type: 'hour', hour: this.hour, label: this.hour === 6 ? '6 AM' : `${this.hour} AM` }); }
    if (this.hour >= 6 && !this.won && !this.dead) { this.won = true; this.running = false; this.emit({ type: 'night-win', night: this.night }); }
  }

  snapshot() {
    const camOk = !this.sys.camera.fault;
    const viewing = this.camera && camOk ? [STALKER_NAME].filter(() => this.pos === this.cam) : [];
    return {
      mode: 'fnaf3', night: this.night, running: this.running, dead: this.dead, won: this.won, scare: this.scare,
      hour: this.hour, elapsed: this.elapsed, progress: Math.min(1, this.elapsed / (6 * this.secondsPerHour)),
      secondsPerHour: this.secondsPerHour,
      camera: this.camera, cam: this.cam, cameraView: viewing,
      stalker: { id: STALKER_NAME, room: this.pos, level: this.level('stalker'), trapped: !!this.trap, trapSection: this.trap?.section ?? null, nearT: this.nearT, paused: this.pause > 0 },
      systems: {
        audio: { fault: this.sys.audio.fault }, camera: { fault: this.sys.camera.fault }, vent: { fault: this.sys.vent.fault },
      },
      reboot: this.rebooting ? { system: this.rebooting.system, remaining: this.rebooting.t } : null,
      ventDrain: this.drain, blur: this.drain,
      seals: { A: { ...this.seals.A }, B: { ...this.seals.B }, C: { ...this.seals.C } },
      lure: this.lure ? { room: this.lure.room, remaining: this.lure.t } : null, lureCooldown: this.lureCd,
      phantoms: this.phantoms.map((p) => ({ ...p })), strikes: this.strikes,
      multiplier: this.mult,
    };
  }
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
export default Fnaf3Mode;
