// fnaf-session.mjs — pure session wrapper around the FNAF engines. No THREE,
// no DOM. It owns one engine instance (FNAF1 night, FNAF2, FNAF3 or FNAF4),
// maps app controls onto that engine's input contract, normalises engine
// events into one canonical shape, and runs the phone-call player.
//
// Canonical events (all carry `kind` and `mode`):
//   jumpscare {who, reason}   move {who, from, to}   cue {id, ...}
//   static {room?, intensity?}   door-knock {who, side, powerLoss?}
//   power-warning {level}   power-out {}   hour {n, label}   win {night}
//   phantom {id, action, location}   eyes {visible}
//   phone-start {id, night}   phone-line {index, text, dur, muted}
//   phone-end {id, reason}

import { FnafNight } from "./fnaf/core/index.mjs";
import Fnaf2Mode from "./fnaf/modes/fnaf2.mjs";
import Fnaf3Mode from "./fnaf/modes/fnaf3.mjs";
import { Fnaf4Mode } from "./fnaf/modes/fnaf4.mjs";
import { PhoneCall } from "./fnaf/phone.mjs";

export const FNAF_MODES = Object.freeze(["fnaf1", "fnaf2", "fnaf3", "fnaf4"]);
export const MODE_LABELS = Object.freeze({
  fnaf1: "Night Shift (FNAF 1 style)",
  fnaf2: "Mask Night (FNAF 2 style)",
  fnaf3: "Vent Night (FNAF 3 style)",
  fnaf4: "The Bedroom (FNAF 4 style)",
});

// Engine character id -> body model used for the on-screen scare. Original
// rigs from world/characters*.mjs; nothing here is a copy of a licensed design.
export const SCARE_MODEL = Object.freeze({
  bellwether: "bellwether",
  lark: "lark",
  ratchet: "ratchet",
  maestro: "maestro",
  bramble: "bellwether",
  pip: "lark",
  cinder: "withered_maestro",
  quill: "withered_songbird",
  nimbus: "ratchet",
  tallow: "withered_hare",
  sprocket: "maestro",
  wick: "stalker",
  jackalope: "marionette",
  scrapjack: "stalker",
  hollowjaw: "bellwether",
  gristle: "ratchet",
  marrow: "maestro",
  sable: "stalker",
  small: "imp_0",
});
export const scareModelFor = (who) => SCARE_MODEL[who] ?? "stalker";

// Keyboard map per mode, shown as a hint bar. Keys are lower-case.
export const KEYMAP = Object.freeze({
  fnaf1: [
    ["Q", "left door"], ["P", "right door"], ["Z", "hold left light"], ["M", "hold right light"],
    ["C", "monitor"], ["[ ]", "camera"], ["E", "use aimed"],
  ],
  fnaf2: [
    ["M", "mask"], ["C", "camera"], ["[ ]", "camera select"], ["F", "hold flashlight"],
    ["W", "hold wind"], ["Q", "left vent light"], ["P", "right vent light"], ["E", "use aimed"],
  ],
  fnaf3: [
    ["C", "camera"], ["[ ]", "camera select"], ["G", "lure (needs audio)"], ["1 2 3", "seal A B C"],
    ["Y U I", "reboot audio camera vent"], ["X", "dismiss phantom"],
  ],
  fnaf4: [
    ["A", "face left"], ["D", "face right"], ["S", "face closet"], ["W", "face hall"],
    ["B", "face bed"], ["Space", "hold door"], ["L", "flashlight"], ["N", "nightlight"],
  ],
});

// Normalise one engine event into the canonical shape. Returns null for
// events the session deliberately drops (the mode's own phone-call-end
// events: PhoneCall governs the call length, see handlePhone).
export function normalizeEvent(mode, ev) {
  if (!ev || typeof ev !== "object") return null;
  const base = { mode };
  switch (ev.type) {
    case "jumpscare":
      return { ...base, kind: "jumpscare", who: ev.who ?? null, reason: ev.reason ?? null };
    case "move":
      return { ...base, kind: "move", who: ev.who ?? null, from: ev.from ?? null, to: ev.to ?? null, reason: ev.reason ?? null };
    case "cue": {
      // FNAF1 engine names cues `name`; the other modes use `id`.
      const id = ev.name ?? ev.id ?? null;
      if (!id) return null;
      return { ...base, kind: "cue", id, ...(ev.room ? { room: ev.room } : {}), ...(ev.who ? { who: ev.who } : {}), ...(ev.door ? { side: ev.door } : {}) };
    }
    case "static":
      return { ...base, kind: "static", room: ev.room ?? null, intensity: ev.intensity ?? null };
    case "door-knock":
      return { ...base, kind: "door-knock", who: ev.who ?? null, side: ev.side ?? null, powerLoss: ev.powerLoss ?? 0 };
    case "power-warning":
      return { ...base, kind: "power-warning", level: ev.level ?? null };
    case "power-out":
      return { ...base, kind: "power-out" };
    case "hour":
      return { ...base, kind: "hour", n: ev.n ?? ev.hour ?? null, label: ev.label ?? null };
    case "night-win":
      return { ...base, kind: "win", night: ev.night ?? null };
    case "phantom":
      return { ...base, kind: "phantom", id: ev.id ?? null, action: ev.action ?? null, location: ev.location ?? null };
    case "eyes":
      return { ...base, kind: "eyes", visible: !!ev.visible };
    case "phone-call-start":
      return { ...base, kind: "phone-start", id: ev.id ?? (ev.night ? `night${ev.night}` : null), night: ev.night ?? null };
    default:
      return null;
  }
}

// Per-mode controls. The app writes these fields; update() maps them onto the
// engine's input each frame. Edge-triggered fields (lure, seal, reboot,
// dismiss) fire once and are cleared after the frame that consumes them.
export function defaultControls() {
  return {
    // FNAF1
    doorL: false, doorR: false, lightL: false, lightR: false, monitor: false, room: "showstage",
    // FNAF2
    mask: false, camera: false, cam: "stage", flashlight: false, wind: false, ventLight: null,
    // FNAF3
    lure: null, seal: null, reboot: null, dismiss: null,
    // FNAF4
    facing: null, hold: false, nightlight: false,
  };
}

export class FnafSession {
  constructor({ mode = "fnaf1", night = 1, rng = Math.random, now = () => 0, secondsPerHour = 45, ai = null } = {}) {
    if (!FNAF_MODES.includes(mode)) throw new Error(`unknown FNAF mode: ${mode}`);
    this.mode = mode;
    this.night = night;
    this.opts = { rng, now, secondsPerHour, ai };
    this.controls = defaultControls();
    this.canonical = [];
    this.phone = null;
    this.reset();
  }

  makeEngine() {
    const { rng, now, secondsPerHour, ai } = this.opts;
    if (this.mode === "fnaf1") {
      const sph = secondsPerHour === 45 ? "classic" : secondsPerHour; // 45 is the shared default
      return new FnafNight({ night: this.night, rng, now, secondsPerHour: sph, ai });
    }
    const Ctor = { fnaf2: Fnaf2Mode, fnaf3: Fnaf3Mode, fnaf4: Fnaf4Mode }[this.mode];
    return new Ctor({ night: this.night, rng, now, secondsPerHour, ai });
  }

  reset() {
    this.engine = this.makeEngine();
    this.canonical = [];
    this.phone?.interrupt?.();
    this.phone = null;
    this.phase = "idle";
    this.controls = defaultControls();
    if (this.mode === "fnaf3") this.controls.cam = "hall1"; // FNAF3 camera rooms
    this.clock = 0;
    this.dead = false;
    this.won = false;
    this.lastScare = null;
  }

  start() {
    if (this.phase !== "idle") return false;
    this.engine.start();
    this.phase = "running";
    this.collect();
    return true;
  }

  // Input for the engine. Pulses are read once, then cleared.
  buildInput() {
    const c = this.controls;
    switch (this.mode) {
      case "fnaf1": {
        const input = {
          doors: { left: c.doorL, right: c.doorR },
          lights: { left: c.lightL, right: c.lightR },
          monitorUp: c.monitor,
          cameraRoom: c.room,
        };
        return input;
      }
      case "fnaf2": {
        const input = {
          mask: c.mask, camera: c.camera, cam: c.cam, flashlight: c.flashlight,
          windMusicBox: c.wind, ventLight: c.ventLight,
        };
        return input;
      }
      case "fnaf3": {
        const input = {
          camera: c.camera, cam: c.cam, lure: c.lure, seal: c.seal, reboot: c.reboot, dismiss: c.dismiss,
        };
        c.lure = c.seal = c.reboot = c.dismiss = null; // edge-triggered
        return input;
      }
      case "fnaf4": {
        return { facing: c.facing, hold: c.hold, flashlight: c.flashlight, nightlight: c.nightlight };
      }
      default:
        return {};
    }
  }

  update(dt) {
    if (this.phase !== "running") {
      this.tickPhone(dt);
      return;
    }
    const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    this.engine.update(step, this.buildInput());
    this.clock += step;
    this.collect();
    this.tickPhone(step);
    const s = this.engine.snapshot();
    // FNAF1 reports `state`; modes 2-4 report booleans. Accept both.
    const dead = s.dead === true || s.state === "dead";
    const won = s.won === true || s.state === "won";
    if (dead) {
      this.dead = true;
      this.phase = "dead";
    } else if (won) {
      this.won = true;
      this.phase = "won";
    }
  }

  collect() {
    for (const e of this.engine.consumeEvents()) {
      if (e.type === "phone-call-end") continue; // PhoneCall owns call length
      const c = normalizeEvent(this.mode, e);
      if (!c) continue;
      if (c.kind === "phone-start") this.startPhone(c.night ?? this.night, c.id, false);
      if (c.kind === "jumpscare") {
        this.lastScare = { who: c.who, reason: c.reason, mode: this.mode, at: this.clock };
        this.interruptPhone();
      }
      this.canonical.push(c);
    }
  }

  // Starts the PhoneCall player. `announce` queues a phone-start event for
  // the scene (sound); collect() passes false because it queues the event itself.
  startPhone(night, id, announce = true) {
    if (this.phone?.snapshot().active) return false;
    this.phone = new PhoneCall({ mode: this.mode, night: Number(night) || 1 });
    this.phone.start();
    if (announce) this.canonical.push({ mode: this.mode, kind: "phone-start", id: id ?? `night${night}`, night: Number(night) || 1 });
    this.collectPhone();
    return true;
  }

  tickPhone(dt) {
    if (!this.phone) return;
    this.phone.update(dt);
    this.collectPhone();
  }

  collectPhone() {
    if (!this.phone) return;
    for (const e of this.phone.consumeEvents()) {
      if (e.type === "phone-call-start") continue;
      this.canonical.push({ mode: this.mode, kind: e.type, ...e });
    }
  }

  // Test-panel and UI helpers that go through the same engine events.
  callPhone(night = this.night) { return this.startPhone(night, null, true); }
  skipPhone() { const r = this.phone?.skip() ?? false; this.collectPhone(); return r; }
  interruptPhone() { const r = this.phone?.interrupt() ?? false; this.collectPhone(); return r; }
  togglePhoneMute() { if (this.phone) this.phone.setMuted(!this.phone.muted); }

  consumeEvents() {
    const out = this.canonical;
    this.canonical = [];
    return out;
  }

  snapshot() {
    const s = this.engine.snapshot();
    return {
      mode: this.mode,
      night: this.night,
      phase: this.phase,
      dead: this.dead,
      won: this.won,
      lastScare: this.lastScare,
      engine: s,
      phone: this.phone ? this.phone.snapshot() : null,
    };
  }
}

// Maps a click on a world item (office button, space prop) onto session
// controls. Pure: the scene calls this and the test suite checks the mapping.
// Returns true when the press changed a control.
export function applyPress(session, id, info = {}) {
  const c = session.controls;
  const toggle = (k) => { c[k] = !c[k]; return true; };
  switch (session.mode) {
    case "fnaf1":
      if (id === "door-left") return toggle("doorL");
      if (id === "door-right") return toggle("doorR");
      if (id === "light-left") return toggle("lightL");
      if (id === "light-right") return toggle("lightR");
      if (id === "monitor") return toggle("monitor");
      if (id === "camera" && info.room) { c.room = info.room; return true; }
      return false;
    case "fnaf2":
      if (id === "mask") return toggle("mask");
      if (id === "monitor") return toggle("camera");
      if (id === "flashlight") return toggle("flashlight");
      if (id === "musicbox") return toggle("wind");
      if (id === "vent-left") { c.ventLight = c.ventLight === "left" ? null : "left"; return true; }
      if (id === "vent-right") { c.ventLight = c.ventLight === "right" ? null : "right"; return true; }
      return false;
    case "fnaf3":
      if (id === "btn-camera") return toggle("camera");
      if (id === "btn-audio") { c.reboot = "audio"; return true; }
      if (id === "btn-vent") { c.reboot = "vent"; return true; }
      if (id === "vent-0") { c.seal = "A"; return true; }
      if (id === "vent-1") { c.seal = "B"; return true; }
      if (id === "vent-2") { c.seal = "C"; return true; }
      if (id === "lure") { c.lure = c.cam; return true; }
      return false;
    case "fnaf4":
      if (id === "door-left") { c.facing = "left"; return true; }
      if (id === "door-right") { c.facing = "right"; return true; }
      if (id === "door-hall") { c.facing = "hall"; return true; }
      if (id === "closet-left" || id === "closet-right") { c.facing = "closet"; return true; }
      if (id === "flashlight") return toggle("flashlight");
      if (id === "nightlight") return toggle("nightlight");
      return false;
    default:
      return false;
  }
}
