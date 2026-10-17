// haunt.mjs — the hunt coordinator. Pure logic, zero THREE dependency, fully
// Node-testable with injected rng/now. Orchestrates the room's entities with
// FNAF-style scare mechanics using the project's ORIGINAL entities (the
// Attendant automaton and the corridor ghost — no third-party characters):
//
//   * Per-entity aggression on a 0..20 scale. Effective aggression escalates
//     with session elapsed time AND director tension.
//   * "Stalker" entities (the Attendant) only accumulate movement opportunity
//     while UNOBSERVED. Every ~tickInterval unobserved seconds they roll
//     rng() < aggression/20; success advances one waypoint toward the player.
//   * "Charger" entities (the ghost) are the opposite threat: being looked at
//     DRAINS them; being ignored builds a charge that ends in a rush.
//   * A stalker that reaches its final waypoint (adjacent to the player) and
//     stays unobserved for a grace window fires a jumpscare. Looking at it
//     resets the grace timer — staring holds it at bay.
//   * RELIEF retreats everyone one step at a time; WAIT (or reset) decays
//     everything fully; a signaled blackout lights the eyes and, if it lasts,
//     fires a jumpscare from whichever entity is furthest along.
//
// The coordinator never moves meshes itself. It emits events that integration
// consumes (consumeEvents) and applies to the THREE-side entity modules
// (animatronic.mjs / ghost.mjs) and the AudioEngine.
//
// Event shapes pushed to the queue:
//   {type:"move",      entity, waypoint, of}        — advance one waypoint
//   {type:"near",      entity}                      — reached final waypoint
//   {type:"stage",     entity, stage, waypoint?}    — "retreat"|"reset"|"manifest"
//   {type:"jumpscare", entity, kind}                — "lunge"|"rush"|"blackout"
//   {type:"cue",       cue, entity?}                — audio hook:
//                       "footstep"|"breath"|"stinger"|"eyes"
//
// VR comfort: this module triggers entity motion, light and sound only. It
// never requests camera motion of any kind.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

export const MAX_AGGRESSION = 20;
export const VIEW_HALF_ANGLE = (55 * Math.PI) / 180;

/* ------------------------- observation cone math ------------------------- */

// World-space forward (-Z) vector of a quaternion {x,y,z,w}.
export function forwardFromQuaternion(q) {
  if (!q) return null;
  const { x, y, z, w } = q;
  if (![x, y, z, w].every(Number.isFinite)) return null;
  // (0,0,-1) rotated by q.
  return {
    x: -(2 * (x * z + w * y)),
    y: -(2 * (y * z - w * x)),
    z: -(1 - 2 * (x * x + y * y)),
  };
}

// Is `target` inside the camera's view cone? `camera` carries position plus
// either an explicit forward vector or a quaternion. Pure and allocation-light
// so it can run per entity per frame and in Node tests. No occlusion test —
// the cone is the FNAF rule.
export function isObserved(camera, target, halfAngle = VIEW_HALF_ANGLE) {
  if (!camera || !camera.position || !target) return false;
  const f =
    camera.forward ?? (camera.quaternion ? forwardFromQuaternion(camera.quaternion) : null);
  if (!f) return false;
  const fl = Math.hypot(num(f.x), num(f.y), num(f.z));
  if (fl < 1e-9) return false;
  const dx = num(target.x) - num(camera.position.x);
  const dy = num(target.y) - num(camera.position.y);
  const dz = num(target.z) - num(camera.position.z);
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-9) return true; // on top of the camera: unquestionably seen
  const cos = (dx * f.x + dy * f.y + dz * f.z) / (d * fl);
  return cos >= Math.cos(clamp(num(halfAngle, VIEW_HALF_ANGLE), 0, Math.PI));
}

/* ------------------------------ coordinator ------------------------------ */

const DEFAULT_ENTITIES = [
  // The Attendant: classic unobserved-stalker. waypoints counts positions
  // 0 (home) .. waypoints-1 (final, adjacent to the player).
  { id: "attendant", kind: "stalker", aggression: 3, waypoints: 5 },
  // The ghost: stared-down charger. Ignoring it fills a 0..1 charge; a full
  // charge is the rush jumpscare.
  { id: "ghost", kind: "charger", aggression: 4 },
];

export class Haunt {
  constructor(opts = {}) {
    const { rng, now, entities, ...rest } = opts;
    this.rng = typeof rng === "function" ? rng : Math.random;
    this.now = typeof now === "function" ? now : () => 0;
    this.opts = {
      tickInterval: 5, // seconds of unobserved opportunity per movement roll
      grace: 1.5, // unobserved seconds at the final waypoint before a scare
      retreatInterval: 2, // RELIEF: one step back per this many seconds
      timeRampPer60: 2.5, // aggression points gained per elapsed minute
      tensionWeight: 6, // aggression points added at tension 1
      chargeTime: 12, // seconds for a charger at aggression 20 to fill
      drainRate: 0.3, // charge lost per observed second (staring drains)
      manifestAt: 0.5, // charge threshold that emits the "manifest" stage
      blackoutDelay: 3, // sustained blackout seconds before its jumpscare
      ...rest,
    };
    this.configs = (Array.isArray(entities) && entities.length ? entities : DEFAULT_ENTITIES).map(
      (e) => ({
        id: String(e.id),
        kind: e.kind === "charger" ? "charger" : "stalker",
        aggression: clamp(num(e.aggression, 0), 0, MAX_AGGRESSION),
        waypoints: Math.max(2, Math.round(num(e.waypoints, 5))),
      }),
    );
    this.reset();
  }

  reset() {
    this.running = false;
    this.ended = false;
    this.blackout = false;
    this.blackoutT = 0;
    this.events = [];
    this.entities = new Map();
    for (const c of this.configs) {
      this.entities.set(c.id, {
        config: c,
        aggression: c.aggression, // base; see setAggression
        effective: c.aggression,
        waypoint: 0,
        tickT: 0,
        graceT: 0,
        charge: 0,
        manifested: false,
        retreatT: 0,
        nearSent: false,
      });
    }
  }

  start() {
    if (this.ended || this.running) this.reset();
    this.running = true;
  }

  // setAggression(id, n) for one entity, setAggression(n) for all. Clamped 0..20.
  setAggression(idOrValue, value) {
    if (value === undefined) {
      const n = clamp(num(idOrValue, 0), 0, MAX_AGGRESSION);
      for (const e of this.entities.values()) e.aggression = n;
      return true;
    }
    const e = this.entities.get(String(idOrValue));
    if (!e) return false;
    e.aggression = clamp(num(value, e.aggression), 0, MAX_AGGRESSION);
    return true;
  }

  emit(ev) {
    this.events.push(ev);
  }

  cue(cue, entity) {
    this.emit(entity ? { type: "cue", cue, entity } : { type: "cue", cue });
  }

  // External events. Known: "blackout" (power-out: eyes glow, and a sustained
  // blackout ends in a jumpscare from the leading entity), "blackout-end".
  notify(name) {
    if (name === "blackout") {
      if (!this.blackout) {
        this.blackout = true;
        this.blackoutT = 0;
        if (this.running && !this.ended) this.cue("eyes");
      }
      return true;
    }
    if (name === "blackout-end") {
      this.blackout = false;
      this.blackoutT = 0;
      return true;
    }
    return false;
  }

  jumpscare(entity, kind) {
    if (this.ended) return;
    this.ended = true; // one terminal scare per session, like a FNAF night
    this.emit({ type: "jumpscare", entity, kind });
    this.cue("stinger", entity);
  }

  // Which entity is furthest along its hunt (for the blackout scare)?
  leader() {
    let best = null;
    let bestScore = -1;
    for (const e of this.entities.values()) {
      const score =
        e.config.kind === "stalker"
          ? e.waypoint / (e.config.waypoints - 1)
          : e.charge;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  fullDecay() {
    for (const e of this.entities.values()) {
      if (e.waypoint > 0 || e.charge > 0) {
        this.emit({ type: "stage", entity: e.config.id, stage: "reset", waypoint: 0 });
      }
      e.waypoint = 0;
      e.tickT = 0;
      e.graceT = 0;
      e.charge = 0;
      e.manifested = false;
      e.retreatT = 0;
      e.nearSent = false;
    }
  }

  // dt: seconds. input: {tension 0..1, state BUILD|PEAK|RELIEF|WAIT,
  // elapsed (session seconds), observed: {entityId: bool}}.
  update(dt, input = {}) {
    if (!this.running || this.ended) return;
    dt = clamp(num(dt, 0), 0, 0.25);
    const tension = clamp(num(input.tension, 0), 0, 1);
    const state = input.state ?? "WAIT";
    const elapsed = Math.max(0, num(input.elapsed, 0));
    const observedMap = input.observed || {};

    // Blackout countdown runs regardless of director state — power is out.
    if (this.blackout) {
      this.blackoutT += dt;
      if (this.blackoutT >= this.opts.blackoutDelay) {
        const lead = this.leader();
        if (lead) this.jumpscare(lead.config.id, "blackout");
        return;
      }
    }

    if (state === "WAIT") {
      this.fullDecay();
      return;
    }

    for (const e of this.entities.values()) {
      const c = e.config;
      e.effective = clamp(
        e.aggression + (elapsed / 60) * this.opts.timeRampPer60 + tension * this.opts.tensionWeight,
        0,
        MAX_AGGRESSION,
      );
      const observed = observedMap[c.id] === true;

      if (state === "RELIEF") {
        e.tickT = 0;
        e.graceT = 0;
        if (c.kind === "stalker") {
          e.retreatT += dt;
          if (e.retreatT >= this.opts.retreatInterval && e.waypoint > 0) {
            e.retreatT = 0;
            e.waypoint -= 1;
            e.nearSent = false;
            this.emit({ type: "stage", entity: c.id, stage: "retreat", waypoint: e.waypoint });
          }
        } else {
          e.charge = Math.max(0, e.charge - dt / 3);
          if (e.manifested && e.charge < this.opts.manifestAt) e.manifested = false;
        }
        continue;
      }
      e.retreatT = 0;

      if (c.kind === "stalker") {
        const last = c.waypoints - 1;
        if (observed) {
          // Watched: frozen. No opportunity accrues and the grace timer that
          // precedes a jumpscare resets — staring keeps it at bay.
          e.graceT = 0;
          continue;
        }
        if (e.waypoint >= last) {
          e.graceT += dt;
          if (e.graceT >= this.opts.grace) this.jumpscare(c.id, "lunge");
          continue;
        }
        e.tickT += dt;
        if (e.tickT >= this.opts.tickInterval) {
          e.tickT -= this.opts.tickInterval;
          if (this.rng() < e.effective / MAX_AGGRESSION) {
            e.waypoint += 1;
            this.emit({ type: "move", entity: c.id, waypoint: e.waypoint, of: last });
            this.cue("footstep", c.id);
            if (e.waypoint >= last && !e.nearSent) {
              e.nearSent = true;
              e.graceT = 0;
              this.emit({ type: "near", entity: c.id });
              this.cue("breath", c.id);
            }
          }
        }
      } else {
        // Charger: ignored => charge builds (scaled by aggression); observed
        // => staring drains it.
        if (observed) {
          e.charge = Math.max(0, e.charge - this.opts.drainRate * dt);
          if (e.manifested && e.charge < this.opts.manifestAt * 0.5) e.manifested = false;
        } else {
          e.charge += ((e.effective / MAX_AGGRESSION) * dt) / this.opts.chargeTime;
          if (!e.manifested && e.charge >= this.opts.manifestAt) {
            e.manifested = true;
            this.emit({ type: "stage", entity: c.id, stage: "manifest" });
            this.cue("breath", c.id);
          }
          if (e.charge >= 1) {
            e.charge = 1;
            this.jumpscare(c.id, "rush");
          }
        }
      }
    }
  }

  consumeEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  snapshot() {
    const entities = {};
    for (const e of this.entities.values()) {
      entities[e.config.id] = {
        kind: e.config.kind,
        aggression: e.aggression,
        effective: e.effective,
        waypoint: e.waypoint,
        waypoints: e.config.waypoints,
        charge: e.charge,
        graceT: e.graceT,
      };
    }
    return {
      running: this.running,
      ended: this.ended,
      blackout: this.blackout,
      entities,
    };
  }
}
