// space-fnaf4.mjs — a child's bedroom at night: bed, closet with two doors, left /
// right side-hall doors and a hallway door behind you, flashlight, nightlight, toys and
// a cracked window. Occupants (silhouette + eyes) appear in door/closet openings when
// the flashlight lights them. ORIGINAL procedural art; only layout/mechanics are
// genre-inspired. The view is fixed (standing/seated, no camera motion).
//
//   createSpaceFnaf4(THREE, scene, { materials?, onInteract?(id, info) })
//   => { group, update(dt,time,state), interactables, dispose, setPowerOut(b),
//        setDoor(name,closed)            name: 'left'|'right'|'hall'
//        setClosetDoor(side,open)        side: 'left'|'right'
//        setFlashlight(on, aimVec)       aimVec: direction {x,y,z}
//        setNightlight(on)
//        setOccupant(place, charId|null) place: left|right|closet-left|closet-right|hall
//        setBreathing(place, bool)       visual hint only (faint pulsing mist)
//        getState(), debug }
// Player eye assumed near (0,1.1,0.2). update state (optional): { tension 0..1, powerOut }.

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

const PLACES = ["left", "right", "closet-left", "closet-right", "hall"];
const ROOM = { x: 2.0, zFront: -2.5, zBack: 2.2, h: 2.6 };
// anchor = where the occupant stands (behind the opening); dir = unit vector from player to it
const ANCHOR = {
  left: { x: -2.45, z: -1.0, ry: Math.PI / 2 },
  right: { x: 2.45, z: -1.0, ry: -Math.PI / 2 },
  "closet-left": { x: -0.4, z: -2.85, ry: 0 },
  "closet-right": { x: 0.4, z: -2.85, ry: 0 },
  hall: { x: 0.65, z: 2.65, ry: Math.PI },
};
const EYE_COLORS = [0xffe070, 0xff5030, 0xffffff, 0x80ffb0];

export function createSpaceFnaf4(THREE, scene, options = {}) {
  const K = makeKit(THREE);
  const { box, cyl, sph, plane, std, basic, tex, hit } = K;
  const inj = options.materials ?? {};
  const group = new THREE.Group(); group.name = "space-fnaf4";
  scene?.add?.(group);
  const rnd = seeded(4);
  const W = ROOM.x, H = ROOM.h, zF = ROOM.zFront, zB = ROOM.zBack, L = zB - zF, zc = (zF + zB) / 2;

  const wallTex = tex(256, 256, (c, w, h) => {
    c.fillStyle = "#2c3a52"; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) { c.fillStyle = "rgba(255,255,255,.05)"; c.fillRect(x, 0, 14, h); }
    c.fillStyle = "rgba(240,220,120,.25)";
    for (let i = 0; i < 18; i++) { const x = rnd() * w, y = rnd() * h * 0.7; c.beginPath(); for (let k = 0; k < 10; k++) { const r = k % 2 ? 3 : 7, a = k * Math.PI / 5; c.lineTo(x + Math.sin(a) * r, y - Math.cos(a) * r); } c.fill(); }
    for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 8, 1 + rnd() * 3); }
    c.fillStyle = "rgba(20,10,5,.45)"; c.fillRect(0, h * 0.82, w, h * 0.18);
  }, { repeat: [3, 1] });
  const floorTex = tex(128, 128, (c, w, h) => {
    c.fillStyle = "#3a2a2a"; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(${rnd() < .5 ? "0,0,0" : "120,70,70"},${rnd() * 0.15})`; c.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }, { repeat: [3, 3] });
  const M = {
    wall: inj.wallPlaster ?? std({ color: wallTex ? 0xffffff : 0x2c3a52, map: wallTex, roughness: 1 }),
    floor: std({ color: floorTex ? 0xffffff : 0x3a2a2a, map: floorTex, roughness: 1 }),
    ceil: std({ color: 0x1a1f2a, roughness: 1 }),
    wood: inj.woodDark ?? std({ color: 0x5a3e28, roughness: 0.8 }),
    door: std({ color: 0x4a3a30, roughness: 0.85 }),
    dark: std({ color: 0x020203, roughness: 1 }),
    darkIn: std({ color: 0x050507, roughness: 1, side: THREE.BackSide }),
    fabric: std({ color: 0x40607a, roughness: 1 }),
    sheet: std({ color: 0x7a8aa8, roughness: 1 }),
    plush: std({ color: 0x8a5a38, roughness: 1 }),
    toyRed: std({ color: 0xa83030, roughness: 0.6 }),
    toyBlue: std({ color: 0x3050a8, roughness: 0.6 }),
    toyYellow: std({ color: 0xc8a830, roughness: 0.6 }),
    metal: inj.metalAged ?? std({ color: 0x6a6a6a, roughness: 0.5, metalness: 0.5 }),
  };

  // ---- shell with door/closet openings ----
  plane(group, M.floor, W * 2, L, 0, 0, zc).rotation.x = -Math.PI / 2;
  plane(group, M.ceil, W * 2, L, 0, H, zc).rotation.x = Math.PI / 2;
  const DW = 0.9, DH = 2.0;
  // front wall: closet opening x ±0.8, h 2.0
  box(group, M.wall, W - 0.8, H, 0.12, -(0.8 + (W - 0.8) / 2), H / 2, zF);
  box(group, M.wall, W - 0.8, H, 0.12, 0.8 + (W - 0.8) / 2, H / 2, zF);
  box(group, M.wall, 1.6, H - DH, 0.12, 0, DH + (H - DH) / 2, zF);
  // closet interior
  box(group, M.dark, 1.7, DH, 0.05, 0, DH / 2, zF - 0.65);
  box(group, M.dark, 0.05, DH, 0.65, -0.85, DH / 2, zF - 0.32);
  box(group, M.dark, 0.05, DH, 0.65, 0.85, DH / 2, zF - 0.32);
  box(group, M.dark, 1.7, 0.05, 0.65, 0, DH, zF - 0.32);
  box(group, M.wood, 1.7, 0.03, 0.4, 0, 1.6, zF - 0.45); // shelf
  box(group, M.wood, 0.02, 0.02, 0.6, 0, 1.45, zF - 0.35); // hanger rail
  for (const x of [-0.5, -0.1, 0.35, 0.6]) box(group, M.fabric, 0.18, 0.5, 0.05, x, 1.2, zF - 0.4); // hanging clothes
  box(group, M.wood, 1.7, 0.08, 0.1, 0, DH + 0.04, zF + 0.05); // lintel trim
  // side walls (with door openings at z -1.45..-0.55)
  for (const s of [-1, 1]) {
    box(group, M.wall, 0.12, H, (zB - (-0.55)), s * W, H / 2, (zB + -0.55) / 2);
    box(group, M.wall, 0.12, H, (-1.45 - zF), s * W, H / 2, (zF + -1.45) / 2);
    box(group, M.wall, 0.12, H - DH, DW, s * W, DH + (H - DH) / 2, -1.0);
    // dark hall recess behind each side door
    box(group, M.darkIn, 0.8, H, DW + 0.2, s * (W + 0.45), H / 2, -1.0);
    box(group, M.wood, 0.14, 0.06, DW + 0.1, s * W, DH + 0.03, -1.0);
  }
  // back wall with hall door opening x 0.2..1.1
  box(group, M.wall, W + 0.2, H, 0.12, -(W - 0.2) / 2 + 0.1 - 0.1, H / 2, zB); // x from -2 to 0.2
  box(group, M.wall, W - 1.1, H, 0.12, 1.1 + (W - 1.1) / 2, H / 2, zB);
  box(group, M.wall, DW, H - DH, 0.12, 0.65, DH + (H - DH) / 2, zB);
  box(group, M.darkIn, DW + 0.2, H, 0.8, 0.65, H / 2, zB + 0.45);

  // ---- doors (hinged) ----
  const doorPivots = {};
  function makeDoor(id, hx, hz, mode, openAngle, wide = DW, h = DH) {
    const pivot = new THREE.Group(); pivot.position.set(hx, 0, hz); group.add(pivot);
    let d;
    if (mode === "z") d = box(pivot, M.door, 0.05, h, wide, 0, h / 2, wide / 2);
    else d = box(pivot, M.door, wide, h, 0.05, wide / 2 * (mode === "-x" ? -1 : 1), h / 2, 0);
    // panel details + knob
    const sgn = mode === "-x" ? -1 : 1;
    if (mode === "z") { box(pivot, M.wood, 0.07, h * 0.4, wide * 0.7, 0, h * 0.7, wide / 2); box(pivot, M.metal, 0.09, 0.05, 0.05, 0, 1.0, wide * 0.85); }
    else { box(pivot, M.wood, wide * 0.7, h * 0.4, 0.07, sgn * wide / 2, h * 0.7, 0); box(pivot, M.metal, 0.05, 0.05, 0.09, sgn * wide * 0.85, 1.0, 0); }
    if (mode === "z") hit(pivot, 0.2, h, wide, 0, h / 2, wide / 2); else hit(pivot, wide, h, 0.2, sgn * wide / 2, h / 2, 0);
    return { pivot, openAngle, shown: 0, target: 0 };
  }
  doorPivots.left = makeDoor("left", -W + 0.04, -1.45, "z", Math.PI / 2 * 0.95);
  doorPivots.right = makeDoor("right", W - 0.04, -1.45, "z", -Math.PI / 2 * 0.95);
  doorPivots.hall = makeDoor("hall", 0.2, zB - 0.04, "x", Math.PI / 2 * 0.95);
  const closets = {
    left: makeDoor("cl", -0.8, zF + 0.06, "x", -1.25, 0.8),
    right: makeDoor("cr", 0.8, zF + 0.06, "-x", 1.25, 0.8),
  };
  closets.left.target = closets.right.target = 1; // closets: shown=1 means closed? see below
  // convention: shown 0 = OPEN pose, 1 = CLOSED pose. Side/hall doors default open (0); closets default closed (1).
  closets.left.shown = closets.right.shown = 1;

  // ---- bed, nightstand, toys ----
  const bed = new THREE.Group(); group.add(bed); bed.position.set(-1.1, 0, 1.2);
  box(bed, M.wood, 1.0, 0.3, 1.9, 0, 0.25, 0);
  box(bed, M.sheet, 0.92, 0.18, 1.8, 0, 0.5, 0);
  box(bed, M.fabric, 0.9, 0.1, 1.0, 0, 0.62, 0.4); // blanket bump
  box(bed, M.sheet, 0.5, 0.12, 0.3, 0, 0.62, -0.7); // pillow
  box(bed, M.wood, 1.04, 0.9, 0.08, 0, 0.6, -0.97); // headboard
  for (const [x, z] of [[-0.48, -0.9], [0.48, -0.9], [-0.48, 0.9], [0.48, 0.9]]) box(bed, M.wood, 0.06, 0.16, 0.06, x, 0.08, z);
  const stand = new THREE.Group(); group.add(stand); stand.position.set(-0.2, 0, 2.0);
  box(stand, M.wood, 0.4, 0.5, 0.35, 0, 0.25, 0);
  box(stand, M.dark, 0.34, 0.12, 0.02, 0, 0.35, 0.18);
  // flashlight prop
  const flashProp = new THREE.Group(); stand.add(flashProp); flashProp.position.set(0, 0.55, 0);
  const lensM = basic({ color: 0x333333 });
  cyl(flashProp, M.metal, 0.03, 0.2, 0, 0, 0).rotation.x = Math.PI / 2;
  cyl(flashProp, lensM, 0.04, 0.04, 0, 0, -0.11).rotation.x = Math.PI / 2;
  flashProp.rotation.y = 0.5;
  hit(flashProp, 0.14, 0.14, 0.34, 0, 0, 0);
  // teddy on bed
  const teddy = new THREE.Group(); bed.add(teddy); teddy.position.set(0.15, 0.7, -0.5);
  sph(teddy, M.plush, 0.11, 0.12, 0.09, 0, 0.1, 0); sph(teddy, M.plush, 0.08, 0.08, 0.08, 0, 0.27, 0);
  sph(teddy, M.plush, 0.03, 0.03, 0.03, -0.06, 0.34, 0); sph(teddy, M.plush, 0.03, 0.03, 0.03, 0.06, 0.34, 0);
  sph(teddy, M.dark, 0.012, 0.012, 0.012, -0.03, 0.28, 0.07); sph(teddy, M.dark, 0.012, 0.012, 0.012, 0.03, 0.28, 0.07);
  // toys on floor
  const blocks = new THREE.Group(); group.add(blocks); blocks.position.set(0.9, 0, 0.9);
  box(blocks, M.toyRed, 0.18, 0.18, 0.18, 0, 0.09, 0); box(blocks, M.toyBlue, 0.18, 0.18, 0.18, 0.2, 0.09, 0.05);
  box(blocks, M.toyYellow, 0.18, 0.18, 0.18, 0.1, 0.27, 0.02).rotation.y = 0.5;
  const toybox = new THREE.Group(); group.add(toybox); toybox.position.set(1.5, 0, 1.7);
  box(toybox, M.toyBlue, 0.7, 0.4, 0.4, 0, 0.2, 0); box(toybox, M.toyYellow, 0.72, 0.04, 0.42, 0, 0.42, 0);
  const lid = box(toybox, M.toyRed, 0.7, 0.03, 0.4, 0, 0.5, -0.25); lid.rotation.x = 0.9;
  const train = new THREE.Group(); group.add(train); train.position.set(-0.2, 0.001, -0.3);
  box(train, M.toyRed, 0.22, 0.12, 0.12, 0, 0.1, 0); box(train, M.toyBlue, 0.12, 0.16, 0.12, 0.1, 0.14, 0);
  for (const x of [-0.07, 0.07]) for (const z of [-0.065, 0.065]) cyl(train, M.dark, 0.03, 0.02, x, 0.04, z).rotation.x = Math.PI / 2;
  // plush on closet shelf (silhouette that reads as "something there")
  const dollHead = sph(group, M.plush, 0.1, 0.11, 0.1, 0.55, 1.72, zF - 0.45);
  // posters (kid drawings)
  const dwgT = tex(96, 128, (c, w, h) => { c.fillStyle = "#d8d0b0"; c.fillRect(0, 0, w, h); c.fillStyle = "#c04040"; c.beginPath(); c.arc(48, 60, 26, 0, 7); c.fill(); c.fillStyle = "#111"; c.fillRect(36, 54, 6, 6); c.fillRect(54, 54, 6, 6); c.fillRect(34, 74, 28, 4); c.fillStyle = "#3050a8"; c.fillRect(30, 90, 36, 28); });
  const dwgM = std({ color: dwgT ? 0xffffff : 0xa8a088, map: dwgT, roughness: 1 });
  plane(group, dwgM, 0.4, 0.5, -W + 0.07, 1.5, 0.4).rotation.y = Math.PI / 2;
  plane(group, dwgM, 0.4, 0.5, 1.4, 1.5, zB - 0.07).rotation.y = Math.PI;

  // ---- cracked window (right wall, behind bed side) ----
  const winT = tex(128, 160, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#35507a"); g.addColorStop(1, "#16213a"); c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = "#d8e4ff"; c.beginPath(); c.arc(92, 34, 12, 0, 7); c.fill();
    c.strokeStyle = "rgba(255,255,255,.9)"; c.lineWidth = 1.5; const cx = 50, cy = 70;
    for (let k = 0; k < 9; k++) { let x = cx, y = cy; const a = k * 0.7 + 0.2; c.beginPath(); c.moveTo(x, y); for (let s = 0; s < 4; s++) { x += Math.cos(a + (rnd() - .5) * .8) * (12 + rnd() * 18); y += Math.sin(a + (rnd() - .5) * .8) * (12 + rnd() * 18); c.lineTo(x, y); } c.stroke(); }
    c.strokeStyle = "rgba(255,255,255,.4)"; c.beginPath(); c.arc(cx, cy, 14, 0, 7); c.stroke(); c.beginPath(); c.arc(cx, cy, 26, 0, 7); c.stroke();
  });
  const winM = std({ color: 0x000000, emissive: winT ? 0xffffff : 0x203050, emissiveMap: winT, emissiveIntensity: 0.55, roughness: 0.2 });
  const win = new THREE.Group(); group.add(win); win.position.set(W - 0.075, 1.5, 1.3); win.rotation.y = -Math.PI / 2;
  plane(win, winM, 0.7, 0.9, 0, 0, 0.0);
  box(win, M.wood, 0.78, 0.06, 0.08, 0, 0.47, 0.02); box(win, M.wood, 0.78, 0.06, 0.08, 0, -0.47, 0.02);
  box(win, M.wood, 0.06, 0.94, 0.08, -0.38, 0, 0.02); box(win, M.wood, 0.06, 0.94, 0.08, 0.38, 0, 0.02);
  box(win, M.wood, 0.04, 0.9, 0.06, 0, 0, 0.03); box(win, M.wood, 0.7, 0.04, 0.06, 0, 0, 0.03);

  // ---- nightlight ----
  const nl = new THREE.Group(); group.add(nl); nl.position.set(-W + 0.12, 0.4, 2.0);
  box(nl, M.dark, 0.04, 0.1, 0.1, -0.02, 0, 0);
  const nlMat = basic({ color: 0xffc070 });
  sph(nl, nlMat, 0.07, 0.07, 0.07, 0.04, 0.04, 0);
  hit(nl, 0.24, 0.24, 0.24, 0.03, 0.03, 0);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0x6a7aa8, 0x2a2024, 0.45); group.add(hemi);
  const spot = new THREE.SpotLight(0xfff0c8, 0, 12, 0.42, 0.55, 1.6);
  const FL = { x: 0.1, y: 1.0, z: 0.25 };
  spot.position.set(FL.x, FL.y, FL.z); group.add(spot); group.add(spot.target);
  const nlLight = new THREE.PointLight(0xffa850, 5, 5.5, 2); nlLight.position.set(-W + 0.4, 0.55, 2.0); group.add(nlLight);
  spot.target.position.set(0, 1, -5);

  // ---- occupants (pooled; one per place) ----
  const figBody = std({ color: 0x08080a, roughness: 0.9 });
  const mistTex = tex(64, 64, (c, w, h) => { const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); g.addColorStop(0, "rgba(200,220,255,.8)"); g.addColorStop(1, "rgba(200,220,255,0)"); c.fillStyle = g; c.fillRect(0, 0, w, h); });
  const occ = {};
  for (const place of PLACES) {
    const a = ANCHOR[place];
    const g = new THREE.Group(); g.position.set(a.x, 0, a.z); g.rotation.y = a.ry; g.visible = false; group.add(g);
    box(g, figBody, 0.6, 0.9, 0.3, 0, 1.0, 0); sph(g, figBody, 0.27, 0.3, 0.25, 0, 1.7, 0);
    box(g, figBody, 1.0, 0.16, 0.16, 0, 1.3, -0.03); // arms/shoulders as one bar
    box(g, figBody, 0.46, 0.55, 0.22, 0, 0.27, 0);
    const ears = [sph(g, figBody, 0.1, 0.1, 0.05, -0.2, 2.0, 0), sph(g, figBody, 0.1, 0.1, 0.05, 0.2, 2.0, 0)];
    const eyeM = basic({ color: EYE_COLORS[0] });
    const eyes = [sph(g, eyeM, 0.045, 0.055, 0.02, -0.1, 1.74, 0.23), sph(g, eyeM, 0.045, 0.055, 0.02, 0.1, 1.74, 0.23)];
    // mouth teeth glints
    const mistM = basic({ color: 0xc8dcff, map: mistTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const mist = new THREE.Mesh(K.unitPlane, mistM); mist.scale.set(0.9, 0.5, 1); group.add(mist);
    // mist sits in front of the opening, facing the player
    const mx = place.startsWith("closet") ? a.x : a.x * 0.8, mz = place.startsWith("closet") ? zF + 0.4 : a.z;
    mist.position.set(mx, 0.12, mz);
    mist.rotation.y = place === "left" ? Math.PI / 2 : place === "right" ? -Math.PI / 2 : place === "hall" ? Math.PI : 0;
    if (place === "hall") mist.position.set(0.65, 0.12, zB - 0.4);
    if (place === "left") mist.position.set(-W + 0.4, 0.12, -1.0);
    if (place === "right") mist.position.set(W - 0.4, 0.12, -1.0);
    occ[place] = { g, ears, eyeM, eyes, charId: null, variant: 0, mist, mistM, breathing: false, lit: 0 };
  }
  function variantOf(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 4; }

  // ---- state ----
  const S = { flash: false, aim: { x: 0, y: 0, z: -1 }, nightlight: true, powerOut: false, tension: 0,
    door: { left: 0, right: 0, hall: 0 } /* target closed 0/1 */, closet: { left: false, right: false } /* open? */ };
  const emit = (id, info) => options.onInteract?.(id, info);
  const normAim = () => { const a = S.aim, l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
  function applyAim() { const d = normAim(); spot.target.position.set(FL.x + d.x * 8, FL.y + d.y * 8, FL.z + d.z * 8); spot.target.updateMatrixWorld?.(); }
  const api = {
    setDoor(name, closed) { const d = doorPivots[name]; if (!d) return false; d.target = closed ? 1 : 0; S.door[name] = closed ? 1 : 0; return !!closed; },
    setClosetDoor(side, open) { const d = closets[side]; if (!d) return false; d.target = open ? 0 : 1; S.closet[side] = !!open; return !!open; },
    setFlashlight(on, aim) { S.flash = !!on; if (aim) S.aim = vec3(aim, S.aim); applyAim(); return S.flash; },
    setNightlight(on) { S.nightlight = !!on; return S.nightlight; },
    setOccupant(place, charId) {
      const o = occ[place]; if (!o) return false;
      const none = charId == null;
      o.charId = none ? null : charId;
      if (!none) { o.variant = variantOf(charId); o.eyeM.color.setHex(EYE_COLORS[o.variant]); o.ears.forEach((e) => (e.visible = o.variant !== 3)); o.ears.forEach((e) => e.scale.set(o.variant === 1 ? 0.05 : 0.1, o.variant === 1 ? 0.25 : 0.1, 0.05)); }
      return true;
    },
    setBreathing(place, b) { const o = occ[place]; if (!o) return false; o.breathing = !!b; return o.breathing; },
    getState: () => ({ doors: { ...S.door }, closets: { ...S.closet }, flashlight: S.flash, nightlight: S.nightlight, occupants: Object.fromEntries(PLACES.map((p) => [p, occ[p].charId])), breathing: Object.fromEntries(PLACES.map((p) => [p, occ[p].breathing])), powerOut: S.powerOut }),
  };
  applyAim();
  const mk = (id, label, mesh, fn) => { K.tagAll(mesh, id); return { id, label, mesh, onInteract: () => { const r = fn(); emit(id, r); return r; } }; };
  const interactables = [
    mk("door-left", "Left door", doorPivots.left.pivot, () => api.setDoor("left", !S.door.left)),
    mk("door-right", "Right door", doorPivots.right.pivot, () => api.setDoor("right", !S.door.right)),
    mk("door-hall", "Hall door", doorPivots.hall.pivot, () => api.setDoor("hall", !S.door.hall)),
    mk("closet-left", "Left closet door", closets.left.pivot, () => api.setClosetDoor("left", !S.closet.left)),
    mk("closet-right", "Right closet door", closets.right.pivot, () => api.setClosetDoor("right", !S.closet.right)),
    mk("flashlight", "Flashlight", flashProp, () => api.setFlashlight(!S.flash)),
    mk("nightlight", "Nightlight", nl, () => api.setNightlight(!S.nightlight)),
  ];

  // is the opening of `place` currently open enough to see through?
  const openness = (place) => {
    if (place === "left" || place === "right" || place === "hall") return 1 - doorPivots[place].shown;
    return 1 - closets[place.slice(7)].shown;
  };
  function update(dt, time = 0, state = {}) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    S.tension = clamp01(state.tension ?? S.tension);
    if (typeof state.powerOut === "boolean") S.powerOut = state.powerOut;
    const on = S.powerOut ? 0.3 : 1;
    // doors
    for (const [name, d] of Object.entries(doorPivots)) { d.shown += (d.target - d.shown) * ease(dt, 9); d.pivot.rotation.y = d.openAngle * (1 - d.shown); }
    for (const [side, d] of Object.entries(closets)) { d.shown += (d.target - d.shown) * ease(dt, 7); d.pivot.rotation.y = d.openAngle * (1 - d.shown); }
    // lights
    const nlFlick = S.tension > 0.5 && Math.sin(time * 31) * Math.sin(time * 5.1) > 0.7 ? 0.2 : 1;
    nlMat.color.setRGB(S.nightlight ? 1 : 0.1, S.nightlight ? 0.75 : 0.07, S.nightlight ? 0.44 : 0.05).multiplyScalar(nlFlick);
    nlLight.intensity = S.nightlight ? 5 * nlFlick : 0;
    hemi.intensity = 0.4 + 1.2 * on;
    winM.emissiveIntensity = 0.45 + 0.1 * Math.sin(time * 0.3);
    const fl = S.flash && S.tension > 0.8 && Math.sin(time * 47) > 0.95 ? 0.25 : 1;
    spot.intensity = S.flash ? 48 * fl : 0;
    const lv = S.flash ? 1 : 0.2; lensM.color.setRGB(lv, 0.94 * lv, 0.78 * lv);
    // occupants
    const aim = normAim();
    for (const place of PLACES) {
      const o = occ[place], a = ANCHOR[place];
      const open = openness(place);
      // direction player -> anchor (player at ~ (0, 1.1, 0.2))
      let dx = a.x - FL.x, dy = 1.0 - FL.y, dz = a.z - FL.z; const dl = Math.hypot(dx, dy, dz);
      const dot = (dx * aim.x + dy * aim.y + dz * aim.z) / dl;
      const lit = S.flash && dot > 0.93;
      const present = o.charId != null && open > 0.5;
      o.g.visible = present && lit;                      // full silhouette when the beam hits it
      // eyes: glint just outside the beam too (read the dark), but only in open doorways
      const eyesOnly = present && !lit && (dot > 0.7 || S.tension > 0.5);
      if (!o.g.visible && eyesOnly) { /* show only eyes */ }
      o.eyes.forEach((e) => (e.visible = o.g.visible));
      // eyes-only: small glow quads would cost draw calls; reuse the mist sprite colour as a hint
      o.mistM.color.setHex(eyesOnly ? EYE_COLORS[o.variant] : 0xc8dcff);
      const breathe = o.breathing ? 0.12 + 0.12 * Math.sin(time * 3.6) : 0;
      o.mistM.opacity = Math.max(breathe, eyesOnly ? 0.1 + 0.05 * Math.sin(time * 5) : 0) * (open > 0.5 || place.startsWith("closet") ? 1 : 0.6);
      o.mist.visible = o.mistM.opacity > 0.003;
      if (o.g.visible) o.g.position.y = Math.sin(time * 1.3 + place.length) * 0.01;
    }
  }

  function dispose() { scene?.remove?.(group); K.dispose(); }

  return {
    group, update, interactables, dispose,
    setPowerOut(b) { S.powerOut = !!b; },
    ...api,
    debug: { renderMeshes: () => countRender(group), occ, doorPivots, closets, spot, nlLight, hemi },
  };
}
