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
import { createVolumetricCone } from "./volumetrics.mjs";
import { createMonitor } from "./monitor.mjs";

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
const attendant = createAnimatronic(THREE, scene);
const ghost = createGhost(THREE, scene);
const monitor = createMonitor(THREE, renderer, scene);
const lampCone = createVolumetricCone(THREE, {
  radiusBottom: 1.5,
  height: 2.7,
  color: 0xf0d6a0,
  anglePower: 5,
  attenuation: 3.4,
});
lampCone.mesh.position.set(0, 2.72, -1);
scene.add(lampCone.mesh);

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
function begin() {
  director.config.duration = +$("duration").value;
  director.start();
  summaryShown = false;
  $("position").disabled = true;
  $("overlay").classList.add("hidden");
  $("pause").textContent = "Pause";
  setState("The room is listening. You can reset at any time.");
  if (!renderer.xr.isPresenting) $("crosshair").classList.remove("hidden");
}
function reset() {
  director.reset();
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
    $("pause").textContent = "Pause";
    toast("Resumed");
  } else {
    director.pause(now);
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
function showSummary() {
  const s = director.getSession();
  const stats = Object.entries(s.encounterStats)
    .filter(([, v]) => v.count > 0)
    .map(
      ([id, v]) =>
        `<tr><td>${id}</td><td>${v.count}</td><td>${v.avgResponse > 0 ? "+" : ""}${v.avgResponse.toFixed(3)}</td></tr>`,
    )
    .join("");
  $("summaryContent").innerHTML = `
    <p>${s.endedReason === "completed" ? "Session completed." : "Session ended."}
       Peak tension <strong>${s.peakTension.toFixed(2)}</strong> over ${Math.round(s.elapsed)}s.</p>
    <table class="summary-table">
      <tr><th>State</th><th>Seconds</th></tr>
      ${Object.entries(s.timeInState)
        .map(([k, v]) => `<tr><td>${k}</td><td>${v.toFixed(1)}</td></tr>`)
        .join("")}
    </table>
    ${stats ? `<table class="summary-table"><tr><th>Encounter</th><th>Count</th><th>Avg response</th></tr>${stats}</table>` : "<p>No encounters fired.</p>"}
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
  download("quiet-room-session.json", JSON.stringify(director.getSession(), null, 2));
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
  else if (k === "f")
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
});
addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));

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
  if (renderer.xr.isPresenting || !held.size) return;
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
function interact() {
  if (renderer.xr.isPresenting) return;
  const target = desktopAim();
  if (target) {
    target.onInteract();
    toast(target.label);
  }
}

// ---------- in-world HUD and XR target panels ----------
function panel(width, height, canvasWidth, canvasHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    }),
  );
  return { canvas, ctx: canvas.getContext("2d"), texture, mesh };
}
const hud = panel(1.65, 0.82, 1024, 512);
hud.mesh.position.set(-1.3, 1.95, -1.25);
hud.mesh.rotation.y = 0.25;
scene.add(hud.mesh);
function target(text, x, action) {
  const p = panel(0.65, 0.16, 650, 160);
  p.ctx.fillStyle = "#243429";
  p.ctx.fillRect(0, 0, 650, 160);
  p.ctx.strokeStyle = "#9aad86";
  p.ctx.strokeRect(3, 3, 644, 154);
  p.ctx.fillStyle = "#e0e9d3";
  p.ctx.font = "38px sans-serif";
  p.ctx.textAlign = "center";
  p.ctx.fillText(text, 325, 95);
  p.texture.needsUpdate = true;
  p.mesh.position.set(x, 1.38, -1.05);
  p.mesh.userData.action = action;
  scene.add(p.mesh);
  return p;
}
const startTarget = target("BEGIN / RESET", -0.4, () => {
  if (director.phase === "running") reset();
  else begin();
});
const soundTarget = target("SOUND: OFF", 0.4, () => setSound(!audioEnabled));
const targets = [startTarget.mesh, soundTarget.mesh];
const xrRotation = new THREE.Matrix4();
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  rig.add(controller);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -1),
    ]),
    new THREE.LineBasicMaterial({ color: 0xbad59c }),
  );
  line.scale.z = 5;
  controller.add(line);
  controller.addEventListener("selectstart", () => {
    xrRotation.identity().extractRotation(controller.matrixWorld);
    aimOrigin.setFromMatrixPosition(controller.matrixWorld);
    aimDir.set(0, 0, -1).applyMatrix4(xrRotation);
    raycaster.set(aimOrigin, aimDir);
    raycaster.far = 20;
    const panelHit = raycaster.intersectObjects(targets)[0];
    if (panelHit) return panelHit.object.userData.action();
    const interactable = aimedInteractable(aimOrigin, aimDir);
    if (interactable) return interactable.onInteract();
    if (director.phase !== "running") begin();
  });
}
const buttonDown = new Map();
function controllerButtons() {
  for (const source of renderer.xr.getSession()?.inputSources || []) {
    const pressed = !!source.gamepad?.buttons[4]?.pressed;
    if (pressed && !buttonDown.get(source)) setSound(!audioEnabled);
    buttonDown.set(source, pressed);
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
});

function drawHud(s) {
  const ctx = hud.ctx;
  ctx.clearRect(0, 0, 1024, 512);
  ctx.fillStyle = "#0d1916ed";
  ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = "#5f7655";
  ctx.strokeRect(3, 3, 1018, 506);
  ctx.textAlign = "left";
  ctx.fillStyle = "#c6d7ad";
  ctx.font = "32px sans-serif";
  ctx.fillText("FOCUSED / THE QUIET ROOM", 38, 65);
  ctx.fillStyle = "#e2e7dc";
  ctx.font = "48px sans-serif";
  ctx.fillText(
    `${s.state}${s.paused ? " (PAUSED)" : ""}    ${Math.ceil(s.remaining)}s`,
    38,
    140,
  );
  ctx.font = "30px sans-serif";
  const mode = client.stats().mode ?? "manual";
  const src = mode === "live" ? s.source : mode;
  ctx.fillText(
    `SOURCE: ${src.toUpperCase()}${src === "hardware" ? " (bridge-reported)" : " / DEMO"}`,
    38,
    205,
  );
  ctx.fillText(
    `INPUT ${s.intensity.toFixed(2)}    TENSION ${s.tension.toFixed(2)}`,
    38,
    260,
  );
  ctx.fillText(
    `QUALITY ${s.quality.toFixed(2)}    ${s.fresh ? "FRESH" : "NO FRESH SIGNAL"}${s.encounter ? `    [${s.encounter.id}]` : ""}`,
    38,
    315,
  );
  ctx.fillStyle = "#9eaf98";
  ctx.font = "25px sans-serif";
  ctx.fillText(
    s.phase === "ended"
      ? "Complete. Point at BEGIN / RESET to try again."
      : s.phase === "ready"
        ? "Point and trigger BEGIN. A/X toggles sound."
        : "Trigger buttons or props. A/X toggles sound.",
    38,
    385,
  );
  ctx.fillText(
    s.state === "WAIT"
      ? "Waiting: atmosphere eases off."
      : `Sound ${audioEnabled ? "ON" : "OFF"} - Experimental response proxy`,
    38,
    438,
  );
  hud.texture.needsUpdate = true;
  soundTarget.ctx.clearRect(0, 0, 650, 160);
  soundTarget.ctx.fillStyle = "#243429";
  soundTarget.ctx.fillRect(0, 0, 650, 160);
  soundTarget.ctx.fillStyle = "#e0e9d3";
  soundTarget.ctx.textAlign = "center";
  soundTarget.ctx.font = "38px sans-serif";
  soundTarget.ctx.fillText(`SOUND: ${audioEnabled ? "ON" : "OFF"}`, 325, 95);
  soundTarget.texture.needsUpdate = true;
}

// ---------- encounter -> entity routing ----------
let lastEncounterKey = null;
let lampFlicker = 0;
function routeEncounter(s) {
  const key = s.encounter ? `${s.encounter.id}:${s.encounter.t <= 0.2}` : null;
  if (!s.encounter) {
    lastEncounterKey = null;
    return;
  }
  const fresh = s.encounter.t <= 0.2 && lastEncounterKey !== s.encounter.id;
  if (!fresh) return;
  lastEncounterKey = s.encounter.id;
  const e = s.encounter;
  if (e.id === "lamp-flicker") lampFlicker = 1.6;
  if (e.id === "door-creak") byId["corridor-door"]?.onInteract();
  if (e.id === "radio-static") {
    const radio = byId.radio;
    if (radio && !radio.mesh.userData.active) radio.onInteract();
  }
  if (e.intensity >= 0.85) attendant.trigger("advance");
  if (e.intensity >= 0.97 && s.tension > 0.8) attendant.trigger("scare");
}

// ---------- stats ----------
let fpsAccum = 0,
  fpsFrames = 0,
  fpsValue = 0;
function updateStats(s) {
  const stats = client.stats();
  $("sourceStat").textContent = (
    stats.mode === "live" ? s.source : (stats.mode ?? "manual")
  ).toUpperCase();
  $("stateStat").textContent = s.paused ? `${s.state} ⏸` : s.state;
  $("tensionStat").textContent = s.tension.toFixed(2);
  $("qualityStat").textContent = s.quality.toFixed(2);
  $("encounterStat").textContent = s.encounter ? s.encounter.id : "–";
  $("fpsStat").textContent = fpsValue ? fpsValue.toFixed(0) : "–";
  $("rateStat").textContent = `${stats.receiveRate.toFixed(1)} Hz`;
  $("signalAgeStat").textContent =
    stats.lastSignalAgeMs == null
      ? "–"
      : `${(stats.lastSignalAgeMs / 1000).toFixed(1)}s`;
  const sec = Math.ceil(s.remaining);
  $("timeStat").textContent =
    `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  $("progressBar").setAttribute("aria-valuenow", Math.round(s.progress * 100));
  $("progressBar").querySelector(".progress-fill").style.width =
    `${(s.progress * 100).toFixed(1)}%`;
  $("connection").textContent =
    stats.mode === "live"
      ? `Relay ${connectionStatus.connection} · ${s.fresh ? "receiving" : "waiting for fresh input"}`
      : `${(stats.mode ?? "manual").toUpperCase()} DEMO · no hardware claim`;
}

// ---------- render loop ----------
let lastTime = performance.now(),
  lastHud = 0,
  lastAim = 0;
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
  const active = current.phase === "running" && !current.paused,
    t = active ? current.tension : 0;
  const safe = active && current.state !== "WAIT";
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
  environment.update(dt, time / 1000, visuals);
  atmosphere.update(dt, time / 1000, visuals);
  attendant.update(dt, time / 1000, active ? visuals : { ...visuals, tension: 0, state: "WAIT" });
  ghost.update(dt, time / 1000, visuals);
  monitor.update(dt, time / 1000, visuals);
  if (lampFlicker > 0) {
    lampFlicker = Math.max(0, lampFlicker - dt);
    lamp.intensity *= 0.35 + 0.65 * Math.abs(Math.sin(time * 0.05));
  }
  lampCone.updateFrom(lamp);
  lampCone.setIntensity(visuals.lighting ? 0.35 + 0.4 * (1 - t) : 0.5);
  routeEncounter(current);
  if (current.phase === "ended") {
    $("position").disabled = false;
    if (!summaryShown) {
      summaryShown = true;
      $("crosshair").classList.add("hidden");
      $("interactHint").classList.add("hidden");
      setState("The room settles. Experience complete.");
      if (!renderer.xr.isPresenting) showSummary();
    }
  }
  hud.mesh.visible = renderer.xr.isPresenting;
  targets.forEach((m) => (m.visible = renderer.xr.isPresenting));
  if (renderer.xr.isPresenting) controllerButtons();
  audio.update(current, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
  musicBox.update(current);
  if (!renderer.xr.isPresenting && active && time - lastAim > 150) {
    lastAim = time;
    const aimed = desktopAim();
    $("interactHint").classList.toggle("hidden", !aimed);
    if (aimed) $("interactHint").textContent = `Press E — ${aimed.label}`;
  }
  if (time - lastHud > 150) {
    lastHud = time;
    drawHud(current);
    updateStats(current);
  }
  renderer.render(scene, camera);
});
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
