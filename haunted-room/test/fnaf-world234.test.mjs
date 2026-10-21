import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSpaceFnaf2 } from "../public/fnaf/world/space-fnaf2.mjs";
import { createSpaceFnaf3 } from "../public/fnaf/world/space-fnaf3.mjs";
import { createSpaceFnaf4 } from "../public/fnaf/world/space-fnaf4.mjs";

const FACTORIES = { fnaf2: createSpaceFnaf2, fnaf3: createSpaceFnaf3, fnaf4: createSpaceFnaf4 };
const run = (s, secs = 1, st = {}) => {
  for (let t = 0; t < secs; t += 1 / 30) s.update(1 / 30, t, st);
};
const counts = (root) => {
  const mats = new Set();
  let meshes = 0,
    lights = 0;
  root.traverse((o) => {
    if (o.isLight && !o.isHemisphereLight && !o.isAmbientLight) lights++;
    let shown = true;
    for (let n = o; n; n = n.parent) if (n.visible === false) shown = false;
    if (o.isMesh && shown && !o.userData.proxy) {
      meshes++;
      mats.add(o.material);
    }
  });
  return { meshes, mats: mats.size, lights };
};

for (const [name, make] of Object.entries(FACTORIES)) {
  test(`${name}: contract, interactables, budget, dispose`, () => {
    const scene = new THREE.Scene();
    const s = make(THREE, scene);
    for (const k of ["group", "update", "interactables", "dispose", "setPowerOut"]) assert.ok(k in s, k);
    assert.ok(s.group.isObject3D && scene.children.includes(s.group));
    assert.ok(Array.isArray(s.interactables) && s.interactables.length >= 5);
    const ids = new Set();
    for (const it of s.interactables) {
      assert.equal(typeof it.id, "string");
      assert.equal(typeof it.label, "string");
      assert.equal(typeof it.onInteract, "function");
      assert.ok(it.mesh.isObject3D);
      assert.ok(!ids.has(it.id), `dup ${it.id}`);
      ids.add(it.id);
      let hasMesh = false;
      it.mesh.traverse((o) => {
        assert.equal(o.userData.interactableId, it.id);
        if (o.isMesh) hasMesh = true;
      });
      assert.ok(hasMesh);
    }
    const c = counts(s.group);
    assert.ok(c.meshes < 120, `draw-call budget: ${c.meshes}`);
    assert.ok(c.lights <= 3, `real-time lights: ${c.lights}`);
    assert.ok(c.mats < 70, `materials: ${c.mats}`);
    // robustness: odd dt / missing state / power out
    s.update(0, 0);
    s.update(-1, 1, {});
    s.update(5, 2, { tension: NaN });
    s.update(1 / 60, 3, { tension: 2, powerOut: true });
    s.setPowerOut(true);
    run(s, 0.3);
    s.setPowerOut(false);
    run(s, 0.3);
    s.dispose();
    assert.ok(!scene.children.includes(s.group));
  });
}

test("fnaf2: flashlight, vent lights, aim, hall figure", () => {
  const s = createSpaceFnaf2(THREE, null);
  run(s, 0.2);
  assert.equal(s.debug.spot.intensity, 0);
  s.setFlashlight(true, { x: 0.3, y: 0, z: -1 });
  run(s, 0.2);
  assert.ok(s.debug.spot.intensity > 10);
  assert.ok(s.debug.spot.target.position.x > 1);
  s.setFlashlight(false);
  run(s, 0.2);
  assert.equal(s.debug.spot.intensity, 0);
  assert.equal(s.setVentLight("left", true), true);
  assert.equal(s.setVentLight("nope", true), false);
  run(s, 1);
  assert.ok(s.debug.vents.left.level > 0.9 && s.debug.vents.right.level < 0.05);
  s.setHallFigure(-100);
  assert.ok(s.getState().hallFigure >= -10);
  s.setHallFigure(null);
  assert.equal(s.getState().hallFigure, null);
  s.dispose();
});

test("fnaf2: mask visor is world-space (not camera-parented), fades fast, tracks eye, no shake", () => {
  const cam = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  scene.add(cam);
  const s = createSpaceFnaf2(THREE, scene);
  run(s, 0.1);
  assert.equal(s.debug.visor.visible, false);
  s.setMask(true);
  s.setEyePosition(0.2, 1.3, 0.1);
  s.update(0.05, 0, {});
  assert.ok(s.debug.visor.visible);
  assert.ok(s.debug.visor.material.opacity < 0.9);
  run(s, 0.3);
  assert.ok(s.debug.visor.material.opacity > 0.8);
  assert.notEqual(s.debug.visor.parent, cam);
  assert.equal(s.debug.visor.parent, s.group);
  assert.ok(Math.abs(s.debug.visor.position.x - 0.2) < 1e-6 && Math.abs(s.debug.visor.position.y - 1.3) < 1e-6);
  const p = s.debug.visor.position.clone();
  run(s, 0.5);
  assert.ok(p.equals(s.debug.visor.position));
  s.setMask(false);
  run(s, 0.4);
  assert.equal(s.debug.visor.visible, false);
  const calls = [];
  const s2 = createSpaceFnaf2(THREE, null, { onInteract: (id, r) => calls.push([id, r]) });
  s2.interactables.find((i) => i.id === "mask").onInteract();
  assert.equal(s2.getState().mask, true);
  assert.equal(calls[0][0], "mask");
  s.dispose();
  s2.dispose();
});

test("fnaf2: music box wind level and musicbox interactable", () => {
  const s = createSpaceFnaf2(THREE, null);
  assert.ok(s.interactables.some((i) => i.id === "musicbox"));
  s.setWindLevel(5);
  assert.equal(s.getState().windLevel, 1);
  s.setWindLevel(-1);
  assert.equal(s.getState().windLevel, 0);
  s.setWindLevel(NaN);
  assert.equal(s.getState().windLevel, 0);
  s.setWindLevel(0.8);
  run(s, 3);
  s.setWindLevel(0.1);
  run(s, 4);
  s.dispose();
});

test("fnaf3: faults, seals, panels, lure, buttons", () => {
  const s = createSpaceFnaf3(THREE, null);
  for (const id of ["btn-audio", "btn-camera", "btn-vent", "vent-0", "vent-1", "vent-2"])
    assert.ok(s.interactables.some((i) => i.id === id), id);
  assert.equal(s.setSystemFault("audio", true), true);
  assert.equal(s.setSystemFault("vent", true), true);
  assert.equal(s.getState().faults.ventilation, true);
  assert.equal(s.setSystemFault("bogus", true), false);
  assert.equal(s.setVentSealed(3, true), false);
  assert.equal(s.setVentSealed(-1, true), false);
  assert.equal(s.setVentSealed(1.5, true), false);
  assert.equal(s.setVentSealed(1, true), true);
  assert.deepEqual(s.getState().sealed, [false, true, false]);
  run(s, 1.2);
  assert.equal(s.debug.vents[1].plate.visible, true);
  assert.equal(s.debug.vents[0].plate.visible, false);
  s.interactables.find((i) => i.id === "btn-audio").onInteract();
  assert.equal(s.getState().panel, "audio");
  s.interactables.find((i) => i.id === "vent-0").onInteract();
  assert.equal(s.getState().sealed[0], true);
  s.pulseLure(4);
  assert.equal(s.getState().lureRoom, 4);
  const before = s.debug.blades.rotation.z;
  run(s, 1);
  assert.notEqual(s.debug.blades.rotation.z, before);
  s.setSystemFault("camera", true);
  run(s, 2);
  for (const f of ["audio", "camera", "ventilation"]) s.setSystemFault(f, false);
  run(s, 1);
  s.dispose();
});

test("fnaf4: worst case (every place occupied + lit) stays near budget", () => {
  const s = createSpaceFnaf4(THREE, null);
  for (const side of ["left", "right"]) s.setClosetDoor(side, true);
  for (const p of ["left", "right", "closet-left", "closet-right", "hall"]) s.setOccupant(p, "z");
  const base = s.debug.renderMeshes();
  for (const o of Object.values(s.debug.occ)) o.g.visible = true;
  const worst = s.debug.renderMeshes();
  assert.ok(worst - base <= 5 * 8, "each occupant <= 8 meshes");
  assert.ok(worst <= 135, `worst-case meshes ${worst}`);
  s.dispose();
});

test("fnaf4: doors, closets, flashlight, occupants, breathing", () => {
  const s = createSpaceFnaf4(THREE, null);
  for (const id of ["door-left", "door-right", "door-hall", "closet-left", "closet-right", "flashlight", "nightlight"])
    assert.ok(s.interactables.some((i) => i.id === id), id);
  const st0 = s.getState();
  assert.equal(st0.doors.left, 0);
  assert.equal(st0.closets.left, false);
  run(s, 1);
  assert.ok(Math.abs(s.debug.doorPivots.left.pivot.rotation.y) > 1);
  assert.ok(Math.abs(s.debug.closets.left.pivot.rotation.y) < 1e-6);
  s.setDoor("left", true);
  run(s, 1.5);
  assert.ok(Math.abs(s.debug.doorPivots.left.pivot.rotation.y) < 0.05);
  s.setClosetDoor("left", true);
  run(s, 1.5);
  assert.ok(Math.abs(s.debug.closets.left.pivot.rotation.y) > 1);
  assert.equal(s.setDoor("nope", true), false);
  assert.equal(s.setClosetDoor("middle", true), false);

  assert.equal(s.setOccupant("nope", "x"), false);
  s.setOccupant("closet-right", "chA");
  s.setFlashlight(true, { x: 0.15, y: 0, z: -1 });
  run(s, 0.5);
  assert.equal(s.debug.occ["closet-right"].g.visible, false);
  s.setClosetDoor("right", true);
  run(s, 1.5);
  assert.equal(s.debug.occ["closet-right"].g.visible, true);
  s.setFlashlight(true, { x: -1, y: 0, z: 0.2 });
  run(s, 0.3);
  assert.equal(s.debug.occ["closet-right"].g.visible, false);
  s.setFlashlight(true, { x: 0.15, y: 0, z: -1 });
  run(s, 0.3);
  assert.equal(s.debug.occ["closet-right"].g.visible, true);
  s.setOccupant("closet-right", null);
  run(s, 0.3);
  assert.equal(s.debug.occ["closet-right"].g.visible, false);
  assert.equal(s.getState().occupants["closet-right"], null);
  s.setOccupant("hall", "foo");
  const v1 = s.debug.occ.hall.variant;
  s.setOccupant("hall", "foo");
  assert.equal(s.debug.occ.hall.variant, v1);
  s.setBreathing("hall", true);
  run(s, 1);
  assert.equal(s.getState().breathing.hall, true);
  assert.equal(s.setBreathing("zzz", true), false);
  s.interactables.find((i) => i.id === "door-hall").onInteract();
  assert.equal(s.getState().doors.hall, 1);
  s.interactables.find((i) => i.id === "nightlight").onInteract();
  assert.equal(s.getState().nightlight, false);
  run(s, 0.2);
  assert.equal(s.debug.nlLight.intensity, 0);
  s.dispose();
});
