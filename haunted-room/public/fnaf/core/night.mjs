// FnafNight: pure FNAF-1 rules engine. No THREE/DOM. Deterministic given rng + dt.
import {
  CHARACTERS, MOVE_INTERVAL, ROUTES, DOOR_ROOM, DOOR_SIDE, RETREAT_ROOM, RATCHET, OFFICE_WAIT_CAP,
  DRAIN_INTERVAL, PASSIVE_DRAIN, POWER_WARN_LEVELS, POWER_OUT, JINGLE, JINGLE_BPM, jingleSeconds,
  NIGHT_AI, PHONE_SECONDS, SECONDS_PER_HOUR, CLASSIC_SPH, NIGHT_HOURS, HOUR_LABELS, CAMERAS,
  AUDIO_ONLY_CAMERAS, clampAi,
} from './data.mjs';

const HALL_ROOMS = new Set(['hall-west','hall-west-corner','hall-east','hall-east-corner']);
const DEFAULT_INPUT = { doors: { left: false, right: false }, lights: { left: false, right: false }, monitorUp: false, cameraRoom: null };

export class FnafNight {
  constructor({ night = 1, rng = Math.random, now = () => 0, secondsPerHour = 'classic', ai = null } = {}) {
    this.night = night === 7 ? 'custom' : night;
    if (this.night !== 'custom' && !(Number.isInteger(this.night) && this.night >= 1 && this.night <= 6)) {
      throw new RangeError('night must be 1-6 or "custom"');
    }
    this.rng = rng; this.now = now;
    this.sph = typeof secondsPerHour === 'string' ? SECONDS_PER_HOUR[secondsPerHour] : secondsPerHour;
    if (!(this.sph > 0)) throw new RangeError('secondsPerHour must be > 0 or a preset name');
    this.scale = CLASSIC_SPH / this.sph; // real dt -> classic-second game time (all timers/power scale; short is denser)
    const table = NIGHT_AI[this.night];
    this.base = { maestro: 0, bellwether: 0, lark: 0, ratchet: 0, ...(table ? table.base : {}) };
    this.wake = table ? table.wake : {};
    this.overridden = new Set();
    if (ai) for (const [k, v] of Object.entries(ai)) if (CHARACTERS.includes(k)) { this.base[k] = clampAi(v); this.overridden.add(k); }
    this.multiplier = 1;
    this.reset();
  }

  reset() {
    this.state = 'idle'; // idle | running | power-out | won | dead
    this.clock = 0; this.hourSeen = 0; this.gtime = 0;
    this.power = 100; this.warned = new Set();
    this.events = [];
    this.input = JSON.parse(JSON.stringify(DEFAULT_INPUT));
    this.chars = {};
    for (const c of CHARACTERS) this.chars[c] = { room: 'showstage', timer: 0, inOffice: false, wait: 0 };
    this.chars.ratchet.room = 'cove';
    Object.assign(this.chars.ratchet, { stage: 0, running: false, runTimer: 0, freeze: 0, watched: false, bangs: 0 });
    this.po = null; this.killer = null;
    this.phone = { playing: false, left: 0 };
    this.lightSeen = { left: false, right: false };
    this.prevLights = { left: false, right: false };
  }

  setAiLevelMultiplier(x) { this.multiplier = Number.isFinite(x) ? Math.max(0, x) : 1; }
  setAiLevel(who, n) { if (CHARACTERS.includes(who)) { this.base[who] = clampAi(n); this.overridden.add(who); } }
  aiLevel(who) { return clampAi(this.base[who] * this.multiplier); }

  start() {
    if (this.state !== 'idle') return;
    this.state = 'running';
    if (PHONE_SECONDS[this.night]) {
      this.phone = { playing: true, left: PHONE_SECONDS[this.night] };
      this._emit('phone-call-start', { night: this.night });
    }
    this._applyWake(0);
  }

  muteCall() { if (this.phone.playing) { this.phone.playing = false; this._emit('phone-call-end', { night: this.night, muted: true }); } }

  consumeEvents() { const e = this.events; this.events = []; return e; }

  _emit(type, data = {}) { this.events.push({ type, t: this.clock * NIGHT_HOURS, ts: this.now(), ...data }); }
  _cue(name, data = {}) { this._emit('cue', { name, ...data }); }
  _roll() { return Math.floor(this.rng() * 21); }
  _between(a, b) { return a + this.rng() * (b - a); }

  _applyWake(hour) {
    for (const [who, sched] of Object.entries(this.wake)) {
      if (sched[hour] !== undefined && !this.overridden.has(who)) this.base[who] = clampAi(sched[hour]);
    }
  }

  _normInput(input) {
    const i = input || {};
    const d = i.doors || {}, l = i.lights || {};
    const doors = { left: !!d.left, right: !!d.right };
    const dead = this.state === 'power-out';
    const out = {
      doors: dead ? { left: false, right: false } : doors,
      lights: { left: !dead && !doors.left && !!l.left, right: !dead && !doors.right && !!l.right },
      monitorUp: !dead && !!i.monitorUp,
      cameraRoom: i.cameraRoom ?? null,
    };
    return out;
  }

  usage() {
    if (this.state === 'power-out') return 0;
    const i = this.input;
    return 1 + (i.doors.left ? 1 : 0) + (i.doors.right ? 1 : 0) + (i.lights.left ? 1 : 0) + (i.lights.right ? 1 : 0) + (i.monitorUp ? 1 : 0);
  }

  update(dt, input) {
    if (!(dt > 0) || (this.state !== 'running' && this.state !== 'power-out')) return;
    this.input = this._normInput(input);
    this.clock += dt / (this.sph * NIGHT_HOURS);
    let g = dt * this.scale; this.gtime += g;
    // hours
    const hour = Math.min(NIGHT_HOURS, Math.floor(this.clock * NIGHT_HOURS + 1e-9));
    while (this.hourSeen < hour) { this.hourSeen++; this._emit('hour', { n: this.hourSeen }); this._applyWake(this.hourSeen); }
    if (this.clock >= 1) { this.clock = 1; this.state = 'won'; this.phone.playing = false; this._emit('night-win', { night: this.night }); return; }
    // phone
    if (this.phone.playing) { this.phone.left -= g; if (this.phone.left <= 0) { this.phone.playing = false; this._emit('phone-call-end', { night: this.night, muted: false }); } }
    if (this.state === 'power-out') { this._updatePowerOut(g); return; }
    this._updatePower(g);
    if (this.state !== 'running') return;
    this._updateLights();
    this._ratchet(g);
    if (this.state !== 'running') return;
    this._walkers(g);
    this._officeWaiters(g);
    if (this.power <= 0 && this.state === 'running') this._startPowerOut();
  }

  _updatePower(g) {
    const u = this.usage();
    let loss = g / DRAIN_INTERVAL[u - 1];
    const passive = PASSIVE_DRAIN[this.night];
    if (passive > 0) loss += g / passive;
    this.power = Math.max(0, this.power - loss);
    this._checkPower();
  }
  _checkPower() {
    for (const lv of POWER_WARN_LEVELS) if (this.power <= lv && this.power > 0 && !this.warned.has(lv)) { this.warned.add(lv); this._emit('power-warning', { level: lv }); }
    if (this.power <= 0 && this.state === 'running') this._startPowerOut();
  }

  _updateLights() {
    for (const side of ['left', 'right']) {
      const on = this.input.lights[side];
      if (on) {
        const present = CHARACTERS.find((c) => this.chars[c].room === (side === 'left' ? 'hall-west-corner' : 'hall-east-corner') && c !== 'ratchet');
        const key = present || null;
        if (key && (!this.prevLights[side] || this.lightSeen[side] !== key)) this._cue('door-presence', { who: key, room: this.chars[key].room, side });
        this.lightSeen[side] = key;
      } else this.lightSeen[side] = false;
      this.prevLights[side] = on;
    }
  }

  _watching(room) { return this.input.monitorUp && this.input.cameraRoom === room && !AUDIO_ONLY_CAMERAS.includes(room); }

  _move(who, to) {
    const c = this.chars[who]; const from = c.room; c.room = to;
    this._emit('move', { who, from, to });
    if (this.input.monitorUp && (this.input.cameraRoom === from || this.input.cameraRoom === to) && !AUDIO_ONLY_CAMERAS.includes(this.input.cameraRoom)) this._emit('static', { room: this.input.cameraRoom });
    if (HALL_ROOMS.has(to) && who !== 'ratchet') this._cue('footstep', { who, room: to });
    if (who === 'maestro') this._cue('laugh', { who, room: to });
  }

  _occupied(room, except) {
    if (room === 'showstage') return false;
    return CHARACTERS.some((c) => c !== except && this.chars[c].room === room);
  }

  _jumpscare(who) {
    if (this.state === 'dead') return;
    this.state = 'dead'; this.killer = who; this.phone.playing = false;
    this._emit('jumpscare', { who });
  }

  _ratchet(g) {
    const c = this.chars.ratchet;
    const watched = this._watching('cove');
    if (watched && !c.watched) c.freeze = this._between(RATCHET.freezeMin, RATCHET.freezeMax);
    c.watched = watched;
    if (c.freeze > 0) c.freeze -= g;
    if (c.running) {
      c.runTimer -= g;
      if (c.runTimer <= 0) this._ratchetArrive();
      return;
    }
    c.timer += g;
    while (c.timer >= MOVE_INTERVAL.ratchet && !c.running) {
      c.timer -= MOVE_INTERVAL.ratchet;
      if (watched || c.freeze > 0) continue;
      const ai = this.aiLevel('ratchet');
      if (!(ai > 0 && this._roll() <= ai)) continue;
      if (c.stage < RATCHET.stages) { c.stage++; this._cue('cove-stage', { who: 'ratchet', room: 'cove', stage: c.stage }); }
      else { c.stage = 4; c.running = true; c.runTimer = RATCHET.runSeconds; this._move('ratchet', 'hall-west'); this._cue('run', { who: 'ratchet', room: 'hall-west' }); }
    }
  }

  _ratchetArrive() {
    const c = this.chars.ratchet;
    c.running = false;
    if (this.input.doors.left) {
      const loss = RATCHET.bangBase + RATCHET.bangStep * c.bangs; c.bangs++;
      this._emit('door-knock', { who: 'ratchet', side: 'left', powerLoss: loss });
      this.power = Math.max(0, this.power - loss);
      c.stage = 1 + (this.rng() < 0.5 ? 0 : 1); c.timer = 0;
      this._move('ratchet', 'cove');
      this._checkPower();
    } else this._jumpscare('ratchet');
  }

  _walkers(g) {
    for (const who of ['bellwether', 'lark', 'maestro']) {
      const c = this.chars[who];
      if (c.inOffice) continue;
      c.timer += g;
      while (c.timer >= MOVE_INTERVAL[who] && this.state === 'running') {
        c.timer -= MOVE_INTERVAL[who];
        // maestro only acts while monitor is down or his camera isn't selected
        if (who === 'maestro' && this._watching(c.room)) continue;
        if (who === 'lark' && c.room === 'kitchen') this._cue('kitchen-noise', { who, room: 'kitchen' });
        const ai = this.aiLevel(who);
        if (!(ai > 0 && this._roll() <= ai)) continue;
        if (c.room === DOOR_ROOM[who]) this._doorAttempt(who);
        else this._step(who);
        if (c.inOffice) break;
      }
    }
  }

  _step(who) {
    const c = this.chars[who];
    const options = (ROUTES[who][c.room] || []).filter((r) => !this._occupied(r, who));
    if (!options.length) return;
    this._move(who, options[Math.min(options.length - 1, Math.floor(this.rng() * options.length))]);
  }

  _doorAttempt(who) {
    const c = this.chars[who];
    if (this.input.doors[DOOR_SIDE[who]]) { this._move(who, RETREAT_ROOM[who]); return; }
    this._move(who, 'office'); c.inOffice = true; c.wait = 0;
    this._cue('office-entry', { who });
  }

  _officeWaiters(g) {
    for (const who of ['bellwether', 'lark', 'maestro']) {
      const c = this.chars[who];
      if (!c.inOffice) continue;
      c.wait += g;
      if (!this.input.monitorUp || c.wait >= OFFICE_WAIT_CAP) { this._jumpscare(who); return; }
    }
  }

  _startPowerOut() {
    this.state = 'power-out'; this.input = this._normInput(this.input);
    this._emit('power-out', {});
    this.phone.playing = false;
    this.po = { phase: 'approach', t: 0, dur: this._between(POWER_OUT.approachMin, POWER_OUT.approachMax), note: 0, noteT: 0, eyesVisible: false, blink: 0 };
    // power-out maestro leaves any room and heads to the left door in the dark (original: he is at the left door)
    this.chars.maestro.inOffice = false;
    this._cue('powerdown');
  }

  _updatePowerOut(g) {
    const p = this.po; p.t += g;
    if (p.phase === 'approach') {
      if (p.t >= p.dur) {
        p.phase = 'jingle'; p.t = 0; p.dur = jingleSeconds(); p.note = 0; p.noteT = 0;
        this.chars.maestro.room = 'office-door';
        this._cue('jingle-start', { who: 'maestro', bpm: JINGLE_BPM, notes: JINGLE.length });
        this._cue('jingle-note', { who: 'maestro', index: 0, midi: JINGLE[0].midi, beats: JINGLE[0].beats });
      }
      return;
    }
    if (p.phase === 'jingle') {
      p.noteT += g;
      let len = JINGLE[p.note].beats * 60 / JINGLE_BPM;
      while (p.note < JINGLE.length - 1 && p.noteT >= len) {
        p.noteT -= len; p.note++; len = JINGLE[p.note].beats * 60 / JINGLE_BPM;
        this._cue('jingle-note', { who: 'maestro', index: p.note, midi: JINGLE[p.note].midi, beats: JINGLE[p.note].beats });
      }
      if (p.t >= p.dur) { p.phase = 'eyes'; p.t = 0; p.dur = POWER_OUT.eyes; p.eyesVisible = true; p.blink = 0; this._cue('eyes', { who: 'maestro', visible: true }); }
      return;
    }
    if (p.phase === 'eyes') {
      p.blink += g;
      if (p.blink >= POWER_OUT.eyeBlink) { p.blink -= POWER_OUT.eyeBlink; p.eyesVisible = !p.eyesVisible; this._cue('eyes', { who: 'maestro', visible: p.eyesVisible }); }
      if (p.t >= p.dur) { p.phase = 'dark'; p.t = 0; p.dur = this._between(POWER_OUT.darkMin, POWER_OUT.darkMax); p.eyesVisible = false; this._cue('dark', { who: 'maestro' }); }
      return;
    }
    if (p.phase === 'dark' && p.t >= p.dur) { p.phase = 'scare'; this._jumpscare('maestro'); }
  }

  snapshot() {
    const chars = {};
    for (const who of CHARACTERS) {
      const c = this.chars[who];
      chars[who] = { room: c.room, ai: this.base[who], effectiveAi: this.aiLevel(who), inOffice: !!c.inOffice };
      if (who === 'ratchet') Object.assign(chars[who], { stage: c.stage, running: c.running, bangs: c.bangs });
    }
    const hour = Math.min(NIGHT_HOURS, Math.floor(this.clock * NIGHT_HOURS + 1e-9));
    const room = this.input.cameraRoom;
    return {
      night: this.night, state: this.state, progress: this.clock, hour, clock: HOUR_LABELS[hour],
      secondsPerHour: this.sph, power: this.power, powerDisplay: Math.ceil(this.power - 1e-9), usage: this.usage(),
      doors: { ...this.input.doors }, lights: { ...this.input.lights }, monitorUp: this.input.monitorUp,
      cameraRoom: room, cameraVideo: !!room && !AUDIO_ONLY_CAMERAS.includes(room) && CAMERAS.includes(room) && this.input.monitorUp,
      characters: chars, multiplier: this.multiplier,
      powerOut: this.po ? { phase: this.po.phase, eyesVisible: this.po.eyesVisible, note: this.po.note } : null,
      phone: { playing: this.phone.playing }, killer: this.killer,
    };
  }
}
