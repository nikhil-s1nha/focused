// figures.mjs — doorway figures for the simple four-door room.
//
// The player stands at the origin, eye at (0, 1.6, 0). Four doorways sit at
// 3.2 m. A figure stands 0.3 m inside its doorway, facing the eye. Figures are
// the existing FNAF characters (characters.mjs), built once at startup and
// pooled: one pooled character per id, moved between doorways. No model is
// created after createFigures() returns.
//
// Motion rules: only figures move. The camera is never touched by this module.
// Each pooled character sits under its own wrapper group; the wrapper carries
// the doorway placement, retreat offset and tension jitter, so the character's
// internal lunge (which works in its parent's space) composes with it.

import { createDoll, DOLL_ID } from "./doll.mjs";
import { createLungeFace } from "./face-texture.mjs";
import {
  createCharacter, CHARACTER_IDS, JUMPSCARE_SECONDS, MAX_TRIANGLES, FACE_DISTANCE,
} from "../fnaf/world/characters.mjs";

export const FIGURE_IDS = Object.freeze([...CHARACTER_IDS, DOLL_ID, "momo", "pennywise"]);
export const SIDES = Object.freeze(["front", "back", "left", "right"]);

/** Doorway centres (the wall opening). */
export const DOORWAYS = Object.freeze({
  front: Object.freeze({ x: 0, y: 0, z: -3.2 }),
  back: Object.freeze({ x: 0, y: 0, z: 3.2 }),
  left: Object.freeze({ x: -3.2, y: 0, z: 0 }),
  right: Object.freeze({ x: 3.2, y: 0, z: 0 }),
});

/** Player's eye. Lunges end 0.42 m in front of it. */
export const EYE = Object.freeze({ x: 0, y: 1.6, z: 0 });
/** Figure stands this far inside its doorway. */
export const INSET = 0.3;
export const RETREAT_SECONDS = 0.5;
export const RETREAT_DISTANCE = 0.9;
/** Frame budget for all four doorways together. */
export const BUDGET = Object.freeze({ maxDrawCalls: 80, maxTriangles: 60000, maxPerFigure: MAX_TRIANGLES });
/**
 * Concurrent figures. Each character builds 15 to 27 meshes, so four at once
 * would be about 83 draw calls (over the 80 budget). Any three is at most 68.
 * show() refuses a fourth figure until one is hidden.
 */
export const MAX_VISIBLE = 3;

/**
 * The built-in jumpscare puts the figure ROOT FACE_DISTANCE from the eye, but the
 * leaning head reaches this far further forward (measured at landing). The head,
 * not the root, must end FACE_DISTANCE from the eye, or the lunge lands inside the face.
 */
const HEAD_REACH = Object.freeze({ bellwether: 0.39, lark: 0.49, ratchet: 0.56, maestro: 0.37, doll: 0.458, momo: .37, pennywise: .37 });
/** Ids whose head is swapped for the sculpted lunge face (face-texture.mjs) during the close-up. */
export const LUNGE_FACE_IDS = Object.freeze([DOLL_ID]);
const FACE_SWAP_PROGRESS = 0.55; // lunge progress at which the close-up face replaces the head
/** Doorway look: near-black silhouette with pale eyes; short harsh light bursts. */
const BURST_SECONDS = 0.35;   // body lit this long per burst
const BURST_EYE = 1.4;        // extra eye glow during a burst
const GAP_MIN = 1.2, GAP_SPAN = 1.8; // gap between bursts, seconds (under 1 burst/s, far below 3 Hz)
const EYE_TAU = 0.12;        // eye low-pass: cutoff about 1.3 Hz, far under the 3 Hz limit
const CAUGHT_EYE = 4.5;      // max flare for a caught figure
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (p) => p * p * (3 - 2 * p);

// Stand point (inside the doorway) and yaw facing the eye, derived once.
const STAND = {};
for (const side of SIDES) {
  const d = DOORWAYS[side];
  const len = Math.hypot(d.x, d.z) || 1;
  const ix = -d.x / len, iz = -d.z / len; // inward unit vector
  const x = d.x + ix * INSET, z = d.z + iz * INSET;
  STAND[side] = {
    x, z,
    yaw: Math.atan2(EYE.x - x, EYE.z - z), // local +Z faces the eye
    outX: -ix, outZ: -iz,
  };
}

/**
 * Build the figure set. Returns the public API described in notes/simple-figures.md.
 * opts.createCanvas and opts.shadows are passed to the character builder.
 * opts.lungeFaceIds (default LUNGE_FACE_IDS): ids that get a close-up face.
 * opts.createLungeFace (default createLungeFace from face-texture.mjs): hook to swap the face
 *   implementation: (THREE, { seed, createCanvas, scale }) => Mesh (faces +Z, userData.dispose).
 */
export function createFigures(THREE, scene, opts = {}) {
  const group = new THREE.Group();
  group.name = "simple-figures";
  const pool = new Map();
  const bySide = { front: null, back: null, left: null, right: null };
  let blackout = false;
  let disposed = false;
  const charOptions = { shadows: !!opts.shadows, createCanvas: opts.createCanvas };
  const faceIds = opts.lungeFaceIds || LUNGE_FACE_IDS;
  const makeFace = opts.createLungeFace || createLungeFace;

  FIGURE_IDS.forEach((id, i) => {
    const character = id === DOLL_ID ? createDoll(THREE, charOptions) : createCharacter(THREE, id, charOptions);
    const head = character.group.getObjectByName(`${id}-head`);
    let face = null, headMeshes = [];
    if (faceIds.includes(id)) {
      face = makeFace(THREE, { seed: 7 + i, createCanvas: opts.createCanvas, scale: 0.165 });
      face.position.set(0, 0.14, -0.005);
      face.visible = false;
      head.add(face);
      // head meshes to hide while the face shows (hair, a pivot named `${id}-hair`, stays)
      const walk = (o) => { for (const c of o.children) { if (c.name === `${id}-hair`) continue; if (c.isMesh && c !== face) headMeshes.push(c); walk(c); } };
      walk(head);
    }
    const wrap = new THREE.Group();
    wrap.name = `simple-figure-${id}`;
    wrap.visible = false;
    wrap.add(character.group);
    group.add(wrap);
    pool.set(id, {
      id, character, wrap, head, face, headMeshes,
      side: null, phase: "idle", t: 0,
      seconds: JUMPSCARE_SECONDS, caughtFlag: false,
      retreatT: 0, retreatOff: 0,
      eye: 0, seed: 1.3 * (i + 1),
      silhouette: false, burst: 0, gap: 0, rng: 1 + i * 7919,
    });
  });
  if (scene) scene.add(group);

  function nextGap(e) {
    e.rng = (e.rng * 16807) % 2147483647;
    return GAP_MIN + (e.rng / 2147483647) * GAP_SPAN;
  }

  /** Body dark (silhouette) unless bursting; the eyes stay lit either way. */
  function syncBlack(e) {
    const dark = blackout || e.phase === "retreat" || (e.silhouette && e.burst <= 0);
    e.character.setBlackout(dark);
  }

  /** Swap the head for the close-up face during the last part of the lunge. */
  function syncFace(e) {
    if (!e.face) return;
    const close = e.phase === "caught" || e.phase === "latched"
      || (e.phase === "lunge" && e.character.getState().jumpscareProgress >= FACE_SWAP_PROGRESS);
    e.face.visible = close;
    for (const m of e.headMeshes) m.visible = !close;
  }

  function resetEntry(e) {
    if (e.side) bySide[e.side] = null;
    e.side = null;
    e.phase = "idle";
    e.silhouette = false;
    e.burst = 0;
    e.t = 0;
    e.retreatT = 0;
    e.retreatOff = 0;
    e.caughtFlag = false;
    e.eye = 0;
    e.character.setPose("idle"); // releases any latched lunge, restoring home
    e.character.group.position.set(0, 0, 0);
    e.character.group.rotation.set(0, 0, 0);
    e.character.setBlackout(blackout);
    e.wrap.position.set(0, 0, 0);
    e.approach = null;
    e.wrap.visible = false;
    e.stand = null;
    syncFace(e);
  }

  function release(e) {
    if (!e || !e.side) return;
    resetEntry(e);
  }

  function place(e, side) {
    const s = STAND[side];
    e.side = side;
    e.phase = "shown";
    e.t = 0;
    e.retreatT = 0;
    e.retreatOff = 0;
    e.caughtFlag = false;
    e.eye = 0;
    e.silhouette = true;
    e.burst = 0;
    e.gap = nextGap(e);
    e.character.setPose("idle");
    e.character.group.position.set(0, 0, 0);
    e.character.group.rotation.set(0, s.yaw, 0);
    e.character.setLookTarget(EYE);
    syncBlack(e);
    e.wrap.position.set(s.x, 0, s.z);
    e.wrap.visible = true;
    e.stand = null;
    bySide[side] = e;
    syncFace(e);
  }

  function valid(side) {
    return !disposed && Object.prototype.hasOwnProperty.call(STAND, side);
  }

  /** Put figure `id` in the doorway on `side`. Replaces whoever was there; an id is only ever on one side. */
  function show(side, id) {
    if (!valid(side) || !pool.has(id)) return false;
    const e = pool.get(id);
    // Figures that stay on screen after this call (not the one being replaced on this side, not e itself).
    let staying = 0;
    for (const x of pool.values()) if (x.side && x !== e && x.side !== side) staying++;
    if (staying >= MAX_VISIBLE) return false;
    if (bySide[side] && bySide[side] !== e) release(bySide[side]);
    if (e.side && e.side !== side) release(e);
    place(e, side);
    return true;
  }

  /** Freeze in the doorway, half out, eyes brightened gently. */
  function hold(side) {
    if (!valid(side)) return false;
    const e = bySide[side];
    if (!e || (e.phase !== "shown" && e.phase !== "hold")) return false;
    e.phase = "hold";
    e.character.setPose("peek");
    return true;
  }

  /** Pull the figure back into the dark over RETREAT_SECONDS, then hide it. */
  function retreat(side) {
    if (!valid(side)) return false;
    const e = bySide[side];
    if (!e) return false;
    if (e.phase === "retreat") return true;
    e.phase = "retreat";
    e.retreatT = 0;
    e.caughtFlag = false;
    e.silhouette = false;
    e.burst = 0;
    syncBlack(e);
    return true;
  }

  /** Lunge at the eye. Only the figure moves; the camera is never touched. */
  function approach(side, { crawl = false, seconds = 3, distance = 1.4 } = {}) {
    const e = bySide[side];
    if (!e) return false;
    e.approach = { crawl, seconds, distance, age: 0 };
    return true;
  }

  function lunge(side, seconds = JUMPSCARE_SECONDS, opts = {}) {
    if (!valid(side)) return false;
    const e = bySide[side];
    if (!e) return false;
    if (e.phase === "caught") return true;
    const sec = clamp(Number(seconds) || JUMPSCARE_SECONDS, 0.10, 2);
    e.approach = null;
    e.character.setPose("idle");          // release any previous latch
    e.character.group.position.set(0, 0, 0);
    // Aim the root so the head ends FACE_DISTANCE from the eye. The built-in lunge
    // lands the root FACE_DISTANCE beyond this target, toward the figure.
    let s = STAND[side];
    // opts.viewDir (horizontal camera forward): the figure pops up in the dark in
    // front of the player and lunges from there, so the face always lands in view.
    // Only the figure moves; the camera is never touched.
    const vd = opts && opts.viewDir;
    e.edgeEntry = null;
    if (opts.entrySide && vd) {
      const n = Math.hypot(vd.x, vd.z) || 1;
      e.edgeEntry = { x: -vd.z / n * opts.entrySide, z: vd.x / n * opts.entrySide, age: 0 };
    }
    if (vd && Number.isFinite(vd.x) && Number.isFinite(vd.z) && Math.hypot(vd.x, vd.z) > 1e-6) {
      const dist = Math.hypot(s.x, s.z);
      const n = Math.hypot(vd.x, vd.z);
      const px = (vd.x / n) * dist, pz = (vd.z / n) * dist;
      s = { x: px, z: pz, yaw: Math.atan2(-px, -pz), outX: px / dist, outZ: pz / dist };
      e.stand = s; // the per-frame update must keep the figure here, not at the door
      e.wrap.position.set(px, 0, pz);
      e.character.group.rotation.set(0, s.yaw, 0);
    }
    const reach = HEAD_REACH[e.id] ?? 0.4;
    const toward = Math.hypot(s.x, s.z) || 1;
    e.character.jumpscare({ x: (s.x / toward) * reach, y: EYE.y, z: (s.z / toward) * reach });
    e.seconds = sec;
    e.retreatT = 0;
    e.retreatOff = 0;
    e.phase = "lunge";
    e.caughtFlag = false;
    e.silhouette = false;
    e.burst = 0;
    return true;
  }

  /** Lunge and stay latched in view with max eye flare until hide(side) or clear(). */
  function caught(side, opts = {}) {
    if (!valid(side)) return false;
    const e = bySide[side];
    if (!e) return false;
    if (e.phase === "caught") return true;
    if (e.phase === "lunge") {
      e.caughtFlag = true; // already lunging (possibly from the view): keep going, then latch
      return true;
    }
    lunge(side, JUMPSCARE_SECONDS, opts);
    e.caughtFlag = true;
    return true;
  }

  function hide(side) {
    if (!valid(side)) return false;
    const e = bySide[side];
    if (!e) return false;
    release(e);
    return true;
  }

  function clear() {
    for (const side of SIDES) hide(side);
  }

  function setBlackout(b) {
    blackout = !!b;
    for (const e of pool.values()) if (e.side) syncBlack(e);
  }

  function update(dt = 0, time = 0, state = {}) {
    if (disposed) return;
    dt = clamp(Number(dt) || 0, 0, 0.1);
    const tension = clamp(Number(state && state.tension) || 0, 0, 1);
    for (const e of pool.values()) {
      if (!e.side) continue;
      const s = e.stand || STAND[e.side];

      // Lunge runs at the character's fixed 0.6 s; scale its clock to the requested duration.
      // Harsh light bursts while the figure waits in the doorway.
      const waiting = e.phase === "shown" || e.phase === "hold";
      if (waiting) {
        if (e.burst > 0) {
          e.burst -= dt;
          if (e.burst <= 0) { e.burst = 0; e.gap = nextGap(e); }
        } else {
          e.gap -= dt;
          if (e.gap <= 0) e.burst = BURST_SECONDS;
        }
      }
      syncBlack(e);

      let charDt = dt;
      if (e.phase === "lunge") charDt = dt * (JUMPSCARE_SECONDS / e.seconds);
      e.character.update(charDt, time, { tension });
      if (e.phase === "lunge" && e.character.getState().latched) {
        e.phase = e.caughtFlag ? "caught" : "latched";
      }
      syncFace(e);

      if (e.phase === "retreat") {
        e.retreatT += dt;
        const p = Math.min(1, e.retreatT / RETREAT_SECONDS);
        e.retreatOff = RETREAT_DISTANCE * smooth(p);
        if (p >= 1) {
          release(e);
          continue;
        }
      }

      // Eye brightness: low-pass the character's value; caught flares to max.
      const base = e.character.getState().eyeIntensity;
      const target = e.phase === "caught" ? CAUGHT_EYE : base + (waiting && e.burst > 0 ? BURST_EYE : 0);
      e.eye += (target - e.eye) * (1 - Math.exp(-dt / EYE_TAU));
      e.character.eyeMaterial.emissiveIntensity = e.eye;

      // Tension jitter: slow sway (under 1 Hz) only while the figure is still in the doorway.
      let jx = 0, jz = 0;
      if ((e.phase === "shown" || e.phase === "hold") && tension > 0.6) {
        const amp = 0.012 * ((tension - 0.6) / 0.4);
        jx = Math.sin(time * 2.3 + e.seed) * amp;
        jz = Math.sin(time * 1.7 + e.seed * 2) * amp * 0.6;
      }
      let off = e.retreatOff, floorY = 0;
      if (e.approach && waiting) {
        e.approach.age += dt;
        const p = Math.min(1,e.approach.age/e.approach.seconds);
        off -= e.approach.distance * p * p;
        floorY = e.approach.crawl ? -1.15 + .035*Math.sin(time*7) : 0;
      }
      let edgeX = 0, edgeZ = 0;
      if (e.edgeEntry && (e.phase === "lunge" || e.phase === "latched" || e.phase === "caught")) {
        e.edgeEntry.age += dt;
        const remaining = 1 - smooth(Math.min(1, e.edgeEntry.age / e.seconds));
        edgeX = e.edgeEntry.x * 1.2 * remaining;
        edgeZ = e.edgeEntry.z * 1.2 * remaining;
      }
      e.wrap.position.set(s.x + s.outX * off + jx + edgeX, floorY, s.z + s.outZ * off + jz + edgeZ);
    }
  }

  function occupant(side) {
    if (!valid(side)) return null;
    return bySide[side] ? bySide[side].id : null;
  }

  /** Read-only snapshot for the director and tests. position is the figure root in world space. */
  function getFigure(side) {
    if (!valid(side)) return null;
    const e = bySide[side];
    if (!e) return null;
    const pos = e.character.group.getWorldPosition(new THREE.Vector3());
    const headPos = e.head.getWorldPosition(new THREE.Vector3());
    const st = e.character.getState();
    return {
      id: e.id,
      side,
      phase: e.phase,
      pose: st.pose,
      position: pos,
      horizontalDistanceToEye: Math.hypot(pos.x - EYE.x, pos.z - EYE.z),
      lit: e.burst > 0,
      headPosition: headPos,
      faceDistanceToEye: Math.hypot(headPos.x - EYE.x, headPos.z - EYE.z),
      eyeIntensity: e.eye,
      bodyFade: st.bodyFade,
    };
  }

  /** Draw calls and triangles for the figures currently visible. */
  function getStats() {
    let figures = 0, drawCalls = 0, triangles = 0;
    for (const e of pool.values()) {
      if (!e.side) continue;
      figures++;
      e.wrap.traverseVisible((o) => {
        if (!o.isMesh) return;
        drawCalls++;
        const idx = o.geometry.index;
        triangles += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
      });
    }
    return { figures, drawCalls, triangles };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const e of pool.values()) {
      e.side = null;
      if (e.face) e.face.userData.dispose?.();
      e.character.dispose();
    }
    for (const side of SIDES) bySide[side] = null;
    if (group.parent) group.parent.remove(group);
  }

  return {
    group,
    show, hold, retreat, approach, lunge, caught, hide, clear,
    setBlackout, update, dispose,
    occupant, getFigure, getStats,
  };
}
