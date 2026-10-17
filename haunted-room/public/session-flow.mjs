// session-flow.mjs — pure wiring logic for the FNAF-style loop. No THREE, no
// DOM, fully Node-testable. app.mjs owns the meshes/audio; this module owns the
// decisions: which zone an entity is in, whether the monitor counts as
// "watching" it, how a jumpscare is sequenced, how a blackout unfolds, and the
// derived-values-only session stats.
//
// Comfort/safety invariants encoded here:
//   * A scare never asks for camera motion (there is no such action type).
//   * At most ONE cut-to-dark per scare (the telegraph), none for blackout scares
//     (the room is already dark).

import { isObserved } from "./haunt.mjs";

/* ------------------------------ zones ------------------------------ */

// The Attendant's path. Index 0 is its home spot; the coordinator's waypoint
// index and animatronic.waypointIndex both follow it (home + 5 nodes = 6).
export const ATTENDANT_HOME = Object.freeze({ x: -2.6, z: -4.8 });
export const ATTENDANT_PATH = Object.freeze([
  { x: -2.2, z: -3.6 },
  { x: -1.4, z: -2.2 },
  { x: -0.8, z: -0.6 },
  { x: -0.3, z: 0.6 },
  { x: 0, z: 1.2 }, // clamped to the safe radius by the entity itself
]);
export const ATTENDANT_NODE_COUNT = ATTENDANT_PATH.length + 1;

// Which security-camera zone covers each waypoint (monitor.mjs default cams:
// far-corner, doorway, cabinet, rear). Home + first node sit by the cabinet,
// the middle of the room is seen from the far corner, the last two nodes are
// behind/beside the player ("rear").
export const ATTENDANT_ZONES = Object.freeze([
  "cabinet",
  "cabinet",
  "far-corner",
  "far-corner",
  "rear",
  "rear",
]);

export function attendantZone(waypoint) {
  const i = Math.max(0, Math.min(ATTENDANT_ZONES.length - 1, Math.floor(waypoint) || 0));
  return ATTENDANT_ZONES[i];
}

// The ghost spawns in the corridor (z ~ -7, "doorway" cam) and rushes through
// the door line toward the player.
export function ghostZone(z) {
  if (!Number.isFinite(z)) return "doorway";
  if (z < -4.6) return "doorway";
  if (z < 0.5) return "far-corner";
  return "rear";
}

/**
 * Is an entity observed? Direct view cone OR the monitor is up on its zone.
 * `watchedZone` is monitor.getWatchedZone() (null when the console is down,
 * the signal is lost or powered off). Invisible entities cannot be seen.
 */
export function entityObserved({ camObserved, watchedZone, zone, visible = true }) {
  if (!visible) return false;
  if (camObserved === true) return true;
  return watchedZone != null && watchedZone === zone;
}

/** Narrow beam test for the hand-held floodlight. */
export const FLOODLIGHT_HALF_ANGLE = (14 * Math.PI) / 180;
export function floodlightHits(camera, target) {
  return isObserved(camera, target, FLOODLIGHT_HALF_ANGLE);
}

/* ------------------------- jumpscare sequencing ------------------------- */

export const JUMPSCARE_TELEGRAPH = 0.8; // s of silence/darkness before the lunge
export const JUMPSCARE_HOLD = 1.5; // s the lunge stays on screen before the end

export function describeCause(ev) {
  if (!ev) return "Unknown";
  if (ev.kind === "blackout")
    return "The power died. Something was waiting in the dark.";
  if (ev.entity === "ghost")
    return "The ghost charged. You looked away from it for too long.";
  return "The Attendant reached you while you were not watching it.";
}

/**
 * telegraph (duck + one lights-cut beat) -> lunge (entity pose + stinger) ->
 * end the session. Feed it the haunt "jumpscare" event, then update(dt) each
 * frame; it returns actions for app.mjs to apply. Strictly one scare per run.
 */
export class JumpscareFlow {
  constructor({ telegraph = JUMPSCARE_TELEGRAPH, hold = JUMPSCARE_HOLD } = {}) {
    this.telegraph = telegraph;
    this.hold = hold;
    this.reset();
  }
  reset() {
    this.phase = "idle"; // idle | telegraph | lunge | done
    this.t = 0;
    this.event = null;
  }
  get active() {
    return this.phase === "telegraph" || this.phase === "lunge";
  }
  trigger(ev) {
    if (this.phase !== "idle" || !ev) return [];
    this.event = { entity: ev.entity, kind: ev.kind };
    this.phase = "telegraph";
    this.t = 0;
    const actions = [{ type: "duck", seconds: this.telegraph }];
    if (ev.kind !== "blackout") actions.push({ type: "lightsCut", seconds: this.telegraph });
    return actions;
  }
  update(dt) {
    if (!this.active) return [];
    this.t += Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    const out = [];
    if (this.phase === "telegraph" && this.t >= this.telegraph) {
      this.phase = "lunge";
      this.t = 0;
      out.push({ type: "lunge", ...this.event }, { type: "stinger", entity: this.event.entity });
    } else if (this.phase === "lunge" && this.t >= this.hold) {
      this.phase = "done";
      out.push({ type: "end", cause: describeCause(this.event), ...this.event });
    }
    return out;
  }
}

/* --------------------------- blackout timeline --------------------------- */

export const BLACKOUT_BEATS = Object.freeze({ musicBox: 3, eyes: 8 });
// The haunt coordinator fires its blackout jumpscare this long after `eyes`
// (it counts from haunt.notify("blackout")): 8 + 5 = 13 s after the grid dies.
export const BLACKOUT_SCARE_DELAY = 5;

export class BlackoutTimeline {
  constructor(beats = BLACKOUT_BEATS) {
    this.beats = beats;
    this.reset();
  }
  reset() {
    this.fired = new Set();
  }
  /** blackout: bool, elapsed: seconds since blackout. Returns newly crossed beats. */
  step(blackout, elapsed) {
    const out = [];
    if (!blackout) return out;
    const fire = (name) => {
      if (!this.fired.has(name)) {
        this.fired.add(name);
        out.push(name);
      }
    };
    fire("dark");
    if (elapsed >= this.beats.musicBox) fire("musicBox");
    if (elapsed >= this.beats.eyes) fire("eyes");
    return out;
  }
}

/* ------------------------------ power helpers ------------------------------ */

export function powerTier(percent, blackout = false) {
  if (blackout || percent <= 0) return "out";
  if (percent <= 10) return "critical";
  if (percent <= 20) return "warning";
  return "ok";
}

/** "~1:24" estimate capped at what is left of the session. */
export function formatEta(secondsRemaining, sessionRemaining, scale = 1) {
  if (!Number.isFinite(secondsRemaining)) return "steady";
  const real = secondsRemaining / Math.max(1e-6, scale); // power sec -> session sec
  const capped = Math.min(real, Math.max(0, sessionRemaining));
  const s = Math.max(0, Math.round(capped));
  const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return real > sessionRemaining ? `lasts (${label})` : `~${label}`;
}

/* ------------------------------ difficulty ------------------------------ */

export const DIFFICULTY = Object.freeze({
  easy: { label: "Easy", ai: 2 },
  normal: { label: "Normal", ai: 5 },
  nightmare: { label: "Nightmare", ai: 14 },
});

export function clampAi(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(20, Math.round(n))) : 5;
}

/** Which named preset matches an AI level (or "custom"). */
export function difficultyFor(ai) {
  for (const [k, v] of Object.entries(DIFFICULTY)) if (v.ai === clampAi(ai)) return k;
  return "custom";
}

/* ---------------------------- session statistics ---------------------------- */

// Derived values only. Never stores raw sensor data.
export class SessionStats {
  constructor() {
    this.reset();
  }
  reset() {
    this.moves = { attendant: 0, ghost: 0 };
    this.jumpscare = null; // {entity, kind, atElapsed, cause}
    this.monitorSeconds = 0;
    this.floodlightSeconds = 0;
    this.cameraSwitches = 0;
    this.staticBursts = 0;
    this.blackoutAt = null;
    this.powerAtEnd = null;
    this.activeSeconds = 0;
    this.ai = null;
  }
  tick(dt, { monitorUp, floodlightOn }) {
    if (!(dt > 0)) return;
    this.activeSeconds += dt;
    if (monitorUp) this.monitorSeconds += dt;
    if (floodlightOn) this.floodlightSeconds += dt;
  }
  noteMove(entity) {
    if (entity in this.moves) this.moves[entity] += 1;
  }
  noteJumpscare(ev, elapsed) {
    this.jumpscare = {
      entity: ev.entity,
      kind: ev.kind,
      atElapsed: Math.round(elapsed * 10) / 10,
      cause: describeCause(ev),
    };
  }
  toJSON(powerPercent = this.powerAtEnd) {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      endedBy: this.jumpscare ? "caught" : "completed-or-reset",
      jumpscare: this.jumpscare,
      entityMoves: { ...this.moves },
      powerAtEndPercent: powerPercent,
      blackoutAtElapsed: this.blackoutAt == null ? null : r1(this.blackoutAt),
      cameraUptimeSeconds: r1(this.monitorSeconds),
      cameraUptimePercent:
        this.activeSeconds > 0 ? Math.round((this.monitorSeconds / this.activeSeconds) * 100) : 0,
      floodlightSeconds: r1(this.floodlightSeconds),
      cameraSwitches: this.cameraSwitches,
      aiLevel: this.ai,
    };
  }
}
