import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createEnvironment } from "../public/environment.mjs";

const visuals = (over = {}) => ({
  tension: 0,
  state: "BUILD",
  elapsed: 0,
  lighting: true,
  fog: true,
  shadow: true,
  shadowPosition: "back",
  quality: 1,
  phase: 0,
  ...over,
});

// Run enough fixed-step updates for smoothing/dwell to converge.
function settle(env, v, seconds = 8, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) env.update(dt, t, v);
}

test("contract: update, interactables, dispose, debug hook", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  assert.equal(typeof env.update, "function");
  assert.equal(typeof env.dispose, "function");
  assert.ok(Array.isArray(env.interactables));
  assert.equal(env.interactables.length, 5);
  assert.equal(typeof env.creakDoor, "function");
  assert.equal(typeof env.debug.corridorVisibleCount, "number");
  assert.equal(typeof env.debug.corridorExtent, "number");
  assert.ok(env.debug.root.isObject3D);
  assert.ok(env.debug.figure.isObject3D);
  env.update(1 / 60, 0, visuals()); // runs with full visuals
  env.update(1 / 60, 0.016); // and with none at all
  env.dispose();
});

test("interactables have unique ids, labels, tagged raycast targets", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  const ids = new Set();
  for (const item of env.interactables) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.label, "string");
    assert.equal(typeof item.onInteract, "function");
    assert.ok(item.mesh.isObject3D);
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
    item.mesh.traverse((o) =>
      assert.equal(o.userData.interactableId, item.id),
    );
  }
  env.dispose();
});

test("corridor segment count strictly increases with tension", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  const counts = [];
  for (const tension of [0, 0.25, 0.5, 0.75, 1]) {
    settle(env, visuals({ tension }));
    counts.push(env.debug.corridorVisibleCount);
  }
  for (let i = 1; i < counts.length; i++)
    assert.ok(
      counts[i] > counts[i - 1],
      `expected strictly increasing counts, got ${counts.join(",")}`,
    );
  assert.ok(counts[0] >= 1, "calm corridor still reads as a short hall");
  assert.equal(counts.at(-1), 6, "full tension reveals every segment");
  env.dispose();
});

test("shadowPosition moves the figure; it only shows past the threshold", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  settle(env, visuals({ tension: 0.3, state: "BUILD", shadowPosition: "left" }));
  assert.equal(env.debug.figure.visible, false, "hidden below tension 0.45");
  settle(env, visuals({ tension: 0.9, state: "PEAK", shadowPosition: "left" }));
  assert.ok(env.debug.figure.visible);
  assert.ok(env.debug.figure.position.x < -2);
  settle(env, visuals({ tension: 0.9, state: "PEAK", shadowPosition: "right" }));
  assert.ok(env.debug.figure.position.x > 2);
  settle(env, visuals({ tension: 0.9, state: "PEAK", shadowPosition: "back" }));
  assert.ok(Math.abs(env.debug.figure.position.x) < 0.2);
  assert.ok(env.debug.figure.position.z < -5.5, "back anchor sits in corridor");
  settle(env, visuals({ tension: 0.9, state: "PEAK", shadow: false }));
  assert.equal(env.debug.figure.visible, false, "effect toggle hides it");
  env.dispose();
});

test("WAIT eases the corridor back down over repeated updates", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  settle(env, visuals({ tension: 1, state: "PEAK" }));
  const peak = env.debug.corridorVisibleCount;
  assert.equal(peak, 6);
  settle(env, visuals({ tension: 1, state: "WAIT" }), 12);
  assert.ok(
    env.debug.corridorVisibleCount < peak,
    "WAIT should retract the corridor even if raw tension stays high",
  );
  assert.ok(env.debug.corridorVisibleCount <= 2);
  env.dispose();
});

test("onInteract handlers run and the radio toggles its active flag", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  const radio = env.interactables.find((i) => i.id === "radio");
  assert.equal(radio.mesh.userData.active, false);
  for (const item of env.interactables) item.onInteract();
  assert.equal(radio.mesh.userData.active, true);
  radio.onInteract();
  assert.equal(radio.mesh.userData.active, false);
  const door = env.interactables.find((i) => i.id === "corridor-door");
  const before = door.mesh.rotation.y;
  door.onInteract();
  settle(env, visuals({ tension: 0.2 }), 10);
  assert.ok(door.mesh.rotation.y > before, "door swings further open");
  env.update(1 / 60, 0, visuals());
  env.dispose();
});

test("dispose restores the scene and releases owned resources only", () => {
  const scene = new THREE.Scene();
  const before = scene.children.length;
  const marked = new THREE.MeshStandardMaterial({ color: 0xff00ff });
  let injectedDisposed = false;
  marked.addEventListener("dispose", () => (injectedDisposed = true));
  const env = createEnvironment(THREE, scene, {
    materials: { wallPlaster: marked },
  });
  assert.ok(scene.children.length > before);
  let usesInjected = false;
  env.debug.root.traverse((o) => {
    if (o.material === marked) usesInjected = true;
  });
  assert.ok(usesInjected, "injected wallPlaster material is used");
  settle(env, visuals({ tension: 0.8 }), 2);
  env.dispose();
  assert.equal(scene.children.length, before);
  assert.equal(injectedDisposed, false, "injected materials are not disposed");
});

test("performance budget: mesh count and triangles stay within limits", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  settle(env, visuals({ tension: 1, state: "PEAK" }), 6);
  let drawables = 0,
    triangles = 0,
    lights = 0;
  env.debug.root.traverse((o) => {
    if (o.isLight) lights++;
    if (!o.isMesh && !o.isPoints) return;
    drawables++;
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  assert.ok(drawables < 120, `drawables ${drawables} should stay under 120`);
  assert.ok(triangles < 150000, `triangles ${triangles} under budget`);
  assert.ok(lights <= 2, "at most two supplementary lights");
  env.dispose();
});

test("decay interactables: drawing and wire exist, are tagged and respond", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  const ids = env.interactables.map((i) => i.id).sort();
  assert.deepEqual(ids, ["clock", "corridor-door", "drawing", "radio", "wire"]);
  // Wire: provoking it lights the spark for a stretch of frames.
  const wire = env.interactables.find((i) => i.id === "wire");
  settle(env, visuals({ tension: 0 }), 1);
  wire.onInteract();
  let lit = 0;
  for (let t = 0; t < 1.2; t += 1 / 30) {
    env.update(1 / 30, t, visuals({ tension: 0 }));
    if (env.debug.spark.material.opacity > 0.3) lit++;
  }
  assert.ok(lit > 20, `spark burst lit ${lit} frames`);
  // Drawing: interacting stirs the paper off its resting tilt.
  const drawing = env.interactables.find((i) => i.id === "drawing");
  drawing.onInteract();
  let maxTilt = 0;
  for (let t = 0; t < 2; t += 1 / 30) {
    env.update(1 / 30, t, visuals({ tension: 0 }));
    maxTilt = Math.max(maxTilt, Math.abs(env.debug.drawing.rotation.z - 0.05));
  }
  assert.ok(maxTilt > 0.03, `paper stirred (${maxTilt})`);
  env.dispose();
});

test("creakDoor opens the door in small clamped increments via the api", () => {
  const scene = new THREE.Scene();
  const env = createEnvironment(THREE, scene);
  const before = env.debug.doorTarget;
  const after = env.creakDoor(0.12);
  assert.ok(Math.abs(after - (before + 0.12)) < 1e-9);
  // Clamped at the full arc no matter how hard it is pushed.
  for (let i = 0; i < 50; i++) env.creakDoor(0.3);
  assert.ok(env.debug.doorTarget <= 1.45 + 1e-9);
  // Negative delta eases it back toward closed, never below zero.
  for (let i = 0; i < 50; i++) env.creakDoor(-0.3);
  assert.equal(env.debug.doorTarget, 0);
  assert.equal(env.creakDoor(Infinity), 0, "non-finite delta is ignored safely");
  // The mesh actually follows the target over time.
  env.creakDoor(1.0);
  const door = env.interactables.find((i) => i.id === "corridor-door");
  const restAngle = door.mesh.rotation.y;
  settle(env, visuals({ tension: 0.1 }), 10);
  assert.ok(door.mesh.rotation.y > restAngle, "door creaks open");
  env.dispose();
});

test("injected decay materials are used for the decals and the paper", () => {
  const scene = new THREE.Scene();
  const markedPaper = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const markedScratch = new THREE.MeshStandardMaterial({ color: 0x0000ff });
  const markedDamage = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const env = createEnvironment(THREE, scene, {
    materials: {
      paperDrawing: markedPaper,
      scratchedPlaster: markedScratch,
      wallDamaged: markedDamage,
    },
  });
  const used = new Set();
  env.debug.root.traverse((o) => o.material && used.add(o.material));
  assert.ok(used.has(markedPaper), "paperDrawing used");
  assert.ok(used.has(markedScratch), "scratchedPlaster used");
  assert.ok(used.has(markedDamage), "wallDamaged used");
  env.dispose();
});
