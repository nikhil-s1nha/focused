import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { Director, validSignal } from "./director.mjs";
const $ = (id) => document.getElementById(id),
  director = new Director();
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
renderer.outputColorSpace = THREE.SRGBColorSpace;
$("viewport").appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));
const ambient = new THREE.HemisphereLight(0x99b1a2, 0x10130e, 0.65);
scene.add(ambient);
const lamp = new THREE.PointLight(0xf0d6a0, 20, 12, 2);
lamp.position.set(0, 2.8, -1);
scene.add(lamp);
const windowLight = new THREE.PointLight(0x759fa4, 8, 9, 2);
windowLight.position.set(2.8, 1.8, -2);
scene.add(windowLight);
const mats = {
  wall: new THREE.MeshStandardMaterial({ color: 0x394039, roughness: 1 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: 0.9 }),
  floor: new THREE.MeshStandardMaterial({ color: 0x38372c, roughness: 0.95 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x080e0d, roughness: 1 }),
  metal: new THREE.MeshStandardMaterial({
    color: 0x55594a,
    roughness: 0.7,
    metalness: 0.25,
  }),
};
function box(x, y, z, w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  scene.add(m);
  return m;
}
// Fixed room geometry. Effects never shift the floor or the player.
box(0, -0.08, -1, 7, 0.16, 9, mats.floor);
box(-3.5, 1.8, -1, 0.15, 3.6, 9, mats.wall);
box(3.5, 1.8, -1, 0.15, 3.6, 9, mats.wall);
box(0, 3.6, -1, 7, 0.15, 9, mats.dark);
box(0, 1.8, 3.5, 7, 3.6, 0.15, mats.wall);
box(-2.25, 1.8, -5.5, 2.5, 3.6, 0.15, mats.wall);
box(2.25, 1.8, -5.5, 2.5, 3.6, 0.15, mats.wall);
box(0, 3.25, -5.5, 2, 0.7, 0.15, mats.wall);
box(0, 1.4, -5.65, 2, 2.8, 0.12, mats.dark);
for (const x of [-1.08, 1.08]) box(x, 1.45, -5.38, 0.14, 2.9, 0.2, mats.wood);
box(0, 2.91, -5.38, 2.3, 0.14, 0.2, mats.wood);
for (let i = 0; i < 18; i++)
  box(-3.3 + i * 0.39, 0.009, -1, 0.012, 0.009, 8.8, mats.dark);
for (const x of [-3.38, 3.38]) {
  box(x, 0.16, -1, 0.08, 0.32, 9, mats.wood);
  for (let z = -5; z < 3.5; z += 1.25)
    box(x, 1.05, z, 0.1, 1.5, 0.04, mats.wood);
  box(x, 1.8, -1, 0.1, 0.08, 9, mats.wood);
}
// A narrow window, a dusty cabinet and an empty chair.
box(3.39, 2, -2, 0.03, 1.7, 1.3, mats.dark);
for (const z of [-2.66, -2, -1.34])
  box(3.35, 2, z, 0.08, 1.8, 0.055, mats.wood);
box(3.35, 2, -2, 0.08, 0.06, 1.3, mats.wood);
box(-2.55, 0.65, -3.7, 1.2, 1.3, 0.6, mats.wood);
box(-2.55, 1.34, -3.7, 1.3, 0.08, 0.7, mats.metal);
for (const x of [-2.85, -2.25]) box(x, 0.7, -3.385, 0.5, 1, 0.035, mats.floor);
const chair = new THREE.Group();
chair.position.set(1.8, 0, -3.7);
chair.rotation.y = -0.3;
scene.add(chair);
function chairPart(x, y, z, w, h, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.wood);
  m.position.set(x, y, z);
  chair.add(m);
}
chairPart(0, 0.48, 0, 0.62, 0.1, 0.62);
for (const x of [-0.24, 0.24])
  for (const z of [-0.24, 0.24]) chairPart(x, 0.23, z, 0.065, 0.46, 0.065);
chairPart(0, 1, -0.27, 0.62, 0.85, 0.08);
const fixture = new THREE.Mesh(
  new THREE.ConeGeometry(0.36, 0.22, 16, 1, true),
  mats.metal,
);
fixture.position.copy(lamp.position);
scene.add(fixture);
box(0, 3.2, -1, 0.02, 0.6, 0.02, mats.dark);
const figure = new THREE.Group(),
  silhouette = new THREE.MeshBasicMaterial({
    color: 0x020403,
    transparent: true,
    opacity: 0,
  });
const body = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.4, 12), silhouette);
body.position.y = 0.8;
figure.add(body);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), silhouette);
head.position.y = 1.61;
figure.add(head);
figure.position.set(0, 0, -5.3);
scene.add(figure);
// In-world text and tracked-controller targets, independent of DOM overlays.
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
let audio = null,
  audioEnabled = false,
  mode = "manual",
  lastSignal = null,
  receivedAt = -Infinity,
  socket = null,
  retryTimer = null,
  socketGeneration = 0,
  retryMs = 500,
  connection = "disconnected",
  lastTime = performance.now(),
  lastHud = 0,
  current = {
    state: "WAIT",
    phase: "ready",
    source: "manual",
    intensity: 0.5,
    tension: 0.12,
    quality: 1,
    remaining: 120,
    fresh: true,
  };
function begin() {
  director.start();
  $("position").disabled = true;
  lastSignal = null;
  receivedAt = -Infinity;
  $("sessionState").textContent =
    "The room is listening. You can reset at any time.";
}
function reset() {
  director.reset();
  $("position").disabled = false;
  lastSignal = null;
  receivedAt = -Infinity;
  $("sessionState").textContent = "Ready when you are.";
}
function makeAudio() {
  const context = new AudioContext(),
    gain = context.createGain(),
    panner = context.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 2;
  panner.maxDistance = 15;
  gain.gain.value = 0;
  panner.connect(context.destination);
  gain.connect(panner);
  for (const frequency of [56, 84.3]) {
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency;
    osc.connect(gain);
    osc.start();
  }
  return { context, gain, panner };
}
async function setSound(value) {
  try {
    if (value) {
      audio ??= makeAudio();
      await audio.context.resume();
    }
    audioEnabled = value;
    if (audio && !value)
      audio.gain.gain.setTargetAtTime(0, audio.context.currentTime, 0.1);
    $("sound").checked = value;
  } catch (e) {
    audioEnabled = false;
    $("sound").checked = false;
    $("error").textContent = `Audio unavailable: ${e.message}`;
  }
}
const startTarget = target("BEGIN / RESET", -0.4, () => {
  if (director.phase === "running") reset();
  else begin();
});
const soundTarget = target("SOUND: OFF", 0.4, () => setSound(!audioEnabled));
const targets = [startTarget.mesh, soundTarget.mesh];
const raycaster = new THREE.Raycaster(),
  rotation = new THREE.Matrix4();
const controllers = [];
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
    rotation.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation);
    const hit = raycaster.intersectObjects(targets)[0];
    if (hit) hit.object.userData.action();
    else if (director.phase !== "running") begin();
  });
  controllers.push(controller);
}
const buttonDown = new Map();
function controllerButtons() {
  for (const source of renderer.xr.getSession()?.inputSources || []) {
    const pressed = !!source.gamepad?.buttons[4]?.pressed;
    if (pressed && !buttonDown.get(source)) setSound(!audioEnabled);
    buttonDown.set(source, pressed);
  }
}
function connect() {
  clearTimeout(retryTimer);
  const generation = ++socketGeneration;
  connection = "connecting";
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signals`,
  );
  socket = ws;
  ws.onopen = () => {
    if (generation !== socketGeneration) return;
    connection = "connected";
    retryMs = 500;
  };
  ws.onmessage = (e) => {
    if (generation !== socketGeneration || mode !== "live") return;
    try {
      const message = JSON.parse(e.data);
      if (!validSignal(message)) throw Error("Invalid signal packet");
      lastSignal = message;
      receivedAt = performance.now() / 1000;
      $("error").textContent = "";
    } catch (e) {
      $("error").textContent = e.message;
    }
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (generation !== socketGeneration) return;
    connection = "disconnected";
    if (mode === "live") {
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(10000, retryMs * 2);
    }
  };
}
function selectSource() {
  mode = $("source").value;
  director.input = null;
  director.receivedAt = -Infinity;
  director.lowTime = director.highTime = 0;
  director.state = "WAIT";
  director.reliefLeft = 0;
  lastSignal = null;
  receivedAt = -Infinity;
  clearTimeout(retryTimer);
  socketGeneration++;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = null;
  connection = "disconnected";
  $("intensity").disabled = mode !== "manual";
  if (mode === "live") connect();
}
$("source").onchange = selectSource;
$("start").onclick = begin;
$("reset").onclick = reset;
$("sound").onchange = () => setSound($("sound").checked);
$("intensity").oninput = () =>
  ($("intensityValue").textContent = Number($("intensity").value).toFixed(2));
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
        "Thresholds must be 0–1, with high at least 0.10 above low.";
      $(field).value = director.config[field];
      return;
    }
    director.config.low = low;
    director.config.high = high;
    director.lowTime = director.highTime = 0;
    $("error").textContent = "";
  };
// Desktop mouse-look only. No forced camera travel or unexpected world motion.
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
renderer.xr.addEventListener("sessionstart", () => {
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  $("overlay").style.display = "none";
});
renderer.xr.addEventListener("sessionend", () => {
  camera.position.set(0, 1.6, 0);
  camera.rotation.set(pitch, yaw, 0);
  $("overlay").style.display = "";
  buttonDown.clear();
});
const position = new THREE.Vector3(),
  quaternion = new THREE.Quaternion(),
  forward = new THREE.Vector3(),
  up = new THREE.Vector3();
function updateAudio(tension, active) {
  if (!audio) return;
  const { context, gain, panner } = audio;
  const level = audioEnabled && active ? 0.006 + tension * 0.014 : 0;
  gain.gain.setTargetAtTime(level, context.currentTime, 0.3);
  panner.positionX.value = figure.position.x;
  panner.positionY.value = 1.3;
  panner.positionZ.value = figure.position.z;
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(position);
  cam.getWorldQuaternion(quaternion);
  forward.set(0, 0, -1).applyQuaternion(quaternion);
  up.set(0, 1, 0).applyQuaternion(quaternion);
  const listener = context.listener;
  if (listener.positionX) {
    listener.positionX.value = position.x;
    listener.positionY.value = position.y;
    listener.positionZ.value = position.z;
    listener.forwardX.value = forward.x;
    listener.forwardY.value = forward.y;
    listener.forwardZ.value = forward.z;
    listener.upX.value = up.x;
    listener.upY.value = up.y;
    listener.upZ.value = up.z;
  }
}
function drawHud(s) {
  const ctx = hud.ctx;
  ctx.clearRect(0, 0, 1024, 512);
  ctx.fillStyle = "#0d1916ed";
  ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = "#5f7655";
  ctx.strokeRect(3, 3, 1018, 506);
  ctx.fillStyle = "#c6d7ad";
  ctx.font = "32px sans-serif";
  ctx.fillText("FOCUSED / THE QUIET ROOM", 38, 65);
  ctx.fillStyle = "#e2e7dc";
  ctx.font = "48px sans-serif";
  ctx.fillText(`${s.state}    ${Math.ceil(s.remaining)}s`, 38, 140);
  ctx.font = "30px sans-serif";
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
    `QUALITY ${s.quality.toFixed(2)}    ${s.fresh ? "FRESH" : "NO FRESH SIGNAL"}`,
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
        : "Point and trigger buttons. A/X toggles sound.",
    38,
    385,
  );
  ctx.fillText(
    s.state === "WAIT"
      ? "Waiting: atmosphere eases off."
      : `Sound ${audioEnabled ? "ON" : "OFF"} · Experimental response proxy`,
    38,
    438,
  );
  hud.texture.needsUpdate = true;
  soundTarget.ctx.clearRect(0, 0, 650, 160);
  soundTarget.ctx.fillStyle = "#243429";
  soundTarget.ctx.fillRect(0, 0, 650, 160);
  soundTarget.ctx.fillStyle = "#e0e9d3";
  soundTarget.ctx.fillText(`SOUND: ${audioEnabled ? "ON" : "OFF"}`, 325, 95);
  soundTarget.texture.needsUpdate = true;
}
renderer.setAnimationLoop((time) => {
  const now = performance.now() / 1000,
    dt = Math.min(0.1, Math.max(0, (performance.now() - lastTime) / 1000));
  lastTime = performance.now();
  if (director.phase === "running") {
    if (mode !== "live") {
      const intensity =
        mode === "manual"
          ? +$("intensity").value
          : 0.5 + 0.48 * Math.sin(director.elapsed * 0.18);
      director.receive(
        {
          type: "signal",
          source: mode,
          intensity,
          signal_quality: 1,
          timestamp: Date.now() / 1000,
        },
        now,
      );
    } else if (lastSignal && now - receivedAt <= director.config.freshness) {
      director.receive(lastSignal, receivedAt);
    }
  }
  current = director.step(dt, now);
  if (current.phase === "ended") $("position").disabled = false;
  const active = current.phase === "running",
    t = active ? current.tension : 0;
  hud.mesh.visible = renderer.xr.isPresenting;
  targets.forEach((target) => (target.visible = renderer.xr.isPresenting));
  const safe = active && current.state !== "WAIT";
  // Gentle dimming; slow irregular modulation avoids rapid strobing.
  const modulation =
    $("lighting").checked && safe
      ? 1 -
        0.1 *
          t *
          (0.5 + 0.5 * Math.sin(time * 0.0037) * Math.sin(time * 0.0021))
      : 1;
  ambient.intensity = $("lighting").checked ? 0.65 - t * 0.5 : 0.65;
  lamp.intensity = ($("lighting").checked ? 20 - t * 17 : 20) * modulation;
  windowLight.intensity = 8 - t * 4;
  scene.fog.density = $("fog").checked ? 0.035 + t * 0.1 : 0.035;
  figure.visible = $("shadow").checked && safe && t > 0.45;
  silhouette.opacity = THREE.MathUtils.clamp((t - 0.4) * 2, 0, 0.85);
  const loc = $("position").value;
  figure.position.set(
    loc === "left" ? -2.7 : loc === "right" ? 2.7 : 0,
    0,
    loc === "back" ? -5.3 : -4.7,
  );
  if (renderer.xr.isPresenting) controllerButtons();
  updateAudio(t, safe);
  if (time - lastHud > 150) {
    lastHud = time;
    drawHud(current);
    $("sourceStat").textContent = (
      mode === "live" ? current.source : mode
    ).toUpperCase();
    $("stateStat").textContent = current.state;
    $("tensionStat").textContent = current.tension.toFixed(2);
    $("qualityStat").textContent = current.quality.toFixed(2);
    const sec = Math.ceil(current.remaining);
    $("timeStat").textContent =
      `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    $("connection").textContent =
      mode === "live"
        ? `Relay ${connection} · ${current.fresh ? "receiving" : "waiting for fresh input"}`
        : `${mode.toUpperCase()} DEMO · no hardware claim`;
    if (current.phase === "ended")
      $("sessionState").textContent =
        "The room settles. Experience complete. Reset to begin again.";
  }
  renderer.render(scene, camera);
});
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
window.addEventListener("pagehide", () => {
  clearTimeout(retryTimer);
  socketGeneration++;
  socket?.close();
  audio?.context.close();
});
