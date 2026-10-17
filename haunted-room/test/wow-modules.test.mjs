import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVolumetricCone } from "../public/volumetrics.mjs";
import { createGhost, GHOST_STATES } from "../public/ghost.mjs";
import { createMonitor } from "../public/monitor.mjs";

/* ------------------------------ volumetrics ------------------------------ */

test("volumetric cone: contract, uniforms, apex-at-origin -Y geometry", () => {
  const cone = createVolumetricCone(THREE, { height: 2.5, radiusBottom: 0.8 });
  assert.ok(cone.mesh.isMesh);
  assert.ok(cone.material.isShaderMaterial);
  assert.equal(typeof cone.setIntensity, "function");
  assert.equal(typeof cone.updateFrom, "function");
  assert.equal(typeof cone.dispose, "function");
  for (const name of [
    "spotPosition",
    "attenuation",
    "anglePower",
    "lightColor",
    "intensity",
  ]) {
    assert.ok(cone.material.uniforms[name], `missing uniform ${name}`);
  }
  // Stereo-safe additive glow settings.
  assert.equal(cone.material.transparent, true);
  assert.equal(cone.material.blending, THREE.AdditiveBlending);
  assert.equal(cone.material.depthWrite, false);
  assert.equal(cone.material.side, THREE.DoubleSide);
  // Apex at the local origin, body hanging down -Y.
  const geo = cone.mesh.geometry;
  geo.computeBoundingBox();
  assert.ok(Math.abs(geo.boundingBox.max.y) < 1e-6);
  assert.ok(Math.abs(geo.boundingBox.min.y + 2.5) < 1e-6);
  cone.dispose();
});

test("volumetric cone: stereo safety — built-in cameraPosition, no camera uniform", () => {
  const cone = createVolumetricCone(THREE, {});
  // The silhouette term must come from the GLSL built-in (per-eye in WebXR)...
  assert.match(cone.material.fragmentShader, /cameraPosition/);
  // ...never from a manually-updated camera uniform.
  for (const name of Object.keys(cone.material.uniforms)) {
    assert.ok(
      !/camera/i.test(name),
      `camera-dependent uniform "${name}" would break per-eye rendering`,
    );
  }
  cone.dispose();
});

test("volumetric cone: setIntensity clamps to 0..1 and rejects non-finite", () => {
  const cone = createVolumetricCone(THREE, {});
  assert.equal(cone.material.uniforms.intensity.value, 1);
  cone.setIntensity(0.4);
  assert.equal(cone.material.uniforms.intensity.value, 0.4);
  cone.setIntensity(5);
  assert.equal(cone.material.uniforms.intensity.value, 1);
  cone.setIntensity(-3);
  assert.equal(cone.material.uniforms.intensity.value, 0);
  cone.setIntensity(NaN);
  assert.equal(cone.material.uniforms.intensity.value, 0);
  cone.dispose();
});

test("volumetric cone: updateFrom tracks an emitter's world position", () => {
  const scene = new THREE.Scene();
  const lamp = new THREE.Object3D();
  lamp.position.set(1.5, 2.6, -3);
  const rig = new THREE.Object3D();
  rig.position.x = 0.5;
  rig.add(lamp);
  scene.add(rig);
  const cone = createVolumetricCone(THREE, {});
  scene.add(cone.mesh);
  cone.updateFrom(lamp);
  const p = cone.material.uniforms.spotPosition.value;
  assert.ok(Math.abs(p.x - 2.0) < 1e-9); // parent offset included
  assert.ok(Math.abs(p.y - 2.6) < 1e-9);
  assert.ok(Math.abs(p.z + 3) < 1e-9);
  cone.updateFrom(null); // must not throw
  cone.dispose();
  cone.dispose(); // idempotent
});

test("volumetric cone: dispose releases geometry and material", () => {
  const cone = createVolumetricCone(THREE, {});
  let geoDisposed = false;
  let matDisposed = false;
  cone.mesh.geometry.addEventListener("dispose", () => (geoDisposed = true));
  cone.material.addEventListener("dispose", () => (matDisposed = true));
  cone.dispose();
  assert.equal(geoDisposed, true);
  assert.equal(matDisposed, true);
});

/* --------------------------------- ghost --------------------------------- */

const PLAYER = { x: 0, z: 2 };
const vis = (over = {}) => ({
  tension: 0.2,
  state: "BUILD",
  quality: 0.9,
  phase: "running",
  ...over,
});
const runGhost = (g, seconds, visuals, dt = 0.05) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) g.update(dt, t, visuals);
};
const ghostDist = (g) =>
  Math.hypot(g.group.position.x - PLAYER.x, g.group.position.z - PLAYER.z);

test("ghost: contract — hidden by default at corridor spawn", () => {
  const scene = new THREE.Scene();
  const before = scene.children.length;
  const g = createGhost(THREE, scene);
  assert.equal(scene.children.length, before + 1);
  assert.ok(g.group.isObject3D);
  assert.equal(typeof g.update, "function");
  assert.equal(typeof g.setState, "function");
  assert.equal(typeof g.dispose, "function");
  assert.deepEqual(GHOST_STATES, ["hidden", "apparition", "stalk", "banished"]);
  assert.equal(g.state, "hidden");
  assert.equal(g.group.visible, false);
  assert.equal(g.group.position.x, 0);
  assert.equal(g.group.position.z, -7);
  // Options override the spawn point.
  const g2 = createGhost(THREE, scene, { position: { x: 1, y: 0, z: -6 } });
  assert.equal(g2.group.position.x, 1);
  assert.equal(g2.group.position.z, -6);
  g.dispose();
  g2.dispose();
});

test("ghost: fades in only at PEAK with tension > 0.6", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  const body = g.group.getObjectByName("ghost-body");
  // High tension outside PEAK: stays hidden.
  runGhost(g, 5, vis({ tension: 0.9, state: "BUILD" }));
  assert.equal(g.state, "hidden");
  assert.equal(g.group.visible, false);
  // PEAK but tension too low: stays hidden.
  runGhost(g, 5, vis({ tension: 0.5, state: "PEAK" }));
  assert.equal(g.state, "hidden");
  // PEAK and hot: apparition fades in gradually.
  runGhost(g, 0.3, vis({ tension: 0.75, state: "PEAK" }));
  assert.equal(g.state, "apparition");
  assert.equal(g.group.visible, true);
  const early = body.material.opacity;
  assert.ok(early > 0 && early < 0.9, `partial fade expected, got ${early}`);
  runGhost(g, 4, vis({ tension: 0.75, state: "PEAK" }));
  assert.ok(body.material.opacity > early);
  assert.ok(body.material.opacity > 0.85); // near full presence
  // Apparition holds position (no stalking yet at spawn).
  assert.equal(g.group.position.z, -7);
  g.dispose();
});

test("ghost: sustained PEAK escalates apparition -> stalk and it advances", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  const hot = vis({ tension: 0.8, state: "PEAK" });
  runGhost(g, 1, hot);
  assert.equal(g.state, "apparition");
  runGhost(g, 6, hot); // stalkDelay is 5s of sustained heat
  assert.equal(g.state, "stalk");
  const z0 = g.group.position.z;
  runGhost(g, 10, hot);
  assert.ok(g.group.position.z > z0, "stalk must drift toward the player");
  g.dispose();
});

test("ghost: stalk never crosses z >= 0.5 nor within 1.5m of the player", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  g.setState("stalk");
  const hot = vis({ tension: 0.9, state: "PEAK" });
  const dt = 0.05;
  for (let t = 0; t < 180; t += dt) {
    g.update(dt, t, hot);
    assert.ok(
      g.group.position.z <= 0.5 + 1e-6,
      `crossed the door line: z=${g.group.position.z} at t=${t.toFixed(2)}`,
    );
    assert.ok(
      ghostDist(g) >= 1.5 - 1e-6,
      `breached player bubble: d=${ghostDist(g)} at t=${t.toFixed(2)}`,
    );
  }
  // It converges onto the limits rather than stopping short forever.
  assert.ok(g.group.position.z > -1, "should have closed most of the distance");
  g.dispose();
});

test("ghost: stalk flicker hides for 1-2 frames and never strobes above ~2 Hz", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  g.setState("stalk");
  const hot = vis({ tension: 0.9, state: "PEAK" });
  runGhost(g, 3, hot); // settle fade-in
  const dt = 0.05;
  let hideEvents = 0;
  let longestHide = 0;
  let currentHide = 0;
  let prevVisible = g.group.visible;
  for (let t = 0; t < 10; t += dt) {
    g.update(dt, t, hot);
    if (!g.group.visible) {
      currentHide += 1;
      if (prevVisible) hideEvents += 1;
      longestHide = Math.max(longestHide, currentHide);
    } else {
      currentHide = 0;
    }
    prevVisible = g.group.visible;
  }
  assert.ok(hideEvents >= 1, "stalk should flicker at least once in 10s");
  assert.ok(hideEvents <= 20, `sustained strobe: ${hideEvents} events in 10s`);
  assert.ok(longestHide <= 2, `hide lasted ${longestHide} frames (max 2)`);
  g.dispose();
});

test("ghost: WAIT/RELIEF banishes, fade-out reaches hidden; light capped at 2", () => {
  const scene = new THREE.Scene();
  const g = createGhost(THREE, scene);
  let light = null;
  g.group.traverse((o) => {
    if (o.isPointLight) light = o;
  });
  assert.ok(light, "eye light exists");
  assert.equal(light.intensity, 0); // dark while hidden
  // Manifest, then drop the feed.
  runGhost(g, 8, vis({ tension: 0.85, state: "PEAK" }));
  assert.notEqual(g.state, "hidden");
  assert.ok(light.intensity > 0);
  assert.ok(light.intensity <= 2 + 1e-9, `eye light too bright: ${light.intensity}`);
  g.update(0.05, 0, vis({ tension: 0, state: "WAIT" }));
  assert.equal(g.state, "banished");
  runGhost(g, 3, vis({ tension: 0, state: "WAIT" }));
  assert.equal(g.state, "hidden");
  assert.equal(g.group.visible, false);
  assert.equal(light.intensity, 0);
  // RELIEF banishes too, as does poor signal quality.
  g.setState("stalk");
  runGhost(g, 1, vis({ tension: 0.9, state: "PEAK" })); // regain presence
  g.update(0.05, 0, vis({ tension: 0.9, state: "RELIEF" }));
  assert.equal(g.state, "banished");
  g.setState("stalk");
  runGhost(g, 1, vis({ tension: 0.9, state: "PEAK" }));
  g.update(0.05, 0, vis({ tension: 0.9, state: "PEAK", quality: 0.2 }));
  assert.equal(g.state, "banished");
  g.dispose();
});

test("ghost: dispose restores the scene and survives further calls", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Group()); // unrelated content survives
  const before = scene.children.length;
  const g = createGhost(THREE, scene);
  assert.equal(scene.children.length, before + 1);
  g.dispose();
  assert.equal(scene.children.length, before);
  g.update(0.05, 0, vis()); // must not throw after dispose
  g.setState("stalk"); // ignored after dispose
  assert.equal(g.state, "hidden");
  g.dispose(); // idempotent
});

/* -------------------------------- monitor -------------------------------- */

function makeStubRenderer({ presenting = false } = {}) {
  const stub = {
    renderCount: 0,
    setTargetCalls: [],
    visibleDuringRender: [],
    monitor: null, // set by tests that want visibility probing
    xr: { isPresenting: presenting },
  };
  stub.setRenderTarget = (t) => stub.setTargetCalls.push(t);
  stub.render = () => {
    stub.renderCount += 1;
    if (stub.monitor) stub.visibleDuringRender.push(stub.monitor.group.visible);
  };
  return stub;
}

const mvis = (over = {}) => ({ tension: 0.3, lighting: true, ...over });

test("monitor: contract — prop in scene at the cabinet by default", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const before = scene.children.length;
  const m = createMonitor(THREE, stub, scene);
  assert.equal(scene.children.length, before + 1);
  assert.ok(m.group.isObject3D);
  assert.equal(typeof m.update, "function");
  assert.equal(typeof m.setFeed, "function");
  assert.equal(typeof m.dispose, "function");
  assert.equal(m.group.position.x, -2.55);
  assert.equal(m.group.position.y, 1.4);
  assert.equal(m.group.position.z, -3.7);
  assert.ok(m.group.getObjectByName("monitor-screen"));
  assert.ok(m.group.getObjectByName("monitor-static"));
  assert.ok(m.group.getObjectByName("monitor-led"));
  m.dispose();
});

test("monitor: renders the RT every 4th update with save/restore and self-hide", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  stub.monitor = m;
  for (let i = 0; i < 12; i++) m.update(0.016, i * 0.016, mvis());
  assert.equal(stub.renderCount, 3); // updates 4, 8, 12
  // Each render saves + restores the target: setRenderTarget(rt), then (null).
  assert.equal(stub.setTargetCalls.length, 6);
  assert.equal(stub.setTargetCalls[1], null);
  assert.ok(stub.setTargetCalls[0]); // the render target itself
  // Feedback-loop guard: the monitor hides itself during its own RT pass...
  assert.deepEqual(stub.visibleDuringRender, [false, false, false]);
  // ...and is visible again afterwards, with scene state restored.
  assert.equal(m.group.visible, true);
  assert.equal(scene.background, null);
  m.dispose();
});

test("monitor: RT skipped when lighting is disabled", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  for (let i = 0; i < 12; i++) m.update(0.016, 0, mvis({ lighting: false }));
  assert.equal(stub.renderCount, 0);
  m.dispose();
});

test("monitor: RT skipped while XR is presenting unless xrSafe is opted in", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer({ presenting: true });
  const m = createMonitor(THREE, stub, scene);
  for (let i = 0; i < 12; i++) m.update(0.016, 0, mvis());
  assert.equal(stub.renderCount, 0); // default: never re-render RT in XR
  m.dispose();
  const m2 = createMonitor(THREE, stub, scene, { xrSafe: true });
  for (let i = 0; i < 12; i++) m2.update(0.016, 0, mvis());
  assert.equal(stub.renderCount, 3); // explicit opt-in allows it
  m2.dispose();
});

test("monitor: setFeed(-1) kills the feed (static only), setFeed(0) restores it", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  const screen = m.group.getObjectByName("monitor-screen");
  const overlay = m.group.getObjectByName("monitor-static");
  m.setFeed(-1);
  for (let i = 0; i < 12; i++) m.update(0.016, 0, mvis());
  assert.equal(stub.renderCount, 0);
  assert.equal(screen.material.map, null); // no RT sampling at all
  assert.ok(overlay.material.opacity >= 0.55); // dead channel reads as static
  m.setFeed(0);
  for (let i = 0; i < 8; i++) m.update(0.016, 0, mvis());
  assert.equal(stub.renderCount, 2);
  assert.ok(screen.material.map);
  m.dispose();
});

test("monitor: options.enabled=false makes update a cheap no-op", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene, { enabled: false });
  const overlay = m.group.getObjectByName("monitor-static");
  const op = overlay.material.opacity;
  for (let i = 0; i < 20; i++) m.update(0.016, 0, mvis({ tension: 0.95 }));
  assert.equal(stub.renderCount, 0);
  assert.equal(overlay.material.opacity, op); // untouched: early return
  m.dispose();
});

test("monitor: static opacity rises with tension and spikes past 0.7", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  const overlay = m.group.getObjectByName("monitor-static");
  m.update(0.016, 0, mvis({ tension: 0.1 }));
  const calm = overlay.material.opacity;
  m.update(0.016, 0, mvis({ tension: 0.5 }));
  const mid = overlay.material.opacity;
  m.update(0.016, 0, mvis({ tension: 0.9 }));
  const peak = overlay.material.opacity;
  assert.ok(mid > calm, `static should rise with tension (${calm} -> ${mid})`);
  assert.ok(peak > mid);
  assert.ok(peak >= 0.8, `entity-active spike expected, got ${peak}`);
  assert.ok(calm < 0.2, "calm baseline stays subtle");
  m.dispose();
});

test("monitor: surveillance console — four default zone cameras", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  const cam = m.getCamera();
  assert.equal(cam.count, 4);
  assert.equal(cam.index, 0);
  assert.equal(cam.zone, "far-corner");
  assert.match(cam.label, /^CAM 01/);
  m.selectCamera(1);
  assert.equal(m.getCamera().zone, "doorway");
  assert.match(m.getCamera().label, /DOORWAY/);
  m.selectCamera(2);
  assert.equal(m.getCamera().zone, "cabinet");
  m.selectCamera(3);
  assert.equal(m.getCamera().zone, "rear");
  // Invalid selections are ignored (never kill the feed, unlike setFeed).
  m.selectCamera(99);
  m.selectCamera(-1);
  m.selectCamera(1.5);
  m.selectCamera("doorway");
  assert.equal(m.getCamera().index, 3);
  // Legacy camera option shape still works, with generated metadata.
  const m2 = createMonitor(THREE, stub, scene, {
    cameras: [{ position: [0, 2, -8], lookAt: [0, 1, 0] }],
  });
  assert.equal(m2.getCamera().count, 1);
  assert.equal(m2.getCamera().zone, "cam-0");
  assert.equal(m2.getCamera().label, "CAM 01");
  m.dispose();
  m2.dispose();
});

test("monitor: setActive(false) puts the console down — no RT cost, dark tube", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  const screen = m.group.getObjectByName("monitor-screen");
  const overlay = m.group.getObjectByName("monitor-static");
  assert.equal(m.isActive(), true);
  m.setActive(false);
  assert.equal(m.isActive(), false);
  for (let i = 0; i < 12; i++) m.update(0.016, 0, mvis({ tension: 0.9 }));
  assert.equal(stub.renderCount, 0); // monitor down => no feed renders
  assert.equal(screen.material.map, null); // tube off
  assert.ok(overlay.material.opacity < 0.1, "static dies with the tube");
  m.setActive(true);
  assert.equal(m.isActive(), true);
  for (let i = 0; i < 12; i++) m.update(0.016, 0, mvis());
  assert.equal(stub.renderCount, 3); // cadence resumes
  assert.ok(screen.material.map); // feed restored
  m.dispose();
  assert.equal(m.isActive(), false); // disposed is never "active"
});

test("monitor: getWatchedZone contract for entity AI", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  assert.equal(m.getWatchedZone(), "far-corner"); // active by default, CAM 01
  m.selectCamera(1);
  assert.equal(m.getWatchedZone(), "doorway");
  m.setActive(false); // monitor down => not observing anything
  assert.equal(m.getWatchedZone(), null);
  m.setActive(true);
  assert.equal(m.getWatchedZone(), "doorway");
  m.setSignalLost(true); // full static => player can't actually see the zone
  assert.equal(m.getWatchedZone(), null);
  m.setSignalLost(false);
  assert.equal(m.getWatchedZone(), "doorway");
  m.setFeed(-1); // dead channel
  assert.equal(m.getWatchedZone(), null);
  m.setFeed(2);
  assert.equal(m.getWatchedZone(), "cabinet");
  m.dispose();
  assert.equal(m.getWatchedZone(), null);
});

test("monitor: staticBurst spikes the overlay then decays back", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  const overlay = m.group.getObjectByName("monitor-static");
  m.update(0.016, 0, mvis({ tension: 0.2 }));
  const calm = overlay.material.opacity;
  assert.ok(calm < 0.2);
  m.staticBurst(0.5);
  assert.ok(m.getState().burstRemaining > 0.4);
  m.update(0.016, 0, mvis({ tension: 0.2 }));
  assert.ok(
    overlay.material.opacity >= 0.9,
    `burst should read as heavy interference, got ${overlay.material.opacity}`,
  );
  // Burst does NOT suppress the live feed (it's interference, not loss).
  assert.equal(m.getWatchedZone(), "far-corner");
  // After the burst window the overlay settles back to the tension baseline.
  for (let i = 0; i < 40; i++) m.update(0.025, 0, mvis({ tension: 0.2 }));
  assert.equal(m.getState().burstRemaining, 0);
  assert.ok(overlay.material.opacity < 0.2, "burst must decay");
  // Non-finite / absurd durations are clamped, never NaN state.
  m.staticBurst(NaN);
  assert.ok(m.getState().burstRemaining > 0);
  m.staticBurst(999);
  assert.ok(m.getState().burstRemaining <= 3);
  m.dispose();
});

test("monitor: setSignalLost => full static, no RT renders, then restores", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  const screen = m.group.getObjectByName("monitor-screen");
  const overlay = m.group.getObjectByName("monitor-static");
  m.setSignalLost(true);
  for (let i = 0; i < 12; i++) m.update(0.016, 0, mvis({ tension: 0.1 }));
  assert.equal(stub.renderCount, 0); // lost channel never re-renders the RT
  assert.equal(screen.material.map, null);
  assert.ok(overlay.material.opacity >= 0.95, "lost signal is full static");
  assert.equal(m.getOsd().signalLost, true);
  assert.equal(m.getState().signalLost, true);
  m.setSignalLost(false);
  for (let i = 0; i < 8; i++) m.update(0.016, 0, mvis({ tension: 0.1 }));
  assert.equal(stub.renderCount, 2);
  assert.ok(screen.material.map);
  assert.equal(m.getOsd().signalLost, false);
  m.dispose();
});

test("monitor: OSD state — label, REC blink, session timestamp", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const m = createMonitor(THREE, stub, scene);
  m.selectCamera(1);
  m.update(0.016, 0, mvis({ elapsed: 65 }));
  let osd = m.getOsd();
  assert.equal(osd.label, "CAM 02 — DOORWAY");
  assert.equal(osd.zone, "doorway");
  assert.equal(osd.timestamp, "00:01:05");
  assert.equal(osd.signalLost, false);
  // Timestamp follows the director's elapsed clock; falls back to internal.
  m.update(0.016, 0, mvis({ elapsed: 3723 }));
  assert.equal(m.getOsd().timestamp, "01:02:03");
  m.update(0.016, 0, mvis({ elapsed: NaN }));
  assert.match(m.getOsd().timestamp, /^00:00:0\d$/); // internal clock fallback
  // REC blinks at ~0.5 Hz: both phases occur within 2.5 simulated seconds.
  const phases = new Set();
  for (let i = 0; i < 50; i++) {
    m.update(0.05, 0, mvis());
    phases.add(m.getOsd().rec);
  }
  assert.deepEqual([...phases].sort(), [false, true]);
  // Dead channel reads as NO FEED, no zone.
  m.setFeed(-1);
  m.update(0.016, 0, mvis());
  osd = m.getOsd();
  assert.equal(osd.label, "NO FEED");
  assert.equal(osd.zone, null);
  m.dispose();
});

test("monitor: dispose restores the scene and further calls are safe", () => {
  const scene = new THREE.Scene();
  const stub = makeStubRenderer();
  const before = scene.children.length;
  const m = createMonitor(THREE, stub, scene);
  assert.equal(scene.children.length, before + 1);
  m.dispose();
  assert.equal(scene.children.length, before);
  m.update(0.016, 0, mvis()); // no-op, must not throw
  m.setFeed(1); // ignored after dispose
  assert.equal(stub.renderCount, 0);
  m.dispose(); // idempotent
});
