// rooms.mjs — the eleven camera-visible rooms of the pizzeria-style venue
// (everything except the office), as procedural low-poly sets. Original art:
// all textures are painted on small canvases at startup with a seeded PRNG.
// No external assets. THREE is injected so the module imports in plain Node.
//
// Rooms are laid out far from the office (z <= -40), only ONE is ever visible
// (setVisibleRoom), and all surfaces are MeshBasicMaterial with baked-looking
// canvas textures + an additive "light pool" decal. Rooms add ZERO real lights.
//
// API:
//   createRooms(THREE, scene, { seed? }) => {
//     group, ids, meta,
//     getRoomGroup(id), getCameraPose(id) -> {position:Vector3, lookAt:Vector3},
//     setOccupants(id, [charId]) -> bool, getOccupants(id),
//     getAnchor(id, charId) -> Object3D (app may attach real models; call
//        usePlaceholders(false) to hide the built-in silhouettes),
//     setVisibleRoom(id|null), getVisibleRoom(), usePlaceholders(bool),
//     setCoveCurtain(open01), getCoveCurtain(),
//     update(dt, time), stats(), dispose() }
// plus named exports ROOM_IDS, CHAR_IDS, ROOM_META, makePlaceholderKit.

export const ROOM_IDS = [
  "showstage", "dining", "backstage", "cove", "hall-west", "hall-west-corner",
  "supply", "kitchen", "restrooms", "hall-east", "hall-east-corner",
];
export const CHAR_IDS = ["bellwether", "lark", "ratchet", "maestro"];

// label = classic "CAM 1A" style, original naming order.
export const ROOM_META = {
  showstage: { label: "CAM 1A", title: "SHOW STAGE" },
  dining: { label: "CAM 1B", title: "DINING HALL" },
  backstage: { label: "CAM 5", title: "BACKSTAGE" },
  cove: { label: "CAM 1C", title: "BUCCANEER COVE" },
  "hall-west": { label: "CAM 2A", title: "WEST HALL" },
  "hall-west-corner": { label: "CAM 2B", title: "WEST CORNER" },
  supply: { label: "CAM 3", title: "SUPPLY CLOSET" },
  kitchen: { label: "CAM 6", title: "KITCHEN" },
  restrooms: { label: "CAM 7", title: "RESTROOMS" },
  "hall-east": { label: "CAM 4A", title: "EAST HALL" },
  "hall-east-corner": { label: "CAM 4B", title: "EAST CORNER" },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasOf(w, h) {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function grime(ctx, w, h, rand, amt = 40, dark = "rgba(0,0,0,0.28)") {
  for (let i = 0; i < amt; i++) {
    const x = rand() * w, y = rand() * h, r = 4 + rand() * w * 0.12;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, dark); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // vertical drip streaks
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  for (let i = 0; i < amt / 3; i++) {
    const x = rand() * w, y = rand() * h * 0.6;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rand() * 2 - 1, y + 10 + rand() * h * 0.4); ctx.stroke();
  }
}

// ---------------------------------------------------------------- painters
const PAINT = {
  checker: (ctx, w, h, r, p) => {
    const n = p.n ?? 8, s = w / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 ? p.a : p.b; ctx.fillRect(x * s, y * s, s, s);
    }
    grime(ctx, w, h, r, 30);
  },
  stripes: (ctx, w, h, r, p) => {
    const n = p.n ?? 8, s = w / n;
    for (let i = 0; i < n; i++) { ctx.fillStyle = i % 2 ? p.a : p.b; ctx.fillRect(i * s, 0, s, h); }
    ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(0, h * 0.82, w, h * 0.18);
    grime(ctx, w, h, r, 40);
  },
  tiles: (ctx, w, h, r, p) => {
    const n = p.n ?? 8, s = w / n;
    ctx.fillStyle = p.grout; ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = 0.85 + r() * 0.15;
      ctx.fillStyle = p.a; ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
      ctx.fillStyle = `rgba(0,0,0,${(1 - v) * 1.5})`; ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
    }
    grime(ctx, w, h, r, 40);
  },
  concrete: (ctx, w, h, r, p) => {
    ctx.fillStyle = p.a; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { ctx.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "255,255,255"},${r() * 0.08})`; ctx.fillRect(r() * w, r() * h, 2 + r() * 4, 2 + r() * 4); }
    grime(ctx, w, h, r, 50);
  },
  planks: (ctx, w, h, r, p) => {
    const n = p.n ?? 8, s = h / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = r() < 0.5 ? p.a : p.b; ctx.fillRect(0, i * s, w, s - 1);
      ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(0, i * s + s - 1, w, 1);
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      for (let k = 0; k < 6; k++) { const y = i * s + r() * s; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + r() * 4 - 2); ctx.stroke(); }
    }
    grime(ctx, w, h, r, 30);
  },
  curtain: (ctx, w, h, r, p) => {
    const n = p.n ?? 10, s = w / n;
    for (let i = 0; i < n; i++) {
      const g = ctx.createLinearGradient(i * s, 0, (i + 1) * s, 0);
      g.addColorStop(0, p.dark); g.addColorStop(0.5, p.a); g.addColorStop(1, p.dark);
      ctx.fillStyle = g; ctx.fillRect(i * s, 0, s + 1, h);
    }
    const v = ctx.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, "rgba(0,0,0,0.5)"); v.addColorStop(0.3, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
    if (p.patch) { // original design: patchwork + crescent moon + tattered hem
      ctx.fillStyle = p.patch; ctx.fillRect(w * 0.12, h * 0.2, w * 0.2, h * 0.16); ctx.fillRect(w * 0.6, h * 0.55, w * 0.25, h * 0.14);
      ctx.fillStyle = p.moon; ctx.beginPath(); ctx.arc(w * 0.5, h * 0.4, w * 0.16, 0, 6.3); ctx.fill();
      ctx.fillStyle = p.dark; ctx.beginPath(); ctx.arc(w * 0.56, h * 0.37, w * 0.14, 0, 6.3); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.9)";
      for (let i = 0; i < 9; i++) { const x = r() * w; ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + 8, h - 10 - r() * 26); ctx.lineTo(x + 18, h); ctx.fill(); }
    }
    grime(ctx, w, h, r, 20);
  },
  pennants: (ctx, w, h, r) => {
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 8); ctx.quadraticCurveTo(w / 2, h * 0.5, w, 8); ctx.stroke();
    const cols = ["#9c2b2b", "#2b5b9c", "#c9a227", "#2b8a4a"];
    for (let i = 0; i < 14; i++) {
      const t = (i + 0.5) / 14, x = t * w, y = 8 + Math.sin(t * Math.PI) * h * 0.25;
      ctx.fillStyle = cols[i % 4]; ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 22); ctx.fill();
    }
  },
  shelves: (ctx, w, h, r) => {
    ctx.fillStyle = "#2b2a25"; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) { ctx.fillStyle = "#4a4130"; ctx.fillRect(0, (i + 1) * h / 4 - 5, w, 5); }
    for (let i = 0; i < 40; i++) { ctx.fillStyle = `rgb(${60 + r() * 60},${50 + r() * 50},${40 + r() * 30})`; ctx.fillRect(r() * w, r() * h, 8 + r() * 14, 8 + r() * 14); }
    grime(ctx, w, h, r, 20);
  },
  lightpool: (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.5, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  },
};

function signPainter(text, fg, bg, sub) {
  return (ctx, w, h) => {
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = fg; ctx.lineWidth = 3; ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `bold ${Math.floor(h * (sub ? 0.38 : 0.5))}px sans-serif`;
    ctx.fillText(text, w / 2, sub ? h * 0.38 : h / 2, w - 16);
    if (sub) { ctx.font = `${Math.floor(h * 0.2)}px sans-serif`; ctx.fillText(sub, w / 2, h * 0.76, w - 16); }
  };
}

// ----------------------------------------------------------- placeholder kit
const CHAR_STYLE = {
  bellwether: { color: 0x4a3222, h: 1.7, w: 0.3, eye: 0xfff0b0 },
  lark: { color: 0x7a6a22, h: 1.6, w: 0.24, eye: 0xd8ffd0 },
  ratchet: { color: 0x6a2a20, h: 1.65, w: 0.22, eye: 0xffd0a0 },
  maestro: { color: 0x34344c, h: 1.9, w: 0.2, eye: 0xc0e0ff },
};

/** Simple silhouettes used until the character agent's models are attached. */
export function makePlaceholderKit(THREE, { dark = false } = {}) {
  const geos = [], mats = [];
  const g = (x) => (geos.push(x), x);
  const cyl = g(new THREE.CylinderGeometry(1, 1, 1, 10));
  const sph = g(new THREE.SphereGeometry(1, 10, 8));
  const cone = g(new THREE.ConeGeometry(1, 1, 8));
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); mats.push(eyeMat);
  const bodyMats = {};
  const bm = (id) => (bodyMats[id] ??= (() => {
    const s = CHAR_STYLE[id];
    const m = new THREE.MeshBasicMaterial({ color: dark ? 0x050505 : s.color }); mats.push(m); return m;
  })());
  const eyeMats = {};
  const em = (id) => (eyeMats[id] ??= (() => {
    const m = new THREE.MeshBasicMaterial({ color: CHAR_STYLE[id].eye }); mats.push(m); return m;
  })());
  function part(grp, geo, mat, x, y, z, sx, sy, sz, name) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz); if (name) m.name = name;
    grp.add(m); return m;
  }
  return {
    // returns { group, bodyMeshes, eyes } ; group faces +Z.
    build(id) {
      const s = CHAR_STYLE[id] ?? CHAR_STYLE.bellwether;
      const grp = new THREE.Group(); grp.name = `placeholder-${id}`;
      const body = [], eyes = [];
      body.push(part(grp, cyl, bm(id), 0, s.h * 0.4, 0, s.w, s.h * 0.8, s.w * 0.8));
      const hy = s.h * 0.88;
      body.push(part(grp, sph, bm(id), 0, hy, 0, s.w * 0.95, s.w * 0.85, s.w * 0.85));
      const ex = s.w * 0.38, ez = s.w * 0.7;
      eyes.push(part(grp, sph, em(id), -ex, hy + 0.03, ez, 0.06, 0.06, 0.03, "eye"));
      eyes.push(part(grp, sph, em(id), ex, hy + 0.03, ez, id === "ratchet" ? 0.04 : 0.06, id === "ratchet" ? 0.04 : 0.06, 0.03, "eye"));
      if (id === "bellwether") { body.push(part(grp, sph, bm(id), -s.w * 0.75, hy + s.w * 0.7, 0, 0.12, 0.12, 0.06), part(grp, sph, bm(id), s.w * 0.75, hy + s.w * 0.7, 0, 0.12, 0.12, 0.06)); }
      if (id === "lark") { const b = part(grp, cone, em(id), 0, hy - 0.02, s.w * 1.2, 0.07, 0.18, 0.07); b.rotation.x = Math.PI / 2; body.push(b); }
      if (id === "ratchet") { const b = part(grp, cone, bm(id), 0, hy - 0.06, s.w * 1.4, 0.09, 0.3, 0.09); b.rotation.x = Math.PI / 2; body.push(b, part(grp, cyl, bm(id), s.w * 1.4, s.h * 0.45, 0.1, 0.025, 0.35, 0.025)); }
      if (id === "maestro") body.push(part(grp, cyl, bm(id), 0, hy + s.w * 1.1, 0, s.w * 0.7, 0.35, s.w * 0.7));
      return { group: grp, bodyMeshes: body, eyes };
    },
    dispose() { geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); },
  };
}

// ------------------------------------------------------------------ rooms
const SPECS = {
  showstage: { w: 10, d: 7, wall: ["stripes", { a: "#4a1d24", b: "#3a171d", n: 10 }], floor: ["checker", { a: "#2a2a2e", b: "#1a1a1d" }], cam: [[4.3, 2.5, 3.1], [0, 1.0, -1.8]], lamp: [0, 0, 0xffd89a], slots: [[-2.7, 0.5, -1.9], [-0.9, 0.5, -1.9], [0.9, 0.5, -1.9], [2.7, 0.5, -1.9]] },
  dining: { w: 10, d: 8, wall: ["stripes", { a: "#3a3a52", b: "#2c2c42", n: 12 }], floor: ["checker", { a: "#25252a", b: "#101012", n: 10 }], cam: [[4.4, 2.6, 3.6], [0, 0.9, -1]], lamp: [0, 0, 0xffe8b0], slots: [[-3, 0, 0.5], [-1, 0, 0.5], [1, 0, 0.5], [3, 0, 0.5]] },
  backstage: { w: 6, d: 5, wall: ["concrete", { a: "#3a3d3a" }], floor: ["concrete", { a: "#2a2b2a" }], cam: [[2.6, 2.5, 2.2], [0, 0.9, -1.2]], lamp: [0, 0, 0xcfe6d0], slots: [[-1.8, 0, 0.3], [-0.6, 0, 0.3], [0.6, 0, 0.3], [1.8, 0, 0.3]] },
  cove: { w: 5, d: 5, wall: ["planks", { a: "#2c3a3a", b: "#243030", n: 10 }], floor: ["planks", { a: "#3a2c1f", b: "#2f2318", n: 8 }], cam: [[2.1, 2.3, 2.2], [0, 1.1, -1.5]], lamp: [0, 0.5, 0xffc27a], slots: [[-1.6, 0, 1], [1.6, 0, 1], [0, 0.3, -1.9], [0.8, 0, 1.2]] },
  supply: { w: 3.5, d: 3.5, wall: ["concrete", { a: "#33332c" }], floor: ["concrete", { a: "#222220" }], cam: [[1.4, 2.2, 1.4], [0, 0.8, -0.5]], lamp: [0, 0, 0xfff0c0], slots: [[-0.7, 0, 0.2], [0.7, 0, 0.2], [0, 0, 0.6], [0, 0, -0.4]] },
  kitchen: { w: 7, d: 5, wall: ["tiles", { a: "#8a9188", grout: "#2a2d2a", n: 12 }], floor: ["tiles", { a: "#4a4d48", grout: "#1a1c1a", n: 8 }], cam: [[3, 2.5, 2], [0, 0.8, -1]], lamp: [0, 0, 0xe8f0e0], slots: [[-2, 0, 0.5], [-0.7, 0, 0.5], [0.7, 0, 0.5], [2, 0, 0.5]] },
  restrooms: { w: 6, d: 5, wall: ["tiles", { a: "#4d7a78", grout: "#1d2c2b", n: 12 }], floor: ["tiles", { a: "#2c3a3a", grout: "#101818", n: 8 }], cam: [[2.6, 2.4, 2.1], [0, 1, -1.2]], lamp: [0, 0, 0xc8fff0], slots: [[-2, 0, 0.6], [-0.7, 0, 0.6], [0.7, 0, 0.6], [2, 0, 0.6]] },
  "hall-west": { w: 2.4, d: 10, hall: true, wall: ["stripes", { a: "#2b3548", b: "#232c3c", n: 6 }], floor: ["checker", { a: "#1e1e22", b: "#141416", n: 8 }], cam: [[0, 2.4, 4.8], [0, 1.2, -4]], lamp: [0, -1, 0xcfd8ff], slots: [[0, 0, 1.5], [0, 0, -0.5], [0, 0, -2.5], [0, 0, -4]] },
  "hall-east": { w: 2.4, d: 10, hall: true, wall: ["stripes", { a: "#2d4535", b: "#25382c", n: 6 }], floor: ["checker", { a: "#1e2220", b: "#121513", n: 8 }], cam: [[0, 2.4, 4.8], [0, 1.2, -4]], lamp: [0, -2, 0xd8ffd0], slots: [[0, 0, 1.5], [0, 0, -0.5], [0, 0, -2.5], [0, 0, -4]] },
  "hall-west-corner": { w: 3.5, d: 3.5, wall: ["stripes", { a: "#2b3548", b: "#232c3c", n: 8 }], floor: ["checker", { a: "#1e1e22", b: "#141416", n: 6 }], cam: [[1.5, 2.3, 1.5], [-0.3, 1.0, -1]], lamp: [0, 0, 0xffb090], slots: [[-0.8, 0, 0.3], [0.2, 0, 0.3], [0.9, 0, 0.3], [0, 0, -0.8]] },
  "hall-east-corner": { w: 3.5, d: 3.5, wall: ["stripes", { a: "#2d4535", b: "#25382c", n: 8 }], floor: ["checker", { a: "#1e2220", b: "#121513", n: 6 }], cam: [[-1.5, 2.3, 1.5], [0.3, 1.0, -1]], lamp: [0, 0, 0xffb090], slots: [[-0.9, 0, 0.3], [-0.2, 0, 0.3], [0.8, 0, 0.3], [0, 0, -0.8]] },
};

function shellGeometry(THREE, w, h, d, tile) {
  // four inward-facing walls with world-scale UVs (no stretch on long halls)
  const hw = w / 2, hd = d / 2;
  const walls = [
    [[-hw, 0, -hd], [hw, 0, -hd], w],
    [[hw, 0, -hd], [hw, 0, hd], d],
    [[hw, 0, hd], [-hw, 0, hd], w],
    [[-hw, 0, hd], [-hw, 0, -hd], d],
  ];
  const pos = [], uv = [], idx = [];
  walls.forEach(([a, b, len], i) => {
    const u = len / tile, v = h / tile;
    pos.push(a[0], 0, a[2], b[0], 0, b[2], b[0], h, b[2], a[0], h, a[2]);
    uv.push(0, 0, u, 0, u, v, 0, v);
    const o = i * 4; idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g; // winding faces inward when viewed from inside
}

export function createRooms(THREE, scene, options = {}) {
  const baseSeed = options.seed ?? 4242;
  const geos = [], mats = [], texs = [];
  const geo = (g) => (geos.push(g), g);
  const texCache = new Map(), matCache = new Map();
  const kit = makePlaceholderKit(THREE);

  const unitBox = geo(new THREE.BoxGeometry(1, 1, 1));
  const unitCyl = geo(new THREE.CylinderGeometry(1, 1, 1, 12));
  const unitCone = geo(new THREE.ConeGeometry(1, 1, 12));
  const unitSph = geo(new THREE.SphereGeometry(1, 10, 8));
  const unitPlane = geo(new THREE.PlaneGeometry(1, 1));
  const unitTorus = geo(new THREE.TorusGeometry(1, 0.12, 6, 14));

  function tex(key, w, h, paint, params, rep) {
    if (texCache.has(key)) return texCache.get(key);
    const c = canvasOf(w, h);
    let t = null;
    if (c) {
      const ctx = c.getContext("2d");
      paint(ctx, w, h, rng(baseSeed + key.length * 7919 + key.charCodeAt(0)), params ?? {});
      t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      texs.push(t);
    }
    texCache.set(key, t); return t;
  }
  function mat(key, color, map, extra = {}) {
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshBasicMaterial({ color, map: map ?? null, ...extra });
    mats.push(m); matCache.set(key, m); return m;
  }
  const flat = (hex, k = hex) => mat(`flat-${k}`, hex);
  const sign = (text, fg, bg, sub, w = 256, h = 96) =>
    mat(`sign-${text}-${fg}`, 0xffffff, tex(`sign-${text}-${fg}`, w, h, signPainter(text, fg, bg, sub)));

  const root = new THREE.Group(); root.name = "rooms";
  scene.add(root);
  const rooms = new Map();
  const flickers = [];
  let coveParts = null, coveOpen = 0;
  let placeholdersOn = true;

  ROOM_IDS.forEach((id, index) => {
    const spec = SPECS[id];
    const grp = new THREE.Group(); grp.name = `room-${id}`;
    grp.position.set((index % 4) * 16 - 24, 0, -40 - Math.floor(index / 4) * 16);
    grp.visible = false;
    root.add(grp);
    const H = 3;
    const { w, d } = spec;

    const add = (m, g, x, y, z, sx, sy, sz, ry = 0, rx = 0) => {
      const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz);
      if (ry) o.rotation.y = ry; if (rx) o.rotation.x = rx; grp.add(o); return o;
    };
    const box = (m, x, y, z, sx, sy, sz, ry) => add(m, unitBox, x, y, z, sx, sy, sz, ry);
    const cyl = (m, x, y, z, r, h, r2 = r) => add(m, unitCyl, x, y, z, r, h, r2 === r ? r : r2);
    const sph = (m, x, y, z, r) => add(m, unitSph, x, y, z, r, r, r);
    const plane = (m, x, y, z, sx, sy, ry = 0, rx = 0) => add(m, unitPlane, x, y, z, sx, sy, 1, ry, rx);

    // shell: walls (world-scale UV), ceiling, floor
    const [wk, wp] = spec.wall;
    const wallMap = tex(`wall-${id}`, 256, 256, PAINT[wk], wp, true);
    const wallMat = mat(`wall-${id}`, 0xc8c8c8, wallMap);
    const shell = new THREE.Mesh(geo(shellGeometry(THREE, w, H, d, 2.5)), wallMat);
    shell.name = "shell"; grp.add(shell);
    const [fk, fp] = spec.floor;
    const floorMap = tex(`floor-${id}`, 256, 256, PAINT[fk], fp, true);
    if (floorMap) floorMap.repeat.set(w / 2.5, d / 2.5);
    const floor = plane(mat(`floor-${id}`, 0x9a9a9a, floorMap), 0, 0.001, 0, w, d, 0, -Math.PI / 2);
    floor.name = "floor";
    plane(flat(0x0c0c0e, "ceil"), 0, H, 0, w, d, 0, Math.PI / 2).name = "ceiling";

    // lamp + baked light pool (additive decal) + emissive bulb
    const [lx, lz, lc] = spec.lamp;
    const poolMat = new THREE.MeshBasicMaterial({
      color: lc, map: tex("lightpool", 128, 128, PAINT.lightpool), transparent: true,
      opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    mats.push(poolMat);
    const pool = plane(poolMat, lx, 0.012, lz, Math.min(w, 6) * 0.9, Math.min(d, 6) * 0.9, 0, -Math.PI / 2);
    pool.name = "light-pool";
    sph(mat(`bulb-${lc}`, lc), lx, H - 0.12, lz, 0.1).name = "bulb";
    flickers.push({ id, mat: poolMat, base: 0.32, seed: index * 3.7 + 1, rate: id.includes("hall") ? 11 : 6 });

    // ---- distinct dressing per room
    const dark = (hex) => flat(hex);
    const BUILD = {
      showstage() {
        const stageM = mat("stage", 0x6a5036, tex("stage-wood", 256, 128, PAINT.planks, { a: "#4a3624", b: "#3d2c1d", n: 6 }, true));
        box(stageM, 0, 0.25, -1.9, 9, 0.5, 3.2).name = "stage";
        box(dark(0x1a1008), 0, 0.52, -0.3, 9, 0.04, 0.12);
        const cur = mat("curtain-red", 0xc0c0c0, tex("curtain-red", 256, 256, PAINT.curtain, { a: "#8a1c28", dark: "#3a0a10", n: 10 }));
        plane(cur, 0, 1.75, -3.44, 9.4, 2.9);
        box(cur, -4.3, 1.5, -3.0, 0.7, 3, 0.5); box(cur, 4.3, 1.5, -3.0, 0.7, 3, 0.5);
        plane(mat("pennants", 0xffffff, tex("pennants", 256, 64, PAINT.pennants), { transparent: true }), 0, 2.45, -0.6, 8, 1.1);
        plane(sign("PARTY STAGE", "#f2d27a", "#2a0a0a"), 0, 2.2, -3.38, 3.2, 0.8);
        box(dark(0x111111), -4.3, 0.95, -0.9, 0.8, 1.0, 0.7); box(dark(0x111111), 4.3, 0.95, -0.9, 0.8, 1.0, 0.7);
        for (const sx of [-2, 2]) {
          const cone = add(mat("spotcone", 0xfff0c0, null, { transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false }), unitCone, sx, 1.5, -1.9, 1.3, 3, 1.3);
          cone.name = "spot-cone"; cone.rotation.z = Math.PI; cone.position.y = 1.5;
        }
        for (const x of [-3, 0, 3]) { cyl(flat(0x8a8a80, "plate"), x, 0.78, 1.8, 0.5, 0.05); cyl(flat(0x222222), x, 0.38, 1.8, 0.07, 0.76); }
      },
      dining() {
        const cloth = mat("cloth", 0xcfcfcf, tex("cloth", 128, 128, PAINT.checker, { a: "#7a2a2a", b: "#d8d0c0", n: 8 }, true));
        [[-3.2, -1.8], [0, -2.4], [3.2, -1.8], [-3.2, -3], [3.2, -3]].forEach(([x, z], i) => {
          cyl(cloth, x, 0.75, z, 0.6, 0.06); cyl(flat(0x2a2a2a), x, 0.37, z, 0.08, 0.74);
          if (i % 2 === 0) add(flat(0xc9a227, "hat"), unitCone, x + 0.1, 0.95, z, 0.14, 0.3, 0.14);
          box(flat(0x3a2a1c), x - 0.9, 0.25, z, 0.4, 0.5, 0.4);
        });
        plane(mat("pennants", 0xffffff, tex("pennants", 256, 64, PAINT.pennants), { transparent: true }), 0, 2.35, 1.2, 9.4, 1.2);
        [[-3.9, 2.2], [-1.2, 2.0], [2, 2.3], [4, 2.1], [0.5, 2.5]].forEach(([x, y], i) =>
          sph(flat([0x9c2b2b, 0x2b5b9c, 0xc9a227, 0x2b8a4a, 0x7a2b9c][i], `bal${i}`), x, y, -0.5 + i * 0.2, 0.22));
        plane(sign("HAPPY BIRTHDAY", "#ffe9a0", "#26262e", null, 256, 64), 0, 2.1, -3.95, 4, 0.9);
        box(dark(0x1c1c20), 4.4, 0.5, 2.6, 0.8, 1, 0.8);
      },
      backstage() {
        const shelf = mat("shelf", 0xc0c0c0, tex("shelves", 256, 256, PAINT.shelves));
        plane(shelf, -2.0, 1.2, -2.45, 2.2, 2.4); plane(shelf, 2.0, 1.2, -2.45, 2.2, 2.4);
        for (const x of [-2.0, 2.0]) for (const y of [0.5, 1.1, 1.7]) box(flat(0x4a4130), x, y, -2.25, 2.2, 0.05, 0.5);
        [[-2.4, 1.78], [-1.7, 1.18], [2.2, 1.78]].forEach(([x, y]) => {
          const hm = flat(0x6a6a62, "head");
          sph(hm, x, y + 0.18, -2.2, 0.2); sph(flat(0x000000, "socket"), x - 0.08, y + 0.2, -2.0, 0.045); sph(flat(0x000000, "socket"), x + 0.08, y + 0.2, -2.0, 0.045);
        });
        [[-1.6, 0.58], [1.8, 1.18], [2.4, 0.58]].forEach(([x, y]) => add(flat(0x55554f, "limb"), unitCyl, x, y + 0.08, -2.2, 0.06, 0.6, 0.06).rotation.z = 1.4);
        box(mat("bench", 0x6a5a40), 0, 0.85, -0.8, 1.8, 0.07, 0.7); box(flat(0x2a2a2a), -0.8, 0.42, -0.8, 0.07, 0.84, 0.6); box(flat(0x2a2a2a), 0.8, 0.42, -0.8, 0.07, 0.84, 0.6);
        for (const x of [-1.2, 0, 1.3]) { cyl(flat(0x5a5a54, "limb"), x, 2.2, -1.2, 0.05, 1.2); sph(flat(0x6a6a62, "head"), x, 1.5, -1.2, 0.17); }
      },
      cove() {
        const cm = tex("curtain-cove", 256, 256, PAINT.curtain, { a: "#1f5a58", dark: "#0b2424", patch: "#a8861f", moon: "#e8d890", n: 8 }, true);
        const curtMat = mat("cove-curtain", 0xc8c8c8, cm, { side: THREE.DoubleSide });
        const left = plane(curtMat, -0.65, 1.2, -1.2, 1.3, 2.3), right = plane(curtMat, 0.65, 1.2, -1.2, 1.3, 2.3);
        coveParts = { left, right };
        box(flat(0x3a2a18, "wood"), 0, 2.4, -1.2, 3, 0.15, 0.2);
        box(flat(0x3a2a18, "wood"), 0, 0.15, -1.6, 3, 0.3, 2.0);
        add(flat(0x4a3220, "wheel"), unitTorus, 1.7, 1.4, -2.3, 0.5, 0.5, 0.5, 0).name = "ship-wheel";
        for (let i = 0; i < 3; i++) { const sp = box(flat(0x4a3220, "wheel"), 1.7, 1.4, -2.3, 0.04, 1.0, 0.04); sp.rotation.z = i * Math.PI / 3; }
        const oos = plane(sign("OUT OF ORDER", "#e8c85a", "#1a1208", "mind the hook", 256, 96), -1.5, 1.7, -2.4, 1.1, 0.42); oos.rotation.z = 0.12;
        box(flat(0x4a3a24, "crate"), -2.0, 0.3, -1.5, 0.6, 0.6, 0.6); box(flat(0x4a3a24, "crate"), -1.9, 0.85, -1.45, 0.45, 0.4, 0.45);
        cyl(flat(0x1c1c1c, "cannon"), 1.9, 0.35, -0.6, 0.18, 0.7).rotation.z = 1.2;
        add(flat(0x7a6a3a, "rope"), unitTorus, 1.2, 0.05, 0.5, 0.35, 0.35, 0.35, 0, -Math.PI / 2);
      },
      supply() {
        const shelf = mat("shelf", 0xc0c0c0, tex("shelves", 256, 256, PAINT.shelves));
        plane(shelf, 0, 1.0, -1.7, 3.0, 2.0); plane(shelf, -1.7, 1.0, 0, 3.0, 2.0, Math.PI / 2);
        for (const y of [0.5, 1.0, 1.5]) box(flat(0x4a4130), 0, y, -1.5, 3.0, 0.05, 0.4);
        [[0.9, 0.2, 0.5], [1.2, 0.2, 0.0], [1.1, 0.65, 0.3], [-0.8, 0.2, -1.2], [-1.1, 0.2, -0.9]].forEach(([x, y, z]) => box(flat(0x5a4a30, "carton"), x, y, z, 0.5, 0.4, 0.5));
        cyl(flat(0x2a3a4a, "bucket"), -0.8, 0.22, 1.0, 0.25, 0.44); cyl(flat(0x6a5a40, "mop"), -0.6, 0.9, 1.0, 0.025, 1.6).rotation.z = 0.25;
      },
      kitchen() {
        const steel = flat(0x7a8078, "steel");
        box(steel, 0, 0.45, -2.1, 6.2, 0.9, 0.7); box(flat(0x2a2c2a), 0, 0.92, -2.1, 6.2, 0.05, 0.75);
        box(flat(0x1a1c1a), -1.6, 0.97, -2.1, 1.2, 0.06, 0.6); box(flat(0x1a1c1a), 1.2, 0.97, -2.1, 1.2, 0.06, 0.6);
        box(steel, 0, 0.45, 0.2, 2.2, 0.9, 0.9); box(steel, -3.2, 0.95, -1.0, 0.8, 1.9, 0.8);
        for (const x of [-1.4, 0, 1.4]) { cyl(flat(0x3a3a38, "pan"), x, 1.9, -1.9, 0.22, 0.06); box(flat(0x2a2a28), x + 0.3, 1.9, -1.9, 0.3, 0.04, 0.05); }
        box(flat(0x2a2a28), 0, 2.15, -1.9, 4.2, 0.04, 0.05);
        plane(sign("KITCHEN", "#c8d8c0", "#202a20"), 2.5, 2.2, -2.47, 1.1, 0.4);
      },
      restrooms() {
        const stall = mat("stall", 0x9aa8b0, null);
        [-1.8, -0.6, 0.6, 1.8].forEach((x) => box(stall, x, 1.0, -1.5, 0.04, 2.0, 1.8));
        [-1.2, 0, 1.2].forEach((x, i) => { const dr = box(flat(0x6a8890, "stalldoor"), x, 0.95, -0.62, 1.05, 1.8, 0.04); dr.rotation.y = i === 1 ? 0.5 : 0; });
        [-2.4, 2.4].forEach((x) => { box(flat(0x8a9090, "sink"), x, 0.85, -2.3, 0.7, 0.15, 0.4); plane(mat("mirror", 0x6a7a80), x, 1.6, -2.48, 0.8, 0.9); });
        plane(sign("RESTROOMS", "#d0f0e8", "#183030"), 0, 2.3, -2.48, 1.4, 0.45);
      },
      hall(isWest) {
        const col = isWest ? 0x2a2a38 : 0x2a382a;
        [-3.5, -0.5, 2.3].forEach((z, i) => {
          plane(mat(`poster-${i}-${isWest}`, 0xffffff, tex(`poster-${i}-${isWest}`, 128, 160, (ctx, pw, ph, r) => {
            ctx.fillStyle = isWest ? "#c8c0a0" : "#b8c8b0"; ctx.fillRect(0, 0, pw, ph);
            ctx.fillStyle = "#6a2a2a"; ctx.beginPath(); ctx.arc(pw / 2, ph * 0.4, pw * 0.25, 0, 6.3); ctx.fill();
            ctx.fillStyle = "#222"; ctx.beginPath(); ctx.arc(pw * 0.42, ph * 0.38, 4, 0, 6.3); ctx.arc(pw * 0.58, ph * 0.38, 4, 0, 6.3); ctx.fill();
            ctx.fillRect(pw * 0.15, ph * 0.78, pw * 0.7, 6); ctx.fillRect(pw * 0.25, ph * 0.86, pw * 0.5, 4);
            grime(ctx, pw, ph, r, 8);
          })), (isWest ? -1.19 : 1.19), 1.4, z, 0.7, 0.9, isWest ? Math.PI / 2 : -Math.PI / 2);
        });
        cyl(flat(0x3a3a3a, "pipe"), 0, 2.75, -1, 0.08, 9.6).rotation.x = Math.PI / 2;
        box(flat(0x050505), 0, 1.1, -4.95, 1.1, 2.2, 0.1);
        plane(sign("EXIT", "#ff4040", "#1a0505"), 0, 2.45, -4.9, 0.5, 0.2);
        sph(flat(isWest ? 0xff3020 : 0xffa020, "alarm"), isWest ? -1.1 : 1.1, 2.5, 3, 0.07);
        box(flat(col, "bench"), isWest ? 1.0 : -1.0, 0.25, 3.5, 0.3, 0.5, 0.9);
      },
      corner(isWest) {
        const s = isWest ? -1 : 1;
        cyl(flat(0x3a3a3a, "bin"), s * 1.4, 0.4, 1.1, 0.25, 0.8);
        cyl(flat(0xa02020, "ext"), -s * 1.55, 0.7, -0.4, 0.07, 0.35); box(flat(0x222222), -s * 1.6, 0.9, -0.4, 0.03, 0.2, 0.03);
        plane(sign(isWest ? "OFFICE >" : "< OFFICE", "#e8e0c0", "#1a1a1e", "staff only", 192, 96), s * 1.74, 1.7, -0.8, 0.9, 0.45, -s * Math.PI / 2);
        plane(mat("poster-c", 0xffffff, tex("poster-c", 128, 160, (ctx, pw, ph, r) => { ctx.fillStyle = "#b8b098"; ctx.fillRect(0, 0, pw, ph); ctx.fillStyle = "#553"; ctx.fillRect(10, 10, pw - 20, ph - 20); ctx.fillStyle = "#d8cfa0"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center"; ctx.fillText("SMILE!", pw / 2, ph / 2); grime(ctx, pw, ph, r, 6); })), 0, 1.5, -1.74, 0.8, 1, 0);
      },
    };
    if (id === "hall-west") BUILD.hall(true);
    else if (id === "hall-east") BUILD.hall(false);
    else if (id === "hall-west-corner") BUILD.corner(true);
    else if (id === "hall-east-corner") BUILD.corner(false);
    else BUILD[id]();

    // anchors for characters (face the camera)
    const cam = spec.cam;
    const anchors = {};
    CHAR_IDS.forEach((cid, i) => {
      const a = new THREE.Group(); a.name = `anchor-${id}-${cid}`;
      const [sx, sy, sz] = spec.slots[i];
      a.position.set(sx, sy, sz);
      a.rotation.y = Math.atan2(cam[0][0] - sx, cam[0][2] - sz);
      a.visible = false; grp.add(a); anchors[cid] = { anchor: a, ph: null };
    });

    rooms.set(id, { id, group: grp, spec, anchors, occupants: [] });
  });

  const camPoses = new Map();
  for (const [id, r] of rooms) {
    camPoses.set(id, { p: r.spec.cam[0], l: r.spec.cam[1] });
  }

  let visibleId = null;
  const api = {
    group: root,
    ids: ROOM_IDS.slice(),
    meta: ROOM_META,
    getRoomGroup(id) { return rooms.get(id)?.group ?? null; },
    getCameraPose(id) {
      const r = rooms.get(id); if (!r) return null;
      const o = r.group.position, c = camPoses.get(id);
      return {
        position: new THREE.Vector3(o.x + c.p[0], o.y + c.p[1], o.z + c.p[2]),
        lookAt: new THREE.Vector3(o.x + c.l[0], o.y + c.l[1], o.z + c.l[2]),
      };
    },
    getAnchor(id, charId) { return rooms.get(id)?.anchors[charId]?.anchor ?? null; },
    getOccupants(id) { return rooms.get(id)?.occupants.slice() ?? []; },
    setOccupants(id, list) {
      const r = rooms.get(id); if (!r || !Array.isArray(list)) return false;
      const want = new Set(list.filter((c) => CHAR_IDS.includes(c)));
      r.occupants = CHAR_IDS.filter((c) => want.has(c));
      for (const cid of CHAR_IDS) {
        const slot = r.anchors[cid]; const on = want.has(cid);
        slot.anchor.visible = on;
        if (on && !slot.ph) { slot.ph = kit.build(cid); slot.anchor.add(slot.ph.group); }
        if (slot.ph) slot.ph.group.visible = on && placeholdersOn;
      }
      return true;
    },
    usePlaceholders(on) {
      placeholdersOn = !!on;
      for (const r of rooms.values()) for (const s of Object.values(r.anchors)) if (s.ph) s.ph.group.visible = placeholdersOn && s.anchor.visible;
    },
    setVisibleRoom(id) {
      visibleId = rooms.has(id) ? id : null;
      for (const r of rooms.values()) r.group.visible = r.id === visibleId;
    },
    getVisibleRoom() { return visibleId; },
    setCoveCurtain(open01) {
      coveOpen = clamp(Number(open01) || 0, 0, 1);
      if (coveParts) {
        coveParts.left.position.x = -0.65 - coveOpen * 0.85; coveParts.right.position.x = 0.65 + coveOpen * 0.85;
        coveParts.left.scale.x = 1.3 - coveOpen * 0.7; coveParts.right.scale.x = 1.3 - coveOpen * 0.7;
      }
    },
    getCoveCurtain() { return coveOpen; },
    update(dt, time) {
      for (const f of flickers) {
        const r = rooms.get(f.id); if (!r.group.visible) continue;
        const n = Math.sin(time * f.rate + f.seed) * Math.sin(time * f.rate * 0.37 + f.seed * 2);
        const dip = Math.sin(time * 1.7 + f.seed) > 0.96 ? 0.25 : 1;
        f.mat.opacity = f.base * dip * (0.85 + 0.15 * n);
      }
    },
    stats() {
      let meshes = 0, drawCalls = 0, maxRoomDraw = 0;
      const per = {};
      for (const r of rooms.values()) {
        let m = 0;
        r.group.traverse((o) => { if (o.isMesh) m += Array.isArray(o.material) ? o.material.length : 1; });
        per[r.id] = m; meshes += m; maxRoomDraw = Math.max(maxRoomDraw, m);
      }
      return { materials: mats.length, textures: texs.length, geometries: geos.length, perRoomDrawCalls: per, maxRoomDraw, totalDraw: meshes };
    },
    dispose() {
      scene.remove(root);
      geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); texs.forEach((t) => t.dispose());
      kit.dispose();
    },
  };
  return api;
}
