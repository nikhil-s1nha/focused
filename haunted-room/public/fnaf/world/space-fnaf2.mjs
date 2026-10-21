// space-fnaf2.mjs — open-office layout (no doors): long front hallway you can
// flashlight, two side vent openings with vent lights, a hanging head-mask with a
// world-space visor frame, a tablet, a wind-up music box and posters.
// ORIGINAL procedural art; only layout/mechanics are genre-inspired.
//
//   createSpaceFnaf2(THREE, scene, { materials?, onInteract?(id, info) })
//   => { group, update(dt,time,state), interactables, dispose, setPowerOut(b),
//        setFlashlight(on,aim), setVentLight(side,on), setMask(on), setWindLevel(0..1),
//        setEyePosition(x,y,z|{x,y,z}), setHallFigure(z|null), setVentLurker(side,on),
//        getState(), debug }
// Player eye is assumed near (0, 1.2, 0) facing -Z. Nothing moves the player. The
// mask "visor" is a world-space ring that tracks setEyePosition()/state.eye (never
// parented to the camera), fades in over 0.15s, has a clear ~35deg centre, no shake.
// update state (all optional): { tension 0..1, powerOut bool, eye {x,y,z} }

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
const OFFICE = { x: 2.2, zFront: -2, zBack: 1.6, h: 2.7 };
const HALL = { x: 1.1, zEnd: -10 };
const FLASH_POS = { x: 0.15, y: 1.0, z: -0.55 };

export function createSpaceFnaf2(THREE, scene, options = {}) {
  const K = makeKit(THREE);
  const { box, cyl, sph, plane, std, basic, tex, hit } = K;
  const inj = options.materials ?? {};
  const group = new THREE.Group();
  group.name = "space-fnaf2";
  scene?.add?.(group);

  // ---- materials (canvas-baked looks) ----
  const rnd = seeded(2);
  const wallTex = tex(256, 256, (c, w, h) => {
    c.fillStyle = "#4a4638"; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(${rnd() < .5 ? "0,0,0" : "200,190,150"},${rnd() * 0.07})`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 14, 1 + rnd() * 3); }
    c.fillStyle = "#6b2f2a"; c.fillRect(0, h * 0.62, w, h * 0.06); // dado stripe
    c.fillStyle = "rgba(0,0,0,.28)"; c.fillRect(0, h * 0.68, w, h * 0.32);
    for (let i = 0; i < 6; i++) { const x = rnd() * w; c.fillStyle = "rgba(20,15,5,.12)"; c.fillRect(x, 0, 2 + rnd() * 3, h * (0.3 + rnd() * 0.6)); }
  });
  const floorTex = tex(256, 256, (c, w, h) => {
    const n = 4, s = w / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { c.fillStyle = (x + y) % 2 ? "#d9d3c0" : "#1d1b1a"; c.fillRect(x * s, y * s, s, s); }
    for (let i = 0; i < 1200; i++) { c.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 4, 1 + rnd() * 4); }
  }, { repeat: [1, 1] });
  const hallFloorTex = floorTex && (() => { const t = floorTex.clone(); t.needsUpdate = true; t.repeat.set(2.2, 8); return t; })();
  const M = {
    wall: inj.wallPlaster ?? std({ color: wallTex ? 0xffffff : 0x4a4638, map: wallTex, roughness: 1 }),
    floor: std({ color: floorTex ? 0xffffff : 0x666055, map: floorTex, roughness: 0.55 }),
    hallFloor: std({ color: floorTex ? 0xffffff : 0x666055, map: hallFloorTex ?? null, roughness: 0.5 }),
    ceil: std({ color: 0x1e1d19, roughness: 1 }),
    wood: inj.woodDark ?? std({ color: 0x3a2a1c, roughness: 0.85 }),
    metal: inj.metalAged ?? std({ color: 0x555a58, roughness: 0.6, metalness: 0.4 }),
    dark: std({ color: 0x050505, roughness: 1 }),
    mask: std({ color: 0xe8e2d0, roughness: 0.5 }),
    redPaint: std({ color: 0xa02420, roughness: 0.6 }),
  };

  // ---- architecture ----
  const arch = new THREE.Group(); group.add(arch);
  const W = OFFICE.x, H = OFFICE.h, zF = OFFICE.zFront, zB = OFFICE.zBack, len = zB - zF;
  plane(arch, M.floor, W * 2, len, 0, 0, (zF + zB) / 2).rotation.x = -Math.PI / 2;
  plane(arch, M.ceil, W * 2, len, 0, H, (zF + zB) / 2).rotation.x = Math.PI / 2;
  plane(arch, M.wall, W * 2, H, 0, H / 2, zB).rotation.y = Math.PI; // behind the player
  for (const s of [-1, 1]) {
    plane(arch, M.wall, len, H, s * W, H / 2, (zF + zB) / 2).rotation.y = -s * Math.PI / 2;
  }
  // front wall with a wide opening (no doors)
  const fw = W - HALL.x;
  for (const s of [-1, 1]) box(arch, M.wall, fw, H, 0.15, s * (HALL.x + fw / 2), H / 2, zF);
  box(arch, M.wall, HALL.x * 2, H - 2.1, 0.15, 0, 2.1 + (H - 2.1) / 2, zF);
  for (const s of [-1, 1]) box(arch, M.wood, 0.1, 2.1, 0.2, s * HALL.x, 1.05, zF);
  box(arch, M.wood, HALL.x * 2 + 0.1, 0.1, 0.2, 0, 2.1, zF);

  // ---- hallway ----
  const hl = zF - HALL.zEnd, hmid = (zF + HALL.zEnd) / 2;
  plane(arch, M.hallFloor, HALL.x * 2, hl, 0, 0.001, hmid).rotation.x = -Math.PI / 2;
  plane(arch, M.ceil, HALL.x * 2, hl, 0, H, hmid).rotation.x = Math.PI / 2;
  plane(arch, M.wall, hl, H, -HALL.x, H / 2, hmid).rotation.y = Math.PI / 2;
  plane(arch, M.wall, hl, H, HALL.x, H / 2, hmid).rotation.y = -Math.PI / 2;
  box(arch, M.dark, HALL.x * 2, H, 0.1, 0, H / 2, HALL.zEnd);
  box(arch, M.wood, 0.14, 2.3, 0.2, -0.7, 1.15, HALL.zEnd + 0.1);
  box(arch, M.wood, 0.14, 2.3, 0.2, 0.7, 1.15, HALL.zEnd + 0.1);
  box(arch, M.wood, 1.54, 0.14, 0.2, 0, 2.3, HALL.zEnd + 0.1);
  const bulbMat = basic({ color: 0xffe2a0 });
  const bulbMat2 = basic({ color: 0xffe2a0 });
  cyl(arch, bulbMat, 0.1, 0.06, 0, H - 0.04, -3.5);
  cyl(arch, bulbMat2, 0.1, 0.06, 0, H - 0.04, -6.5);
  cyl(arch, M.metal, 0.05, hl, HALL.x - 0.12, H - 0.15, hmid).rotation.x = Math.PI / 2;

  // ---- posters ----
  const posters = [];
  const posterDefs = [
    { x: -HALL.x + 0.01, y: 1.5, z: -4.2, ry: Math.PI / 2, s: 0.7, seed: 11, text: "PARTY!" },
    { x: HALL.x - 0.01, y: 1.45, z: -5.2, ry: -Math.PI / 2, s: 0.8, seed: 12, text: "SMILE" },
    { x: -HALL.x + 0.01, y: 1.4, z: -7.2, ry: Math.PI / 2, s: 0.7, seed: 13, text: "WELCOME" },
    { x: -W + 0.01, y: 1.55, z: 0.6, ry: Math.PI / 2, s: 0.8, seed: 14, text: "STAFF ONLY" },
    { x: W - 0.01, y: 1.6, z: 0.9, ry: -Math.PI / 2, s: 0.7, seed: 15, text: "HAVE FUN" },
  ];
  for (const d of posterDefs) {
    const r = seeded(d.seed);
    const t = tex(128, 192, (c, w, h) => {
      c.fillStyle = ["#c9b36a", "#6aa0c9", "#c96a7a", "#8ac96a"][d.seed % 4]; c.fillRect(0, 0, w, h);
      c.fillStyle = "#2b2118"; c.fillRect(6, 6, w - 12, h - 12);
      c.fillStyle = "#d8cfb0"; c.fillRect(10, 10, w - 20, h - 20);
      c.fillStyle = "#9a7a52"; c.beginPath(); c.arc(w / 2, 82, 40, 0, 7); c.fill();
      c.beginPath(); c.arc(w / 2 - 32, 46, 14, 0, 7); c.arc(w / 2 + 32, 46, 14, 0, 7); c.fill();
      c.fillStyle = "#111"; c.beginPath(); c.arc(w / 2 - 15, 76, 6 + r() * 3, 0, 7); c.arc(w / 2 + 15, 76, 6 + r() * 3, 0, 7); c.fill();
      c.fillRect(w / 2 - 14, 100, 28, 4);
      c.fillStyle = "#a02420"; c.font = "bold 20px sans-serif"; c.textAlign = "center"; c.fillText(d.text, w / 2, 160);
      for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(0,0,0,${r() * 0.1})`; c.fillRect(r() * w, r() * h, 2, 2 + r() * 8); }
    });
    const m = std({ color: t ? 0xffffff : 0xb8aa80, map: t, roughness: 1 });
    const p = plane(group, m, 0.6 * d.s, 0.9 * d.s, d.x, d.y, d.z); p.rotation.y = d.ry; posters.push(p);
  }

  // ---- desk ----
  const desk = new THREE.Group(); group.add(desk);
  box(desk, M.wood, 2.0, 0.07, 0.75, 0, 0.74, -0.95);
  box(desk, M.wood, 0.06, 0.72, 0.7, -0.95, 0.36, -0.95);
  box(desk, M.wood, 0.06, 0.72, 0.7, 0.95, 0.36, -0.95);
  box(desk, M.dark, 1.9, 0.5, 0.04, 0, 0.4, -1.28);
  const lampMat = basic({ color: 0xffd9a0 });
  cyl(desk, M.metal, 0.07, 0.03, -0.8, 0.79, -1.15);
  box(desk, M.metal, 0.02, 0.35, 0.02, -0.8, 0.95, -1.15);
  sph(desk, lampMat, 0.08, 0.05, 0.08, -0.8, 1.14, -1.1);
  const flashProp = new THREE.Group(); desk.add(flashProp);
  const flashLens = basic({ color: 0x333333 });
  cyl(flashProp, M.metal, 0.035, 0.22, 0, 0, 0).rotation.x = Math.PI / 2;
  cyl(flashProp, flashLens, 0.045, 0.04, 0, 0, -0.12).rotation.x = Math.PI / 2;
  flashProp.position.set(-0.35, 0.81, -0.8); flashProp.rotation.y = 0.2;
  hit(flashProp, 0.1, 0.1, 0.35, 0, 0, 0);

  const screenTex = tex(128, 96, (c, w, h) => {
    c.fillStyle = "#0b1a14"; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) { c.fillStyle = `rgba(120,255,170,${rnd() * 0.35})`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 10, 1); }
    c.strokeStyle = "rgba(120,255,170,.7)"; c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = "#9fffc0"; c.font = "bold 12px monospace"; c.fillText("CAM 04   REC", 12, 20);
    c.fillRect(30, 48, 68, 22);
  });
  const screenMat = std({ color: 0x111111, emissive: screenTex ? 0xffffff : 0x1a4a2c, emissiveMap: screenTex, emissiveIntensity: 1, roughness: 0.4 });
  const tablet = new THREE.Group(); desk.add(tablet);
  box(tablet, M.metal, 0.5, 0.34, 0.03, 0, 0, 0);
  plane(tablet, screenMat, 0.46, 0.3, 0, 0, 0.0165);
  box(tablet, M.metal, 0.3, 0.02, 0.2, 0, -0.17, -0.1).rotation.x = 0.3;
  tablet.position.set(0.4, 0.98, -0.95); tablet.rotation.x = -0.35;
  hit(tablet, 0.6, 0.45, 0.2, 0, 0, 0);

  const maskHang = new THREE.Group(); desk.add(maskHang);
  box(maskHang, M.metal, 0.03, 0.18, 0.03, 0, 0.18, 0);
  sph(maskHang, M.mask, 0.12, 0.15, 0.08, 0, 0, 0.03);
  for (const s of [-1, 1]) {
    sph(maskHang, M.dark, 0.035, 0.045, 0.02, s * 0.05, 0.02, 0.1);
    sph(maskHang, M.redPaint, 0.03, 0.02, 0.01, s * 0.085, -0.04, 0.1);
  }
  box(maskHang, M.dark, 0.08, 0.012, 0.01, 0, -0.07, 0.1);
  maskHang.position.set(-0.6, 1.0, -1.1);
  hit(maskHang, 0.34, 0.4, 0.25, 0, 0.05, 0.05);

  // ---- vent openings ----
  const glowTex = tex(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  const vents = {};
  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const g = new THREE.Group(); group.add(g);
    g.position.set(s * (W - 0.02), 0.95, -0.55); g.rotation.y = -s * Math.PI / 2;
    box(g, M.metal, 0.78, 0.6, 0.06, 0, 0, 0);
    box(g, M.dark, 0.64, 0.46, 0.08, 0, 0, 0.01);
    for (let i = -2; i <= 2; i++) box(g, M.metal, 0.62, 0.015, 0.02, 0, i * 0.085, 0.06);
    const lampM = basic({ color: 0x401010 });
    box(g, lampM, 0.5, 0.05, 0.04, 0, 0.42, 0.05);
    const glowM = basic({ color: 0xff3a20, map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    plane(g, glowM, 1.3, 1.0, 0, 0.1, 0.12);
    const eyeM = basic({ color: 0xffffff });
    const eyes = new THREE.Group(); g.add(eyes);
    sph(eyes, eyeM, 0.025, 0.025, 0.01, -0.06, 0, 0.05); sph(eyes, eyeM, 0.025, 0.025, 0.01, 0.06, 0, 0.05);
    eyes.visible = false;
    hit(g, 0.9, 0.8, 0.3, 0, 0.1, 0.1);
    vents[side] = { g, lampM, glowM, on: false, level: 0, eyes };
  }

  // ---- music box ----
  const mbWood = std({ color: 0x8a6240, roughness: 0.7 });
  const mb = new THREE.Group(); group.add(mb); mb.position.set(1.5, 0, -0.35);
  cyl(mb, mbWood, 0.28, 0.04, 0, 0.58, 0);
  cyl(mb, mbWood, 0.05, 0.56, 0, 0.28, 0);
  cyl(mb, mbWood, 0.15, 0.03, 0, 0.02, 0);
  box(mb, mbWood, 0.34, 0.16, 0.24, 0, 0.68, 0);
  box(mb, M.redPaint, 0.36, 0.02, 0.26, 0, 0.77, 0);
  const lid = box(mb, mbWood, 0.34, 0.02, 0.24, 0, 0.84, -0.18); lid.rotation.x = -1.1;
  const crank = new THREE.Group(); crank.position.set(0.2, 0.68, 0); mb.add(crank);
  cyl(crank, M.metal, 0.012, 0.08, 0.02, 0, 0).rotation.z = Math.PI / 2;
  box(crank, M.metal, 0.012, 0.14, 0.012, 0.06, 0.06, 0);
  sph(crank, M.redPaint, 0.025, 0.025, 0.025, 0.06, 0.13, 0);
  const ringMat = basic({ color: 0x5a1a10 });
  const ring = K.add(mb, K.geo(new THREE.TorusGeometry(0.22, 0.01, 6, 28)), ringMat, 0, 0.605, 0);
  ring.rotation.x = Math.PI / 2;
  const pips = [];
  for (let i = 0; i < 6; i++) { const m = basic({ color: 0x2a1a10 }); box(mb, m, 0.035, 0.035, 0.01, -0.1 + i * 0.04, 0.665, 0.125); pips.push(m); }
  hit(mb, 0.6, 0.45, 0.5, 0, 0.7, 0);

  // ---- lights (real-time: hemi + flashlight spot + desk point + hall point) ----
  const hemi = new THREE.HemisphereLight(0x8a8570, 0x1a1612, 0.55); group.add(hemi);
  const spot = new THREE.SpotLight(0xfff2d0, 0, 14, 0.38, 0.5, 1.6);
  spot.position.set(FLASH_POS.x, FLASH_POS.y, FLASH_POS.z);
  group.add(spot); group.add(spot.target);
  const deskLight = new THREE.PointLight(0xffc880, 0.9, 5, 2); deskLight.position.set(-0.8, 1.15, -1.0); group.add(deskLight);
  const hallGlow = new THREE.PointLight(0xffe2a0, 0, 9, 2); hallGlow.position.set(0, 2.4, -4.5); group.add(hallGlow);

  const beamMat = basic({ color: 0xfff0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const beam = new THREE.Mesh(K.geo(new THREE.ConeGeometry(1, 1, 16, 1, true)), beamMat); group.add(beam);
  beam.visible = false;

  const fig = new THREE.Group(); group.add(fig); fig.visible = false;
  const figM = std({ color: 0x0b0a0a, roughness: 1 });
  const figEyeM = basic({ color: 0xffffff });
  box(fig, figM, 0.55, 1.0, 0.3, 0, 1.0, 0); sph(fig, figM, 0.26, 0.28, 0.24, 0, 1.75, 0);
  box(fig, figM, 0.14, 0.6, 0.14, -0.38, 1.0, 0); box(fig, figM, 0.14, 0.6, 0.14, 0.38, 1.0, 0);
  box(fig, figM, 0.2, 0.55, 0.2, -0.15, 0.27, 0); box(fig, figM, 0.2, 0.55, 0.2, 0.15, 0.27, 0);
  sph(fig, figEyeM, 0.04, 0.05, 0.02, -0.1, 1.78, 0.2); sph(fig, figEyeM, 0.04, 0.05, 0.02, 0.1, 1.78, 0.2);

  // visor frame (world-space; follows eye position, fades in/out; never camera-parented)
  const visorTex = tex(256, 256, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, w * 0.16, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, "rgba(10,8,6,0)"); g.addColorStop(0.45, "rgba(10,8,6,.85)"); g.addColorStop(1, "rgba(0,0,0,1)");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  const visorMat = basic({ color: visorTex ? 0xffffff : 0x080604, map: visorTex, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
  const visor = new THREE.Mesh(K.geo(new THREE.RingGeometry(0.19, 0.62, 28, 1)), visorMat);
  visor.renderOrder = 999; visor.visible = false; visor.frustumCulled = false;
  group.add(visor);
  const eye = { x: 0, y: 1.2, z: 0 };

  // ---- state ----
  const S = { flash: false, aim: { x: 0, y: -0.04, z: -1 }, mask: false, maskFade: 0, wind: 0, windShown: 0, kick: 0, crankA: 0,
    hallFig: null, flick: 1, tension: 0, powerOut: false, vent: { left: false, right: false } };
  const emit = (id, info) => options.onInteract?.(id, info);

  function applyAim() {
    const a = S.aim, l = Math.hypot(a.x, a.y, a.z) || 1;
    const d = { x: a.x / l, y: a.y / l, z: a.z / l };
    spot.target.position.set(FLASH_POS.x + d.x * 10, FLASH_POS.y + d.y * 10, FLASH_POS.z + d.z * 10);
    spot.target.updateMatrixWorld?.();
    const L = 8, R = Math.tan(0.38) * L;
    beam.scale.set(R, L, R);
    beam.position.set(FLASH_POS.x + d.x * L / 2, FLASH_POS.y + d.y * L / 2, FLASH_POS.z + d.z * L / 2);
    // cone apex is +y; apex must sit at the lamp, so +y -> back toward lamp
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-d.x, -d.y, -d.z));
  }
  const api = {
    setFlashlight(on, aim) { S.flash = !!on; if (aim) S.aim = vec3(aim, S.aim); applyAim(); return S.flash; },
    setVentLight(side, on) { const v = vents[side]; if (!v) return false; v.on = !!on; S.vent[side] = !!on; return v.on; },
    setMask(on) { S.mask = !!on; maskHang.visible = !S.mask; return S.mask; },
    setWindLevel(l) { const n = clamp01(l); if (n > S.wind) S.kick = Math.min(1, S.kick + (n - S.wind) * 4 + 0.2); S.wind = n; },
    setEyePosition(x, y, z) { if (x && typeof x === "object") { eye.x = x.x; eye.y = x.y; eye.z = x.z; } else { eye.x = x; eye.y = y; eye.z = z; } },
    setHallFigure(z) { S.hallFig = z == null || !Number.isFinite(z) ? null : Math.min(zF - 0.5, Math.max(HALL.zEnd + 0.6, z)); fig.position.set(0, 0, S.hallFig ?? -8); },
    setVentLurker(side, on) { const v = vents[side]; if (v) v.eyes.visible = !!on; },
    getState: () => ({ flashlight: S.flash, mask: S.mask, ventLeft: S.vent.left, ventRight: S.vent.right, windLevel: S.wind, hallFigure: S.hallFig, powerOut: S.powerOut }),
  };
  applyAim();
  api.setMask(false);

  const mk = (id, label, mesh, fn) => { K.tagAll(mesh, id); return { id, label, mesh, onInteract: () => { const r = fn(); emit(id, r); return r; } }; };
  const interactables = [
    mk("flashlight", "Flashlight", flashProp, () => api.setFlashlight(!S.flash)),
    mk("mask", "Head mask", maskHang, () => api.setMask(!S.mask)),
    mk("monitor", "Tablet", tablet, () => ({ flicker: (S.flick = 0.2) })),
    mk("vent-left", "Left vent light", vents.left.g, () => api.setVentLight("left", !vents.left.on)),
    mk("vent-right", "Right vent light", vents.right.g, () => api.setVentLight("right", !vents.right.on)),
    mk("musicbox", "Music box", mb, () => { S.kick = Math.min(1, S.kick + 0.5); return { wound: true }; }),
  ];

  function update(dt, time = 0, state = {}) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    S.tension = clamp01(state.tension ?? S.tension);
    if (typeof state.powerOut === "boolean") S.powerOut = state.powerOut;
    if (state.eye) api.setEyePosition(state.eye);
    const on = S.powerOut ? 0 : 1;
    S.flick = Math.min(1, S.flick + dt * 3);
    const fl = on * (S.tension > 0.5 && Math.sin(time * 37) * Math.sin(time * 11.3) > 0.55 + (1 - S.tension) ? 0.2 : 1) * S.flick;
    bulbMat.color.setRGB(fl, 0.85 * fl, 0.55 * fl); bulbMat2.color.setRGB(0.9 * fl, 0.75 * fl, 0.5 * fl);
    hallGlow.intensity = 2.2 * fl;
    hemi.intensity = 0.12 + 0.6 * on;
    deskLight.intensity = 0.9 * on;
    lampMat.color.setRGB(1 * (on || 0.05), 0.85 * (on || 0.05), 0.63 * (on || 0.05));
    screenMat.emissiveIntensity = fl * (0.9 + 0.1 * Math.sin(time * 23));
    const flick = S.flash && S.tension > 0.7 && Math.sin(time * 53) > 0.93 ? 0.3 : 1;
    spot.intensity = S.flash ? 55 * flick : 0;
    beamMat.opacity = S.flash ? 0.028 * flick : 0; beam.visible = S.flash;
    const lv = S.flash ? 1 : 0.2; flashLens.color.setRGB(lv, 0.94 * lv, 0.75 * lv);
    fig.visible = S.flash && S.hallFig != null;
    if (fig.visible) fig.position.x = Math.sin(time * 0.7) * 0.02;
    for (const side of ["left", "right"]) {
      const v = vents[side];
      v.level += ((v.on ? 1 : 0) - v.level) * ease(dt, 14);
      v.lampM.color.setRGB(0.25 + 0.75 * v.level, 0.06 + 0.1 * v.level, 0.05 + 0.05 * v.level);
      v.glowM.opacity = v.level * (0.22 + 0.04 * Math.sin(time * 9));
    }
    const target = S.mask ? 1 : 0;
    S.maskFade += Math.sign(target - S.maskFade) * Math.min(Math.abs(target - S.maskFade), dt / 0.15);
    visor.visible = S.maskFade > 0.001;
    visorMat.opacity = S.maskFade * 0.9;
    visor.position.set(eye.x, eye.y, eye.z - 0.28);
    S.windShown += (S.wind - S.windShown) * ease(dt, 4);
    S.kick = Math.max(0, S.kick - dt * 1.2);
    S.crankA += dt * (S.kick * 9 + S.wind * 0.8);
    crank.rotation.x = S.crankA;
    const wl = S.windShown;
    ringMat.color.setRGB(0.35 + 0.65 * wl, 0.1 + 0.55 * wl, 0.06 + 0.1 * wl);
    ring.scale.setScalar(1 + 0.04 * Math.sin(time * 3) * (1 - wl));
    for (let i = 0; i < pips.length; i++) {
      const lit = wl * pips.length > i + 0.2;
      pips[i].color.setRGB(lit ? 1 : 0.16, lit ? 0.75 : 0.1, lit ? 0.25 : 0.06);
    }
  }

  function dispose() {
    scene?.remove?.(group);
    K.dispose();
  }

  return {
    group, update, interactables, dispose,
    setPowerOut(b) { S.powerOut = !!b; },
    ...api,
    debug: { renderMeshes: () => countRender(group), spot, visor, vents, fig, hemi, deskLight, posters },
  };
}
