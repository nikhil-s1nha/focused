import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSimpleRoom } from "../public/simple/room.mjs";

const SIDES = ["left", "right", "front", "back"];

function meshStats(group) {
  let meshes = 0;
  let lights = 0;
  let tris = 0;
  group.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    if (o.isLight) lights++;
  });
  return { meshes, lights, tris };
}

// Sample flicker output over a window at a fixed step.
function sampleFlicker(room, seconds, dt = 1 / 120) {
  const out = [];
  let t = 0;
  for (; t < seconds; t += dt) {
    room.update(dt, t);
    out.push(room.group.getObjectByName("ceiling-lamp").intensity);
  }
  return out;
}

test("API surface and player position", () => {
  const scene = new THREE.Scene();
  const room = createSimpleRoom(THREE, scene);
  assert.ok(room.group.isGroup);
  assert.ok(scene.children.includes(room.group));
  for (const side of SIDES) {
    assert.ok(room.doors[side].pivot.isObject3D, `door ${side}`);
    assert.equal(room.getDoor(side), 0);
  }
  for (const fn of ["setDoor", "getDoor", "setLight", "flicker", "setHallLight", "update", "dispose"]) {
    assert.equal(typeof room[fn], "function", fn);
  }
  assert.deepEqual(room.playerPosition, { x: 0, y: 1.6, z: 0 });
  room.dispose();
});

test("unknown door side is rejected", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  assert.throws(() => room.setDoor("up", 1), RangeError);
  assert.throws(() => room.getDoor("up"), RangeError);
  assert.throws(() => room.setHallLight("up", 1), RangeError);
  room.dispose();
});

test("door animation reaches its target in about 0.6 s and eases", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  for (const side of SIDES) {
    room.setDoor(side, 1);
    let prev = 0;
    let moved = false;
    for (let i = 0; i < 40; i++) {
      room.update(1 / 60, i / 60);
      const v = room.getDoor(side);
      assert.ok(v >= prev - 1e-12 && v <= 1, "monotonic and bounded");
      if (v > 0 && v < 1) moved = true;
      prev = v;
    }
    assert.ok(moved, "passes through intermediate values");
    assert.equal(room.getDoor(side), 1);
  }
  // Closing also reaches zero.
  room.setDoor("front", 0);
  room.update(0.3, 0);
  room.update(0.3, 0);
  assert.equal(room.getDoor("front"), 0);
  room.dispose();
});

test("door swing is eased: slow start, fast middle, slow end", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  room.setDoor("back", 1);
  const base = room.doors.back.pivot.rotation.y;
  const angles = [];
  for (let i = 0; i < 12; i++) {
    room.update(0.05, 0);
    angles.push(room.doors.back.pivot.rotation.y - base);
  }
  const d = angles.map((a, i) => (i ? a - angles[i - 1] : a));
  assert.ok(d[1] > d[0], "accelerates out of rest");
  assert.ok(d[5] > d[11], "decelerates toward the end");
  room.dispose();
});

test("setDoor clamps to 0..1", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  room.setDoor("left", 5);
  for (let i = 0; i < 4; i++) room.update(0.25, 0);
  assert.equal(room.getDoor("left"), 1);
  room.setDoor("left", -3);
  for (let i = 0; i < 4; i++) room.update(0.25, 0);
  assert.equal(room.getDoor("left"), 0);
  room.dispose();
});

test("setLight clamps and drives the ceiling lamp monotonically", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  const lamp = room.group.getObjectByName("ceiling-lamp");
  room.setLight(-4);
  room.update(0, 0);
  assert.equal(lamp.intensity, 0);
  room.setLight(9);
  room.update(0, 0);
  const full = lamp.intensity;
  room.setLight(1);
  room.update(0, 0);
  assert.equal(lamp.intensity, full);
  room.setLight(0.5);
  room.update(0, 0);
  assert.ok(lamp.intensity > 0 && lamp.intensity < full);
  room.dispose();
});

test("zero fixture power removes wall and prop self-illumination", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  room.setLight(0);
  room.update(0, 0);
  const walls = room.group.getObjectByName("walls");
  assert.equal(walls.material.emissiveIntensity, 0);
  room.group.traverse((o) => {
    if(o.material?.isMeshStandardMaterial) assert.equal(o.material.emissiveIntensity,0,`${o.name} has no residual emission`);
  });
  assert.equal(room.group.getObjectByName("lamp-bulb").material.color.getHex(),0);
  assert.equal(room.group.getObjectByName("window").material.color.getHex(),0);
  assert.equal(room.group.getObjectByName("dust-motes").material.opacity,0);
  room.dispose();
});

test("flicker is active for its duration and then ends", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  room.setLight(1);
  room.update(0, 0);
  const lamp = room.group.getObjectByName("ceiling-lamp");
  const full = lamp.intensity;
  room.flicker(2, 0.8);
  const samples = sampleFlicker(room, 2.5);
  assert.ok(Math.min(...samples) < full * 0.95, "dips below full while flickering");
  // After the flicker window the lamp returns to steady full output.
  room.update(0.01, 0);
  assert.equal(lamp.intensity, full);
  room.dispose();
});

test("flicker never strobes faster than 3 Hz (counted as local minima)", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  room.setLight(1);
  room.flicker(8, 1);
  const dt = 1 / 120;
  const samples = sampleFlicker(room, 8, dt);
  let minima = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i] < samples[i - 1] && samples[i] <= samples[i + 1]) minima++;
  }
  const rate = minima / 8;
  assert.ok(rate <= 3, `minima per second ${rate}`);
  room.dispose();
});

test("flicker with zero seconds or intensity leaves light steady", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  room.setLight(0.7);
  room.flicker(0);
  room.update(0.1, 0);
  const lamp = room.group.getObjectByName("ceiling-lamp");
  const steady = lamp.intensity;
  room.flicker(3, 0);
  for (let i = 0; i < 60; i++) {
    room.update(1 / 60, i / 60);
    assert.ok(Math.abs(lamp.intensity - steady) < 1e-9);
  }
  room.dispose();
});

test("setHallLight: one spot follows the brightest glowing door, off at zero", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  const spot = room.group.children.find((o) => o.isSpotLight);
  room.setHallLight("left", 0.5);
  assert.ok(spot.intensity > 0);
  const leftPos = spot.position.clone();
  room.setHallLight("right", 0.9);
  assert.ok(!spot.position.equals(leftPos), "spot moved to the brighter door");
  room.setHallLight("right", 0);
  assert.ok(spot.intensity > 0, "left still glows, so spot stays on");
  room.setHallLight("left", 0);
  assert.equal(spot.intensity, 0);
  room.dispose();
});

test("draw-call, light and triangle budgets", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  const { meshes, lights, tris } = meshStats(room.group);
  assert.ok(meshes < 60, `draw calls ${meshes}`);
  assert.ok(lights <= 2, `lights ${lights}`);
  assert.ok(tris < 40000, `triangles ${tris}`);
  room.dispose();
});

test("wall normals are axis-aligned and face into the room", () => {
  const room = createSimpleRoom(THREE, new THREE.Scene());
  const walls = room.group.getObjectByName("walls").geometry;
  const pos = walls.attributes.position;
  const nrm = walls.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    const n = new THREE.Vector3().fromBufferAttribute(nrm, i);
    assert.ok(Math.abs(n.length() - 1) < 1e-6, "unit normal");
    // Every wall vertex sits on x = +-HALF or z = +-HALF. Its normal must be
    // that wall's axis, pointing back into the room.
    const hits = [];
    if (Math.abs(Math.abs(p.x) - 3.5) < 1e-6) hits.push("x");
    if (Math.abs(Math.abs(p.z) - 3.5) < 1e-6) hits.push("z");
    assert.ok(hits.length > 0, `vertex on a wall plane at ${p.toArray()}`);
    assert.ok(
      hits.some((ax) => Math.abs(n[ax]) > 0.999 && Math.sign(n[ax]) === -Math.sign(p[ax])),
      `normal ${n.toArray()} at ${p.toArray()} faces into the room`,
    );
  }
  room.dispose();
});

test("dispose is safe to call twice and removes the group", () => {
  const scene = new THREE.Scene();
  const room = createSimpleRoom(THREE, scene);
  room.dispose();
  room.dispose();
  assert.equal(scene.children.length, 0);
});

test("two rooms can coexist and dispose independently", () => {
  const scene = new THREE.Scene();
  const a = createSimpleRoom(THREE, scene);
  const b = createSimpleRoom(THREE, scene);
  a.dispose();
  assert.equal(scene.children.length, 1);
  b.dispose();
  assert.equal(scene.children.length, 0);
});

 test("fixture power is pooled and nonlinear; cold hall spill stays explicitly controlled", () => {
  const room=createSimpleRoom(THREE,new THREE.Scene());
  const fixture=room.group.getObjectByName("ceiling-lamp");
  const bulb=room.group.getObjectByName("lamp-bulb");
  room.setLight(.1);room.update(0,0);const low=fixture.intensity;
  assert.ok(low>0&&low<1);assert.ok(bulb.material.color.getHex()>0);
  room.setLight(.45);room.update(0,0);assert.ok(fixture.intensity>low*8);
  assert.equal(fixture.distance,7);
  room.setLight(0);room.setHallLight("front",.25);room.update(0,0);
  assert.equal(fixture.intensity,0);assert.ok(room.group.getObjectByName("hall-glow").intensity>0);
  room.setHallLight("front",0);room.update(0,0);assert.equal(room.group.getObjectByName("hall-glow").intensity,0);
  room.dispose();
});
