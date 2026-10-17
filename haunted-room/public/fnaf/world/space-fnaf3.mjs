// space-fnaf3.mjs — cramped ventilation-themed security office, heater-green light.
// A control monitor carries three on-screen buttons (audio / camera / ventilation) and
// a live fault readout; three vent grates with sliding seal plates; a desk fan; a
// speaker-style audio-lure decoy station; a space heater. ORIGINAL procedural art;
// only layout/mechanics are genre-inspired.
//
//   createSpaceFnaf3(THREE, scene, { materials?, onInteract?(id, info) })
//   => { group, update(dt,time,state), interactables, dispose, setPowerOut(b),
//        setVentSealed(i,bool), setSystemFault(name,bool), pulseLure(roomId),
//        setPanel('audio'|'camera'|'vent'), getState(), debug }
// Faults: 'audio' | 'camera' | 'ventilation' (alias 'vent'). update state (optional):
// { tension 0..1, powerOut bool }. Player eye assumed near (0,1.2,0) facing -Z.

// ---- shared mini-kit (duplicated per space file so each module is standalone) ----
const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const ease = (dt, k) => 1 - Math.exp(-k * dt);
const hasDOM = () => typeof document !== "undefined" && !!document.createElement;

function makeKit(THREE) {
  const geos = [], mats = [], texs = [];
  const geo = (g) => (geos.push(g), g);
  const unitBox = geo(new THREE.BoxGeometry(1, 1, 1));
  const unitCyl = geo(new THREE.CylinderGeometry(1, 1, 1, 14));
  const unitPlane = geo(new THREE.PlaneGeometry(1, 1));
  const unitSphere = geo(new THREE.SphereGeometry(1, 14, 10));
  const std = (def) => { const m = new THREE.MeshStandardMaterial(def); mats.push(m); return m; };
  const basic = (def) => { const m = new THREE.MeshBasicMaterial(def); mats.push(m); return m; };
  // Canvas-baked texture (null in headless Node). paint(ctx,w,h)
  const tex = (w, h, paint, { repeat, srgb = true } = {}) => {
    if (!hasDOM()) return null;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    paint(ctx, w, h);
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    t.anisotropy = 4;
    texs.push(t);
    return t;
  };
  const add = (parent, g, m, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z); o.scale.set(sx, sy, sz);
    parent.add(o); return o;
  };
  const box = (p, m, w, h, d, x, y, z) => add(p, unitBox, m, x, y, z, w, h, d);
  const cyl = (p, m, r, h, x, y, z) => add(p, unitCyl, m, x, y, z, r, h, r);
  const sph = (p, m, rx, ry, rz, x, y, z) => add(p, unitSphere, m, x, y, z, rx, ry, rz);
  const plane = (p, m, w, h, x, y, z) => add(p, unitPlane, m, x, y, z, w, h, 1);
  // invisible raycast proxy (never rendered)
  const hit = (p, w, h, d, x, y, z) => {
    const o = box(p, proxyMat, w, h, d, x, y, z); o.visible = false; o.userData.proxy = true; return o;
  };
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false }); mats.push(proxyMat);
  const tagAll = (root, id) => root.traverse((o) => { o.userData.interactableId = id; });
  const dispose = () => {
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    for (const t of texs) t.dispose();
    geos.length = mats.length = texs.length = 0;
  };
  return { THREE, geo, std, basic, tex, add, box, cyl, sph, plane, hit, tagAll, dispose,
    unitBox, unitCyl, unitPlane, unitSphere };
}
function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function vec3(v, d) { return v && Number.isFinite(v.x) ? { x: v.x, y: v.y, z: v.z } : { ...d }; }
function isShown(o) { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; }
function countRender(root) { let meshes = 0; root.traverse((o) => { if (o.isMesh && !o.userData.proxy && isShown(o)) meshes++; }); return meshes; }
// ---------------------------------------------------------------------------------

const ROOM = { x: 1.8, zFront: -2.2, zBack: 1.4, h: 2.5 };
const FAULTS = ["audio", "camera", "ventilation"];
const PANELS = ["audio", "camera", "vent"];

export function createSpaceFnaf3(THREE, scene, options = {}) {
  const K = makeKit(THREE);
  const { box, cyl, sph, plane, std, basic, tex, hit } = K;
  const inj = options.materials ?? {};
  const group = new THREE.Group(); group.name = "space-fnaf3";
  scene?.add?.(group);
  const rnd = seeded(3);

  const metalTex = tex(256, 256, (c, w, h) => {
    c.fillStyle = "#3a4238"; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 64) { c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(x, 0, 3, h); }
    for (let y = 0; y < h; y += 64) { c.fillStyle = "rgba(0,0,0,.25)"; c.fillRect(0, y, w, 2); }
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(${rnd() < .5 ? "0,0,0" : "120,150,100"},${rnd() * 0.08})`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 18, 1 + rnd() * 2); }
    for (let i = 0; i < 40; i++) { c.fillStyle = "rgba(90,50,20,.18)"; c.fillRect(rnd() * w, rnd() * h * 0.9, 2, 20 + rnd() * 60); }
  });
  const floorTex = tex(128, 128, (c, w, h) => {
    c.fillStyle = "#222a22"; c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(0,0,0,.6)"; for (let i = 0; i < w; i += 16) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i - 16, h); c.stroke(); }
    for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(0,0,0,${rnd() * 0.2})`; c.fillRect(rnd() * w, rnd() * h, 3, 3); }
  }, { repeat: [3, 3] });
  const M = {
    wall: inj.wallPlaster ?? std({ color: metalTex ? 0xffffff : 0x3a4238, map: metalTex, roughness: 0.85, metalness: 0.2 }),
    floor: std({ color: floorTex ? 0xffffff : 0x222a22, map: floorTex, roughness: 0.9 }),
    ceil: std({ color: 0x1a201a, roughness: 1 }),
    metal: inj.metalAged ?? std({ color: 0x5a6258, roughness: 0.55, metalness: 0.5 }),
    desk: inj.woodDark ?? std({ color: 0x2f3a2c, roughness: 0.8, metalness: 0.2 }),
    dark: std({ color: 0x050605, roughness: 1 }),
    plastic: std({ color: 0x232823, roughness: 0.5 }),
    red: std({ color: 0x8a2020, roughness: 0.6 }),
  };

  // ---- architecture ----
  const W = ROOM.x, H = ROOM.h, zF = ROOM.zFront, zB = ROOM.zBack, L = zB - zF, zc = (zF + zB) / 2;
  plane(group, M.floor, W * 2, L, 0, 0, zc).rotation.x = -Math.PI / 2;
  plane(group, M.ceil, W * 2, L, 0, H, zc).rotation.x = Math.PI / 2;
  plane(group, M.wall, W * 2, H, 0, H / 2, zF);
  plane(group, M.wall, W * 2, H, 0, H / 2, zB).rotation.y = Math.PI;
  for (const s of [-1, 1]) plane(group, M.wall, L, H, s * W, H / 2, zc).rotation.y = -s * Math.PI / 2;
  // exposed ceiling duct + pipes
  box(group, M.metal, 0.5, 0.4, L, 0, H - 0.2, zc);
  for (let z = zF + 0.5; z < zB; z += 1.0) box(group, M.dark, 0.54, 0.45, 0.04, 0, H - 0.2, z);
  cyl(group, M.metal, 0.05, L, -W + 0.2, H - 0.25, zc).rotation.x = Math.PI / 2;
  cyl(group, M.metal, 0.04, L, -W + 0.35, H - 0.2, zc).rotation.x = Math.PI / 2;
  // hazard stripe baseboard
  const hz = tex(128, 16, (c, w, h) => { for (let x = -16; x < w + 16; x += 16) { c.fillStyle = (x / 16) % 2 ? "#d9c04a" : "#111"; c.beginPath(); c.moveTo(x, h); c.lineTo(x + 16, 0); c.lineTo(x + 32, 0); c.lineTo(x + 16, h); c.fill(); } });
  const hzM = std({ color: hz ? 0xffffff : 0x8a7a30, map: hz, roughness: 0.9 });
  plane(group, hzM, W * 2, 0.12, 0, 0.08, zF + 0.005);
  for (const s of [-1, 1]) plane(group, hzM, L, 0.12, s * (W - 0.005), 0.08, zc).rotation.y = -s * Math.PI / 2;

  // ---- desk + monitor ----
  box(group, M.desk, 2.1, 0.07, 0.8, 0, 0.74, -1.5);
  box(group, M.desk, 0.07, 0.72, 0.8, -1.0, 0.36, -1.5);
  box(group, M.desk, 0.07, 0.72, 0.8, 1.0, 0.36, -1.5);
  box(group, M.dark, 1.9, 0.6, 0.04, 0, 0.4, -1.86);

  const S = { panel: "camera", faults: { audio: false, camera: false, ventilation: false }, sealed: [false, false, false],
    sealShown: [0, 0, 0], lureRoom: null, lureT: 9, power: false, powerOut: false, tension: 0, dirty: true, lastBlink: 0, fanPhase: 0, fanSpeed: 0, flick: 1 };

  // screen canvas
  const SW = 256, SH = 160;
  let sctx = null, screenTex = null;
  if (hasDOM()) {
    const c = document.createElement("canvas"); c.width = SW; c.height = SH; sctx = c.getContext("2d");
    screenTex = new THREE.CanvasTexture(c); screenTex.colorSpace = THREE.SRGBColorSpace; K.geo({ dispose() { screenTex.dispose(); } });
  }
  function drawScreen(blink) {
    if (!sctx) return;
    const c = sctx;
    c.fillStyle = "#06120a"; c.fillRect(0, 0, SW, SH);
    c.font = "bold 11px monospace"; c.textAlign = "left";
    c.fillStyle = "#7dffa0"; c.fillText("MAINTENANCE TERMINAL", 8, 14);
    c.fillStyle = "rgba(125,255,160,.35)"; c.fillRect(8, 19, SW - 16, 1);
    FAULTS.forEach((f, i) => {
      const bad = S.faults[f];
      c.fillStyle = bad ? (blink ? "#ff4a3a" : "#401410") : "#4fd078";
      c.fillRect(10, 28 + i * 16, 10, 10);
      c.fillStyle = bad ? "#ff6a58" : "#7dffa0";
      c.fillText(`${f.toUpperCase().padEnd(12)} ${bad ? "FAULT" : "OK"}`, 26, 37 + i * 16);
    });
    c.fillStyle = "rgba(125,255,160,.35)"; c.fillRect(8, 80, SW - 16, 1);
    c.fillStyle = "#9dffb8";
    if (S.panel === "audio") {
      c.fillText(S.faults.audio ? "AUDIO LURE: OFFLINE" : S.lureRoom != null ? `LURE SENT -> ROOM ${S.lureRoom}` : "LURE READY", 10, 98);
      for (let i = 0; i < 24; i++) c.fillRect(10 + i * 10, 140 - (S.faults.audio ? 3 : 6 + ((i * 7 + (S.lureT < 1 ? 13 : 3)) % 30)), 6, S.faults.audio ? 3 : 6 + ((i * 7 + (S.lureT < 1 ? 13 : 3)) % 30));
    } else if (S.panel === "camera") {
      c.fillText(S.faults.camera ? "CAMERA SYSTEM: REBOOT REQUIRED" : "CAMERAS ONLINE: 3/3", 10, 98);
      c.strokeStyle = "#4fd078"; for (let i = 0; i < 3; i++) { c.strokeRect(10 + i * 80, 108, 72, 40); if (S.faults.camera) { c.fillStyle = "rgba(255,80,60,.5)"; c.fillRect(10 + i * 80, 108, 72, 40); } }
    } else {
      c.fillText("VENT SECTIONS", 10, 98);
      for (let i = 0; i < 3; i++) { c.fillStyle = S.sealed[i] ? "#4fd078" : "#2a4a34"; c.fillRect(10 + i * 80, 108, 72, 40); c.fillStyle = "#001"; c.fillText(S.sealed[i] ? `V${i + 1} SEALED` : `V${i + 1} OPEN`, 16 + i * 80, 132); }
      if (S.faults.ventilation) { c.fillStyle = blink ? "#ff6a58" : "#401410"; c.fillText("AIRFLOW FAILURE", 10, 156); }
    }
    for (let y = 0; y < SH; y += 3) { c.fillStyle = "rgba(0,0,0,.18)"; c.fillRect(0, y, SW, 1); }
    screenTex.needsUpdate = true;
  }
  const screenMat = std({ color: 0x000000, emissive: screenTex ? 0xffffff : 0x1d5a30, emissiveMap: screenTex, emissiveIntensity: 1.1, roughness: 1 });
  const mon = new THREE.Group(); group.add(mon); mon.position.set(0, 0.78, -1.55);
  box(mon, M.plastic, 1.35, 0.95, 0.5, 0, 0.52, -0.05);
  box(mon, M.plastic, 0.5, 0.06, 0.4, 0, 0.03, 0);
  plane(mon, screenMat, 1.15, 0.72, 0, 0.56, 0.21);
  mon.rotation.x = 0;
  // three buttons across the monitor bezel (on-screen buttons)
  const btns = {};
  const btnDefs = [["audio", "AUDIO", -0.42], ["camera", "CAMERA", 0], ["vent", "VENT", 0.42]];
  for (const [id, label, x] of btnDefs) {
    const t = tex(128, 40, (c, w, h) => { c.fillStyle = "#0a1c10"; c.fillRect(0, 0, w, h); c.strokeStyle = "#7dffa0"; c.lineWidth = 3; c.strokeRect(3, 3, w - 6, h - 6); c.fillStyle = "#7dffa0"; c.font = "bold 20px monospace"; c.textAlign = "center"; c.fillText(label, w / 2, 28); });
    const m = std({ color: t ? 0x000000 : 0x113322, emissive: t ? 0xffffff : 0x2a8a50, emissiveMap: t, emissiveIntensity: 0.6, roughness: 0.4 });
    const g = new THREE.Group(); mon.add(g);
    plane(g, m, 0.34, 0.1, x, 0.11, 0.213);
    hit(g, 0.4, 0.16, 0.12, x, 0.11, 0.22);
    btns[id] = { g, m };
  }

  // ---- fan ----
  const fan = new THREE.Group(); group.add(fan); fan.position.set(0.8, 0.78, -1.25);
  cyl(fan, M.metal, 0.09, 0.03, 0, 0.015, 0);
  cyl(fan, M.metal, 0.015, 0.2, 0, 0.12, 0);
  const fanHead = new THREE.Group(); fanHead.position.set(0, 0.24, 0); fan.add(fanHead);
  cyl(fanHead, M.plastic, 0.04, 0.1, 0, 0, 0).rotation.x = Math.PI / 2;
  const blades = new THREE.Group(); blades.position.z = 0.07; fanHead.add(blades);
  for (let i = 0; i < 3; i++) { const b = box(blades, M.metal, 0.05, 0.13, 0.005, 0, 0, 0); b.position.set(Math.sin(i * 2.094) * 0.07, Math.cos(i * 2.094) * 0.07, 0); b.rotation.z = -i * 2.094; }
  const cage = K.add(fanHead, K.geo(new THREE.TorusGeometry(0.16, 0.004, 4, 20)), M.metal, 0, 0, 0.09);
  hit(fan, 0.4, 0.45, 0.4, 0, 0.2, 0);

  // ---- heater ----
  const heater = new THREE.Group(); group.add(heater); heater.position.set(-1.35, 0, -0.6);
  box(heater, M.metal, 0.4, 0.5, 0.18, 0, 0.25, 0);
  const coilMat = basic({ color: 0xff7a20 });
  for (let i = 0; i < 4; i++) box(heater, coilMat, 0.3, 0.025, 0.02, 0, 0.12 + i * 0.09, 0.1);
  box(heater, M.dark, 0.4, 0.03, 0.2, 0, 0.5, 0);

  // ---- vent grates with seal plates ----
  const ventDefs = [
    { x: -W + 0.02, y: 0.7, z: -0.3, ry: Math.PI / 2 },
    { x: W - 0.02, y: 0.7, z: -0.6, ry: -Math.PI / 2 },
    { x: -1.3, y: 0.8, z: zF + 0.02, ry: 0 },
  ];
  const vents = ventDefs.map((d, i) => {
    const g = new THREE.Group(); group.add(g); g.position.set(d.x, d.y, d.z); g.rotation.y = d.ry;
    box(g, M.metal, 0.8, 0.8, 0.08, 0, 0, 0);
    box(g, M.dark, 0.68, 0.68, 0.1, 0, 0, 0.01);
    for (let k = -3; k <= 3; k++) box(g, M.metal, 0.66, 0.02, 0.025, 0, k * 0.09, 0.06).rotation.x = 0.4;
    const plate = box(g, M.red, 0.72, 0.72, 0.03, 0, 0.75, 0.1); // slid up out of the way when open
    const lampM = basic({ color: 0x3a0a0a });
    box(g, lampM, 0.06, 0.06, 0.03, 0.34, -0.46, 0.06);
    const wheel = K.add(g, K.geo(new THREE.TorusGeometry(0.06, 0.012, 6, 12)), M.metal, -0.3, -0.46, 0.09);
    hit(g, 0.9, 0.9, 0.3, 0, 0, 0.08);
    return { g, plate, lampM, wheel };
  });

  // ---- lure station ----
  const lure = new THREE.Group(); group.add(lure); lure.position.set(1.4, 0, -0.5);
  cyl(lure, M.metal, 0.12, 0.03, 0, 0.015, 0);
  cyl(lure, M.metal, 0.02, 0.7, 0, 0.35, 0);
  box(lure, M.plastic, 0.3, 0.3, 0.2, 0, 0.8, 0);
  const coneMat = std({ color: 0x111111, emissive: 0x30ff70, emissiveIntensity: 0.05, roughness: 0.6 });
  const spk = cyl(lure, coneMat, 0.1, 0.03, 0, 0.8, 0.11); spk.rotation.x = Math.PI / 2;
  const lureRingMat = basic({ color: 0x66ff99, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const lureRing = K.add(lure, K.geo(new THREE.RingGeometry(0.9, 1, 24)), lureRingMat, 0, 0.8, 0.14);
  lureRing.scale.setScalar(0.1);
  box(lure, M.red, 0.05, 0.05, 0.02, 0.1, 0.93, 0.11);
  hit(lure, 0.45, 0.9, 0.35, 0, 0.55, 0);

  // posters/notes
  const noteT = tex(96, 128, (c, w, h) => { c.fillStyle = "#c8c19a"; c.fillRect(0, 0, w, h); c.fillStyle = "#222"; for (let i = 0; i < 9; i++) c.fillRect(10, 14 + i * 12, w - 20 - rnd() * 30, 3); c.fillStyle = "#8a2020"; c.fillRect(10, 6, 40, 5); for (let i = 0; i < 200; i++) { c.fillStyle = `rgba(0,0,0,${rnd() * .1})`; c.fillRect(rnd() * w, rnd() * h, 2, 2); } });
  const noteM = std({ color: noteT ? 0xffffff : 0x9a9478, map: noteT, roughness: 1 });
  plane(group, noteM, 0.4, 0.55, 1.2, 1.55, zF + 0.01);
  plane(group, noteM, 0.4, 0.55, 0.6, 1.4, zF + 0.01).rotation.z = 0.05;
  plane(group, noteM, 0.45, 0.6, -W + 0.01, 1.6, 0.6).rotation.y = Math.PI / 2;

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0x5a7a58, 0x101510, 0.5); group.add(hemi);
  const heaterLight = new THREE.PointLight(0x8cff6a, 6, 7, 2); heaterLight.position.set(0, 2.1, -0.4); group.add(heaterLight);
  const screenLight = new THREE.PointLight(0x4cff9a, 1.4, 4, 2); screenLight.position.set(0, 1.35, -1.1); group.add(screenLight);
  const bulbM = basic({ color: 0xc8ffa0 });
  box(group, bulbM, 0.4, 0.04, 0.12, 0, H - 0.42, -0.4);

  // ---- API ----
  const emit = (id, info) => options.onInteract?.(id, info);
  const faultName = (n) => (n === "vent" ? "ventilation" : n);
  const api = {
    setVentSealed(i, b) { if (i >= 0 && i < 3 && Number.isInteger(i)) { S.sealed[i] = !!b; S.dirty = true; return S.sealed[i]; } return false; },
    setSystemFault(name, b) { const n = faultName(name); if (!FAULTS.includes(n)) return false; S.faults[n] = !!b; S.dirty = true; return S.faults[n]; },
    pulseLure(roomId) { S.lureRoom = roomId ?? null; S.lureT = 0; S.dirty = true; },
    setPanel(p) { if (PANELS.includes(p)) { S.panel = p; S.dirty = true; } return S.panel; },
    getState: () => ({ panel: S.panel, faults: { ...S.faults }, sealed: [...S.sealed], lureRoom: S.lureRoom, powerOut: S.powerOut }),
  };
  const mk = (id, label, mesh, fn) => { K.tagAll(mesh, id); return { id, label, mesh, onInteract: () => { const r = fn(); emit(id, r); return r; } }; };
  const interactables = [
    mk("btn-audio", "Audio control", btns.audio.g, () => api.setPanel("audio")),
    mk("btn-camera", "Camera control", btns.camera.g, () => api.setPanel("camera")),
    mk("btn-vent", "Ventilation control", btns.vent.g, () => api.setPanel("vent")),
    ...vents.map((v, i) => mk(`vent-${i}`, `Seal vent ${i + 1}`, v.g, () => api.setVentSealed(i, !S.sealed[i]))),
    mk("lure", "Audio lure", lure, () => { api.pulseLure(S.lureRoom); return { pulsed: true }; }),
    mk("fan", "Desk fan", fan, () => ({ fan: true })),
  ];

  function update(dt, time = 0, state = {}) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    S.tension = clamp01(state.tension ?? S.tension);
    if (typeof state.powerOut === "boolean") S.powerOut = state.powerOut;
    const on = S.powerOut ? 0 : 1;
    const blink = Math.floor(time * 2.5) % 2 === 0;
    const anyFault = FAULTS.some((f) => S.faults[f]);
    if (S.dirty || (anyFault && blink !== S.lastBlink)) { drawScreen(blink); S.dirty = false; S.lastBlink = blink; }
    S.lureT += dt;
    const jitter = S.faults.camera ? (Math.sin(time * 41) > 0.6 ? 0.3 : 1) : 1;
    screenMat.emissiveIntensity = 1.1 * on * jitter * (0.95 + 0.05 * Math.sin(time * 19));
    screenLight.intensity = 1.4 * on * jitter;
    // heater-green light: slow breath, flicker when tense / ventilation faulted
    const flick = (S.tension > 0.6 || S.faults.ventilation) && Math.sin(time * 29) * Math.sin(time * 7.3) > 0.6 ? 0.35 : 1;
    heaterLight.intensity = (4.5 + 1.2 * Math.sin(time * 0.8)) * flick * (0.15 + 0.85 * on);
    hemi.intensity = 0.1 + 0.4 * on;
    bulbM.color.setScalar(on * flick * 0.85 + 0.03).multiply(new THREE.Color(0xc8ffa0));
    coilMat.color.setRGB(1, 0.35 + 0.15 * Math.sin(time * 2), 0.1).multiplyScalar(0.7 + 0.3 * on);
    // fan: ventilation fault stutters / slows it
    const targetSpeed = S.faults.ventilation ? (Math.sin(time * 3) > 0.4 ? 5 : 0.5) : 14;
    S.fanSpeed += (targetSpeed * on - S.fanSpeed) * ease(dt, 3);
    S.fanPhase += S.fanSpeed * dt;
    blades.rotation.z = S.fanPhase;
    fanHead.rotation.y = Math.sin(time * 0.5) * 0.6;
    // vents
    for (let i = 0; i < 3; i++) {
      const v = vents[i];
      S.sealShown[i] += ((S.sealed[i] ? 1 : 0) - S.sealShown[i]) * ease(dt, 8);
      v.plate.position.y = 0.75 * (1 - S.sealShown[i]);
      v.plate.visible = S.sealShown[i] > 0.03;
      v.lampM.color.setRGB(S.sealed[i] ? 0.2 : 0.7, S.sealed[i] ? 0.9 : 0.1, S.sealed[i] ? 0.3 : 0.08).multiplyScalar(0.3 + 0.7 * on);
      v.wheel.rotation.z = S.sealShown[i] * Math.PI * 2;
    }
    // lure pulse
    const p = Math.min(S.lureT / 1.2, 1);
    lureRing.scale.setScalar(0.1 + p * 1.4);
    lureRingMat.opacity = p < 1 && !S.faults.audio ? (1 - p) * 0.8 : 0;
    coneMat.emissiveIntensity = p < 1 && !S.faults.audio ? 1.2 * (1 - p) * (0.6 + 0.4 * Math.sin(time * 60)) : S.faults.audio ? 0 : 0.05;
    // active panel button highlight
    for (const [id] of btnDefs) btns[id].m.emissiveIntensity = (S.panel === id ? 1.5 : 0.55) * on;
  }

  function dispose() { scene?.remove?.(group); K.dispose(); }

  return {
    group, update, interactables, dispose,
    setPowerOut(b) { S.powerOut = !!b; },
    ...api,
    debug: { renderMeshes: () => countRender(group), vents, blades, screenMat, heaterLight, screenLight, btns },
  };
}
