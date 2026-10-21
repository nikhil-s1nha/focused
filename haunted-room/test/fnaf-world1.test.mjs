import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createOffice } from "../public/fnaf/world/office.mjs";
import { createRooms, ROOM_IDS, CHAR_IDS } from "../public/fnaf/world/rooms.mjs";
import { createCameraFeed } from "../public/fnaf/world/camera-feed.mjs";

const EXPECTED_ROOMS = ["showstage", "dining", "backstage", "cove", "hall-west", "hall-west-corner", "supply", "kitchen", "restrooms", "hall-east", "hall-east-corner"];

function stubRenderer() {
  const r = { renders: 0, targets: [], target: null, xr: { enabled: true, isPresenting: false, sawEnabled: [] } };
  r.render = () => { r.renders++; r.xr.sawEnabled.push(r.xr.enabled); };
  r.setRenderTarget = (t) => { r.target = t; r.targets.push(t); };
  r.getRenderTarget = () => r.target;
  return r;
}
const visibleDraws = (root) => {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    n += Array.isArray(o.material) ? o.material.length : 1;
  });
  return n;
};
const lightCount = (root) => { let n = 0; root.traverse((o) => o.isLight && n++); return n; };
const settle = (o, sec, t0 = 0) => { for (let t = 0; t < sec; t += 1 / 60) o.update(1 / 60, t0 + t); };

test("room ids match the shared contract (11 camera rooms)", () => {
  assert.deepEqual([...ROOM_IDS].sort(), [...EXPECTED_ROOMS].sort());
  assert.deepEqual(CHAR_IDS, ["bellwether", "lark", "ratchet", "maestro"]);
});

test("office: API surface and interactables", () => {
  const s = new THREE.Scene(); const o = createOffice(THREE, s);
  for (const k of ["update", "setDoor", "setHallLight", "setDoorOccupant", "setPowerOut", "dispose", "getFanState", "setMonitorUp", "setMonitorTextures", "on"])
    assert.equal(typeof o[k], "function", k);
  assert.ok(o.group.isObject3D && Array.isArray(o.interactables));
  const ids = o.interactables.map((i) => i.id).sort();
  for (const id of ["door-left", "light-left", "door-right", "light-right", "monitor"]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  for (const it of o.interactables) {
    assert.equal(typeof it.onInteract, "function"); assert.equal(typeof it.label, "string");
    it.mesh.traverse((n) => assert.equal(n.userData.interactableId, it.id));
  }
  o.update(0.016, 0); o.update(NaN, 1); o.update(5, 2); // robust to bad dt
  o.dispose();
});

test("office: door slides closed in ~0.4s and reopens; events fire", () => {
  const s = new THREE.Scene(); const o = createOffice(THREE, s);
  const ev = [];
  o.on("door", (e) => ev.push(["door", e.side, e.closed])); o.on("door-done", (e) => ev.push(["done", e.side, e.closed]));
  const y0 = o.debug.doorMesh.left.position.y;
  assert.equal(o.getDoor("left").closed, false);
  assert.equal(o.setDoor("left", true), true);
  assert.equal(o.setDoor("up", true), false);
  assert.equal(o.getDoor("left").moving, true);
  o.update(0.1, 0); o.update(0.1, 0.1); const mid = o.getDoor("left").progress;
  assert.ok(mid > 0.3 && mid < 0.7, `mid ${mid}`);
  settle(o, 0.3, 0.2);
  assert.equal(o.getDoor("left").progress, 1);
  assert.ok(o.debug.doorMesh.left.position.y < y0 - 2);
  assert.equal(o.getDoor("right").closed, false); // independent sides
  o.setDoor("left", false); settle(o, 0.5);
  assert.equal(o.getDoor("left").progress, 0);
  assert.deepEqual(ev, [["door", "left", true], ["done", "left", true], ["door", "left", false], ["done", "left", false]]);
  o.dispose();
});

test("office: interactables drive events; autoToggle toggles; power-out kills buttons", () => {
  const s = new THREE.Scene(); const o = createOffice(THREE, s);
  const got = []; o.on("press", (e) => got.push(e.id));
  const by = (id) => o.interactables.find((i) => i.id === id);
  by("door-right").onInteract(); by("light-left").onInteract(); by("monitor").onInteract();
  assert.deepEqual(got, ["door-right", "light-left", "monitor"]);
  assert.equal(o.getDoor("right").closed, false); // game logic belongs to the app
  const picks = []; o.on("camera-pick", (e) => picks.push(e.uv));
  by("monitor-map").onInteract({ uv: { x: 0.4, y: 0.6 } });
  assert.deepEqual(picks, [{ x: 0.4, y: 0.6 }]);
  const a = createOffice(THREE, new THREE.Scene(), { autoToggle: true });
  a.interactables.find((i) => i.id === "door-left").onInteract();
  a.interactables.find((i) => i.id === "light-right").onInteract();
  a.interactables.find((i) => i.id === "monitor").onInteract();
  assert.equal(a.getDoor("left").closed, true); assert.equal(a.getHallLight("right"), true); assert.equal(a.isMonitorUp(), true);
  a.setPowerOut(true);
  let dead = 0; a.on("press-dead", () => dead++);
  assert.equal(a.pressButton("door-left"), false); assert.equal(dead, 1);
  o.dispose(); a.dispose();
});

test("office: hall light, occupant visibility rules, power out", () => {
  const s = new THREE.Scene(); const o = createOffice(THREE, s);
  assert.equal(o.setDoorOccupant("left", "ratchet"), true);
  assert.equal(o.setDoorOccupant("left", "nobody"), false);
  assert.equal(o.getDoorOccupant("left"), "ratchet");
  const ph = o.debug.occ.left.ratchet;
  const vis = () => ({ body: ph.bodyMeshes.some((m) => m.visible), eyes: ph.eyes.some((m) => m.visible), grp: ph.group.visible });
  assert.deepEqual(vis(), { body: false, eyes: false, grp: true }); // dark hall: nothing visible
  o.setHallLight("left", true); settle(o, 0.5);
  assert.deepEqual(vis(), { body: true, eyes: true, grp: true });
  assert.ok(o.debug.lights.left.intensity > 0);
  assert.equal(o.debug.lights.right.intensity, 0);
  // flicker while occupied: intensity varies over time
  const seen = new Set(); for (let t = 1; t < 3; t += 0.03) { o.update(0.03, t); seen.add(o.debug.lights.left.intensity.toFixed(2)); }
  assert.ok(seen.size > 5);
  o.setPowerOut(true); settle(o, 1, 4);
  assert.deepEqual(vis(), { body: false, eyes: true, grp: true }); // only eyes in the dark
  assert.equal(o.debug.lights.left.intensity, 0); assert.equal(o.debug.lamp.intensity, 0);
  assert.ok(o.getFanState().speed < 1);
  o.setPowerOut(false); settle(o, 1, 6);
  assert.ok(o.debug.lamp.intensity > 0.5);
  o.setDoorOccupant("left", null);
  assert.equal(ph.group.visible, false);
  o.dispose();
});

test("office: fan spins, oscillates and exposes a sound anchor", () => {
  const o = createOffice(THREE, new THREE.Scene());
  const a0 = o.getFanState().angle; settle(o, 0.5);
  assert.ok(o.getFanState().angle > a0 + 3);
  assert.ok(o.getFanState().position.isVector3);
  assert.ok(o.anchors.fan && o.anchors.radio);
  o.dispose();
});

test("rooms: API surface, anchors, occupants", () => {
  const s = new THREE.Scene(); const r = createRooms(THREE, s);
  assert.deepEqual([...r.ids].sort(), [...EXPECTED_ROOMS].sort());
  for (const id of EXPECTED_ROOMS) {
    assert.ok(r.getRoomGroup(id).isObject3D);
    const pose = r.getCameraPose(id);
    assert.ok(pose.position.isVector3 && pose.lookAt.isVector3);
    assert.ok(pose.position.distanceTo(pose.lookAt) > 1);
    for (const c of CHAR_IDS) assert.ok(r.getAnchor(id, c).isObject3D);
    assert.ok(Math.hypot(pose.position.x, pose.position.z) > 20, "rooms stay far from the office");
  }
  assert.equal(r.getRoomGroup("office"), null);
  assert.equal(r.setOccupants("office", ["lark"]), false);
  assert.equal(r.setOccupants("dining", ["lark", "ghost", "ratchet"]), true);
  assert.deepEqual(r.getOccupants("dining"), ["lark", "ratchet"]); // unknown ids dropped, canonical order
  assert.equal(r.getAnchor("dining", "lark").visible, true);
  assert.equal(r.getAnchor("dining", "maestro").visible, false);
  r.setOccupants("dining", ["lark"]);
  assert.equal(r.getAnchor("dining", "ratchet").visible, false);
  r.usePlaceholders(false);
  assert.equal(r.getAnchor("dining", "lark").children[0].visible, false);
  r.usePlaceholders(true);
  assert.equal(r.getAnchor("dining", "lark").children[0].visible, true);
  r.setCoveCurtain(1); assert.equal(r.getCoveCurtain(), 1); r.setCoveCurtain(9); assert.equal(r.getCoveCurtain(), 1);
  r.update(0.016, 1);
  r.dispose();
});

test("rooms: only the selected room is visible", () => {
  const r = createRooms(THREE, new THREE.Scene());
  const shown = () => EXPECTED_ROOMS.filter((id) => r.getRoomGroup(id).visible);
  assert.deepEqual(shown(), []);
  r.setVisibleRoom("cove"); assert.deepEqual(shown(), ["cove"]);
  r.setVisibleRoom("kitchen"); assert.deepEqual(shown(), ["kitchen"]);
  r.setVisibleRoom("nope"); assert.deepEqual(shown(), []); assert.equal(r.getVisibleRoom(), null);
  r.dispose();
});

test("camera feed: select, state, static burst, signal lost, power", () => {
  const s = new THREE.Scene(); const r = createRooms(THREE, s); const rend = stubRenderer();
  const f = createCameraFeed(THREE, rend, s, r);
  assert.ok(f.texture); assert.equal(f.getSelected(), "showstage");
  assert.equal(f.select("dining"), true); assert.equal(f.select("office"), false); assert.equal(f.select("zzz"), false);
  assert.equal(f.getSelected(), "dining"); assert.equal(f.getState().staticBurst, true);
  f.update(0.5, 0, { active: true }); assert.equal(f.getState().staticBurst, false);
  f.select("kitchen"); assert.deepEqual([f.getState().disabled, f.getState().audioOnly], [true, true]);
  f.select("cove"); assert.equal(f.getState().disabled, false);
  f.triggerSignalLost(0.5); assert.equal(f.getState().signalLost, true);
  f.update(0.6, 1, { active: true }); assert.equal(f.getState().signalLost, false);
  f.setPowerOut(true); assert.equal(f.getState().powerOut, true);
  f.dispose(); r.dispose();
});

test("camera feed: renders only while active, ~12fps, restores renderer/scene/xr state", () => {
  const s = new THREE.Scene(); const r = createRooms(THREE, s); const rend = stubRenderer();
  s.background = new THREE.Color(0x123456); s.fog = new THREE.Fog(0x222222, 1, 10);
  const f = createCameraFeed(THREE, rend, s, r);
  f.select("hall-west"); f.update(0.5, 0, { active: true }); // burst time, drains
  const base = f.stats().framesRendered;
  for (let t = 0; t < 1; t += 1 / 60) f.update(1 / 60, 1 + t, { active: true });
  const frames = f.stats().framesRendered - base;
  assert.ok(frames >= 10 && frames <= 13, `frames ${frames}`);
  const before = rend.renders;
  for (let t = 0; t < 1; t += 1 / 60) f.update(1 / 60, 3 + t, { active: false });
  assert.equal(rend.renders, before, "no rendering when the monitor is down");
  assert.equal(s.background.getHex(), 0x123456); assert.ok(s.fog);
  assert.equal(rend.xr.enabled, true); assert.equal(rend.target, null);
  assert.ok(rend.xr.sawEnabled.every((e) => e === false), "RT passes ran with xr disabled");
  assert.equal(r.getVisibleRoom(), null, "rooms hidden again after feed pass");
  assert.ok(rend.targets.includes(f.texture ? rend.targets.find((x) => x && x.texture === f.texture) : null));
  f.dispose(); r.dispose();
});

test("camera feed: scene pass skipped for disabled/lost cameras but post pass still draws", () => {
  const s = new THREE.Scene(); const r = createRooms(THREE, s); const rend = stubRenderer();
  const f = createCameraFeed(THREE, rend, s, r, { initialRoom: "kitchen" });
  f.renderNow(0);
  assert.equal(f.stats().sceneRenders, 0); assert.equal(f.stats().framesRendered, 1); assert.equal(rend.renders, 1);
  f.select("dining"); f.update(0.5, 0, { active: false }); // drains the static burst
  f.renderNow(1); assert.equal(f.stats().sceneRenders, 1);
  f.dispose(); r.dispose();
});

test("map hit-testing: every camera hit, office/gaps miss, no overlaps", () => {
  const s = new THREE.Scene(); const r = createRooms(THREE, s);
  const f = createCameraFeed(THREE, stubRenderer(), s, r);
  const rects = f.getMapRects();
  assert.deepEqual(Object.keys(rects).sort(), [...EXPECTED_ROOMS].sort());
  for (const [id, [x, y, w, h]] of Object.entries(rects)) {
    assert.equal(f.pickCameraAt({ x: x + w / 2, y: 1 - (y + h / 2) }), id, id); // uv v is up
    assert.equal(f.pickCameraAt({ x: x + 0.01, y: 1 - (y + 0.01) }), id);
    assert.ok(x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1);
  }
  const ids = Object.keys(rects);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const [a, b] = [rects[ids[i]], rects[ids[j]]];
    const overlap = a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    assert.equal(overlap, false, `${ids[i]} overlaps ${ids[j]}`);
  }
  assert.equal(f.pickCameraAt({ x: 0.5, y: 1 - 0.84 }), null); // office marker is not a camera
  assert.equal(f.pickCameraAt({ x: 0.001, y: 0.999 }), null);
  assert.equal(f.pickCameraAt(null), null); assert.equal(f.pickCameraAt({ x: NaN, y: 0 }), null);
  f.dispose(); r.dispose();
});

test("integration: feed texture plugs into the office monitor and power-out blanks it", () => {
  const s = new THREE.Scene(); const o = createOffice(THREE, s); const r = createRooms(THREE, s);
  const f = createCameraFeed(THREE, stubRenderer(), s, r);
  o.setMonitorTextures(f.texture, f.getMapTexture());
  assert.equal(o.debug.mat.feed.map, null); // monitor still down
  o.setMonitorUp(true); assert.equal(o.debug.mat.feed.map, f.texture);
  o.setPowerOut(true); assert.equal(o.debug.mat.feed.map, null);
  f.dispose(); o.dispose(); r.dispose();
});

test("perf budget guard: draw calls, lights, materials, geometry", () => {
  const s = new THREE.Scene();
  const o = createOffice(THREE, s); const r = createRooms(THREE, s);
  const officeDraws = visibleDraws(o.group);
  assert.ok(officeDraws <= 80, `office draw calls ${officeDraws}`);
  assert.equal(lightCount(o.group), 4, "1 ambient + lamp + 2 hall lights"); // 3 real + cheap ambient
  const st = r.stats();
  assert.ok(st.maxRoomDraw <= 40, `largest room ${st.maxRoomDraw}`);
  assert.ok(officeDraws + st.maxRoomDraw <= 115, "office + current room under the 120 budget");
  assert.ok(st.geometries <= 20 && st.materials <= 140, JSON.stringify(st));
  assert.equal(lightCount(r.group), 0, "rooms add no real lights");
  // placeholder meshes are created lazily: worst case all four chars in a room
  r.setOccupants("dining", CHAR_IDS); r.setVisibleRoom("dining");
  assert.ok(officeDraws + visibleDraws(r.group) <= 120, `worst case ${officeDraws + visibleDraws(r.group)}`);
  // both door occupants lit: still within budget
  o.setDoorOccupant("left", "maestro"); o.setDoorOccupant("right", "lark"); o.setHallLight("left", true); o.setHallLight("right", true);
  assert.ok(visibleDraws(o.group) <= 95);
  o.dispose(); r.dispose();
});
