import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Haunt,
  isObserved,
  forwardFromQuaternion,
  MAX_AGGRESSION,
  VIEW_HALF_ANGLE,
} from "../public/haunt.mjs";

/* ----------------------------- cone math ----------------------------- */

const CAM = { position: { x: 0, y: 1.6, z: 2 }, forward: { x: 0, y: 0, z: -1 } };

test("cone: straight ahead is observed, behind is not", () => {
  assert.equal(isObserved(CAM, { x: 0, y: 1.6, z: -3 }), true);
  assert.equal(isObserved(CAM, { x: 0, y: 1.6, z: 6 }), false);
});

test("cone: ~55 degree half-angle boundary", () => {
  // 5m ahead; lateral offset tan(50deg)*5 ~ 5.96 inside, tan(60deg)*5 ~ 8.66 out.
  assert.equal(isObserved(CAM, { x: 5.9, y: 1.6, z: -3 }), true);
  assert.equal(isObserved(CAM, { x: 8.7, y: 1.6, z: -3 }), false);
  // 90 degrees off-axis is never inside a 55 degree cone.
  assert.equal(isObserved(CAM, { x: 5, y: 1.6, z: 2 }), false);
  // A custom narrow cone rejects what the default accepts.
  assert.equal(isObserved(CAM, { x: 2, y: 1.6, z: -3 }, 0.1), false);
  assert.equal(isObserved(CAM, { x: 2, y: 1.6, z: -3 }), true);
});

test("cone: vertical offsets count too", () => {
  // Entity high above the view line at close range falls outside the cone.
  assert.equal(isObserved(CAM, { x: 0, y: 6, z: 1.5 }), false);
  assert.equal(isObserved(CAM, { x: 0, y: 2.0, z: 0 }), true);
});

test("cone: quaternion camera orientation", () => {
  // Identity quaternion looks down -Z.
  const f = forwardFromQuaternion({ x: 0, y: 0, z: 0, w: 1 });
  assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.y) < 1e-9 && f.z === -1);
  const cam = { position: { x: 0, y: 1.6, z: 2 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  assert.equal(isObserved(cam, { x: 0, y: 1.6, z: -4 }), true);
  // 180 degree yaw looks down +Z.
  const camBack = { position: { x: 0, y: 1.6, z: 2 }, quaternion: { x: 0, y: 1, z: 0, w: 0 } };
  assert.equal(isObserved(camBack, { x: 0, y: 1.6, z: -4 }), false);
  assert.equal(isObserved(camBack, { x: 0, y: 1.6, z: 6 }), true);
});

test("cone: degenerate inputs are safely unobserved (or trivially observed)", () => {
  assert.equal(isObserved(null, { x: 0, y: 0, z: 0 }), false);
  assert.equal(isObserved({ position: CAM.position }, { x: 0, y: 0, z: 0 }), false);
  assert.equal(
    isObserved({ position: CAM.position, forward: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 0 }),
    false,
  );
  assert.equal(isObserved(CAM, null), false);
  assert.equal(isObserved(CAM, { x: 0, y: 1.6, z: 2 }), true); // on the camera
  assert.ok(VIEW_HALF_ANGLE > 0.9 && VIEW_HALF_ANGLE < 1.0); // ~55 degrees
});

/* ------------------------------- Haunt -------------------------------- */

const always = (v) => () => v;
const input = (over = {}) => ({
  tension: 0,
  state: "BUILD",
  elapsed: 0,
  observed: {},
  ...over,
});
const run = (h, seconds, inp, dt = 0.1) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) h.update(dt, inp);
};
const ofType = (evs, type) => evs.filter((e) => e.type === type);

test("haunt: construction, start gating, snapshot shape", () => {
  const h = new Haunt({ rng: always(0) });
  const snap = h.snapshot();
  assert.equal(snap.running, false);
  assert.ok(snap.entities.attendant);
  assert.ok(snap.entities.ghost);
  assert.equal(snap.entities.attendant.kind, "stalker");
  assert.equal(snap.entities.ghost.kind, "charger");
  assert.equal(snap.entities.attendant.waypoint, 0);
  // Updates before start() do nothing.
  run(h, 30, input());
  assert.deepEqual(h.consumeEvents(), []);
  assert.equal(h.snapshot().entities.attendant.waypoint, 0);
  h.start();
  assert.equal(h.snapshot().running, true);
});

test("haunt: stalker moves on ~5s unobserved ticks when rng < aggression/20", () => {
  const h = new Haunt({ rng: always(0.1), entities: [
    { id: "attendant", kind: "stalker", aggression: 10, waypoints: 5 },
  ] });
  h.start();
  // aggression 10 => threshold 0.5; rng 0.1 always moves.
  run(h, 5.05, input());
  let evs = h.consumeEvents();
  assert.equal(ofType(evs, "move").length, 1);
  assert.deepEqual(ofType(evs, "move")[0], {
    type: "move", entity: "attendant", waypoint: 1, of: 4,
  });
  assert.ok(evs.some((e) => e.type === "cue" && e.cue === "footstep"));
  // rng above the threshold: the roll fails, no movement.
  const h2 = new Haunt({ rng: always(0.9), entities: [
    { id: "attendant", kind: "stalker", aggression: 10, waypoints: 5 },
  ] });
  h2.start();
  run(h2, 20, input());
  assert.equal(ofType(h2.consumeEvents(), "move").length, 0);
  // aggression 0 never moves even with rng 0.
  const h3 = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 0, waypoints: 5 },
  ] });
  h3.start();
  run(h3, 60, input());
  assert.equal(ofType(h3.consumeEvents(), "move").length, 0);
});

test("haunt: the core FNAF rule — no opportunity accrues while observed", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 5 },
  ] });
  h.start();
  run(h, 60, input({ observed: { attendant: true } }));
  assert.equal(ofType(h.consumeEvents(), "move").length, 0);
  assert.equal(h.snapshot().entities.attendant.waypoint, 0);
  // Look away: it starts moving again.
  run(h, 5.05, input());
  assert.equal(ofType(h.consumeEvents(), "move").length, 1);
});

test("haunt: aggression escalates with elapsed time and tension (clamped 0..20)", () => {
  const h = new Haunt({ rng: always(0.99), entities: [
    { id: "attendant", kind: "stalker", aggression: 2, waypoints: 5 },
  ] });
  h.start();
  // Base 2: rng .99 >= 2/20, never moves (4 failed rolls in 21s).
  run(h, 21, input());
  assert.equal(ofType(h.consumeEvents(), "move").length, 0);
  // Deep into the session at full tension: 2 + 10*2.5 + 6 clamps to 20 => always moves.
  run(h, 5.2, input({ tension: 1, elapsed: 600 }));
  assert.equal(ofType(h.consumeEvents(), "move").length, 1);
  assert.equal(h.snapshot().entities.attendant.effective, MAX_AGGRESSION);
});

test("haunt: reaching the final waypoint emits near + breath cue", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 3 },
  ] });
  h.start();
  run(h, 10.1, input()); // two ticks: waypoint 1, then 2 (final)
  const evs = h.consumeEvents();
  assert.equal(ofType(evs, "move").length, 2);
  assert.equal(ofType(evs, "near").length, 1);
  assert.equal(ofType(evs, "near")[0].entity, "attendant");
  assert.ok(evs.some((e) => e.type === "cue" && e.cue === "breath"));
});

test("haunt: jumpscare fires after the grace window unobserved at the final waypoint", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 3 },
  ] });
  h.start();
  run(h, 10.1, input()); // at final (grace already ~0.1s in)
  h.consumeEvents();
  run(h, 1.2, input()); // still under the 1.5s grace
  assert.equal(ofType(h.consumeEvents(), "jumpscare").length, 0);
  run(h, 0.4, input());
  const evs = h.consumeEvents();
  const js = ofType(evs, "jumpscare");
  assert.equal(js.length, 1);
  assert.deepEqual(js[0], { type: "jumpscare", entity: "attendant", kind: "lunge" });
  assert.ok(evs.some((e) => e.type === "cue" && e.cue === "stinger"));
  assert.equal(h.snapshot().ended, true);
  // A night ends at one scare: nothing further until reset.
  run(h, 30, input());
  assert.deepEqual(h.consumeEvents(), []);
});

test("haunt: staring at it on the final waypoint holds it at bay", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 3 },
  ] });
  h.start();
  run(h, 10.1, input());
  h.consumeEvents();
  // Alternate: never 1.5s unobserved in a row; observation resets the grace.
  for (let i = 0; i < 10; i++) {
    run(h, 1.0, input());
    run(h, 0.2, input({ observed: { attendant: true } }));
  }
  assert.equal(ofType(h.consumeEvents(), "jumpscare").length, 0);
  assert.equal(h.snapshot().ended, false);
  // Blink too long and it has you.
  run(h, 1.6, input());
  assert.equal(ofType(h.consumeEvents(), "jumpscare").length, 1);
});

test("haunt: charger builds while ignored (manifest at 0.5, rush at 1)", () => {
  const h = new Haunt({ rng: always(0.99), entities: [
    { id: "ghost", kind: "charger", aggression: 20 },
  ] });
  h.start();
  // At aggression 20 the charge takes chargeTime (12s) to fill.
  run(h, 6.2, input());
  let evs = h.consumeEvents();
  assert.equal(ofType(evs, "stage").filter((e) => e.stage === "manifest").length, 1);
  assert.equal(ofType(evs, "jumpscare").length, 0);
  run(h, 6.2, input());
  evs = h.consumeEvents();
  const js = ofType(evs, "jumpscare");
  assert.equal(js.length, 1);
  assert.deepEqual(js[0], { type: "jumpscare", entity: "ghost", kind: "rush" });
});

test("haunt: staring drains the charger — the opposite rule", () => {
  const h = new Haunt({ rng: always(0.99), entities: [
    { id: "ghost", kind: "charger", aggression: 20 },
  ] });
  h.start();
  run(h, 7, input()); // charge ~0.58, manifested
  const before = h.snapshot().entities.ghost.charge;
  assert.ok(before > 0.5);
  run(h, 2, input({ observed: { ghost: true } })); // drain 0.3/s
  const after = h.snapshot().entities.ghost.charge;
  assert.ok(after < before - 0.5, `stare should drain: ${before} -> ${after}`);
  // Staring forever never produces a ghost jumpscare.
  run(h, 60, input({ observed: { ghost: true } }));
  assert.equal(ofType(h.consumeEvents(), "jumpscare").length, 0);
  assert.equal(h.snapshot().entities.ghost.charge, 0);
});

test("haunt: RELIEF retreats one step at a time; WAIT fully decays", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 6 },
    { id: "ghost", kind: "charger", aggression: 8 },
  ] });
  h.start();
  run(h, 15.1, input()); // attendant at waypoint 3, ghost charging
  assert.equal(h.snapshot().entities.attendant.waypoint, 3);
  h.consumeEvents();
  run(h, 2.05, input({ state: "RELIEF" }));
  let evs = h.consumeEvents();
  assert.equal(h.snapshot().entities.attendant.waypoint, 2);
  assert.deepEqual(ofType(evs, "stage")[0], {
    type: "stage", entity: "attendant", stage: "retreat", waypoint: 2,
  });
  run(h, 2.05, input({ state: "RELIEF" }));
  assert.equal(h.snapshot().entities.attendant.waypoint, 1);
  assert.ok(h.snapshot().entities.ghost.charge < 1);
  // WAIT: everything resets at once.
  h.update(0.1, input({ state: "WAIT" }));
  const snap = h.snapshot();
  assert.equal(snap.entities.attendant.waypoint, 0);
  assert.equal(snap.entities.ghost.charge, 0);
  const resets = ofType(h.consumeEvents(), "stage").filter((e) => e.stage === "reset");
  assert.ok(resets.length >= 1);
});

test("haunt: blackout lights the eyes, then fires a jumpscare from the leader", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 5 },
    { id: "ghost", kind: "charger", aggression: 2 },
  ] });
  h.start();
  run(h, 10.1, input()); // attendant waypoint 2 of 4 => clear leader
  h.consumeEvents();
  assert.equal(h.notify("blackout"), true);
  let evs = h.consumeEvents();
  assert.ok(evs.some((e) => e.type === "cue" && e.cue === "eyes"));
  run(h, 2.5, input({ observed: { attendant: true, ghost: true } }));
  assert.equal(ofType(h.consumeEvents(), "jumpscare").length, 0); // not yet
  run(h, 0.7, input({ observed: { attendant: true, ghost: true } }));
  const js = ofType(h.consumeEvents(), "jumpscare");
  assert.equal(js.length, 1);
  assert.equal(js[0].entity, "attendant");
  assert.equal(js[0].kind, "blackout");
  assert.equal(h.snapshot().ended, true);
});

test("haunt: blackout-end cancels the countdown; unknown notify is false", () => {
  const h = new Haunt({ rng: always(0.99) });
  h.start();
  h.notify("blackout");
  run(h, 2.5, input());
  assert.equal(h.notify("blackout-end"), true);
  run(h, 30, input({ observed: { attendant: true, ghost: true } }));
  assert.equal(ofType(h.consumeEvents(), "jumpscare").length, 0);
  assert.equal(h.snapshot().blackout, false);
  assert.equal(h.notify("quantum-flux"), false);
});

test("haunt: setAggression clamps, targets one or all, rejects unknown ids", () => {
  const h = new Haunt({ rng: always(0) });
  assert.equal(h.setAggression("attendant", 99), true);
  assert.equal(h.snapshot().entities.attendant.aggression, MAX_AGGRESSION);
  assert.equal(h.setAggression("attendant", -5), true);
  assert.equal(h.snapshot().entities.attendant.aggression, 0);
  assert.equal(h.setAggression(7), true); // all entities
  assert.equal(h.snapshot().entities.attendant.aggression, 7);
  assert.equal(h.snapshot().entities.ghost.aggression, 7);
  assert.equal(h.setAggression("fredbear", 20), false);
});

test("haunt: consumeEvents drains; reset clears state and re-arms after a scare", () => {
  const h = new Haunt({ rng: always(0), entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: 2 },
  ] });
  h.start();
  run(h, 5.1, input()); // move straight onto the final waypoint
  run(h, 1.6, input()); // grace elapses -> jumpscare
  assert.ok(ofType(h.consumeEvents(), "jumpscare").length === 1);
  assert.deepEqual(h.consumeEvents(), []); // drained
  h.reset();
  const snap = h.snapshot();
  assert.equal(snap.running, false);
  assert.equal(snap.ended, false);
  assert.equal(snap.entities.attendant.waypoint, 0);
  h.start();
  run(h, 5.1, input());
  assert.equal(ofType(h.consumeEvents(), "move").length, 1); // hunts again
});

test("haunt: deterministic with an injected rng sequence", () => {
  const seq = [0.9, 0.1, 0.9, 0.1]; // fail, move, fail, move
  const make = () => {
    let i = 0;
    return new Haunt({
      rng: () => seq[i++ % seq.length],
      entities: [{ id: "attendant", kind: "stalker", aggression: 10, waypoints: 9 }],
    });
  };
  const a = make();
  const b = make();
  a.start();
  b.start();
  run(a, 21, input());
  run(b, 21, input());
  assert.deepEqual(a.consumeEvents(), b.consumeEvents());
  assert.equal(a.snapshot().entities.attendant.waypoint, 2); // ticks 2 and 4 moved
});

test("haunt: hostile dt and missing input fields are safe", () => {
  const h = new Haunt({ rng: always(0) });
  h.start();
  h.update(NaN);
  h.update(-5, {});
  h.update(1e9, { tension: NaN, state: undefined, observed: null });
  // state defaulted to WAIT above => decay path; nothing explodes.
  assert.equal(h.snapshot().running, true);
});
