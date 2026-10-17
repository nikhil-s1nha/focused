// FNAF-mechanic additions to the ghost: stare-to-banish, the rush jumpscare
// variant, and blackout eye points. The legacy surface is covered in
// wow-modules.test.mjs and must stay intact alongside these.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createGhost, GHOST_STATES } from "../public/ghost.mjs";

const PLAYER = { x: 0, z: 2 };
const vis = (over = {}) => ({
  tension: 0.85,
  state: "PEAK",
  quality: 0.9,
  phase: "running",
  ...over,
});
const run = (g, seconds, visuals, dt = 0.05) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) g.update(dt, t, visuals);
};
const dist = (g) =>
  Math.hypot(g.group.position.x - PLAYER.x, g.group.position.z - PLAYER.z);

test("ghost: new API present without changing the legacy export surface", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  assert.deepEqual(GHOST_STATES, ["hidden", "apparition", "stalk", "banished"]);
  assert.equal(typeof g.trigger, "function");
  assert.equal(typeof g.setObserved, "function");
  assert.equal(typeof g.setBlackout, "function");
  assert.equal(g.mode, null);
  assert.equal(g.observed, false);
  assert.ok(g.group.getObjectByName("ghost-eye-point-l"));
  assert.ok(g.group.getObjectByName("ghost-eye-point-r"));
  assert.equal(g.trigger("waltz"), false); // unknown kinds are rejected
  g.dispose();
});

test("ghost: staring at it directly drives it off (opposite of the Attendant)", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  g.setState("stalk");
  run(g, 1, vis());
  assert.equal(g.state, "stalk");
  g.setObserved(true);
  run(g, 2.0, vis()); // under the 2.2s stare threshold
  assert.equal(g.state, "stalk");
  run(g, 0.4, vis());
  assert.equal(g.state, "banished");
  run(g, 3, vis({ state: "WAIT", tension: 0 }));
  assert.equal(g.state, "hidden");
  g.dispose();
});

test("ghost: glancing away lets it recover — stare pressure decays", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  g.setState("stalk");
  run(g, 1, vis());
  // 1s on / 3s off repeatedly never accumulates to the 2.2s banish threshold.
  for (let i = 0; i < 5; i++) {
    g.setObserved(true);
    run(g, 1, vis());
    g.setObserved(false);
    run(g, 3, vis());
  }
  assert.equal(g.state, "stalk");
  g.dispose();
});

test("ghost: rush — fast approach through the door line to a face-reveal, then banished", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  const face = g.group.getObjectByName("ghost-face");
  assert.equal(g.trigger("rush"), true);
  assert.equal(g.trigger("rush"), false); // uninterruptible once begun
  assert.equal(g.state, "stalk"); // public state stays within GHOST_STATES
  assert.equal(g.mode, "approach");
  // Calm director input cannot cancel a rush in flight.
  run(g, 0.5, vis({ state: "RELIEF" }));
  assert.equal(g.mode, "approach");
  // It covers ~8m at ~3.2 m/s: far faster than any stalk, crossing z >= 0.5.
  run(g, 2.3, vis());
  assert.equal(g.mode, "reveal");
  assert.ok(g.group.position.z > 0.5, `should cross the door line: z=${g.group.position.z}`);
  assert.ok(Math.abs(dist(g) - 0.9) < 0.05, `stops at revealDistance: ${dist(g)}`);
  assert.ok(face.scale.x > 1.6, `face-reveal swell: ${face.scale.x}`);
  // Reveal holds ~0.8s, then it banishes itself and the face springs back.
  run(g, 1.0, vis());
  assert.equal(g.mode, null);
  assert.equal(g.state, "banished");
  run(g, 2, vis({ state: "WAIT", tension: 0 }));
  assert.equal(g.state, "hidden");
  assert.ok(face.scale.x < 1.2);
  g.dispose();
});

test("ghost: rush never touches the player and never moves the camera rig", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  g.trigger("jumpscare"); // alias for rush
  const dt = 0.05;
  for (let t = 0; t < 6; t += dt) {
    g.update(dt, t, vis());
    assert.ok(dist(g) >= 0.85 - 1e-6, `too close: ${dist(g)} at t=${t.toFixed(2)}`);
  }
  g.dispose();
});

test("ghost: rush from hidden re-manifests at the corridor spawn and fades in fast", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  const body = g.group.getObjectByName("ghost-body");
  assert.equal(g.state, "hidden");
  g.trigger("rush");
  assert.equal(g.state, "stalk");
  assert.equal(g.group.position.z, -7); // charges from the corridor
  run(g, 0.5, vis());
  assert.ok(body.material.opacity > 0.8, "rush fade-in is fast");
  g.dispose();
});

test("ghost: blackout — shroud near-invisible, eye points burn at full opacity", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  const body = g.group.getObjectByName("ghost-body");
  const eyePt = g.group.getObjectByName("ghost-eye-point-l");
  g.setState("stalk");
  run(g, 3, vis()); // full presence
  assert.ok(body.material.opacity > 0.85);
  assert.ok(eyePt.material.opacity > 0.8);
  g.setBlackout(true);
  g.update(0.05, 0, vis());
  assert.ok(body.material.opacity < 0.06, `body should vanish: ${body.material.opacity}`);
  assert.equal(eyePt.material.opacity, 1);
  g.setBlackout(false);
  g.update(0.05, 0, vis());
  assert.ok(body.material.opacity > 0.85);
  g.dispose();
});

test("ghost: new calls are inert after dispose", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  g.dispose();
  assert.equal(g.trigger("rush"), false);
  g.setObserved(true);
  g.setBlackout(true);
  assert.equal(g.observed, false);
  assert.equal(g.mode, null);
  g.update(0.05, 0, vis()); // no throw
});
