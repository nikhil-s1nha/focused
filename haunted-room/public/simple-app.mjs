import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { Director } from "./director.mjs";
import { SignalClient } from "./signal-client.mjs";
import { AudioEngine } from "./audio-engine.mjs";
import { FnafAudio } from "./fnaf/audio/fnaf-audio.mjs";
import { createSimpleRoom } from "./simple/room.mjs";
import { createFigures } from "./simple/figures.mjs";
import { ScareDirector } from "./simple/scare.mjs";
import { createCues } from "./simple/cues.mjs";
import { AdaptiveProfile } from "./simple/calibration.mjs";

const $ = (id) => document.getElementById(id);
const SIDES = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };
// ?spectate=1 is the TV view: it replays the headset's head pose and scares.
const spectate = new URLSearchParams(location.search).has("spectate");
document.body.classList.toggle("spectate", spectate);

// ---------- renderer / scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color("#030201");
scene.fog = new THREE.FogExp2(0x070503, 0.06);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 30);
const rig = new THREE.Group();
camera.position.set(0, 1.6, 0);
camera.rotation.order = "YXZ";
rig.add(camera);
scene.add(rig);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFoveation(0.666);
$("viewport").appendChild(renderer.domElement);
if (!spectate) document.body.appendChild(VRButton.createButton(renderer));

// ---------- world ----------
const room = createSimpleRoom(THREE, scene);
const figures = createFigures(THREE, scene);
const cues = createCues(THREE, scene);

// ---------- input / signal ----------
const director = new Director();
const scares = new ScareDirector({ rng: Math.random, durationSeconds: 120 });
// Calibration: a few scripted scares, then the rest adapt to this person's measured
// response. The spike metric inside is a PLACEHOLDER (see notes/simple-calibration.md).
const profile = new AdaptiveProfile({ rng: Math.random });
let adaptive = null;
const client = new SignalClient({
  onSignal(message, receiptMs) {
    director.receive(message, receiptMs / 1000);
  },
  onStatus(status) {
    if (status.error) setStatus(status.error);
  },
});
client.setMode("manual");
client.setManualValue(+$("intensity").value);

// ---------- audio (opt-in) ----------
const engine = new AudioEngine();
let sfx = null;
async function setSound(on) {
  try {
    const ok = await engine.setEnabled(on);
    if (on && ok && !sfx) sfx = new FnafAudio(engine);
    $("sound").checked = on && !!ok;
  } catch (e) {
    $("sound").checked = false;
    setStatus(`Audio unavailable: ${e.message}`);
  }
}
const sideOf = (s) => (s === "left" || s === "right" ? s : "center");
const posOf = (s) => ({ x: SIDES[s][0] * 3, z: SIDES[s][1] * 3 });
// Audio and image are timed together: sounds are scheduled against the lunge
// so the loudest hit lands as the face arrives, not when the lunge starts.
const timers = new Set();
function later(ms, fn) {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}
function cancelTimers() {
  for (const id of timers) clearTimeout(id);
  timers.clear();
}
function cue(name, opts) {
  try {
    engine.cue(name, opts);
  } catch {
    /* audio is best-effort */
  }
}
function play(name, opts) {
  try {
    sfx?.play(name, opts);
  } catch {
    /* audio is best-effort */
  }
}

// ---------- spectator link (headset publishes, TV replays) ----------
let spec = null,
  specRetry = 0,
  lastPoseSent = 0;
const poseP = new THREE.Vector3(),
  poseQ = new THREE.Quaternion();
function connectSpec() {
  try {
    spec = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/spectate`);
  } catch {
    return;
  }
  spec.onopen = () => {
    specRetry = 0;
    if (spectate) setStatus("Spectator view. Waiting for the headset...");
  };
  spec.onmessage = (m) => spectate && onSpectate(m.data);
  spec.onclose = () => {
    spec = null;
    setTimeout(connectSpec, Math.min(5000, 500 * 2 ** specRetry++));
  };
  spec.onerror = () => {};
}
function publish(obj) {
  if (!spectate && spec && spec.readyState === 1) spec.send(JSON.stringify(obj));
}
function publishPose(time) {
  if (spectate || !spec || spec.readyState !== 1 || time - lastPoseSent < 50) return;
  lastPoseSent = time;
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(poseP);
  cam.getWorldQuaternion(poseQ);
  publish({
    type: "pose",
    p: [poseP.x, poseP.y, poseP.z],
    q: [poseQ.x, poseQ.y, poseQ.z, poseQ.w],
    l: baseLight,
  });
}
function onSpectate(data) {
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (m.type === "pose") {
    camera.position.set(m.p[0], m.p[1], m.p[2]);
    camera.quaternion.set(m.q[0], m.q[1], m.q[2], m.q[3]);
    if (typeof m.l === "number") baseLight = m.l;
  } else if (m.type === "event") {
    handleScare(m.ev);
  } else if (m.type === "phase") {
    if (m.phase === "begin") {
      clearAll();
      phase = "running";
      setStatus("Live from the headset.");
    } else if (m.phase === "reset") reset();
    else if (m.phase === "end") finish(m.reason);
  }
}

// ---------- session ----------
let phase = "ready"; // ready | running | ended
let baseLight = 0.5;
let captionTimer = 0;
let nextBeat = 0;

// Doors are never shut: they rest ajar and creep, so a dark gap is always in view.
const ajar = {};
function ajarInit() {
  for (const side of Object.keys(SIDES)) {
    ajar[side] = { value: 0.05 + Math.random() * 0.1, next: 3 + Math.random() * 6 };
    room.setDoor(side, ajar[side].value, 2.5);
  }
}
function ajarTick(dt) {
  const active = scares.snapshot().activeScare?.side;
  for (const [side, a] of Object.entries(ajar)) {
    if (side === active) continue;
    a.next -= dt;
    if (a.next > 0) continue;
    a.next = 6 + Math.random() * 10;
    a.value = Math.min(0.24, Math.max(0.04, a.value + (Math.random() - 0.35) * 0.14));
    const seconds = 3 + Math.random() * 3;
    room.setDoor(side, a.value, seconds);
    creak(side, seconds);
  }
}
// A hinge creak: a sawtooth with an irregular pitch wobble through a narrow
// band, panned to the door. Quiet by design; sound stays opt-in.
function creak(side, seconds = 1.8, level = 0.1) {
  const ctx = engine.ctx;
  const out = engine.graph?.master;
  if (!engine.enabled || !ctx || !out) return;
  const t0 = ctx.currentTime;
  const t1 = t0 + seconds;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(level, t0 + Math.min(0.4, seconds / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t1);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 700;
  bp.Q.value = 6;
  const o = ctx.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(110, t0);
  for (let i = 1; i <= 6; i++) o.frequency.linearRampToValueAtTime(90 + Math.random() * 90, t0 + (seconds * i) / 6);
  o.connect(bp);
  bp.connect(g);
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (pan) {
    pan.pan.value = side === "left" ? -0.8 : side === "right" ? 0.8 : 0;
    g.connect(pan);
    pan.connect(out);
  } else g.connect(out);
  o.start(t0);
  o.stop(t1 + 0.05);
}
// Room light follows tension each frame unless a scare effect holds it.
let lightOverride = null;
function setLightFx(level) {
  lightOverride = level;
  room.setLight(level);
}
function releaseLight() {
  lightOverride = null;
}
function lightPattern(ev) {
  const secs = ev.seconds ?? 1;
  if (ev.pattern === "stutter") room.flicker(secs, 0.8);
  else if (ev.pattern === "sag") {
    setLightFx(baseLight * 0.35);
    later(secs * 1000, releaseLight);
  } else {
    setLightFx(0.03); // cut-and-return
    later(secs * 1000, releaseLight);
  }
}
function footstepsRun(ev) {
  if (!SIDES[ev.from] || !SIDES[ev.to]) return;
  const secs = ev.seconds ?? 2;
  const n = Math.max(3, Math.round(secs / 0.45));
  const a = posOf(ev.from);
  const b = posOf(ev.to);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    later((i * secs * 1000) / n, () =>
      cue("footstep", { position: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, intensity: 0.5 }),
    );
  }
}
function setStatus(text) {
  $("status").textContent = text;
}
function caption(text, seconds = 2.5) {
  const el = $("caption");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => el.classList.add("hidden"), seconds * 1000);
}
function begin() {
  if (phase === "running") return;
  clearAll();
  ajarInit();
  director.reset();
  director.start();
  scares.reset();
  scares.setHold(false);
  scares.setBeatWeights({});
  scares.start();
  profile.reset();
  profile.start();
  adaptive = null;
  phase = "running";
  $("intro").classList.add("hidden");
  $("summary").classList.add("hidden");
  setStatus("Stay still. Watch the doors.");
  sfx?.setAmbience?.("office3");
  nextBeat = 0;
  publish({ type: "phase", phase: "begin" });
}
function reset() {
  clearAll();
  ajarInit();
  director.reset();
  scares.reset();
  scares.setHold(false);
  scares.setBeatWeights({});
  profile.reset();
  adaptive = null;
  phase = "ready";
  if (!spectate) $("intro").classList.remove("hidden");
  $("summary").classList.add("hidden");
  setStatus(spectate ? "Spectator view. Waiting for the headset..." : "Ready.");
  publish({ type: "phase", phase: "reset" });
}
function clearAll() {
  cancelTimers();
  figures.clear();
  cues.clear();
  for (const s of Object.keys(SIDES)) {
    room.setDoor(s, 0);
    room.setHallLight?.(s, 0);
  }
  releaseLight();
  room.setLight(0.5);
  room.setBlackout?.(false);
  figures.setBlackout(false);
}
function finish(reason) {
  if (phase === "ended") return;
  phase = "ended";
  publish({ type: "phase", phase: "end", reason });
  director.end?.(reason);
  const caught = reason === "caught";
  $("summaryTitle").textContent = caught ? "CAUGHT" : "You survived";
  $("summaryText").textContent = caught
    ? "It was waiting behind the door you weren't watching."
    : "The room is quiet again. For now.";
  setTimeout(() => $("summary").classList.remove("hidden"), caught ? 1600 : 400);
  setStatus(caught ? "Caught." : "Survived.");
}

// ---------- scare events -> world ----------
function handleScare(ev) {
  publish({ type: "event", ev });
  switch (ev.type) {
    case "silence":
      engine.duck?.(ev.seconds ?? 0.8);
      break;
    case "lights":
      setLightFx(ev.level ?? 0.05);
      break;
    case "flicker":
      room.flicker(ev.seconds ?? 0.6, 0.7);
      play("lightBuzz", { side: "center", intensity: 0.4 });
      break;
    case "creak":
      creak(ev.side, 1.8, 0.14);
      break;
    case "breath":
      play("breathing", { side: sideOf(ev.side), intensity: 0.5 });
      break;
    case "door":
      room.setDoor(ev.side, ev.open ?? 1);
      room.setHallLight?.(ev.side, 0.08);
      play("doorSlam", { side: sideOf(ev.side), intensity: 0.6 });
      cue("knock", { position: posOf(ev.side), intensity: 0.9 });
      break;
    case "figure":
      figures.show(ev.side, ev.id);
      play("footsteps", { side: sideOf(ev.side), intensity: 0.7 });
      play("eyes", { side: sideOf(ev.side), intensity: 0.6 });
      cue("breath", { position: posOf(ev.side), intensity: 0.9 });
      cue("thump", { position: posOf(ev.side), intensity: 0.8 });
      break;
    case "hold":
      figures.hold(ev.side);
      break;
    case "retreat":
      figures.retreat(ev.side);
      room.setDoor(ev.side, ajar[ev.side]?.value ?? 0.08, 1.5);
      releaseLight();
      break;
    case "lunge": {
      const seconds = ev.seconds ?? 0.22;
      const side = ev.side;
      if (!spectate) profile.scareLunge(performance.now() / 1000, side);
      figures.lunge(side, seconds, { viewDir: viewDir() });
      cue("breath", { position: posOf(side), intensity: 1 }); // sharp intake as it moves
      later(seconds * 650, () => {
        play("jumpscare", { side: sideOf(side), intensity: 1 });
        cue("stinger", { intensity: 1 });
      });
      later(seconds * 1000, () => setLightFx(0.02)); // cut to black on contact
      break;
    }
    case "stinger":
      play("victimSting", { side: "center", intensity: 0.8 });
      break;
    case "caught":
      figures.caught(ev.side, { viewDir: viewDir() });
      break;
    case "recover":
      figures.hide(ev.side);
      room.setDoor(ev.side, ajar[ev.side]?.value ?? 0.08, 1.5);
      releaseLight();
      break;
    case "fake-door": {
      const secs = ev.seconds ?? 1.5;
      if (ev.open > 0) {
        room.setDoor(ev.side, ev.open, secs);
        creak(ev.side, secs, 0.14);
      } else room.setDoor(ev.side, ajar[ev.side]?.value ?? 0.08, Math.max(0.6, secs));
      break;
    }
    case "knock":
      for (let i = 0; i < (ev.count ?? 1); i++)
        later(i * 430, () => cue("knock", { position: posOf(ev.side), intensity: 1 }));
      break;
    case "empty-open": {
      room.setDoor(ev.side, 1, 1.8);
      creak(ev.side, 1.8, 0.16);
      room.setHallLight?.(ev.side, 0.1);
      later((ev.seconds ?? 3) * 1000, () => {
        room.setDoor(ev.side, ajar[ev.side]?.value ?? 0.08, 2);
        room.setHallLight?.(ev.side, 0);
      });
      break;
    }
    case "false-lunge": // a lunge that stops short and retreats: nothing catches you
      figures.show(ev.side, ev.id);
      play("footsteps", { side: sideOf(ev.side), intensity: 0.8 });
      later(500, () => {
        figures.lunge(ev.side, 0.55);
        cue("breath", { position: posOf(ev.side), intensity: 1 });
      });
      later(860, () => figures.retreat(ev.side));
      later(1700, () => figures.hide(ev.side));
      break;
    case "glimpse":
      figures.show(ev.side, ev.id);
      play("eyes", { side: sideOf(ev.side), intensity: 0.6 });
      later((ev.seconds ?? 0.4) * 1000, () => figures.hide(ev.side));
      break;
    case "eyes":
      cues.eyes(ev.side, ev.seconds ?? 2);
      play("eyes", { side: sideOf(ev.side), intensity: 0.5 });
      break;
    case "shadow-pass":
      cues.shadowPass(ev.side, ev.seconds ?? 1.2);
      cue("footstep", { position: posOf(ev.side), intensity: 0.5 });
      break;
    case "wall-shadow":
      cues.wallShadow(ev.side, ev.seconds ?? 2);
      break;
    case "far-figure":
      cues.farFigure(ev.side, ev.seconds ?? 4);
      break;
    case "hall-light":
      room.setHallLight?.(ev.side, ev.level ?? 0.12);
      play("lightBuzz", { side: sideOf(ev.side), intensity: 0.3 });
      later((ev.seconds ?? 2) * 1000, () => room.setHallLight?.(ev.side, 0));
      break;
    case "light-pattern":
      lightPattern(ev);
      break;
    case "footsteps":
      footstepsRun(ev);
      break;
    case "whisper":
      play("murmur", { side: sideOf(ev.side), intensity: 0.5 });
      break;
    case "heartbeat-spike":
      for (let i = 0; i < 4; i++) later(i * 260, () => cue("thump", { intensity: 0.9 }));
      break;
    case "end":
      finish(ev.reason);
      break;
  }
}

// ---------- which door is the player looking at ----------
const fwd = new THREE.Vector3();
function viewDir() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldDirection(fwd);
  const n = Math.hypot(fwd.x, fwd.z);
  return n > 1e-6 ? { x: fwd.x / n, z: fwd.z / n } : { x: 0, z: -1 };
}
function observedDoor() {
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) return null;
  fwd.normalize();
  let best = null,
    bestDot = Math.cos((38 * Math.PI) / 180);
  for (const [side, [x, z]] of Object.entries(SIDES)) {
    const d = fwd.x * x + fwd.z * z;
    if (d > bestDot) (best = side), (bestDot = d);
  }
  return best;
}

// ---------- desktop look ----------
let dragging = false,
  lastX = 0,
  lastY = 0,
  yaw = 0,
  pitch = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (spectate || renderer.xr.isPresenting) return;
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.003;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - lastY) * 0.003, -0.7, 0.7);
  camera.rotation.set(pitch, yaw, 0);
  lastX = e.clientX;
  lastY = e.clientY;
});
renderer.domElement.addEventListener("pointerup", () => (dragging = false));
renderer.domElement.addEventListener("pointercancel", () => (dragging = false));

// ---------- UI ----------
$("start").onclick = begin;
$("again").onclick = reset;
$("reset").onclick = reset;
$("sound").onchange = () => setSound($("sound").checked);
$("intensity").oninput = () => {
  client.setManualValue(+$("intensity").value);
  $("intensityValue").textContent = (+$("intensity").value).toFixed(2);
};
$("source").onchange = () => {
  const mode = $("source").value;
  director.input = null;
  director.receivedAt = -Infinity;
  client.setMode(mode);
  $("intensity").disabled = mode !== "manual";
  $("source-note").textContent =
    mode === "live"
      ? "Live stream. Waits for the publisher; hardware label is bridge-reported."
      : mode === "synthetic"
        ? "Synthetic demo signal. No hardware connected."
        : "Manual demo. No hardware connected.";
};
for (const b of document.querySelectorAll("[data-scare]"))
  b.onclick = () => {
    if (phase !== "running") begin();
    const k = b.dataset.scare;
    if (k === "caught") scares.trigger(null, null, { forceCaught: true, skipTelegraph: true });
    else scares.trigger(k, null, { skipTelegraph: true });
  };
for (const b of document.querySelectorAll("[data-fx]"))
  b.onclick = () => {
    const k = b.dataset.fx;
    if (k === "flicker") handleScare({ type: "flicker", seconds: 1.2 });
    else if (k === "cut") {
      setLightFx(0.03);
      later(700, releaseLight);
    } else if (k === "creak") handleScare({ type: "creak", side: "left" });
    else if (k === "breath") handleScare({ type: "breath", side: "right" });
  };
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const k = e.key.toLowerCase();
  if (k === " ") {
    e.preventDefault();
    phase === "running" ? null : begin();
  } else if (k === "r") {
    if (!spectate) reset();
  } else if (k === "t") $("test").open = !$("test").open;
  else if (k === "f")
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen?.();
});
if (new URLSearchParams(location.search).has("test")) $("test").open = true;

// ---------- VR controllers ----------
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  rig.add(c);
  c.addEventListener("selectstart", () => (phase === "running" ? reset() : begin()));
  c.addEventListener("squeezestart", () => {
    if (phase !== "running") begin();
    scares.trigger(null, null, { skipTelegraph: true });
  });
}
const buttonDown = new Map();
function controllerButtons() {
  for (const source of renderer.xr.getSession()?.inputSources || []) {
    const pressed = !!source.gamepad?.buttons[4]?.pressed;
    if (pressed && !buttonDown.get(source)) setSound(!engine.enabled);
    buttonDown.set(source, pressed);
  }
}
renderer.xr.addEventListener("sessionstart", () => {
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  $("vrnote").classList.add("hidden");
});
renderer.xr.addEventListener("sessionend", () => {
  camera.position.set(0, 1.6, 0);
  camera.rotation.set(pitch, yaw, 0);
  buttonDown.clear();
});

// ---------- loop ----------
let last = performance.now();
renderer.setAnimationLoop((time) => {
  const dt = Math.min(0.1, Math.max(0, (performance.now() - last) / 1000));
  last = performance.now();
  if (spectate) {
    // TV view: no game logic. Pose and scares come from the headset.
    room.update(dt, time / 1000);
    figures.update(dt, time / 1000, { tension: 0 });
    cues.update(dt, time / 1000);
    if (lightOverride === null) room.setLight(baseLight);
    renderer.render(scene, camera);
    return;
  }
  const snap = director.step(dt, performance.now() / 1000);
  const running = phase === "running";
  const tension = running ? snap.tension : 0;
  baseLight = 0.55 - 0.35 * tension;

  if (running) {
    const nowS = performance.now() / 1000;
    profile.sample(nowS, { intensity: snap.intensity, quality: snap.quality, fresh: snap.fresh });
    adaptive = profile.update(dt, nowS, { tension });
    scares.setHold(!!adaptive.suppressOthers); // calibration owns the first scares
    scares.setBeatWeights(adaptive.beatWeights);
    if (adaptive.trigger) scares.trigger(null, null, {});
    scares.update(dt, {
      tension: adaptive.effectiveTension,
      state: snap.state,
      elapsed: snap.elapsed,
      observed: observedDoor(),
    });
    for (const ev of scares.consumeEvents()) handleScare(ev);
    ajarTick(dt);
    if (snap.phase === "ended" && phase === "running") finish("survived");
  }
  room.update(dt, time / 1000);
  figures.update(dt, time / 1000, { tension });
  cues.setObserved(observedDoor());
  cues.update(dt, time / 1000);
  if (lightOverride === null) room.setLight(baseLight);
  if (engine.enabled) {
    const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    // The drone never settles during a session: a floor that rises with time
    // keeps the bed heavy even when the signal is calm.
    const dread = running
      ? Math.max(snap.tension, Math.min(0.85, 0.35 + (snap.elapsed / 120) * 0.5))
      : 0;
    const bed = running
      ? { ...snap, phase: "running", paused: false, state: dread > 0.6 ? "PEAK" : "BUILD", tension: dread, encounter: null }
      : snap;
    engine.update(bed, cam);
    sfx?.update?.(snap, cam);
    if (running) {
      const now = performance.now() / 1000;
      if (now >= nextBeat) {
        cue("thump", { intensity: 0.2 + 0.25 * dread });
        nextBeat = now + 1.15 - 0.7 * dread; // heartbeat quickens as dread rises
      }
    }
  }
  if (renderer.xr.isPresenting) controllerButtons();
  publishPose(time);
  renderer.render(scene, camera);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
addEventListener("pagehide", () => {
  client.dispose();
  engine.dispose?.();
  room.dispose();
  figures.dispose();
  cues.dispose();
});
if (spectate) {
  $("intro").classList.add("hidden");
  setStatus("Spectator view. Waiting for the headset...");
}
connectSpec();
ajarInit();
window.__simple = { spectate, cameraEuler: () => new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ"), room, figures, cues, scares, director, profile, adaptive: () => adaptive, begin, reset, state: () => ({ phase, baseLight }) };
