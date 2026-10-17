import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { Director } from "./director.mjs";
import { SignalClient } from "./signal-client.mjs";
import { AudioEngine } from "./audio-engine.mjs";
import { MusicBox } from "./music-box.mjs";
import { createEnvironment } from "./environment.mjs";
import { createMaterialLibrary } from "./textures.mjs";
import { createAtmosphere, ATMOSPHERES } from "./atmosphere.mjs";
import { createAnimatronic } from "./animatronic.mjs";
import { createGhost } from "./ghost.mjs";
import { createVolumetricCone, createDustMotes } from "./volumetrics.mjs";
import { createMonitor } from "./monitor.mjs";
import { Haunt } from "./haunt.mjs";
import { PowerSystem } from "./power.mjs";
import {
  ATTENDANT_HOME,
  ATTENDANT_NODE_COUNT,
  ATTENDANT_PATH,
  BLACKOUT_SCARE_DELAY,
  BlackoutTimeline,
  DIFFICULTY,
  JumpscareFlow,
  PhantomSounds,
  SessionStats,
  TapeScript,
  attendantZone,
  clampAi,
  difficultyFor,
  entityObserved,
  focusObserved,
  formatEta,
  ghostZone,
  powerTier,
} from "./session-flow.mjs";

const $ = (id) => document.getElementById(id);
const director = new Director();

// ---------- renderer / scene / rig ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0a100f");
scene.fog = new THREE.FogExp2(0x18221e, 0.055);
const camera = new THREE.PerspectiveCamera(
    65,
    innerWidth / innerHeight,
    0.05,
    35,
  ),
  rig = new THREE.Group();
rig.position.z = 2;
camera.position.y = 1.6;
rig.add(camera);
scene.add(rig);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFoveation(0.666);
renderer.outputColorSpace = THREE.SRGBColorSpace;
$("viewport").appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
window.__renderer = renderer; // read-only hook for the XR test harness

// ---------- lights owned by the app (atmosphere drives their values) ----------
const ambient = new THREE.HemisphereLight(0x99b1a2, 0x10130e, 0.65);
scene.add(ambient);
const lamp = new THREE.PointLight(0xf0d6a0, 20, 12, 2);
lamp.position.set(0, 2.8, -1);
scene.add(lamp);
const windowLight = new THREE.PointLight(0x759fa4, 8, 9, 2);
windowLight.position.set(2.8, 1.8, -2);
scene.add(windowLight);
const fixture = new THREE.Mesh(
  new THREE.ConeGeometry(0.36, 0.22, 16, 1, true),
  new THREE.MeshStandardMaterial({
    color: 0x55594a,
    roughness: 0.7,
    metalness: 0.25,
  }),
);
fixture.position.copy(lamp.position);
scene.add(fixture);

// ---------- world: environment, entities, cinematics ----------
const materialLibrary = createMaterialLibrary(THREE);
const environment = createEnvironment(THREE, scene, {
  materials: materialLibrary.materials,
});
const atmosphere = createAtmosphere(THREE, {
  scene,
  ambient,
  lamp,
  windowLight,
});
atmosphere.setDomOverlay(true);
// The Attendant is rebuilt (cheaply) whenever the hunt model retreats or the
// session restarts, so its mesh always matches the coordinator's waypoint.
// Its lunge targets the head position captured at (re)build time.
let attendant = null;
let attendantWp = 0; // haunt waypoint this instance was built at
function headSpot() {
  const p = new THREE.Vector3();
  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(p);
  return p;
}
function buildAttendant(wp = 0) {
  attendant?.dispose();
  const start = wp === 0 ? ATTENDANT_HOME : ATTENDANT_PATH[wp - 1];
  const head = headSpot();
  attendant = createAnimatronic(THREE, scene, {
    x: start.x,
    z: start.z,
    waypoints: ATTENDANT_PATH.slice(wp),
    safeRadius: 0.9,
    playerX: head.x,
    playerZ: head.z,
  });
  attendantWp = wp;
}
buildAttendant(0);
const meshWaypoint = () => attendantWp + attendant.waypointIndex + 1;
const ghost = createGhost(THREE, scene);
const monitor = createMonitor(THREE, renderer, scene, {
  active: false,
  xrSafe: true, // RT feed also renders in VR (xr is disabled around it, see render loop)
});
const haunt = new Haunt({
  blackoutDelay: BLACKOUT_SCARE_DELAY,
  entities: [
    { id: "attendant", kind: "stalker", aggression: 5, waypoints: ATTENDANT_NODE_COUNT },
    { id: "ghost", kind: "charger", aggression: 5 },
  ],
});
const power = new PowerSystem();
const flow = new JumpscareFlow();
const blackoutTimeline = new BlackoutTimeline();
const stats = new SessionStats();
const tape = new TapeScript();
const phantom = new PhantomSounds();
// Floodlight: one spot light that always exists (intensity 0 when off) so the
// light count never changes at runtime (no shader recompiles on Quest).
const floodlight = new THREE.SpotLight(0xfff0d0, 0, 16, Math.PI / 8, 0.45, 1.6);
const floodTarget = new THREE.Object3D();
floodTarget.position.set(0, 0, -1);
floodlight.add(floodTarget);
floodlight.target = floodTarget;
camera.add(floodlight);
floodlight.position.set(0.08, -0.1, 0);
const lampCone = createVolumetricCone(THREE, {
  radiusBottom: 1.5,
  height: 2.7,
  color: 0xf0d6a0,
  anglePower: 5,
  attenuation: 3.4,
});
lampCone.mesh.position.set(0, 2.72, -1);
scene.add(lampCone.mesh);
const lampMotes = createDustMotes(THREE, { count: 120, radiusBottom: 1.4, height: 2.6 });
lampCone.mesh.add(lampMotes.points);

// ---------- audio ----------
const audio = new AudioEngine();
const musicBox = new MusicBox();
let audioEnabled = false;
async function setSound(value) {
  try {
    await audio.setEnabled(value);
    await musicBox.setEnabled(value);
    audioEnabled = value;
    $("sound").checked = value;
    if (value) applyVolume();
  } catch (e) {
    audioEnabled = false;
    $("sound").checked = false;
    $("error").textContent = `Audio unavailable: ${e.message}`;
  }
}
function applyVolume() {
  const v = +$("volume").value;
  audio.setVolume(v);
  musicBox.setVolume(v * 0.6);
  $("volumeValue").textContent = v.toFixed(2);
}

// ---------- signal input ----------
let connectionStatus = { connection: "idle", error: null };
const client = new SignalClient({
  onSignal(message, receiptMs) {
    director.receive(message, receiptMs / 1000);
  },
  onStatus(status) {
    connectionStatus = status;
    $("error").textContent = status.error ?? "";
  },
});
client.setMode($("source").value);
client.setManualValue(+$("intensity").value);
client.setManualQuality(+$("quality").value);

// ---------- session flow ----------
let current = director.snapshot(performance.now() / 1000);
let summaryShown = false;
let endHandled = false;
let powerScale = 1; // power is tuned for 120 s; stretch/shrink with the duration
let hudNote = { text: "", until: 0 };
let floodDesk = false; // L key / button held
let floodVR = false; // grip held
let doorSealed = false;
let windLocked = false; // blackout sequence owns the music box wind
const scratch = new THREE.Vector3();

function notice(text, { alert = false, seconds = 4 } = {}) {
  hudNote = { text, until: performance.now() / 1000 + seconds };
  const el = $("caption");
  el.textContent = text;
  el.classList.toggle("alert", alert);
  el.classList.remove("hidden");
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => el.classList.add("hidden"), seconds * 1000);
}
function cue(name, opts) {
  try {
    audio.cue(name, opts);
  } catch {
    /* audio is optional */
  }
}
function applyAggression() {
  haunt.setAggression(clampAi($("aiLevel").value));
}
function resetWorld() {
  haunt.reset();
  power.reset();
  flow.reset();
  blackoutTimeline.reset();
  tape.reset();
  phantom.reset();
  stats.reset();
  if (attendant.jumping || meshWaypoint() !== 0 || attendant.stage !== 0) buildAttendant(0);
  attendant.setBlackout(false);
  attendant.setStage(0);
  ghost.setState("hidden");
  ghost.setBlackout(false);
  monitor.setSignalLost(false);
  monitor.setActive(false);
  monitor.selectCamera(0);
  atmosphere.setBlackout(false);
  musicBox.setWind(1);
  musicBox.setMuffled(false);
  windLocked = false;
  floodDesk = floodVR = false;
  setDoor(false, true);
  endHandled = false;
  hudNote = { text: "", until: 0 };
  $("caption").classList.add("hidden");
}
function begin() {
  director.config.duration = +$("duration").value;
  director.start();
  resetWorld();
  buildAttendant(0); // re-captures the player's head position for the lunge
  haunt.start();
  applyAggression();
  stats.ai = clampAi($("aiLevel").value);
  powerScale = 120 / director.config.duration;
  power.start();
  summaryShown = false;
  $("position").disabled = true;
  $("overlay").classList.add("hidden");
  $("summaryPanel").classList.add("hidden");
  $("pause").textContent = "Pause";
  setState("The room is listening. You can reset at any time.");
  if (!renderer.xr.isPresenting) $("crosshair").classList.remove("hidden");
}
function reset() {
  director.reset();
  resetWorld();
  summaryShown = false;
  $("position").disabled = false;
  $("overlay").classList.remove("hidden");
  $("summaryPanel").classList.add("hidden");
  $("crosshair").classList.add("hidden");
  $("interactHint").classList.add("hidden");
  $("pause").textContent = "Pause";
  setState("Ready when you are.");
}
function togglePause() {
  const now = performance.now() / 1000;
  if (director.phase !== "running") return begin();
  if (director.paused) {
    director.resume(now);
    power.start();
    $("pause").textContent = "Pause";
    toast("Resumed");
  } else {
    director.pause(now);
    power.stop();
    $("pause").textContent = "Resume";
    toast("Paused");
  }
}
function setState(text) {
  $("sessionState").textContent = text;
}
let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("hidden");
  void el.offsetWidth; // restart the fade animation
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// ---------- end-of-session summary ----------
const fnafSummary = () => stats.toJSON(power.getState().percent);
function sessionExport() {
  return { ...director.getSession(), fnaf: fnafSummary() };
}
function showSummary() {
  const s = director.getSession();
  const f = fnafSummary();
  const stat = Object.entries(s.encounterStats)
    .filter(([, v]) => v.count > 0)
    .map(
      ([id, v]) =>
        `<tr><td>${id}</td><td>${v.count}</td><td>${v.avgResponse > 0 ? "+" : ""}${v.avgResponse.toFixed(3)}</td></tr>`,
    )
    .join("");
  const headline =
    s.endedReason === "caught"
      ? `<p class="caught"><strong>CAUGHT.</strong> ${f.jumpscare?.cause ?? ""}</p>`
      : s.endedReason === "completed"
        ? "<p><strong>You survived the night.</strong></p>"
        : "<p>Session ended.</p>";
  $("summaryContent").innerHTML = `
    ${headline}
    <p>Peak tension <strong>${s.peakTension.toFixed(2)}</strong> over ${Math.round(s.elapsed)}s.</p>
    <table class="summary-table">
      <tr><th>Survival</th><th></th></tr>
      <tr><td>Ended by</td><td>${f.jumpscare ? `${f.jumpscare.entity} (${f.jumpscare.kind}) at ${f.jumpscare.atElapsed}s` : s.endedReason}</td></tr>
      <tr><td>Power at end</td><td>${f.powerAtEndPercent}%</td></tr>
      <tr><td>Blackout</td><td>${f.blackoutAtElapsed == null ? "none" : `at ${f.blackoutAtElapsed}s`}</td></tr>
      <tr><td>Attendant moves</td><td>${f.entityMoves.attendant}</td></tr>
      <tr><td>Camera uptime</td><td>${f.cameraUptimeSeconds}s (${f.cameraUptimePercent}%), ${f.cameraSwitches} switches</td></tr>
      <tr><td>Floodlight</td><td>${f.floodlightSeconds}s</td></tr>
      <tr><td>AI level</td><td>${f.aiLevel}</td></tr>
    </table>
    <table class="summary-table">
      <tr><th>State</th><th>Seconds</th></tr>
      ${Object.entries(s.timeInState)
        .map(([k, v]) => `<tr><td>${k}</td><td>${v.toFixed(1)}</td></tr>`)
        .join("")}
    </table>
    ${stat ? `<table class="summary-table"><tr><th>Encounter</th><th>Count</th><th>Avg response</th></tr>${stat}</table>` : "<p>No encounters fired.</p>"}
    <p class="console-note">Derived control values only; no raw sensor data is stored.</p>`;
  $("summaryPanel").classList.remove("hidden");
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- creator presets ----------
const PRESET_KEY = "quietroom-preset";
const PRESET_FIELDS = [
  "low",
  "high",
  "duration",
  "atmosphere",
  "volume",
  "position",
  "scenario",
  "aiLevel",
];
const PRESET_TOGGLES = ["sound", "lighting", "fog", "shadow"];
function collectPreset() {
  const p = {};
  for (const f of PRESET_FIELDS) p[f] = $(f).value;
  for (const t of PRESET_TOGGLES) p[t] = $(t).checked;
  return p;
}
function applyPreset(p) {
  if (!p || typeof p !== "object") return false;
  for (const f of PRESET_FIELDS)
    if (f in p && $(f)) {
      $(f).value = p[f];
      $(f).dispatchEvent(new Event("change"));
    }
  for (const t of PRESET_TOGGLES)
    if (t in p && $(t) && t !== "sound") $(t).checked = !!p[t];
  applyVolume();
  return true;
}

// ---------- power / cameras / floodlight / door ----------
function setCameras(up) {
  if (up && power.getState().blackout) {
    notice("No power. The monitor is dead.", { alert: true });
    return;
  }
  if (monitor.isActive() === up) return;
  monitor.setActive(up);
  power.setLoad("monitor", up);
  cue(up ? "monitorUp" : "monitorDown");
}
function selectCamera(i) {
  if (!monitor.isActive()) return;
  const n = monitor.getCamera().count;
  monitor.selectCamera(((i % n) + n) % n);
  stats.cameraSwitches++;
  cue("cameraSwitch");
}
function nextCamera() {
  if (!monitor.isActive()) return;
  selectCamera(Math.max(0, monitor.getCamera().index) + 1);
}
function toggleCameras() {
  setCameras(!monitor.isActive());
}
function setDoor(sealed, silent = false) {
  if (sealed && (power.getState().blackout || director.phase !== "running")) {
    if (!silent) notice(director.phase !== "running" ? "Begin first." : "No power. The seal will not hold.", { alert: true });
    return;
  }
  if (doorSealed === sealed) return;
  doorSealed = sealed;
  power.setLoad("door", sealed);
  environment.creakDoor(sealed ? -2 : 1.1);
  if (!silent) {
    cue(sealed ? "thump" : "knock", { position: { x: 0.95, z: -5.0 }, intensity: 0.6 });
    notice(sealed ? "Door sealed. The corridor cannot reach you. Power draining." : "Door open.");
  }
}
const toggleDoor = () => setDoor(!doorSealed);
function floodOn() {
  return (
    (floodDesk || floodVR) &&
    director.phase === "running" &&
    !director.paused &&
    !power.getState().blackout
  );
}

// ---------- UI wiring ----------
$("start").onclick = begin;
$("reset").onclick = reset;
$("pause").onclick = togglePause;
$("sound").onchange = () => setSound($("sound").checked);
$("volume").oninput = applyVolume;
$("intensity").oninput = () => {
  client.setManualValue(+$("intensity").value);
  $("intensityValue").textContent = (+$("intensity").value).toFixed(2);
};
$("quality").oninput = () => {
  client.setManualQuality(+$("quality").value);
  $("qualityValue").textContent = (+$("quality").value).toFixed(2);
};
$("source").onchange = () => {
  const mode = $("source").value;
  director.input = null;
  director.receivedAt = -Infinity;
  client.setMode(mode);
  $("intensity").disabled = mode !== "manual";
  $("quality").disabled = mode !== "manual";
};
$("camToggle").onclick = toggleCameras;
$("camNext").onclick = nextCamera;
$("doorBtn").onclick = toggleDoor;
for (const b of document.querySelectorAll("#camButtons [data-cam]"))
  b.onclick = () => selectCamera(+b.dataset.cam);
{
  const f = $("floodBtn");
  const on = (e) => {
    floodDesk = true;
    e.preventDefault();
  };
  const off = () => (floodDesk = false);
  f.addEventListener("pointerdown", on);
  for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"])
    f.addEventListener(ev, off);
}
const onAi = () => {
  const n = clampAi($("aiLevel").value);
  $("aiLevel").value = n;
  $("aiLevelValue").textContent = n;
  $("difficulty").value = difficultyFor(n);
  applyAggression();
};
$("aiLevel").addEventListener("input", onAi);
$("aiLevel").addEventListener("change", onAi);
$("difficulty").onchange = () => {
  const d = DIFFICULTY[$("difficulty").value];
  if (!d) return;
  $("aiLevel").value = d.ai;
  onAi();
  toast(`${d.label}: AI level ${d.ai}`);
};
$("scenario").onchange = () => client.setScenario($("scenario").value);
$("presetTense").onclick = () => {
  $("intensity").value = 0.05;
  $("intensity").dispatchEvent(new Event("input"));
  toast("Build preset: low input, tension rises");
};
$("presetCalm").onclick = () => {
  $("intensity").value = 0.95;
  $("intensity").dispatchEvent(new Event("input"));
  toast("Relief preset: high input, room eases");
};
$("duration").onchange = () => {
  if (director.phase !== "running")
    director.config.duration = +$("duration").value;
};
$("atmosphere").onchange = () => {
  atmosphere.setPreset($("atmosphere").value);
  toast(`Atmosphere: ${$("atmosphere").value}`);
};
for (const field of ["low", "high"])
  $(field).onchange = () => {
    const low = +$("low").value,
      high = +$("high").value;
    if (
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      low < 0 ||
      high > 1 ||
      high - low < 0.1
    ) {
      $("error").textContent =
        "Thresholds must be 0-1, with high at least 0.10 above low.";
      $(field).value = director.config[field];
      return;
    }
    director.config.low = low;
    director.config.high = high;
    director.lowTime = director.highTime = 0;
    $("error").textContent = "";
  };
$("helpToggle").onclick = () => {
  const open = $("helpPanel").classList.toggle("hidden");
  $("helpToggle").setAttribute("aria-expanded", String(!open));
};
$("consoleToggle").onclick = () => {
  const el = $("directorConsole");
  const collapsed = el.classList.contains("collapsed");
  el.classList.toggle("collapsed", !collapsed);
  el.classList.toggle("open", collapsed);
  $("consoleToggle").setAttribute("aria-expanded", String(collapsed));
};
$("dismissSummary").onclick = () =>
  $("summaryPanel").classList.add("hidden");
$("exportSession").onclick = () => {
  download("quiet-room-session.json", JSON.stringify(sessionExport(), null, 2));
  toast("Session summary downloaded");
};
$("savePreset").onclick = () => {
  localStorage.setItem(PRESET_KEY, JSON.stringify(collectPreset()));
  toast("Preset saved in this browser");
};
$("exportPreset").onclick = () => {
  download("quiet-room-preset.json", JSON.stringify(collectPreset(), null, 2));
  toast("Preset downloaded");
};
$("resetPreset").onclick = () => {
  localStorage.removeItem(PRESET_KEY);
  applyPreset({
    low: "0.30",
    high: "0.75",
    duration: "120",
    atmosphere: "observatory",
    volume: "0.6",
    position: "back",
    scenario: "cycle",
    aiLevel: "5",
    lighting: true,
    fog: true,
    shadow: true,
  });
  toast("Preset reset to defaults");
};
$("importPreset").onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    try {
      const parsed = JSON.parse(await input.files[0].text());
      if (!applyPreset(parsed)) throw Error("not a preset object");
      toast("Preset imported");
    } catch (e) {
      $("error").textContent = `Preset import failed: ${e.message}`;
    }
  };
  input.click();
};
const saved = localStorage.getItem(PRESET_KEY);
if (saved) {
  try {
    applyPreset(JSON.parse(saved));
  } catch {
    localStorage.removeItem(PRESET_KEY);
  }
}

// ---------- keyboard ----------
const held = new Set();
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const k = e.key.toLowerCase();
  if (["w", "a", "s", "d"].includes(k)) held.add(k);
  else if (k === " ") {
    e.preventDefault();
    togglePause();
  } else if (k === "r") reset();
  else if (k === "1") $("presetTense").click();
  else if (k === "2") $("presetCalm").click();
  else if (k === "h") $("helpToggle").click();
  else if (k === "e") interact();
  else if (k === "c") toggleCameras();
  else if (k === "v") nextCamera();
  else if (k === "tab") {
    e.preventDefault();
    nextCamera();
  } else if (k === "x") toggleDoor();
  else if (k === "l") floodDesk = true;
  else if (k === "f")
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
});
addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  held.delete(k);
  if (k === "l") floodDesk = false;
});

// ---------- desktop look + walk ----------
let dragging = false,
  lastX = 0,
  lastY = 0,
  yaw = 0,
  pitch = 0;
camera.rotation.order = "YXZ";
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (renderer.xr.isPresenting) return;
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
function walk(dt) {
  if (renderer.xr.isPresenting || !held.size || director.phase === "running") return;
  const speed = 1.8 * dt;
  const fx = -Math.sin(yaw),
    fz = -Math.cos(yaw);
  let dx = 0,
    dz = 0;
  if (held.has("w")) (dx += fx), (dz += fz);
  if (held.has("s")) (dx -= fx), (dz -= fz);
  if (held.has("a")) (dx += fz), (dz -= fx);
  if (held.has("d")) (dx -= fz), (dz += fx);
  if (!dx && !dz) return;
  const n = Math.hypot(dx, dz);
  rig.position.x = THREE.MathUtils.clamp(
    rig.position.x + (dx / n) * speed,
    -3.1,
    3.1,
  );
  rig.position.z = THREE.MathUtils.clamp(
    rig.position.z + (dz / n) * speed,
    -5.0,
    3.1,
  );
}

// ---------- interaction (desktop crosshair + XR controllers) ----------
const raycaster = new THREE.Raycaster();
const interactableMeshes = environment.interactables.map((i) => i.mesh);
const byId = Object.fromEntries(
  environment.interactables.map((i) => [i.id, i]),
);
function aimedInteractable(origin, direction) {
  raycaster.set(origin, direction);
  raycaster.far = 4.5;
  const hit = raycaster.intersectObjects(interactableMeshes, true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && !o.userData.interactableId) o = o.parent;
  return o ? byId[o.userData.interactableId] : null;
}
const aimOrigin = new THREE.Vector3(),
  aimDir = new THREE.Vector3();
function desktopAim() {
  camera.getWorldPosition(aimOrigin);
  camera.getWorldDirection(aimDir);
  return aimedInteractable(aimOrigin, aimDir);
}
function activateInteractable(target) {
  if (!target) return false;
  if (target.id === "corridor-door") toggleDoor();
  else target.onInteract();
  return true;
}
function interact() {
  if (renderer.xr.isPresenting) return;
  const target = desktopAim();
  if (target) {
    activateInteractable(target);
    toast(target.label);
  }
}

// ---------- in-world HUD and XR target panels ----------
// Everything below lives in WORLD space (children of the scene, never of the
// camera), so it never swims with the head in VR.
function panel(width, height, canvasWidth, canvasHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    }),
  );
  return { canvas, ctx: canvas.getContext("2d"), texture, mesh };
}
const hud = panel(1.65, 0.82, 1024, 512);
hud.mesh.position.set(-1.3, 1.95, -1.25);
hud.mesh.rotation.y = 0.25;
scene.add(hud.mesh);
function drawTarget(p, text, lit = false) {
  const c = p.ctx;
  c.clearRect(0, 0, 650, 160);
  c.fillStyle = lit ? "#6d5a26" : "#243429";
  c.fillRect(0, 0, 650, 160);
  c.strokeStyle = lit ? "#e0b84f" : "#9aad86";
  c.lineWidth = 4;
  c.strokeRect(3, 3, 644, 154);
  c.fillStyle = "#f1f5e8";
  c.font = "bold 44px sans-serif";
  c.textAlign = "center";
  c.fillText(text, 325, 95);
  p.texture.needsUpdate = true;
}
function target(text, x, action) {
  const p = panel(0.65, 0.16, 650, 160);
  drawTarget(p, text);
  p.mesh.position.set(x, 1.38, -1.05);
  p.mesh.rotation.y = -x * 0.12; // gentle inward curve toward the player
  p.mesh.userData.action = action;
  scene.add(p.mesh);
  return p;
}
const startTarget = target("BEGIN / RESET", -1.05, () => {
  if (director.phase === "running") reset();
  else begin();
});
const soundTarget = target("SOUND: OFF", -0.35, () => setSound(!audioEnabled));
const camTarget = target("CAMERAS", 0.35, toggleCameras);
const nextTarget = target("NEXT CAM", 1.05, nextCamera);
const targets = [startTarget.mesh, soundTarget.mesh, camTarget.mesh, nextTarget.mesh];
// Power readout lives on the cabinet by the CRT (never head-locked).
const powerPanel = panel(0.62, 0.3, 512, 248);
powerPanel.mesh.position.set(-2.1, 2.05, -3.45);
powerPanel.mesh.lookAt(0, 1.7, 2);
scene.add(powerPanel.mesh);

const xrRotation = new THREE.Matrix4();
const controllers = [];
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  rig.add(controller);
  controllers.push(controller);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -1),
    ]),
    new THREE.LineBasicMaterial({ color: 0xbad59c }),
  );
  line.scale.z = 5;
  controller.add(line);
  controller.addEventListener("selectstart", () => pointerSelect(controller));
}
function pointerSelect(controller) {
  xrRotation.identity().extractRotation(controller.matrixWorld);
  aimOrigin.setFromMatrixPosition(controller.matrixWorld);
  aimDir.set(0, 0, -1).applyMatrix4(xrRotation);
  raycaster.set(aimOrigin, aimDir);
  raycaster.far = 20;
  // Nearest of: UI panels, the CRT, interactable props.
  const panelHit = raycaster.intersectObjects(targets)[0];
  const crtHit = raycaster.intersectObject(monitor.group, true)[0];
  raycaster.far = 4.5;
  const propHit = raycaster.intersectObjects(interactableMeshes, true)[0];
  const best = [
    panelHit && { d: panelHit.distance, run: () => panelHit.object.userData.action() },
    crtHit && {
      d: crtHit.distance,
      run: () => (monitor.isActive() ? nextCamera() : setCameras(true)),
    },
    propHit && {
      d: propHit.distance,
      run: () => {
        let o = propHit.object;
        while (o && !o.userData.interactableId) o = o.parent;
        activateInteractable(o && byId[o.userData.interactableId]);
      },
    },
  ]
    .filter(Boolean)
    .sort((a, b) => a.d - b.d)[0];
  if (best) return best.run();
  if (director.phase !== "running") begin();
}
const buttonDown = new Map();
function controllerButtons() {
  let grip = false;
  let gripController = null;
  const sources = renderer.xr.getSession()?.inputSources || [];
  sources.forEach((source, idx) => {
    const b = source.gamepad?.buttons;
    const a = !!b?.[4]?.pressed;
    const y = !!b?.[5]?.pressed;
    const sq = !!b?.[1]?.pressed;
    const prev = buttonDown.get(source) || {};
    if (a && !prev.a) setSound(!audioEnabled);
    if (y && !prev.y) toggleCameras();
    if (sq) {
      grip = true;
      gripController = controllers[idx] ?? gripController;
    }
    buttonDown.set(source, { a, y });
  });
  floodVR = grip;
  if (gripController && floodlight.parent !== gripController) {
    gripController.add(floodlight);
    floodlight.position.set(0, 0, 0);
  }
}
function attachFloodlightToCamera() {
  if (floodlight.parent !== camera) {
    camera.add(floodlight);
    floodlight.position.set(0.08, -0.1, 0);
  }
}
renderer.xr.addEventListener("sessionstart", () => {
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  $("overlay").classList.add("hidden");
  $("crosshair").classList.add("hidden");
  $("interactHint").classList.add("hidden");
});
renderer.xr.addEventListener("sessionend", () => {
  camera.position.set(0, 1.6, 0);
  camera.rotation.set(pitch, yaw, 0);
  if (director.phase !== "running") $("overlay").classList.remove("hidden");
  buttonDown.clear();
  floodVR = false;
  attachFloodlightToCamera();
});

function drawHud(s) {
  const ctx = hud.ctx;
  const ps = power.getState();
  ctx.clearRect(0, 0, 1024, 512);
  ctx.fillStyle = "#0b1412f2";
  ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = "#7d9770";
  ctx.lineWidth = 4;
  ctx.strokeRect(3, 3, 1018, 506);
  ctx.textAlign = "left";
  ctx.fillStyle = "#c6d7ad";
  ctx.font = "30px sans-serif";
  ctx.fillText("FOCUSED / THE QUIET ROOM", 36, 56);
  ctx.fillStyle = "#f2f5ec";
  ctx.font = "bold 52px sans-serif";
  ctx.fillText(
    `${s.state}${s.paused ? " (PAUSED)" : ""}   ${Math.ceil(s.remaining)}s`,
    36,
    122,
  );
  ctx.font = "30px sans-serif";
  const mode = client.stats().mode ?? "manual";
  const src = mode === "live" ? s.source : mode;
  ctx.fillText(
    `SOURCE ${src.toUpperCase()}${src === "hardware" ? " (bridge-reported)" : " / DEMO"}`,
    36,
    175,
  );
  ctx.fillText(
    `INPUT ${s.intensity.toFixed(2)}   TENSION ${s.tension.toFixed(2)}   Q ${s.quality.toFixed(2)}`,
    36,
    222,
  );
  const tier = powerTier(ps.percent, ps.blackout);
  ctx.fillStyle = tier === "ok" ? "#b8d9a0" : tier === "warning" ? "#e8c05a" : "#f08a72";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(
    ps.blackout ? "POWER OUT" : `POWER ${ps.percent}%${monitor.isActive() ? "  CAMS" : ""}${floodOn() ? "  LIGHT" : ""}${doorSealed ? "  DOOR" : ""}`,
    36,
    276,
  );
  ctx.fillStyle = hudNote.until > performance.now() / 1000 ? "#f0c27a" : "#9eaf98";
  ctx.font = "27px sans-serif";
  const hint =
    s.phase === "ended"
      ? s.endedReason === "caught"
        ? "CAUGHT. Point at BEGIN / RESET to try again."
        : "You survived. Point at BEGIN / RESET to replay."
      : s.phase === "ready"
        ? "Point + trigger BEGIN. A/X sound. B/Y cameras. Grip = floodlight."
        : hudNote.until > performance.now() / 1000
          ? hudNote.text
          : "Watch the Attendant. Face the ghost. Save power.";
  wrapText(ctx, hint, 36, 335, 950, 34);
  ctx.fillStyle = "#8fa08a";
  ctx.font = "24px sans-serif";
  ctx.fillText(`Sound ${audioEnabled ? "ON" : "OFF"} - experimental response proxy`, 36, 470);
  hud.texture.needsUpdate = true;

  drawTarget(soundTarget, `SOUND: ${audioEnabled ? "ON" : "OFF"}`, audioEnabled);
  drawTarget(camTarget, monitor.isActive() ? "CAMERAS: UP" : "CAMERAS", monitor.isActive());
  drawTarget(nextTarget, monitor.isActive() ? monitor.getCamera().label?.split("—")[0].trim() ?? "NEXT CAM" : "NEXT CAM");
  drawTarget(startTarget, director.phase === "running" ? "RESET" : "BEGIN", false);

  // Power panel by the CRT.
  const c = powerPanel.ctx;
  c.fillStyle = "#070b0bef";
  c.fillRect(0, 0, 512, 248);
  c.strokeStyle = tier === "ok" ? "#6c8a5f" : tier === "warning" ? "#c9a040" : "#c8553f";
  c.lineWidth = 4;
  c.strokeRect(3, 3, 506, 242);
  c.textAlign = "left";
  c.fillStyle = "#cfd8c4";
  c.font = "bold 28px monospace";
  c.fillText("SECURITY POWER", 22, 46);
  c.font = "bold 78px monospace";
  c.fillStyle = tier === "ok" ? "#b8d9a0" : tier === "warning" ? "#e8c05a" : "#f08a72";
  c.fillText(ps.blackout ? "OUT" : `${ps.percent}%`, 22, 128);
  c.fillStyle = "#1a2220";
  c.fillRect(22, 150, 468, 26);
  c.fillStyle = c.fillStyle = tier === "ok" ? "#8fb07a" : tier === "warning" ? "#d9a648" : "#d4644a";
  c.fillRect(22, 150, 468 * (ps.blackout ? 0 : ps.level), 26);
  c.fillStyle = "#cfd8c4";
  c.font = "26px monospace";
  const cam = monitor.getCamera();
  c.fillText(monitor.isActive() ? cam.label ?? "CAM --" : "CAMERAS DOWN", 22, 214);
  powerPanel.texture.needsUpdate = true;
}
function wrapText(ctx, text, x, y, maxW, lh) {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = w;
      y += lh;
    } else line = t;
  }
  if (line) ctx.fillText(line, x, y);
}

// ---------- encounter -> entity routing ----------
let lastEncounterKey = null;
function routeEncounter(s) {
  if (!s.encounter) {
    lastEncounterKey = null;
    return;
  }
  const fresh = s.encounter.t <= 0.2 && lastEncounterKey !== s.encounter.id;
  if (!fresh) return;
  lastEncounterKey = s.encounter.id;
  const e = s.encounter;
  if (e.id === "lamp-flicker") {
    atmosphere.flicker(0.5, 1.6, "stutter");
    cue("lightFlicker", { intensity: 0.4 });
  }
  if (e.id === "door-creak" && !doorSealed) byId["corridor-door"]?.onInteract();
  if (e.id === "radio-static") {
    const radio = byId.radio;
    if (radio && !radio.mesh.userData.active) radio.onInteract();
  }
  // The Attendant is moved ONLY by the hunt coordinator (unobserved rule).
}

// ---------- hunt / power / scare event handling ----------
const entityPos = (id) => {
  const g = id === "ghost" ? ghost.group : attendant.group;
  return { x: g.position.x, z: g.position.z };
};
function entityByName(id) {
  return id === "ghost" ? ghost : attendant;
}
let attendantTargetWp = 0;
function onHauntEvent(ev) {
  switch (ev.type) {
    case "move": {
      if (ev.entity === "attendant") {
        attendantTargetWp = ev.waypoint;
        attendant.trigger("advance");
        stats.noteMove("attendant");
        if (monitor.getWatchedZone() === attendantZone(ev.waypoint)) {
          monitor.staticBurst(0.7);
          cue("static", { intensity: 0.5 });
          notice("CAMERA INTERFERENCE: something moved on the feed.", { alert: true, seconds: 3 });
        }
      }
      lampMotes.agitate(0.6);
      break;
    }
    case "stage":
      if (ev.entity === "attendant" && (ev.stage === "retreat" || ev.stage === "reset"))
        attendantTargetWp = ev.waypoint ?? 0;
      if (ev.stage === "manifest" && ev.entity === "ghost") {
        if (ghost.state === "hidden") ghost.setState("apparition");
        stats.noteMove("ghost");
        if (monitor.getWatchedZone() === "doorway") {
          monitor.staticBurst(0.7);
          cue("static", { intensity: 0.5 });
        }
        environment.creakDoor(doorSealed ? 0 : 0.2);
        notice("Something is standing in the corridor. Keep your eyes on it.", { alert: true });
      }
      break;
    case "cue":
      if (ev.cue === "stinger") break; // the scare flow times its own stinger
      cue(ev.cue, { position: ev.entity ? entityPos(ev.entity) : undefined, intensity: ev.cue === "eyes" ? 0.7 : 0.75 });
      break;
    case "jumpscare": {
      stats.noteJumpscare(ev, current.elapsed);
      applyFlow(flow.trigger(ev));
      break;
    }
    default:
      break;
  }
}
function applyFlow(actions) {
  for (const a of actions) {
    switch (a.type) {
      case "duck":
        audio.duck(a.seconds + 0.2);
        musicBox.hardCut();
        break;
      case "lightsCut":
        atmosphere.lightsCut(a.seconds); // the ONE cut-to-dark of this scare
        lampMotes.agitate(1);
        break;
      case "lunge":
        if (a.entity === "ghost") ghost.trigger("rush");
        else attendant.trigger("jumpscare");
        break;
      case "stinger":
        cue("stinger", { intensity: 1 });
        break;
      case "end":
        director.end("caught");
        break;
    }
  }
}
function onPowerEvent(e) {
  switch (e.type) {
    case "warning":
      notice("POWER 20%. Cameras and floodlight are draining it.", { alert: true });
      cue("powerWarning");
      break;
    case "critical":
      notice("POWER 10%. Conserve everything.", { alert: true });
      cue("powerCritical");
      break;
    case "flicker":
      atmosphere.flicker(0.55, 0.9, "sag");
      cue("lightFlicker", { intensity: 0.5 });
      lampMotes.agitate(0.3);
      break;
    case "blackout":
      monitor.setActive(false);
      monitor.setSignalLost(true);
      setDoor(false, true);
      floodDesk = floodVR = false;
      stats.blackoutAt = current.elapsed;
      cue("blackout", { intensity: 0.9 });
      notice("POWER OUT. Do not move. Do not look away.", { alert: true, seconds: 8 });
      break;
  }
}
function onBlackoutBeat(name) {
  if (name === "dark") {
    atmosphere.setBlackout(true);
    musicBox.setWind(0);
    windLocked = true;
    lampMotes.agitate(1);
  } else if (name === "musicBox") {
    musicBox.setMuffled(true);
    musicBox.setWind(0.45); // a distant, wheezing box from behind a wall
  } else if (name === "eyes") {
    attendant.setBlackout(true);
    ghost.setBlackout(true);
    haunt.notify("blackout");
  }
}
function onSessionEnded() {
  endHandled = true;
  stats.powerAtEnd = power.getState().percent;
  power.stop();
  floodDesk = floodVR = false;
  if (current.endedReason !== "caught") {
    atmosphere.setBlackout(false);
    attendant.setBlackout(false);
    ghost.setBlackout(false);
    haunt.notify("blackout-end");
    musicBox.setMuffled(false);
    musicBox.setWind(1);
    windLocked = false;
  }
}

// ---------- observation ----------
const headPos = new THREE.Vector3();
const headQuat = new THREE.Quaternion();
const headCam = { position: headPos, quaternion: headQuat };
function headPose() {
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);
  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(headPos);
  camera.getWorldQuaternion(headQuat);
  return headCam;
}
const tgt = { x: 0, y: 0, z: 0 };
function coneSees(head, group) {
  tgt.x = group.position.x;
  tgt.y = group.position.y + 1.1;
  tgt.z = group.position.z;
  return focusObserved(head, tgt);
}

// ---------- stats ----------
let fpsAccum = 0,
  fpsFrames = 0,
  fpsValue = 0;
function updateStats(s) {
  const stats2 = client.stats();
  $("sourceStat").textContent = (
    stats2.mode === "live" ? s.source : (stats2.mode ?? "manual")
  ).toUpperCase();
  $("stateStat").textContent = s.paused ? `${s.state} ⏸` : s.state;
  $("tensionStat").textContent = s.tension.toFixed(2);
  $("qualityStat").textContent = s.quality.toFixed(2);
  $("encounterStat").textContent = s.encounter ? s.encounter.id : "–";
  $("fpsStat").textContent = fpsValue ? fpsValue.toFixed(0) : "–";
  $("rateStat").textContent = `${stats2.receiveRate.toFixed(1)} Hz`;
  $("signalAgeStat").textContent =
    stats2.lastSignalAgeMs == null
      ? "–"
      : `${(stats2.lastSignalAgeMs / 1000).toFixed(1)}s`;
  const sec = Math.ceil(s.remaining);
  $("timeStat").textContent =
    `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  $("progressBar").setAttribute("aria-valuenow", Math.round(s.progress * 100));
  $("progressBar").querySelector(".progress-fill").style.width =
    `${(s.progress * 100).toFixed(1)}%`;
  $("connection").textContent =
    stats2.mode === "live"
      ? `Relay ${connectionStatus.connection} · ${s.fresh ? "receiving" : "waiting for fresh input"}`
      : `${(stats2.mode ?? "manual").toUpperCase()} DEMO · no hardware claim`;

  // Power + camera dock
  const ps = power.getState();
  const tier = powerTier(ps.percent, ps.blackout);
  $("powerPct").textContent = ps.blackout ? "OUT" : `${ps.percent}%`;
  $("powerStat").textContent = ps.blackout ? "OUT" : `${ps.percent}%`;
  $("powerFill").style.width = `${ps.blackout ? 0 : ps.percent}%`;
  $("powerBar").dataset.tier = tier;
  $("powerDock").dataset.tier = tier;
  $("powerBar").setAttribute("aria-valuenow", ps.percent);
  $("powerEta").textContent = ps.blackout
    ? "POWER OUT"
    : formatEta(ps.secondsRemaining, s.remaining, powerScale);
  $("loadMonitor").classList.toggle("on", ps.activeLoads.includes("monitor"));
  $("loadFlood").classList.toggle("on", ps.activeLoads.includes("floodlight"));
  $("loadDoor").classList.toggle("on", ps.activeLoads.includes("door"));
  const up = monitor.isActive();
  const cam = monitor.getCamera();
  $("camToggle").setAttribute("aria-pressed", String(up));
  $("floodBtn").setAttribute("aria-pressed", String(floodOn()));
  $("doorBtn").setAttribute("aria-pressed", String(doorSealed));
  for (const b of document.querySelectorAll("#camButtons button")) {
    b.disabled = !up;
    b.classList.toggle("sel", up && b.dataset.cam !== undefined && +b.dataset.cam === cam.index);
  }
  $("camLabel").textContent = ps.blackout ? "SIGNAL LOST: POWER OUT" : up ? (cam.label ?? "NO SIGNAL") : "CAMERAS DOWN";
  $("camStat").textContent = ps.blackout ? "LOST" : up ? `CAM ${cam.index + 1}` : "DOWN";

  const hs = haunt.snapshot();
  const att = hs.entities.attendant;
  const gh = hs.entities.ghost;
  $("attendantStat").textContent = `${att.waypoint}/${att.waypoints - 1}${attendant.observed ? " seen" : ""}`;
  $("ghostStat").textContent = `${Math.round(gh.charge * 100)}%${ghost.observed ? " seen" : ""}`;
  $("aiStat").textContent = `${att.aggression}→${att.effective.toFixed(1)}`;
}

// ---------- render loop ----------
let lastTime = performance.now(),
  lastHud = 0,
  lastAim = 0;
let floodLevel = 0;
renderer.setAnimationLoop((time) => {
  const now = performance.now() / 1000,
    dt = Math.min(0.1, Math.max(0, (performance.now() - lastTime) / 1000));
  lastTime = performance.now();
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fpsValue = fpsFrames / fpsAccum;
    fpsAccum = 0;
    fpsFrames = 0;
  }
  current = director.step(dt, now);
  const running = current.phase === "running" && !current.paused,
    active = running,
    t = active ? current.tension : 0;
  const visuals = {
    tension: t,
    state: current.state,
    elapsed: current.elapsed,
    lighting: $("lighting").checked,
    fog: $("fog").checked,
    shadow: $("shadow").checked,
    shadowPosition: $("position").value,
    quality: current.quality,
    phase: time / 1000,
    xrPresenting: renderer.xr.isPresenting,
  };
  walk(dt);

  // --- simulation (only while a session is running and not paused) ---
  const head = headPose();
  const ghostVisible = ghost.group.visible && ghost.state !== "hidden";
  const watched = monitor.getWatchedZone();
  const ghostSeen = entityObserved({
    camObserved: coneSees(head, ghost.group),
    watchedZone: watched,
    zone: ghostZone(ghost.group.position.z),
    visible: ghostVisible,
  });
  const observed = {
    attendant: entityObserved({
      camObserved: coneSees(head, attendant.group),
      watchedZone: watched,
      zone: attendantZone(meshWaypoint()),
    }),
    // a sealed door holds the corridor back: the ghost's charge drains
    ghost: ghostSeen || (doorSealed && running),
  };
  attendant.setObserved(observed.attendant);
  ghost.setObserved(ghostSeen);
  const blackoutNow = power.getState().blackout;
  if (running) {
    // power
    power.setLoad("floodlight", floodOn());
    power.update(dt * powerScale);
    for (const e of power.consumeEvents()) onPowerEvent(e);
    const ps = power.getState();
    for (const b of blackoutTimeline.step(ps.blackout, ps.blackoutElapsed * (1 / powerScale)))
      onBlackoutBeat(b);
    if (!windLocked) musicBox.setWind(Math.min(1, power.getLevel() / 0.5));
    stats.tick(dt, { monitorUp: monitor.isActive(), floodlightOn: floodOn() });
    // tape briefing + phantom audio-only sounds
    for (const line of tape.due(current.elapsed)) {
      notice(line, { seconds: 5.5 });
      cue("static", { intensity: 0.25 });
    }
    const ph = phantom.update(dt, {
      tension: t,
      state: current.state,
      blackout: blackoutNow,
      scared: flow.phase !== "idle" || haunt.ended,
    });
    if (ph) {
      cue(ph.cue, { position: ph.position, intensity: ph.intensity });
      lampMotes.agitate(0.15);
    }
    // hunt: setObserved -> update -> consume events -> entity update
    haunt.update(dt, {
      tension: t,
      state: current.state,
      elapsed: current.elapsed,
      observed,
    });
    for (const ev of haunt.consumeEvents()) onHauntEvent(ev);
    applyFlow(flow.update(dt));
  }
  // The mesh follows the model backwards (retreat/reset) once nobody watches.
  if (running && attendantTargetWp < meshWaypoint() && !attendant.jumping && !observed.attendant && flow.phase === "idle")
    buildAttendant(attendantTargetWp);
  if (!running && current.phase !== "running" && attendantTargetWp !== 0 && flow.phase === "idle") attendantTargetWp = 0;

  const tAbs = time / 1000;
  environment.update(dt, tAbs, visuals);
  atmosphere.update(dt, tAbs, visuals);
  attendant.update(dt, tAbs, active ? visuals : { ...visuals, tension: 0, state: "WAIT" });
  ghost.update(dt, tAbs, visuals);
  // Monitor feed: three.js re-targets to the XR camera whenever xr.enabled is
  // true, so disable it around the monitor's own render-target pass.
  const xrWas = renderer.xr.enabled;
  renderer.xr.enabled = false;
  monitor.update(dt, tAbs, visuals);
  renderer.xr.enabled = xrWas;

  // Floodlight (hold-to-use): attach to camera on desktop, controller in VR.
  if (!renderer.xr.isPresenting) attachFloodlightToCamera();
  floodLevel += ((floodOn() ? 1 : 0) - floodLevel) * Math.min(1, dt * 12);
  floodlight.intensity = 55 * floodLevel;
  const dark = 1 - atmosphere.blackLevel;
  lampCone.updateFrom(lamp);
  const coneI = (visuals.lighting ? 0.35 + 0.4 * (1 - t) : 0.5) * dark;
  lampCone.setIntensity(coneI);
  lampMotes.setIntensity(coneI);
  lampMotes.update(dt);
  routeEncounter(current);
  if (current.phase === "ended") {
    $("position").disabled = false;
    if (!endHandled) onSessionEnded();
    if (!summaryShown) {
      summaryShown = true;
      $("crosshair").classList.add("hidden");
      $("interactHint").classList.add("hidden");
      setState(
        current.endedReason === "caught"
          ? "Caught. Press Reset to try again."
          : "The room settles. Experience complete.",
      );
      if (!renderer.xr.isPresenting) showSummary();
    }
  }
  hud.mesh.visible = renderer.xr.isPresenting;
  targets.forEach((m) => (m.visible = renderer.xr.isPresenting));
  powerPanel.mesh.visible = monitor.isActive() || renderer.xr.isPresenting || running;
  if (renderer.xr.isPresenting) controllerButtons();
  audio.update(current, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
  musicBox.update(current);
  if (!renderer.xr.isPresenting && active && time - lastAim > 150) {
    lastAim = time;
    const aimed = desktopAim();
    $("interactHint").classList.toggle("hidden", !aimed);
    if (aimed)
      $("interactHint").textContent =
        aimed.id === "corridor-door"
          ? `Press E: ${doorSealed ? "open" : "seal"} the door`
          : `Press E — ${aimed.label}`;
  }
  if (time - lastHud > 150) {
    lastHud = time;
    drawHud(current);
    updateStats(current);
  }
  renderer.render(scene, camera);
});
window.__quiet = {
  director,
  haunt,
  power,
  monitor,
  flow,
  stats,
  atmosphere,
  floodlight,
  camera,
  rig,
  get attendant() {
    return attendant;
  },
  ghost,
  renderer,
  scene,
  get doorSealed() {
    return doorSealed;
  },
  get floodOn() {
    return floodOn();
  },
  get audioEnabled() {
    return audioEnabled;
  },
  setLook(y, p = 0) {
    yaw = y;
    pitch = p;
    camera.rotation.set(pitch, yaw, 0);
  },
};
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
window.addEventListener("pagehide", () => {
  client.dispose();
  audio.dispose();
  musicBox.dispose();
});
