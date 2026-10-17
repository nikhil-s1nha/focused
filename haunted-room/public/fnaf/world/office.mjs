// office.mjs — the security office (seated, fixed viewpoint), original design.
//
// Metric layout (player seat ~ (0,1.2,0) looking -Z):
//   room x ±1.8, z -1.7..+1.3, ceiling y 2.6. Desk at z≈-0.8 with a fan, a
//   wall-mounted CRT (camera feed) and a smaller map screen on the front wall,
//   a mini radio and a flickering lamp. Doorways in both side walls
//   (z -0.7..0.3, 1.0 m wide, 2.1 m high) each with a vertical sliding steel
//   door and a 3.6 m hall segment beyond with its own real point light.
//   Door/light buttons sit on the wall between each doorway and the front wall.
//
// Real lights (constant count, intensity-animated, never added/removed):
//   1 ambient (cheap), lamp point, hall-left point, hall-right point.
//
// API:
//   createOffice(THREE, scene, { materials?, autoToggle=false }) => {
//     group, update(dt, time, state?), interactables, anchors, screens,
//     setDoor(side, closed), getDoor(side), setHallLight(side, on),
//     getHallLight(side), setDoorOccupant(side, charId|null), getDoorOccupant(side),
//     setPowerOut(bool), isPowerOut(), setMonitorUp(bool), isMonitorUp(),
//     setMonitorTextures(feedTexture, mapTexture), pressButton(id),
//     getFanState(), on(type, fn) -> off(), debug, dispose() }
// update state (all optional): { tension 0..1 } — raises lamp dip frequency.
// Events: 'press' {id,kind,side,uv?}, 'press-dead' (button during power out),
//   'door' {side,closed}, 'door-start', 'door-done' {side,closed}, 'light'
//   {side,on}, 'monitor' {up}, 'camera-pick' {uv}, 'power' {out}, 'fan' {speed}.

import { canvasOf, makePlaceholderKit } from "./rooms.mjs";

const SIDES = ["left", "right"];
const SIGN = { left: -1, right: 1 };
const DOOR_TIME = 0.4;
const DOOR_H = 2.15;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function createOffice(THREE, scene, options = {}) {
  const injected = options.materials ?? {};
  const autoToggle = !!options.autoToggle;
  const geos = [], mats = [], texs = [];
  const geo = (g) => (geos.push(g), g);
  const own = (m) => (mats.push(m), m);
  const rand = rng(1984);

  const root = new THREE.Group(); root.name = "office";
  scene.add(root);
  const unit = geo(new THREE.BoxGeometry(1, 1, 1));
  const plane1 = geo(new THREE.PlaneGeometry(1, 1));
  const cyl1 = geo(new THREE.CylinderGeometry(1, 1, 1, 14));
  const sph1 = geo(new THREE.SphereGeometry(1, 8, 6));
  const ring1 = geo(new THREE.TorusGeometry(0.19, 0.008, 4, 18));

  function paint(w, h, fn) {
    const c = canvasOf(w, h); if (!c) return null;
    const ctx = c.getContext("2d"); fn(ctx, w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; texs.push(t); return t;
  }
  const blotch = (ctx, w, h, n, a = 0.25) => {
    for (let i = 0; i < n; i++) {
      const x = rand() * w, y = rand() * h, r = 6 + rand() * w * 0.1;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  };
  const std = (color, extra = {}, map = null) => own(new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, map, ...extra }));
  const basic = (color, extra = {}) => own(new THREE.MeshBasicMaterial({ color, ...extra }));
  // textured when a canvas exists, otherwise a flat fallback color (Node tests)
  const tstd = (tex, fallback, extra = {}) => std(tex ? 0xffffff : fallback, extra, tex);

  // ---- materials (injected materials win; otherwise painted here)
  const wallTex = paint(256, 256, (ctx, w, h) => { // painted cinder block
    ctx.fillStyle = "#6f7568"; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 2;
    for (let y = 0; y < 8; y++) { ctx.beginPath(); ctx.moveTo(0, y * 32); ctx.lineTo(w, y * 32); ctx.stroke(); for (let x = (y % 2) * 32; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x, y * 32); ctx.lineTo(x, y * 32 + 32); ctx.stroke(); } }
    blotch(ctx, w, h, 40, 0.3);
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, h * 0.78, w, h * 0.22);
  });
  const floorTex = paint(256, 256, (ctx, w, h) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { ctx.fillStyle = (x + y) % 2 ? "#2c2e2c" : "#222421"; ctx.fillRect(x * 32, y * 32, 32, 32); }
    blotch(ctx, w, h, 50, 0.3);
  });
  const steelTex = paint(128, 256, (ctx, w, h) => {
    ctx.fillStyle = "#5c6064"; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) { ctx.fillStyle = `rgba(255,255,255,${rand() * 0.06})`; ctx.fillRect(0, rand() * h, w, 1); }
    for (let i = -4; i < 14; i++) { ctx.fillStyle = i % 2 ? "#c9a227" : "#1a1a1a"; const x = i * 14; ctx.beginPath(); ctx.moveTo(x, h * 0.9); ctx.lineTo(x + 14, h * 0.9); ctx.lineTo(x + 28, h); ctx.lineTo(x + 14, h); ctx.fill(); }
    ctx.fillStyle = "#2a2d30"; for (const [x, y] of [[8, 8], [w - 8, 8], [8, h * 0.8], [w - 8, h * 0.8], [8, h / 2], [w - 8, h / 2]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.3); ctx.fill(); }
    blotch(ctx, w, h, 12, 0.3);
  });
  const mWall = injected.wallPlaster ?? tstd(wallTex, 0x4a5048, { roughness: 1 });
  const mFloor = injected.floorPlanks ?? tstd(floorTex, 0x242622, { roughness: 0.8 });
  const mCeil = injected.ceiling ?? std(0x1a1d1a, { roughness: 1 });
  const mMetal = injected.metalAged ?? std(0x4a4e50, { roughness: 0.55, metalness: 0.5 });
  const mWood = injected.woodDark ?? std(0x3a2a1c, { roughness: 0.85 });
  const mSteel = tstd(steelTex, 0x5c6064, { roughness: 0.5, metalness: 0.6 });
  const mBlack = std(0x0c0c0d, { roughness: 0.7 });
  const mHallWall = {};
  for (const s of SIDES) {
    mHallWall[s] = injected.corridorWall ? injected.corridorWall.clone() : tstd(wallTex, 0x7a807a, { roughness: 1 });
    if (injected.corridorWall) mats.push(mHallWall[s]);
  }

  function mesh(parent, g, m, x, y, z, sx, sy, sz, ry = 0, rx = 0, name) {
    const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz);
    o.rotation.set(rx, ry, 0); if (name) o.name = name; parent.add(o); return o;
  }
  const box = (p, m, x, y, z, w, h, d, ry = 0, name) => mesh(p, unit, m, x, y, z, w, h, d, ry, 0, name);
  const plane = (p, m, x, y, z, w, h, ry = 0, rx = 0, name) => mesh(p, plane1, m, x, y, z, w, h, 1, ry, rx, name);
  const cyl = (p, m, x, y, z, r, h, name) => mesh(p, cyl1, m, x, y, z, r, h, r, 0, 0, name);

  // ---- room shell
  const X = 1.8, ZF = -1.7, ZB = 1.3, H = 2.6, DZ0 = -0.7, DZ1 = 0.3;
  plane(root, mFloor, 0, 0, (ZF + ZB) / 2, X * 2, ZB - ZF, 0, -Math.PI / 2, "floor");
  plane(root, mCeil, 0, H, (ZF + ZB) / 2, X * 2, ZB - ZF, 0, Math.PI / 2, "ceiling");
  box(root, mWall, 0, H / 2, ZF - 0.1, X * 2 + 0.4, H, 0.2, 0, "wall-front");
  box(root, mWall, 0, H / 2, ZB + 0.1, X * 2 + 0.4, H, 0.2, 0, "wall-back");
  for (const s of SIDES) {
    const x = SIGN[s] * (X + 0.1);
    box(root, mWall, x, H / 2, (ZF + DZ0) / 2, 0.2, H, DZ0 - ZF, 0, `wall-${s}-front`);
    box(root, mWall, x, H / 2, (DZ1 + ZB) / 2, 0.2, H, ZB - DZ1, 0, `wall-${s}-back`);
    box(root, mWall, x, (DOOR_H + H) / 2, (DZ0 + DZ1) / 2, 0.2, H - DOOR_H, DZ1 - DZ0, 0, `lintel-${s}`);
  }

  // ---- lights, state
  const lights = {};
  const ambient = new THREE.AmbientLight(0x1c2530, 0.45); root.add(ambient);
  const lamp = new THREE.PointLight(0xffc880, 3.2, 7, 2); lamp.position.set(0.55, 1.35, -0.85); lamp.name = "lamp-light"; root.add(lamp);
  const state = {
    power: false,
    doors: { left: { closed: false, p: 0 }, right: { closed: false, p: 0 } },
    hall: { left: { on: false, k: 0 }, right: { on: false, k: 0 } },
    occupant: { left: null, right: null },
    monitorUp: false,
    fan: 1, fanAngle: 0, fanPrev: 1,
  };
  const doorMesh = {}, hallGroup = {};
  const kit = makePlaceholderKit(THREE);
  const occ = { left: {}, right: {} };
  const HALL_X0 = X + 0.2, HALL_LEN = 3.6;
  for (const s of SIDES) {
    const sg = SIGN[s];
    const hg = new THREE.Group(); hg.name = `hall-${s}`; root.add(hg); hallGroup[s] = hg;
    const cx = sg * (HALL_X0 + HALL_LEN / 2), zc = (DZ0 + DZ1) / 2, wd = DZ1 - DZ0;
    plane(hg, mFloor, cx, 0.002, zc, HALL_LEN, wd, 0, -Math.PI / 2);
    plane(hg, mCeil, cx, H, zc, HALL_LEN, wd, 0, Math.PI / 2);
    plane(hg, mHallWall[s], cx, H / 2, DZ0, HALL_LEN, H, 0, 0, "hall-wall-a");
    plane(hg, mHallWall[s], cx, H / 2, DZ1, HALL_LEN, H, Math.PI, 0, "hall-wall-b");
    plane(hg, mBlack, sg * (HALL_X0 + HALL_LEN), H / 2, zc, wd, H, -sg * Math.PI / 2, 0, "hall-end");
    const pl = new THREE.PointLight(0xdfe8ff, 0, 6.5, 2); pl.position.set(sg * (HALL_X0 + 1.2), 2.2, zc); pl.name = `hall-light-${s}`; root.add(pl); lights[s] = pl;
    doorMesh[s] = box(root, mSteel, sg * X, DOOR_H / 2 + 2.2, zc, 0.1, DOOR_H, wd + 0.04, 0, `door-${s}`);
    box(root, mMetal, sg * (X - 0.02), 1.07, DZ0 - 0.03, 0.14, DOOR_H, 0.06);
    box(root, mMetal, sg * (X - 0.02), 1.07, DZ1 + 0.03, 0.14, DOOR_H, 0.06);
    for (const cid of ["bellwether", "lark", "ratchet", "maestro"]) {
      const ph = kit.build(cid);
      ph.group.position.set(sg * (HALL_X0 + 1.5), 0, zc);
      ph.group.rotation.y = sg < 0 ? Math.PI / 2 : -Math.PI / 2;
      ph.group.visible = false; root.add(ph.group); occ[s][cid] = ph;
    }
  }

  // ---- desk, fan
  box(root, mWood, 0, 0.75, -0.8, 1.9, 0.06, 0.7, 0, "desk-top");
  box(root, mMetal, -0.9, 0.37, -0.8, 0.06, 0.74, 0.62); box(root, mMetal, 0.9, 0.37, -0.8, 0.06, 0.74, 0.62);
  box(root, mBlack, 0, 0.45, -1.08, 1.8, 0.7, 0.04, 0, "desk-modesty");
  const fan = new THREE.Group(); fan.name = "fan"; fan.position.set(-0.7, 0.78, -0.65); root.add(fan);
  cyl(fan, mMetal, 0, 0.02, 0, 0.1, 0.04); cyl(fan, mMetal, 0, 0.17, 0, 0.018, 0.28);
  const fanHead = new THREE.Group(); fanHead.position.set(0, 0.32, 0); fan.add(fanHead);
  mesh(fanHead, cyl1, mMetal, 0, 0, -0.02, 0.05, 0.1, 0.05, 0, Math.PI / 2);
  const rotor = new THREE.Group(); rotor.position.set(0, 0, 0.05); fanHead.add(rotor);
  const mBlade = std(0x8a8d8c, { roughness: 0.4, metalness: 0.3 });
  for (let i = 0; i < 3; i++) {
    const b = box(rotor, mBlade, Math.sin(i * 2.094) * -0.09, Math.cos(i * 2.094) * 0.09, 0, 0.07, 0.17, 0.008);
    b.rotation.z = i * 2.094;
  }
  mesh(fanHead, ring1, mMetal, 0, 0, 0.07, 1, 1, 1);

  // ---- monitors on front wall
  const mScreenFeed = basic(0x000000), mScreenMap = basic(0x000000);
  const monGroup = new THREE.Group(); monGroup.name = "monitor-main"; root.add(monGroup);
  box(monGroup, mBlack, -0.25, 1.5, ZF + 0.12, 0.98, 0.74, 0.22, 0, "crt-shell");
  box(monGroup, mMetal, -0.25, 1.5, ZF + 0.235, 0.9, 0.66, 0.02, 0, "crt-bezel");
  const feedScreen = plane(monGroup, mScreenFeed, -0.25, 1.5, ZF + 0.25, 0.8, 0.6, 0, 0, "screen-feed");
  const mapGroup = new THREE.Group(); mapGroup.name = "monitor-map"; root.add(mapGroup);
  box(mapGroup, mBlack, 0.78, 1.5, ZF + 0.1, 0.52, 0.62, 0.18, 0, "map-shell");
  const mapScreen = plane(mapGroup, mScreenMap, 0.78, 1.5, ZF + 0.2, 0.44, 0.54, 0, 0, "screen-map");
  box(root, mBlack, 0, 1.0, ZF + 0.25, 1.8, 0.1, 0.35, 0, "shelf-monitors");
  // ---- lamp
  const lampGroup = new THREE.Group(); lampGroup.position.set(0.55, 0.78, -0.85); root.add(lampGroup);
  cyl(lampGroup, mMetal, 0, 0.02, 0, 0.09, 0.04);
  mesh(lampGroup, cyl1, mMetal, 0, 0.2, 0, 0.012, 0.36, 0.012, 0, 0).rotation.z = -0.25;
  mesh(lampGroup, cyl1, mMetal, -0.1, 0.4, 0, 0.07, 0.1, 0.07, 0, 0).rotation.z = 0.5;
  const mBulb = basic(0xffd89a);
  mesh(lampGroup, sph1, mBulb, -0.07, 0.36, 0, 0.035, 0.035, 0.035);

  // ---- radio
  const radio = new THREE.Group(); radio.position.set(1.15, 0.78, -0.75); radio.rotation.y = -0.35; root.add(radio);
  const radioFace = paint(128, 64, (ctx) => { ctx.fillStyle = "#3a3024"; ctx.fillRect(0, 0, 128, 64); ctx.fillStyle = "#111"; for (let i = 0; i < 12; i++) ctx.fillRect(8, 8 + i * 4, 50, 2); ctx.fillStyle = "#c9a227"; ctx.fillRect(70, 14, 50, 14); ctx.fillStyle = "#000"; ctx.fillRect(74, 20, 40, 2); ctx.fillStyle = "#a02020"; ctx.fillRect(100, 18, 2, 10); });
  const mRadio = tstd(radioFace, 0x3a3024, { roughness: 0.7 });
  box(radio, mWood, 0, 0.08, 0, 0.26, 0.16, 0.1, 0, "radio-body");
  plane(radio, mRadio, 0, 0.08, 0.052, 0.24, 0.13, 0, 0, "radio-face");
  mesh(radio, cyl1, mMetal, 0.1, 0.3, -0.03, 0.004, 0.3, 0.004, 0, 0).rotation.z = -0.2;
  const dialGlow = basic(0xffb040); plane(radio, dialGlow, 0.04, 0.095, 0.054, 0.1, 0.03);

  // ---- posters (original art) + paper clutter
  const poster = (w, h, fn) => tstd(paint(w, h, fn), 0x8a8470, { roughness: 1 });
  const p1 = poster(128, 176, (ctx, w, h) => {
    ctx.fillStyle = "#d8c9a0"; ctx.fillRect(0, 0, w, h);
    ["#6a3d22", "#b8a02a", "#a8341f", "#44446a"].forEach((c, i) => { const x = 22 + i * 28; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, 70, 14, 0, 6.3); ctx.fill(); ctx.fillRect(x - 9, 82, 18, 40); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x - 5, 67, 3, 0, 6.3); ctx.arc(x + 5, 67, 3, 0, 6.3); ctx.fill(); });
    ctx.fillStyle = "#4a1a1a"; ctx.font = "bold 20px sans-serif"; ctx.textAlign = "center"; ctx.fillText("CELEBRATE!", w / 2, 30);
    ctx.font = "11px sans-serif"; ctx.fillText("EVERY NIGHT IS PARTY NIGHT", w / 2, 150); blotch(ctx, w, h, 12, 0.3);
  });
  const p2 = poster(128, 176, (ctx, w, h) => {
    ctx.fillStyle = "#c8c8b8"; ctx.fillRect(0, 0, w, h); ctx.fillStyle = "#222"; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "left";
    ctx.fillText("NIGHT SHIFT NOTES", 10, 22); ctx.font = "10px sans-serif";
    ["1. Doors cost power.", "2. Lights cost power.", "3. The cameras cost", "    power. Everything", "    costs power.", "4. If the music stops,", "    check your doors.", "5. Do not hum."].forEach((t, i) => ctx.fillText(t, 10, 46 + i * 15));
    blotch(ctx, w, h, 10, 0.3);
  });
  const p3 = poster(128, 176, (ctx, w, h) => {
    ctx.fillStyle = "#e8e0c0"; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = "#a02020"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(64, 60, 20, 0, 6.3); ctx.moveTo(64, 80); ctx.lineTo(64, 125); ctx.moveTo(40, 100); ctx.lineTo(88, 100); ctx.moveTo(64, 125); ctx.lineTo(48, 155); ctx.moveTo(64, 125); ctx.lineTo(80, 155); ctx.stroke();
    ctx.fillStyle = "#222"; ctx.fillRect(54, 54, 4, 6); ctx.fillRect(70, 54, 4, 6);
    ctx.strokeStyle = "#222"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(64, 70, 8, 0.2, 2.9); ctx.stroke(); blotch(ctx, w, h, 8, 0.25);
  });
  plane(root, p1, -1.4, 1.45, ZF + 0.01, 0.5, 0.7, 0, 0, "poster-1");
  plane(root, p2, 1.5, 1.35, ZF + 0.01, 0.42, 0.58, 0, 0, "poster-2");
  plane(root, p3, -X + 0.01, 1.5, 0.8, 0.5, 0.68, Math.PI / 2, 0, "poster-3");
  const paperTex = paint(128, 64, (ctx) => {
    for (let i = 0; i < 5; i++) { ctx.save(); ctx.translate(20 + i * 22, 30 + (i % 2) * 8); ctx.rotate(rand() * 1.2 - 0.6); ctx.fillStyle = "#d8d4c0"; ctx.fillRect(-14, -18, 28, 36); ctx.fillStyle = "#555"; for (let k = 0; k < 5; k++) ctx.fillRect(-10, -12 + k * 6, 20 - (k % 2) * 6, 1.5); ctx.restore(); }
  });
  plane(root, own(new THREE.MeshStandardMaterial({ map: paperTex, color: paperTex ? 0xffffff : 0xd8d4c0, transparent: !!paperTex, roughness: 1 })), 0.1, 0.785, -0.62, 0.8, 0.4, 0, -Math.PI / 2, "paper-scraps");
  box(root, mBlack, -1.2, 0.2, 0.9, 0.5, 0.4, 0.5, 0.3, "crate");

  // ---- control panels
  const buttons = {}, pressAnim = {}, iact = [];
  const makePanel = (s) => {
    const sg = SIGN[s];
    const pg = new THREE.Group(); pg.position.set(sg * (X - 0.04), 1.3, -1.2); pg.rotation.y = -sg * Math.PI / 2; root.add(pg);
    const label = tstd(paint(96, 160, (ctx, w, h) => {
      ctx.fillStyle = "#26292b"; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = "#777"; ctx.lineWidth = 2; ctx.strokeRect(2, 2, w - 4, h - 4);
      ctx.fillStyle = "#ccc"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.fillText("DOOR", w / 2, 18); ctx.fillText("LIGHT", w / 2, 92); blotch(ctx, w, h, 5, 0.3);
    }), 0x26292b, { roughness: 0.6 });
    box(pg, label, 0, 0, 0, 0.26, 0.42, 0.04, 0, `panel-${s}`);
    for (const kind of ["door", "light"]) {
      const y = kind === "door" ? 0.1 : -0.12;
      const m = basic(0x222222);
      const g = new THREE.Group(); g.position.set(0, y, 0.03); pg.add(g);
      mesh(g, cyl1, m, 0, 0, 0, 0.065, 0.03, 0.065, 0, Math.PI / 2, `${kind}-${s}-cap`);
      mesh(g, cyl1, mMetal, 0, 0, -0.012, 0.08, 0.02, 0.08, 0, Math.PI / 2);
      const id = `${kind}-${s}`;
      g.traverse((o) => (o.userData.interactableId = id));
      buttons[id] = { id, kind, side: s, group: g, mat: m, baseZ: g.position.z };
      iact.push({ id, label: `${kind === "door" ? "Door" : "Light"} (${s})`, mesh: g, onInteract: (hit) => pressButton(id, hit) });
    }
  };
  SIDES.forEach(makePanel);
  monGroup.traverse((o) => (o.userData.interactableId = "monitor"));
  mapGroup.traverse((o) => (o.userData.interactableId = "monitor-map"));
  iact.push({ id: "monitor", label: "Camera monitor", mesh: monGroup, onInteract: (hit) => pressButton("monitor", hit) });
  iact.push({ id: "monitor-map", label: "Camera map", mesh: mapGroup, onInteract: (hit) => pressButton("monitor-map", hit) });

  // ---- events
  const handlers = new Map();
  const emit = (type, payload) => { for (const f of [...(handlers.get(type) ?? [])]) { try { f(payload); } catch { /* listener errors never break the sim */ } } };
  function on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); }

  function pressButton(id, hit) {
    const b = buttons[id];
    if (b) pressAnim[id] = 0.14;
    const kind = b ? b.kind : id === "monitor" ? "monitor" : "map";
    const ev = { id, kind, side: b?.side ?? null };
    if (id === "monitor-map" && hit?.uv) ev.uv = { x: hit.uv.x, y: hit.uv.y };
    if (state.power && b) { emit("press-dead", ev); return false; }
    emit("press", ev);
    if (ev.uv) emit("camera-pick", { uv: ev.uv });
    if (autoToggle) {
      if (kind === "door") api.setDoor(b.side, !state.doors[b.side].closed);
      else if (kind === "light") api.setHallLight(b.side, !state.hall[b.side].on);
      else if (kind === "monitor") api.setMonitorUp(!state.monitorUp);
    }
    return true;
  }

  function refreshOccupant(s) {
    const id = state.occupant[s];
    for (const [cid, ph] of Object.entries(occ[s])) {
      const here = cid === id;
      ph.group.visible = here;
      if (!here) continue;
      const lit = state.hall[s].on && !state.power;
      for (const m of ph.bodyMeshes) m.visible = lit;
      for (const e of ph.eyes) e.visible = lit || state.power; // eyes alone in the dark only when power is out
    }
  }
  function refreshButtons() {
    for (const b of Object.values(buttons)) {
      let c = 0x222222;
      if (!state.power) {
        if (b.kind === "door") c = state.doors[b.side].closed ? 0xd02020 : 0x20c040;
        else c = state.hall[b.side].on ? 0xffd040 : 0x4a4012;
      }
      b.mat.color.set(c);
    }
  }
  let feedTex = null, mapTex = null;
  function refreshScreens() {
    const up = state.monitorUp && !state.power;
    mScreenFeed.color.set(up ? 0xffffff : 0x000000); mScreenMap.color.set(up ? 0xffffff : 0x000000);
    mScreenFeed.map = up ? feedTex : null; mScreenMap.map = up ? mapTex : null;
    mScreenFeed.needsUpdate = mScreenMap.needsUpdate = true;
  }

  const api = {
    group: root,
    interactables: iact,
    anchors: { fan, radio, lamp: lampGroup, doorLeft: doorMesh.left, doorRight: doorMesh.right, hallLeft: hallGroup.left, hallRight: hallGroup.right },
    screens: { feed: feedScreen, map: mapScreen },
    on,
    pressButton: (id) => pressButton(id, null),
    setDoor(side, closed) {
      if (!SIDES.includes(side)) return false;
      const d = state.doors[side]; closed = !!closed;
      if (d.closed !== closed) { d.closed = closed; emit("door", { side, closed }); refreshButtons(); }
      return true;
    },
    getDoor(side) {
      const d = state.doors[side]; if (!d) return null;
      return { closed: d.closed, progress: d.p, moving: d.p !== (d.closed ? 1 : 0) };
    },
    setHallLight(side, on) {
      if (!SIDES.includes(side)) return false;
      on = !!on; const h = state.hall[side];
      if (h.on !== on) { h.on = on; emit("light", { side, on }); refreshButtons(); refreshOccupant(side); }
      return true;
    },
    getHallLight(side) { return state.hall[side]?.on ?? null; },
    setDoorOccupant(side, charId) {
      if (!SIDES.includes(side)) return false;
      if (charId != null && !occ[side][charId]) return false;
      state.occupant[side] = charId ?? null; refreshOccupant(side); return true;
    },
    getDoorOccupant(side) { return state.occupant[side] ?? null; },
    setPowerOut(out) {
      out = !!out; if (state.power === out) return;
      state.power = out; emit("power", { out });
      refreshButtons(); refreshScreens(); refreshOccupant("left"); refreshOccupant("right");
    },
    isPowerOut() { return state.power; },
    setMonitorUp(up) { up = !!up; if (state.monitorUp !== up) { state.monitorUp = up; emit("monitor", { up }); refreshScreens(); } },
    isMonitorUp() { return state.monitorUp; },
    setMonitorTextures(feed, map) { feedTex = feed ?? null; mapTex = map ?? null; refreshScreens(); },
    getFanState() {
      const v = new THREE.Vector3(); fan.getWorldPosition(v);
      return { speed: state.fan, angle: state.fanAngle, position: v };
    },
    update(dt, time, st = {}) {
      dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      const tension = clamp(st.tension ?? 0, 0, 1);
      for (const s of SIDES) {
        const d = state.doors[s], target = d.closed ? 1 : 0;
        if (d.p !== target) {
          const start = d.p === (d.closed ? 0 : 1);
          if (start) emit("door-start", { side: s, closed: d.closed });
          d.p = d.p < target ? Math.min(target, d.p + dt / DOOR_TIME) : Math.max(target, d.p - dt / DOOR_TIME);
          if (d.p === target) emit("door-done", { side: s, closed: d.closed });
        }
        const e = d.p * d.p * (3 - 2 * d.p);
        doorMesh[s].position.y = DOOR_H / 2 + (1 - e) * 2.2;
      }
      const fanTarget = state.power ? 0 : 1;
      state.fan += (fanTarget - state.fan) * (1 - Math.exp(-(state.power ? 0.9 : 3) * dt));
      if (Math.abs(state.fan - state.fanPrev) > 0.05) { state.fanPrev = state.fan; emit("fan", { speed: state.fan }); }
      state.fanAngle += state.fan * 22 * dt;
      rotor.rotation.z = state.fanAngle;
      fanHead.rotation.y = Math.sin(time * 0.45) * 0.7;
      let lampK = 0.92 + 0.08 * Math.sin(time * 37) * Math.sin(time * 11.3);
      const slot = Math.floor(time * 8);
      if (hash(slot) < 0.015 + tension * 0.12) lampK *= 0.15 + 0.5 * hash(slot + 7);
      if (state.power) lampK = 0;
      lamp.intensity = 3.2 * lampK;
      mBulb.color.setRGB(0.45 + 0.55 * lampK, (0.45 + 0.55 * lampK) * 0.85, (0.45 + 0.55 * lampK) * 0.6);
      if (state.power) mBulb.color.setRGB(0.04, 0.03, 0.02);
      ambient.intensity = state.power ? 0.02 : 0.45;
      dialGlow.color.set(state.power ? 0x120a02 : 0xffb040);
      for (const s of SIDES) {
        const h = state.hall[s];
        h.k += ((h.on && !state.power ? 1 : 0) - h.k) * (1 - Math.exp(-30 * dt));
        if (h.k < 0.001) h.k = 0;
        const f = state.occupant[s]
          ? 0.35 + 0.65 * hash(Math.floor(time * 18) + (s === "left" ? 0 : 91))
          : 0.93 + 0.07 * hash(Math.floor(time * 30));
        lights[s].intensity = 4.2 * h.k * f;
      }
      for (const [id, t] of Object.entries(pressAnim)) {
        const nt = Math.max(0, t - dt); pressAnim[id] = nt;
        buttons[id].group.position.z = buttons[id].baseZ - (nt > 0 ? 0.012 : 0);
        if (nt === 0) delete pressAnim[id];
      }
    },
    debug: { lights, doorMesh, hallGroup, buttons, occ, ambient, lamp, mat: { feed: mScreenFeed, map: mScreenMap } },
    dispose() {
      scene.remove(root);
      geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose()); kit.dispose();
      handlers.clear();
    },
  };
  refreshButtons(); refreshScreens();
  return api;
}
