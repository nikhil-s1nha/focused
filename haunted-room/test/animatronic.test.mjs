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
