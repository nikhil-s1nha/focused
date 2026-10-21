import { EventDirector } from "./simple/event-director.mjs";
import { Lives } from "./simple/lives.mjs";
import { createVrStart } from "./simple/vr-start.mjs";
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
import { installSignalLink } from "./signal-link/adapter.mjs";
import { mountSignalLinkPanel } from "./signal-link/panel.mjs";

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
// Hackathon defaults to the self-contained show; sensor adaptation remains opt-in.
const eventDriven = new URLSearchParams(location.search).get('mode') !== 'demo';
const adaptiveMode = new URLSearchParams(location.search).get("mode") === "adaptive";
let partnerNotifications = Promise.resolve();
const eventDirector = new EventDirector({cadenceSeconds:5,emit:event=>{
  partnerNotifications = partnerNotifications.then(()=>fetch('/signal-link/game',{method:'POST',signal:AbortSignal.timeout(2000),headers:{'Content-Type':'application/json'},body:JSON.stringify(event)})).then(r=>{if(!r.ok)throw Error('Notification rejected');}).catch(()=>setStatus('Partner notification failed; check server connection'));
}});
const director = new Director();
const scares = new ScareDirector({ rng: Math.random, durationSeconds: 120, variableTiming: true });
// Calibration: a few scripted scares, then the rest adapt to this person's measured
// response. The spike metric inside is a PLACEHOLDER (see notes/simple-calibration.md).
const profile = new AdaptiveProfile({ rng: Math.random, config: { firstScareAt: 5 + Math.random() * 5, calibrationGap: 9, calibrationJitter: 3 } });
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
engine.setBoost(3);
engine.setVolume(1); // Full game volume; headset buttons control listening level.
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
// Unlock audio in the browser gesture that enters immersive VR.
// START also resumes it, so there is no separate sound opt-in step.
document.addEventListener('click',e=>{
  if(e.target.closest?.('#VRButton'))setSound(true);
},true);
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
  $("stop").disabled = false;
      setStatus("Live from the headset.");
    } else if (m.phase === "reset") reset();
    else if (m.phase === "end") finish(m.reason);
  }
}

// ---------- session ----------
const lives = new Lives(5);
let attackId=0;
function drawLives(){
  $("lives").textContent="♥".repeat(lives.remaining)+"♡".repeat(5-lives.remaining)+"  "+lives.remaining+" / 5 LIVES";
  $("lives").style.color=lives.remaining<=2?"#ff6666":"#f4dba5";
}
let roundEndsAt = 0;
let nextEmptyDarkness = 0;
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
    setLightFx(0); // existing cut-and-return pattern
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
  setSound(true);
  clearAll();
  lives.reset();drawLives();
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
  if(eventDriven)eventDirector.start(crypto.randomUUID());
  roundEndsAt = performance.now()+120000;
  nextDesktopPop = performance.now()/1000 + 4 + Math.random()*4;
  desktopDoorBusy.clear();
  lastDesktopDoor = null; lastApproach = null;
  nextMood = 0; nextFlicker = performance.now()/1000+3; nextFeint = performance.now()/1000+5;
  $("intro").classList.add("hidden");
  $("summary").classList.add("hidden");
  setStatus("Stay still. Watch the doors.");
  sfx?.setAmbience?.("office3");
  nextBeat = 0;
  nextEmptyDarkness = 3 + Math.random() * 6;
  publish({ type: "phase", phase: "begin" });
}
function reset() {
  eventDirector.stop();
  clearAll();
  lives.reset();drawLives();
  ajarInit();
  director.reset();
  scares.reset();
  scares.setHold(false);
  scares.setBeatWeights({});
  profile.reset();
  adaptive = null;
  phase = "ready";
  $("stop").disabled = true;
  if (!spectate) $("intro").classList.remove("hidden");
  $("summary").classList.add("hidden");
  setStatus(spectate ? "Spectator view. Waiting for the headset..." : "Ready.");
  publish({ type: "phase", phase: "reset" });
}
function clearAll() {
  clearReactionIndicator();
  cancelTimers();
  desktopDoorBusy.clear();
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
  $("stop").disabled = true;
  setSound(false);
  eventDirector.stop();
  clearAll();
  publish({ type: "phase", phase: "end", reason });
  director.end?.(reason);
  const caught = reason === "caught";
  $("summaryTitle").textContent = caught ? "GAME OVER" : reason === "stopped" ? "Game stopped" : "You survived";
  $("summaryText").textContent = caught
    ? "You lost all five lives. Click Try again or the VR PLAY AGAIN button."
    : reason === "stopped" ? "Session ended. Check Signal Scope status for confirmation." : "The room is quiet again. For now.";
  later(caught ? 1600 : 400, () => $("summary").classList.remove("hidden"));
  setStatus(caught ? "Caught." : reason === "stopped" ? "Stopped." : "Survived.");
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
      if (!spectate && !eventDriven) profile.scareLunge(performance.now() / 1000, side);
      const ignored = observedDoor() !== side;
      if(phase==="running"&&!spectate && lives.attack(++attackId,!ignored)) {
        drawLives();
        setStatus(`Caught from ${side}! ${lives.remaining} lives left.`);
        if(lives.remaining===0) later(550,()=>finish("caught"));
      }
      const forward = viewDir();
      const door = SIDES[side];
      const lateral = door[0] * -forward.z + door[1] * forward.x;
      // Behind the player has no unique screen side; alternate the edge randomly.
      const edge = Math.abs(lateral) > .05 ? Math.sign(lateral) : (Math.random() < .5 ? -1 : 1);
      figures.lunge(side, seconds, ignored ? { viewDir: forward, entrySide: edge } : {});
      cue("breath", { position: posOf(side), intensity: 1 }); // sharp intake as it moves
      later(seconds * 650, () => {
        play(ev.sound ?? "jumpscare", { side: sideOf(side), intensity: 1 });
        cue("stinger", { intensity: 1 });
      });
      // Keep the arriving face visible; a blackout no longer marks every impact.
      break;
    }
    case "stinger":
      play("victimSting", { side: "center", intensity: 0.8 });
      break;
    case "caught":
      figures.caught(ev.side);
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
$("again").onclick = begin;
$("reset").onclick = reset;
$("sound").onchange = () => setSound($("sound").checked);
$("audioBoost").onchange = () => engine.setBoost(Number($("audioBoost").value));
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
    const k = b.dataset.scare;
    if (controllerTestMode && !renderer.xr.isPresenting && SIDES[k]) {
      nextDesktopPop = performance.now() / 1000 + 10;
      reset();
      $("intro").classList.add("hidden");
      const [x,z] = SIDES[k];
      yaw = Math.atan2(-x,-z) + .22;
      pitch = 0;
      camera.rotation.set(pitch,yaw,0);
      setLightFx(.65);
      room.setDoor(k,1,.2);
      figures.show(k,b.dataset.character || "bellwether");
      setStatus(`Desktop preview: ${k} door — lunge in one second.`);
      later(1000,()=>{
        handleScare({type:"lunge",side:k,seconds:.13});
        setStatus(`Desktop preview: ${k} door. Choose another door to replay.`);
      });
      later(2200,()=>{ figures.hide(k);room.setDoor(k,.08,.5); });
      return;
    }
    if (phase !== "running") begin();
    if (k === "caught") scares.trigger(null, null, { forceCaught: true, skipTelegraph: true });
    else scares.trigger(k, b.dataset.character || null, { skipTelegraph: true });
  };
function applyExistingEffect(kind, options = {}) {
  const seconds = Math.max(.25, Math.min(2, options.seconds ?? 1.6));
  const strength = Math.max(0, Math.min(1, options.strength ?? 1));
  if (kind === "flicker") lightPattern({ pattern:"stutter", seconds });
  else if (kind === "cut") { setLightFx(Math.max(0, baseLight * (1 - strength))); later(seconds * 1000, releaseLight); }
  else if (kind === "creak") handleScare({type:"creak",side:"left"});
  else if (kind === "breath") handleScare({type:"breath",side:"right"});
  else if (kind === "door") { handleScare({type:"fake-door",side:"left",open:strength,seconds}); later(seconds * 1000,()=>room.setDoor("left",ajar.left?.value ?? .08,1)); }
  else return false;
  return true;
}
for (const b of document.querySelectorAll("[data-fx]")) b.onclick=()=>applyExistingEffect(b.dataset.fx);
$("stop").onclick = () => { if (phase === "running") finish("stopped"); };
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && phase === "running") { finish("stopped"); return; }
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const k = e.key.toLowerCase();
  if (k === " ") {
    e.preventDefault();
    phase === "running" ? null : begin();
  } else if (k === "r") {
    if (!spectate) reset();
  } else if (k === "t") return;
  else if (k === "f")
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen?.();
});
const controllerTestMode = new URLSearchParams(location.search).has("test");
if (controllerTestMode) $("test").open = true;
// Desktop test page also plays a continuous ambient scare loop without clicks.
let nextDesktopPop = performance.now() / 1000 + 4 + Math.random() * 5;
let lastDesktopDoor = null;
let lastApproach = null;
const desktopDoorBusy = new Map();
let moodLevel = .45, moodTarget = .38;
let nextMood = 0, nextFlicker = 0, nextFeint = 0;
function showActive() {
  return !spectate && (((eventDriven || !adaptiveMode) && phase === "running") ||
    (controllerTestMode && !renderer.xr.isPresenting && phase === "ready"));
}
function desktopAtmosphereTick(now, dt) {
  if (!showActive()) return;
  if (now >= nextMood) {
    moodTarget = [.18,.27,.38,.5][Math.floor(Math.random()*4)];
    nextMood = now + 4 + Math.random()*8;
  }
  moodLevel += (moodTarget-moodLevel)*(1-Math.exp(-dt/1.8));
  baseLight = moodLevel * (1 + .025*Math.sin(now*.71));
  if (now >= nextFlicker) {
    const r=Math.random();
    lightPattern({pattern:r<.6?"stutter":r<.88?"sag":"cut-return",seconds:r<.88?1+Math.random()*1.3:.5+Math.random()});
    nextFlicker=now+5+Math.random()*12;
  }
  if(eventDriven)return; // Partner director still owns door encounters.
  if (now >= nextFeint) {
    const doors=Object.keys(SIDES).filter(side=>(desktopDoorBusy.get(side)||0)<=now);
    if (doors.length) {
      const side=doors[Math.floor(Math.random()*doors.length)];
      const seconds=1.1+Math.random()*1.8;
      desktopDoorBusy.set(side,now+seconds+1);
      // Empty door movement: no figure and no queued attack behind this feint.
      room.setDoor(side,.12+Math.random()*.35,.4+Math.random()*.6);
      creak(side,seconds,.16);
      if(Math.random()<.45) room.setHallLight(side,.08+Math.random()*.12);
      later(seconds*1000,()=>{room.setDoor(side,.03,.5);room.setHallLight(side,0);});
    }
    nextFeint=now+4+Math.random()*10;
  }
}

function desktopPopTick(now) {
  if (!showActive()) return;
  let plan=null;
  if(eventDriven){if(phase!=="running")return;plan=eventDirector.tick();if(!plan)return;}
  else if(now < nextDesktopPop)return;
  const choices = Object.keys(SIDES).filter(side => side !== lastDesktopDoor && (desktopDoorBusy.get(side) || 0) <= now);
  if (!choices.length) return;
  const side = plan?.door || choices[Math.floor(Math.random() * choices.length)];
  lastDesktopDoor = side;
  nextDesktopPop = now + 6 + Math.random() * 9;
  $("intro").classList.add("hidden");
  desktopDoorBusy.set(side,now+3);
  room.setDoor(side,1,.2);
  const cast = ["bellwether", "lark", "ratchet", "maestro", "momo", "pennywise"];
  if(!plan || !["feint","lighting","audio"].includes(plan.kind)) figures.show(side,plan?.character || cast[Math.floor(Math.random()*cast.length)]);
  setStatus(renderer.xr.isPresenting ? "Watch all four doors. A/X toggles sound." : "Random encounters active. Drag to look around.");
  const variants=["crawl","creep","watcher","retreat","rush"].filter(v=>v!==lastApproach);
  const variant=plan?.kind || variants[Math.floor(Math.random()*variants.length)];
  lastApproach=variant;
  let wait=700+Math.random()*600, attacks=true;
  if(variant==="feint"||variant==="lighting"||variant==="audio") {
    attacks=false;wait=1800+Math.random()*1200;
    if(variant==="feint"){room.setDoor(side,.25,.6);creak(side,2,.18);}
    if(variant==="lighting")lightPattern({pattern:Math.random()<.5?'sag':'stutter',seconds:1.5});
    if(variant==="audio")play(Math.random()<.5?'murmur':'ventCrawl',{side:sideOf(side),intensity:.7});
  } else if(variant==="crawl") {
    wait=2200+Math.random()*1400;
    figures.approach(side,{crawl:true,seconds:wait/1000,distance:1.8});
    play("ventCrawl",{side:sideOf(side),intensity:.8});
  } else if(variant==="creep") {
    wait=3000+Math.random()*1500;
    figures.approach(side,{seconds:wait/1000,distance:1.5});
    play("breathing",{side:sideOf(side),intensity:.6});
    later(wait*.6,()=>play("footsteps",{side:sideOf(side),intensity:.8}));
  } else if(variant==="watcher") {
    wait=2500+Math.random()*2500;
    figures.hold(side);
    attacks=Math.random()<.5;
    play("murmur",{side:sideOf(side),intensity:.45});
  } else if(variant==="retreat") {
    wait=2600+Math.random()*1200;
    play("laugh",{side:sideOf(side),intensity:.6});
    later(900,()=>figures.retreat(side));
    later(wait-300,()=>figures.show(side,cast[Math.floor(Math.random()*cast.length)]));
  } else {
    play(Math.random()<.5?"doorBang":"scream",{side:sideOf(side),intensity:.8});
  }
  desktopDoorBusy.set(side,now+wait/1000+2);
  nextDesktopPop=Math.max(nextDesktopPop,now+wait/1000+3);
  later(wait,()=>{
    if(attacks) handleScare({type:"lunge",side,seconds:.10+Math.random()*.06,sound:Math.random()<.5?"scream":"jumpscare"});
    else figures.retreat(side);
  });
  later(wait+1100,()=>{figures.hide(side);room.setDoor(side,.08,.5);if(plan)eventDirector.finish();showScareIndicator();});
}


// ---------- VR controllers ----------
const vrStart=createVrStart(THREE,scene);
const startControllers=[];
let startPresented=false;
function updateVrStart(){
  const show=renderer.xr.isPresenting && phase!=="running" && !spectate;
  if(show && !startPresented) vrStart.show(renderer.xr.getCamera(),phase==="ended");
  if(!show) vrStart.hide();
  startPresented=show;
  let hover=false;
  for(const {controller,line} of startControllers){
    line.visible=show && !!controller.userData.connected;
    if(line.visible&&vrStart.hit(controller))hover=true;
  }
  if(show)vrStart.paint(phase==="ended",hover);
}

for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  rig.add(c);
  const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-3)]),new THREE.LineBasicMaterial({color:0xffdf96,depthTest:false}));
  line.renderOrder=101;line.visible=false;c.add(line);startControllers.push({controller:c,line});
  c.addEventListener("connected",()=>{c.userData.connected=true;});
  c.addEventListener("disconnected",()=>{c.userData.connected=false;});
  c.addEventListener("selectstart", () => {
    if(phase!=="running" && vrStart.hit(c)){begin();vrStart.hide();startPresented=false;}
  });
  c.addEventListener("squeezestart", () => {
    if (!controllerTestMode) return;
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
  reset();startPresented=false;
  setSound(true);
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  $("vrnote").classList.add("hidden");
  // Stop a round if the headset loses visibility; no queued ambush on return.
  const xrSession=renderer.xr.getSession();
  xrSession.addEventListener("visibilitychange",()=>{
    if(xrSession.visibilityState!=="visible" && phase==="running") reset();
  });
});
renderer.xr.addEventListener("sessionend", () => {
  camera.position.set(0, 1.6, 0);
  camera.rotation.set(pitch, yaw, 0);
  buttonDown.clear();
  if (phase === "running") reset();
});

let reactionUntil = 0;
let reactionTimer;
function clearReactionIndicator(){
  reactionUntil=0;clearTimeout(reactionTimer);
  const el=$("reactionIndicator");el.classList.remove("active");
  el.textContent='reaction signal';
}
// Visual fallback only: never creates a packet or feeds the event director.
function showScareIndicator(){
  reactionUntil=performance.now()+3000;
  const el=$("reactionIndicator");el.classList.add("active");
  el.textContent='reaction signal';
  clearTimeout(reactionTimer);reactionTimer=setTimeout(clearReactionIndicator,3000);
}
function showReactionIndicator(m){
  if(['reaction','startle_flinch'].includes(m.event))showScareIndicator();
}
// Operator-event link is independent of continuous sensor input. No marker is classified.
const signalLink = installSignalLink({
 onHook:eventDriven ? m=>{showReactionIndicator(m);return eventDirector.receiveHook(m);} : null,
 onReaction:m=>eventDriven && eventDirector.receive(m),
 onVision:m=>{const accepted=eventDriven && eventDirector.receiveVision(m);if(accepted)showScareIndicator();return accepted;},
 canApply:()=>phase === "running" && !spectate,
 actions:{
  light:c=>applyExistingEffect("flicker",c),
  ambient:c=>engine.enabled ? applyExistingEffect("breath",c) : {applied:false,reason:"Sound is off; opt in manually"},
  environment:c=>applyExistingEffect("door",c),
  reaction:c=>applyExistingEffect("cut",c)
 }
});
if(spectate)signalLink.setEnabled(false);
const signalPanel=mountSignalLinkPanel({adapter:signalLink});
// A compact world-space readout remains visible when HTML is hidden in immersive VR.
const linkCanvas=document.createElement('canvas');linkCanvas.width=768;linkCanvas.height=256;
const linkCtx=linkCanvas.getContext('2d'),linkTexture=new THREE.CanvasTexture(linkCanvas);
const linkHud=new THREE.Mesh(new THREE.PlaneGeometry(1.15,.38),new THREE.MeshBasicMaterial({map:linkTexture,transparent:true,depthWrite:false}));
linkHud.position.set(-1.5,1.05,-2.7);linkHud.lookAt(0,1.6,0);scene.add(linkHud);let lastLinkHud=0;
function updateLinkHud(time) {
  linkHud.visible=renderer.xr.isPresenting;
  if(linkHud.visible){
    const xrCam=renderer.xr.getCamera();
    xrCam.getWorldPosition(linkHud.position);
    xrCam.getWorldQuaternion(linkHud.quaternion);
    linkHud.translateZ(-1.65);linkHud.translateY(-.55);
  }
  if(time-lastLinkHud<250)return;lastLinkHud=time;
  const st=signalLink.snapshot();
  linkCtx.clearRect(0,0,768,256);linkCtx.fillStyle='#090d0ce8';linkCtx.fillRect(0,0,768,256);
  linkCtx.font='25px monospace';linkCtx.fillStyle='#bdb8a9';
  const title=phase==="running"?"NIGHT WATCH — "+Math.max(0,Math.ceil((roundEndsAt-performance.now())/1000))+"s":phase==="ended"?(lives.remaining===0?"GAME OVER":"WATCH COMPLETE"):"READY FOR NIGHT WATCH";
  linkCtx.fillText(title,20,45);linkCtx.font='22px monospace';
  linkCtx.fillText(phase==="running"?"Turn your head. Watch all four doors.":"Point at START / PLAY AGAIN and click",20,93);
  linkCtx.fillText(eventDriven?eventDirector.status.slice(0,52):"A / X: sound "+(engine.enabled?"ON":"OFF")+" | boost "+engine.boost+"x",20,141);
  linkCtx.fillStyle=lives.remaining<=2?"#ff6666":"#f4dba5";linkCtx.font="bold 32px sans-serif";linkCtx.fillText("♥".repeat(lives.remaining)+"♡".repeat(5-lives.remaining)+"   "+lives.remaining+" / 5 LIVES",20,200);
  if(performance.now()<reactionUntil){linkCtx.fillStyle='#e41525';linkCtx.fillRect(0,0,768,62);linkCtx.fillStyle='white';linkCtx.font='bold 28px monospace';linkCtx.fillText('reaction signal',20,42);}
  linkTexture.needsUpdate=true;
}

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
  // The ceiling supply visibly dies down after entry. A small pool of light
  // remains; no rapid strobing or camera movement is introduced.
  const targetLight = .24 - .17 * tension;
  const entry = running ? Math.min(1, snap.elapsed / 2.6) : 0;
  baseLight = running ? .5 + (targetLight - .5) * entry : .45;

  if (running && adaptiveMode && !eventDriven) {
    // Independent empty brownouts: darkness is atmosphere, not an attack cue.
    if (snap.elapsed >= nextEmptyDarkness && !scares.snapshot().activeScare && lightOverride === null) {
      lightPattern({pattern: Math.random() < .5 ? "sag" : "cut-return", seconds: .7 + Math.random() * 1.5});
      nextEmptyDarkness = snap.elapsed + 9 + Math.random() * 15;
    }
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
  if (running && (eventDriven || !adaptiveMode) && (snap.phase === "ended" || performance.now() >= roundEndsAt)) finish("survived");
  desktopAtmosphereTick(time / 1000, dt);
  desktopPopTick(time / 1000);
  if(eventDriven){
    const status=signalLink.snapshot();
    if(status.connection!=="connected")eventDirector.disconnect();
    $("eventStatus").textContent=eventDirector.status;
    $("eventStatus").title="Session: "+(eventDirector.session||"none")+" | Encounter: "+((eventDirector.current||eventDirector.last)?.encounter_id||"none");
  }
  updateVrStart();
  updateLinkHud(time);
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
  vrStart.dispose();
  for(const {line} of startControllers){line.geometry.dispose();line.material.dispose();}
  signalPanel.dispose();
  signalLink.dispose();
  linkHud.geometry.dispose();linkHud.material.dispose();linkTexture.dispose();
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
drawLives();
window.__simple = { signalLink, applyExistingEffect, spectate, cameraEuler: () => new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ"), room, figures, cues, scares, director, profile, adaptive: () => adaptive, begin, reset, state: () => ({ phase, baseLight }) };

async function refreshAcquisitionState(){
 try{const r=await fetch('/signal-link/control/state',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error();const s=await r.json();
 const labels={idle:'Ready — press Start',awaiting_ack:'Waiting for acknowledgment',starting:'Starting',running:'Receiving',stopping:'Stopping',stopped:'Stopped',rejected:'Start/stop rejected',failed:'Failed',disconnected:'Disconnected'};
 $('acquisitionStatus').textContent='Signal Scope: '+(labels[s.status]||'Unknown');
 }catch{$('acquisitionStatus').textContent='Signal Scope: connection unavailable';}
}
refreshAcquisitionState();setInterval(refreshAcquisitionState,1500);

addEventListener('pagehide',()=>{
 if(eventDirector.active)navigator.sendBeacon('/signal-link/game',new Blob([JSON.stringify({event:'session_ended',session_id:eventDirector.session})],{type:'application/json'}));
});
