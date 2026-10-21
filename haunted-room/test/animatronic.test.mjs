import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createAnimatronic, STAGES } from "../public/animatronic.mjs";

const PLAYER = { x: 0, z: 2 };
const vis = (over = {}) => ({
  tension: 0.2,
  state: "BUILD",
  quality: 0.9,
  phase: "running",
  ...over,
});
const run = (a, seconds, visuals, dt = 0.1) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) a.update(dt, t, visuals);
};
const distToPlayer = (a) =>
  Math.hypot(a.group.position.x - PLAYER.x, a.group.position.z - PLAYER.z);

test("contract: group in scene, API shape, dormant corner start", () => {
  const scene = new THREE.Scene();
  const before = scene.children.length;
  const a = createAnimatronic(THREE, scene);
  assert.equal(scene.children.length, before + 1);
  assert.ok(a.group.isObject3D);
  assert.equal(typeof a.update, "function");
  assert.equal(typeof a.setStage, "function");
  assert.equal(typeof a.trigger, "function");
  assert.equal(typeof a.dispose, "function");
  assert.equal(a.stage, 0);
  assert.equal(STAGES[a.stage], "dormant");
  assert.equal(a.group.position.x, -2.6);
  assert.equal(a.group.position.z, -4.8);
  // Eyes exist and are dark while dormant.
  const eye = a.group.getObjectByName("attendant-eye-l");
  assert.ok(eye);
  run(a, 5, vis({ tension: 0.1 }));
  assert.equal(a.stage, 0);
  assert.equal(eye.material.emissiveIntensity, 0);
  a.dispose();
});

test("stage progression: dormant -> aware on sustained mid tension -> active at PEAK", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  const head = a.group.getObjectByName("attendant-head");
  const eye = a.group.getObjectByName("attendant-eye-l");
  // Brief mid tension is not enough (dwell is 3s).
  run(a, 2, vis({ tension: 0.5 }));
  assert.equal(a.stage, 0);
  run(a, 2, vis({ tension: 0.5 }));
  assert.equal(a.stage, 1);
  // Aware: eyes faintly glow and the head creeps toward the player.
  run(a, 3, vis({ tension: 0.5 }));
  assert.ok(eye.material.emissiveIntensity > 0.05);
  assert.ok(eye.material.emissiveIntensity < 0.6);
  assert.ok(Math.abs(head.rotation.y) > 0.01); // turning, slowly
  // Mid tension alone never reaches active.
  assert.equal(a.stage, 1);
  run(a, 1, vis({ tension: 0.9, state: "PEAK" }));
  assert.equal(a.stage, 2);
  const glowAware = 0.6;
  run(a, 4, vis({ tension: 0.9, state: "PEAK" }));
  assert.ok(eye.material.emissiveIntensity > glowAware); // bright when active
  assert.equal(a.stage, 2); // auto logic never exceeds active
  a.dispose();
});

test("advance snaps closer but never inside the 1.2m safety radius", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  a.setStage(2);
  const v = vis({ tension: 0.9, state: "PEAK" });
  let prev = distToPlayer(a);
  assert.ok(prev > 7); // starts in the far corner
  assert.equal(a.trigger("advance"), true);
  assert.equal(a.stage, 3);
  run(a, 1, v);
  let d = distToPlayer(a);
  assert.ok(d < prev, "advance must move it closer");
  assert.ok(d >= 1.2 - 1e-9);
  // Hammer it: many advances can never breach the safety radius.
  for (let i = 0; i < 20; i++) {
    prev = d;
    a.trigger("advance");
    run(a, 1, v);
    d = distToPlayer(a);
    assert.ok(d <= prev + 1e-9);
    assert.ok(d >= 1.2 - 1e-9, `advance ${i} breached safety radius: ${d}`);
  }
  assert.ok(Math.abs(d - 1.2) < 1e-6); // converges onto the radius, never past
  // Opacity recovers after the snap fade.
  const skull = a.group.getObjectByName("attendant-skull");
  assert.ok(skull.material.opacity > 0.99);
  a.dispose();
});

test("lunge is short: back to stage 2 within 1s, position untouched", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  a.setStage(2);
  const before = distToPlayer(a);
  assert.equal(a.trigger("scare"), true);
  assert.equal(a.stage, 4);
  assert.equal(a.trigger("scare"), false); // no re-trigger mid-lunge
  run(a, 1, vis({ tension: 0.9, state: "PEAK" }), 0.05);
  assert.equal(a.stage, 2);
  assert.equal(distToPlayer(a), before); // lunge is a lean, not a move
  assert.ok(distToPlayer(a) >= 1.2);
  a.dispose();
});

test("WAIT and low quality decay the stage toward dormant (~2.5s per stage)", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  a.setStage(2);
  run(a, 1, vis({ state: "WAIT", tension: 0 }));
  assert.equal(a.stage, 2); // not instant
  run(a, 11, vis({ state: "WAIT", tension: 0 }));
  assert.equal(a.stage, 0);
  // Low signal quality decays too, even in BUILD.
  a.setStage(1);
  run(a, 4, vis({ tension: 0.9, quality: 0.2 }));
  assert.equal(a.stage, 0);
  // Hunting decays as well.
  a.setStage(3);
  run(a, 12, vis({ state: "WAIT", tension: 0 }));
  assert.equal(a.stage, 0);
  a.dispose();
});

/* ------------------- FNAF-mechanic additions ------------------- */

test("observed freeze: it never moves while watched; queued advances land after", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  a.setStage(2);
  const v = vis({ tension: 0.9, state: "PEAK" });
  const before = distToPlayer(a);
  a.setObserved(true);
  assert.equal(a.trigger("advance"), true);
  run(a, 3, v);
  assert.equal(distToPlayer(a), before, "moved while observed");
  // Look away: the queued move lands between the frames.
  a.setObserved(false);
  run(a, 1, v);
  assert.ok(distToPlayer(a) < before, "queued advance should land once unobserved");
  a.dispose();
});

test("observed mid-fade aborts the snap and re-queues it", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  a.setStage(2);
  const v = vis({ tension: 0.9, state: "PEAK" });
  const before = distToPlayer(a);
  a.trigger("advance");
  run(a, 0.2, v); // fade begun, snap moment (0.25s) not yet reached
  a.setObserved(true);
  run(a, 2, v);
  assert.equal(distToPlayer(a), before, "snap must abort when caught looking");
  a.setObserved(false);
  run(a, 1, v);
  assert.ok(distToPlayer(a) < before);
  // Observation also brightens the eyes while roused.
  const eye = a.group.getObjectByName("attendant-eye-l");
  const unobserved = eye.material.emissiveIntensity;
  a.setObserved(true);
  run(a, 4, v);
  assert.ok(eye.material.emissiveIntensity > unobserved + 0.2);
  a.dispose();
});

test("waypoint path: advances land on each node in order, clamped off the player", () => {
  const scene = new THREE.Scene();
  const path = [
    { x: -2, z: -3 },
    { x: -1, z: -1 },
    { x: 0, z: 1.4 }, // 0.6m from the player: must be pushed out to safeRadius
  ];
  const a = createAnimatronic(THREE, scene, { waypoints: path, safeRadius: 0.9 });
  a.setStage(2);
  const v = vis({ tension: 0.9, state: "PEAK" });
  assert.equal(a.waypointIndex, -1);
  a.trigger("advance");
  run(a, 1, v);
  assert.equal(a.waypointIndex, 0);
  assert.equal(a.group.position.x, -2);
  assert.equal(a.group.position.z, -3);
  a.trigger("advance");
  run(a, 1, v);
  assert.equal(a.waypointIndex, 1);
  assert.equal(a.group.position.z, -1);
  a.trigger("advance");
  run(a, 1, v);
  assert.equal(a.waypointIndex, 2);
  assert.ok(Math.abs(distToPlayer(a) - 0.9) < 1e-6, `final node sits at safeRadius: ${distToPlayer(a)}`);
  // Past the end of the path: nothing moves.
  const x = a.group.position.x;
  const z = a.group.position.z;
  a.trigger("advance");
  run(a, 1, v);
  assert.equal(a.waypointIndex, 2);
  assert.equal(a.group.position.x, x);
  assert.equal(a.group.position.z, z);
  a.dispose();
});

test("jumpscare: ~0.6s lunge into the player's face, latched until setStage", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  a.setStage(2);
  const v = vis({ tension: 0.9, state: "PEAK" });
  run(a, 1, v);
  const homeX = a.group.position.x;
  const homeZ = a.group.position.z;
  assert.equal(a.jumping, false);
  assert.equal(a.trigger("jumpscare"), true);
  assert.equal(a.jumping, true);
  assert.equal(a.stage, 4);
  assert.equal(a.trigger("jumpscare"), false); // no re-trigger mid-scare
  assert.equal(a.trigger("advance"), false);
  assert.equal(a.trigger("scare"), false);
  run(a, 0.7, v, 0.05);
  // In the face: ~0.42m out at raised eye height, eyes flared, jaw gaping.
  assert.ok(Math.abs(distToPlayer(a) - 0.42) < 0.02, `at the face: ${distToPlayer(a)}`);
  assert.ok(a.group.position.y > 0.15);
  const eye = a.group.getObjectByName("attendant-eye-l");
  const jaw = a.group.getObjectByName("attendant-jaw");
  assert.ok(eye.material.emissiveIntensity > 3, `eye flare: ${eye.material.emissiveIntensity}`);
  assert.ok(jaw.rotation.x > 0.7, `jaw gape: ${jaw.rotation.x}`);
  // Latched: it does not auto-return like a "scare" lean.
  run(a, 2, v, 0.05);
  assert.equal(a.stage, 4);
  assert.ok(Math.abs(distToPlayer(a) - 0.42) < 0.02);
  // Session reset pulls it out and restores the pre-jump spot.
  a.setStage(0);
  assert.equal(a.jumping, false);
  assert.equal(a.group.position.x, homeX);
  assert.equal(a.group.position.z, homeZ);
  assert.equal(a.group.position.y, 0);
  a.dispose();
});

test("blackout: body near-invisible while both eyes burn; restores cleanly", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  const skull = a.group.getObjectByName("attendant-skull");
  const eyeL = a.group.getObjectByName("attendant-eye-l");
  const eyeR = a.group.getObjectByName("attendant-eye-r");
  a.setBlackout(true);
  a.update(0.1, 0, vis({ tension: 0.1 }));
  assert.ok(skull.material.opacity <= 0.05, `body visible in blackout: ${skull.material.opacity}`);
  assert.equal(eyeL.material.opacity, 1);
  assert.equal(eyeR.material.opacity, 1);
  assert.ok(eyeL.material.emissiveIntensity >= 2.2, "bright eye glows in the dark");
  assert.ok(eyeR.material.emissiveIntensity >= 1.3, "dim eye still glows in the dark");
  a.setBlackout(false);
  a.update(0.1, 0, vis({ tension: 0.1 }));
  assert.ok(skull.material.opacity > 0.99);
  assert.equal(eyeL.material.emissiveIntensity, 0); // dormant again: dark eyes
  a.dispose();
});

test("damage read: one dim + one bright eye, jaw/dent/ribs/wire parts exist", () => {
  const scene = new THREE.Scene();
  const a = createAnimatronic(THREE, scene);
  const eyeL = a.group.getObjectByName("attendant-eye-l");
  const eyeR = a.group.getObjectByName("attendant-eye-r");
  assert.notEqual(eyeL.material, eyeR.material, "eyes use distinct materials");
  for (const name of [
    "attendant-jaw",
    "attendant-dent",
    "attendant-rib-0",
    "attendant-rib-1",
    "attendant-rib-2",
    "attendant-wire",
  ]) {
    assert.ok(a.group.getObjectByName(name), `missing part: ${name}`);
  }
  a.setStage(2);
  run(a, 6, vis({ tension: 0.9, state: "PEAK" }));
  assert.ok(
    eyeR.material.emissiveIntensity < eyeL.material.emissiveIntensity * 0.5,
    `right eye should run dim: ${eyeR.material.emissiveIntensity} vs ${eyeL.material.emissiveIntensity}`,
  );
  assert.ok(eyeR.material.emissiveIntensity > 0.05, "but not dead");
  a.dispose();
});

test("dispose removes the group and restores the scene child count", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Group()); // unrelated content survives
  const before = scene.children.length;
  const a = createAnimatronic(THREE, scene);
  assert.equal(scene.children.length, before + 1);
  a.dispose();
  assert.equal(scene.children.length, before);
  a.update(0.1, 0, vis()); // must not throw after dispose
  a.dispose(); // idempotent
});
