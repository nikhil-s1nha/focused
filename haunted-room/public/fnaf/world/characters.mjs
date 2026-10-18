// characters.mjs — four ORIGINAL derelict animatronics for the FNAF-style mode
// plus the shared rig/builder that characters-extra.mjs reuses.
//
// Designs (all original; no official silhouette, palette or name is used):
//   bellwether  tall brass-and-felt hare automaton, long jaw, cracked ear plate
//   lark        lanky bird automaton, bib, loose crooked beak hinge, creepy tray
//   ratchet     hunched wiry runner, hook arm, torn faceplate, curtain stages 0-3
//   maestro     large top-hat conductor, enamel face, eyes that go black + glow
//
// House rules: THREE is injected (module imports cleanly in Node), geometry is
// procedural and merged per body part, vertex colours carry the palette so ONE
// shared "body" and ONE shared "metal" material serve every character. Each
// character owns exactly one eye material, so a character uses <= 4 materials
// (body, metal, void, eye). The camera is never touched; the jumpscare is the
// character itself lunging into the player's face. No flicker above 3 Hz.

import { makeNoise } from "../../textures.mjs";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

export const POSE_NAMES = Object.freeze(["idle", "stare", "peek", "lean", "jumpscare"]);
export const JUMPSCARE_SECONDS = 0.6;
export const FACE_DISTANCE = 0.42;
export const MAX_TRIANGLES = 6000;

// ---------------------------------------------------------------------------
// Geometry kit + merged parts
// ---------------------------------------------------------------------------

export function makeKit(THREE) {
  return {
    box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
    cyl: (rt, rb, h, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s, 1),
    sph: (r, ws = 10, hs = 8) => new THREE.SphereGeometry(r, ws, hs),
    cone: (r, h, s = 6) => new THREE.ConeGeometry(r, h, s, 1),
    tor: (R, r, rs = 5, ts = 10, arc = Math.PI * 2) => new THREE.TorusGeometry(R, r, rs, ts, arc),
    hemi: (r, ws = 10, hs = 5) => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI / 2),
  };
}

/** A bag of primitives; merged into one mesh per material key at build time. */
export class Part {
  constructor(K) {
    this.K = K;
    this.items = [];
  }
  add(mat, geo, o = {}) {
    this.items.push({ mat, geo, p: o.p || [0, 0, 0], r: o.r || [0, 0, 0], s: o.s || [1, 1, 1], c: o.c ?? 0xffffff });
    return this;
  }
  box(mat, d, o) { return this.add(mat, this.K.box(...d), o); }
  cyl(mat, d, o) { return this.add(mat, this.K.cyl(...d), o); }
  sph(mat, d, o) { return this.add(mat, this.K.sph(...d), o); }
  cone(mat, d, o) { return this.add(mat, this.K.cone(...d), o); }
  tor(mat, d, o) { return this.add(mat, this.K.tor(...d), o); }
  hemi(mat, d, o) { return this.add(mat, this.K.hemi(...d), o); }
  /** Row of teeth along x. dir=-1 points down (upper row), +1 points up. */
  teeth(n, { x0 = -0.07, x1 = 0.07, y = 0, z = 0, curve = 0.3, w = 0.02, h = 0.04, dir = -1, pointed = false, c = 0xd8cfb4, mat = "body" } = {}) {
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 0.5 : i / (n - 1);
      const x = lerp(x0, x1, u);
      const zz = z - curve * (x / Math.max(1e-3, Math.max(Math.abs(x0), Math.abs(x1)))) ** 2 * 0.1;
      const shade = i % 3 === 1 ? 0.78 : 1; // uneven, stained
      const cc = scaleColor(c, shade);
      if (pointed) {
        this.cone(mat, [w * 0.7, h, 4], { p: [x, y, zz], r: [dir < 0 ? Math.PI : 0, 0, (i % 2 ? 0.08 : -0.06)], c: cc });
      } else {
        this.box(mat, [w, h * (i % 4 === 2 ? 0.7 : 1), w * 0.8], { p: [x, y + (dir < 0 ? -h / 2 : h / 2), zz], r: [0, 0, (i % 2 ? 0.05 : -0.04)], c: cc });
      }
    }
    return this;
  }
}

function scaleColor(hex, k) {
  const r = Math.round(((hex >> 16) & 255) * k);
  const g = Math.round(((hex >> 8) & 255) * k);
  const b = Math.round((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
}

function mergeItems(THREE, items, withColor, wear) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const col = new THREE.Color();
  const sallow = new THREE.Color(0x6b5a2e);
  const geos = items.map((it) => {
    const g = it.geo.clone();
    e.set(it.r[0], it.r[1], it.r[2]);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(...it.p), q, new THREE.Vector3(...it.s));
    g.applyMatrix4(m);
    return g;
  });
  let vc = 0;
  let ic = 0;
  for (const g of geos) {
    vc += g.attributes.position.count;
    ic += g.index.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const colr = withColor ? new Float32Array(vc * 3) : null;
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  geos.forEach((g, gi) => {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    if (colr) {
      col.setHex(items[gi].c);
      if (wear) {
        col.multiplyScalar(wear.dark ?? 1);
        col.lerp(sallow, wear.sallow ?? 0);
      }
      for (let i = 0; i < n; i++) colr.set([col.r, col.g, col.b], (vo + i) * 3);
    }
    const src = g.index.array;
    for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
    vo += n;
    io += src.length;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (colr) out.setAttribute("color", new THREE.BufferAttribute(colr, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// Shared materials + grime texture
// ---------------------------------------------------------------------------

function paintGrime(createCanvas, seed) {
  const S = 128;
  const cv = createCanvas(S, S);
  const ctx = cv && cv.getContext && cv.getContext("2d");
  if (!ctx) return null;
  const rnd = makeNoise(seed);
  ctx.fillStyle = "#dcdcdc";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 14; i++) {
    const x = rnd() * S, y = rnd() * S, r = 14 + rnd() * 34;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, `rgba(30,24,18,${0.25 + rnd() * 0.3})`);
    g.addColorStop(1, "rgba(30,24,18,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 22; i++) { // vertical drips / rust runs
    const x = rnd() * S, y = rnd() * S * 0.6, l = 12 + rnd() * 50;
    ctx.strokeStyle = `rgba(50,30,18,${0.2 + rnd() * 0.3})`;
    ctx.lineWidth = 1 + rnd() * 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y + l); ctx.stroke();
  }
  for (let i = 0; i < 26; i++) { // scratches
    const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI, l = 6 + rnd() * 22;
    ctx.strokeStyle = `rgba(255,255,255,${0.1 + rnd() * 0.25})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  for (let i = 0; i < 500; i++) { // speckle
    ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.22})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  return cv;
}

const RIM_PATCH = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <emissivemap_fragment>",
    `#include <emissivemap_fragment>
     float rimF = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.6);
     totalEmissiveRadiance += vec3(0.16, 0.2, 0.3) * rimF;`,
  );
};

const sharedCache = new WeakMap();

/** Reference-counted material set shared by every character of one THREE. */
export function acquireShared(THREE, createCanvas) {
  let s = sharedCache.get(THREE);
  if (!s) {
    let map = null;
    const mk = createCanvas || (typeof document !== "undefined" ? (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }) : null);
    if (mk) {
      try {
        const cv = paintGrime(mk, 4471);
        if (cv) {
          map = new THREE.CanvasTexture(cv);
          map.wrapS = map.wrapT = THREE.RepeatWrapping;
          map.colorSpace = THREE.SRGBColorSpace;
        }
      } catch { map = null; }
    }
    const body = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.86, metalness: 0.05, emissive: 0x0c0c10 });
    const metal = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 0.42, metalness: 0.78, emissive: 0x08080a });
    for (const m of [body, metal]) {
      m.onBeforeCompile = RIM_PATCH;
      m.customProgramCacheKey = () => "fnaf-rim-v1";
    }
    const voidMat = new THREE.MeshBasicMaterial({ color: 0x020203, transparent: true, opacity: 0.05, depthWrite: false });
    const phantom = new THREE.MeshStandardMaterial({ color: 0x0a1018, transparent: true, opacity: 0.34, roughness: 1, metalness: 0, depthWrite: false, emissive: 0x0a1624, side: THREE.DoubleSide });
    s = { body, metal, void: voidMat, phantom, map, refs: 0 };
    sharedCache.set(THREE, s);
  }
  s.refs++;
  return s;
}

function releaseShared(THREE) {
  const s = sharedCache.get(THREE);
  if (!s) return;
  if (--s.refs <= 0) {
    for (const k of ["body", "metal", "void", "phantom"]) s[k].dispose();
    if (s.map) s.map.dispose();
    sharedCache.delete(THREE);
  }
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

const BASE = {
  lean: 0, sway: 0, twist: 0, hp: 0, hy: 0, hr: 0, jaw: 0.1,
  aL: [0.05, 0.1, 0.2], aR: [0.05, 0.1, 0.2], // [forward, outward, elbow bend]
  eye: 0.6, rx: 0, rz: 0, ry: 0, drop: 0, crouch: 0, rise: 0,
  look: 0, gait: 0, conduct: 0, lid: 0, ear: 0,
};
const DEFAULT_POSES = {
  idle: { look: 0.25, eye: 0.5 },
  stare: { look: 1, eye: 1.1, jaw: 0.08, hp: 0.02, aL: [0.04, 0.12, 0.1], aR: [0.04, 0.12, 0.1] },
  // peek assumes a door-frame edge at local x ~ +0.45: about half the body hides.
  peek: { rx: 0.42, ry: -0.5, sway: 0.3, hr: -0.3, look: 1, eye: 1.3, jaw: 0.2, twist: -0.25, aL: [0.02, 0.05, 0.1], aR: [0.4, 1.2, 0.6] },
  lean: { lean: 0.5, hp: -0.3, look: 1, eye: 1.5, jaw: 0.35, rz: 0.15, aL: [0.9, 0.2, 0.3], aR: [0.9, 0.2, 0.3] },
  jumpscare: { lean: 0.4, hp: -0.25, look: 1, eye: 4, jaw: 1, crouch: 0.1, aL: [1.5, 0.6, 0.2], aR: [1.5, 0.6, 0.2] },
};
const NUM_KEYS = ["lean", "sway", "twist", "hp", "hy", "hr", "jaw", "eye", "rx", "rz", "ry", "drop", "crouch", "rise", "look", "gait", "conduct", "lid", "ear"];

function flatten(p) {
  const o = {};
  for (const k of NUM_KEYS) o[k] = p[k] ?? BASE[k];
  const aL = p.aL || BASE.aL, aR = p.aR || BASE.aR;
  o.aLf = aL[0]; o.aLo = aL[1]; o.aLe = aL[2];
  o.aRf = aR[0]; o.aRo = aR[1]; o.aRe = aR[2];
  return o;
}
const ALL_KEYS = [...NUM_KEYS, "aLf", "aLo", "aLe", "aRf", "aRo", "aRe"];

// ---------------------------------------------------------------------------
// Rig builder (shared with characters-extra.mjs)
// ---------------------------------------------------------------------------

/**
 * Build a character from a spec. See the specs below for the shape.
 * Returns the public character API.
 */
export function buildCharacter(THREE, spec, options = {}) {
  const shared = acquireShared(THREE, options.createCanvas);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x050505, roughness: 0.2, metalness: 0,
    emissive: spec.eye?.color ?? 0xffd37a, emissiveIntensity: 0,
  });
  const matFor = spec.phantom
    ? { body: shared.phantom, metal: shared.phantom, eye: eyeMat }
    : { body: shared.body, metal: shared.metal, eye: eyeMat };

  const geometries = [];
  const bodyMeshes = []; // { mesh, normal }
  let triangles = 0;
  let vertices = 0;
  const meshSet = new Set();
  const usedMats = new Set([shared.void, eyeMat]);

  function realize(part, parent) {
    if (!part) return null;
    const byMat = {};
    for (const it of part.items) (byMat[it.mat] ||= []).push(it);
    for (const [key, items] of Object.entries(byMat)) {
      const g = mergeItems(THREE, items, key !== "eye", spec.wear);
      geometries.push(g);
      triangles += g.index.count / 3;
      vertices += g.attributes.position.count;
      const mesh = new THREE.Mesh(g, matFor[key]);
      mesh.name = `${spec.id}-${key}`;
      mesh.castShadow = !!options.shadows;
      mesh.matrixAutoUpdate = true;
      parent.add(mesh);
      meshSet.add(mesh);
      usedMats.add(matFor[key]);
      if (key !== "eye") bodyMeshes.push({ mesh, normal: matFor[key] });
    }
    return parent;
  }
  const pivot = (name, parent, pos = [0, 0, 0]) => {
    const g = new THREE.Group();
    g.name = `${spec.id}-${name}`;
    g.position.set(...pos);
    parent.add(g);
    return g;
  };

  const group = new THREE.Group();
  group.name = `fnaf-${spec.id}`;
  const riser = pivot("riser", group);
  const piv = { root: group, riser };
  if (spec.fixtures) realize(spec.fixtures, group);

  if (spec.legs) {
    piv.leg = {};
    for (const side of ["L", "R"]) {
      const L = spec.legs[side];
      const hip = pivot(`hip${side}`, riser, L.pos);
      realize(L.thigh, hip);
      const knee = pivot(`knee${side}`, hip, L.knee);
      realize(L.shin, knee);
      piv.leg[side] = { hip, knee };
    }
  }
  const body = pivot("body", riser, [0, spec.hipY, 0]);
  realize(spec.body, body);
  const head = pivot("head", body, spec.head.pos);
  head.scale.setScalar(spec.headScale ?? 1);
  realize(spec.head.part, head);
  const jaw = pivot("jaw", head, spec.jaw.pos);
  realize(spec.jaw.part, jaw);
  piv.body = body; piv.head = head; piv.jaw = jaw;
  const arms = {};
  for (const side of ["L", "R"]) {
    const A = spec.arms[side];
    const sh = pivot(`arm${side}`, body, A.pos);
    realize(A.upper, sh);
    const el = pivot(`elbow${side}`, sh, A.elbow);
    realize(A.fore, el);
    arms[side] = { sh, el };
    piv["arm" + side] = sh;
    piv["fore" + side] = el;
  }
  const extras = [];
  for (const ex of spec.extras || []) {
    const par = piv[ex.parent] || group;
    const g = pivot(ex.name, par, ex.pos);
    if (ex.rot) g.rotation.set(...ex.rot);
    realize(ex.part, g);
    extras.push({ ...ex, obj: g, baseRot: g.rotation.clone() });
    piv[ex.name] = g;
  }

  if (options.position) group.position.set(options.position.x ?? 0, options.position.y ?? 0, options.position.z ?? 0);
  if (options.rotationY != null) group.rotation.y = options.rotationY;
  if (options.parent) options.parent.add(group);

  // ---- state ----
  const poses = {};
  const poseTable = { ...DEFAULT_POSES, ...(spec.poses || {}) };
  for (const [name, p] of Object.entries(poseTable)) {
    const base = DEFAULT_POSES[name] ? { ...DEFAULT_POSES[name], ...(spec.poses?.[name] || {}) } : p;
    poses[name] = flatten({ ...BASE, ...(spec.base || {}), ...base });
  }
  const seed = options.seed ?? [...spec.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const cur = { ...poses.idle };
  const st = {
    pose: "idle", blackout: false, fade: 1, eye: 0, disposed: false,
    look: null, jump: null, home: null, gaitPhase: 0,
  };
  const player = options.player || { x: 0, y: 1.6, z: 2 };
  const jawMax = spec.jawMax ?? 0.75;
  const eyeBase = spec.eye?.base ?? 0.3;
  const eyeGlow = spec.eye?.glow ?? 1.7;
  const tmpV = new THREE.Vector3();
  const lookLocal = new THREE.Vector3();
  const headWorld = new THREE.Vector3();

  function applyMaterials() {
    const useVoid = st.fade < 0.6;
    for (const b of bodyMeshes) b.mesh.material = useVoid ? shared.void : b.normal;
  }

  function setPose(name) {
    if (st.disposed || !poses[name]) return false;
    if (name !== "jumpscare") releaseJump();
    st.pose = name;
    if (name === "jumpscare") jumpscare();
    return true;
  }

  function releaseJump() {
    if (st.jump && st.home) {
      group.position.copy(st.home.pos);
      group.rotation.y = st.home.yaw;
    }
    st.jump = null;
    st.home = null;
  }

  function jumpscare(target) {
    if (st.disposed) return;
    if (st.jump) return;
    group.updateMatrixWorld(true);
    const tp = target || player;
    const wp = group.getWorldPosition(new THREE.Vector3());
    let dx = wp.x - tp.x, dz = wp.z - tp.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const world = new THREE.Vector3(tp.x + dx * FACE_DISTANCE, (tp.y ?? 1.6) - (spec.headTop ?? 1.8) * 0.92, tp.z + dz * FACE_DISTANCE);
    const local = group.parent ? group.parent.worldToLocal(world.clone()) : world;
    st.home = { pos: group.position.clone(), yaw: group.rotation.y };
    st.jump = { t: 0, from: group.position.clone(), to: local, yawFrom: group.rotation.y, yawTo: Math.atan2(tp.x - wp.x, tp.z - wp.z) };
    st.pose = "jumpscare";
  }

  function setBlackout(b) {
    if (st.disposed) return;
    st.blackout = !!b;
  }
  function setVisible(v) {
    if (!st.disposed) group.visible = !!v;
  }
  function setLookTarget(v) {
    st.look = v ? { x: v.x, y: v.y, z: v.z } : null;
  }

  function update(dt = 0.016, time = 0, state = {}) {
    if (st.disposed || !(dt >= 0)) return;
    dt = Math.min(dt, 0.1);
    const tgt = poses[st.pose];
    const tau = st.pose === "jumpscare" ? 0.07 : spec.tau ?? 0.35;
    const k = 1 - Math.exp(-dt / tau);
    for (const key of ALL_KEYS) cur[key] += (tgt[key] - cur[key]) * k;

    // jumpscare lunge: accelerating, ~0.6 s, then latched at the face.
    if (st.jump) {
      st.jump.t = Math.min(JUMPSCARE_SECONDS, st.jump.t + dt);
      const p = st.jump.t / JUMPSCARE_SECONDS;
      const e = p * p * (1.6 - 0.6 * p);
      group.position.lerpVectors(st.jump.from, st.jump.to, e);
      const dy = Math.atan2(Math.sin(st.jump.yawTo - st.jump.yawFrom), Math.cos(st.jump.yawTo - st.jump.yawFrom));
      group.rotation.y = st.jump.yawFrom + dy * Math.min(1, p * 2);
    }

    const observed = !!state.observed;
    const calm = observed ? 0.2 : 1;
    const tension = clamp(Number(state.tension) || 0, 0, 1);
    const breath = Math.sin(time * 1.1 + seed) * 0.012;
    const drift = Math.sin(time * 0.37 + seed) * 0.05 * calm;
    const twitch = Math.pow(Math.max(0, Math.sin(time * 0.9 + seed * 3)), 10) * 0.07 * calm * (0.5 + tension);

    // gait / conduct phases
    const gait = cur.gait;
    st.gaitPhase += dt * 9 * (gait > 0.05 ? 1 : 0);
    const gp = st.gaitPhase;

    riser.position.set(cur.rx, cur.rise, cur.rz);
    riser.rotation.y = cur.ry;
    body.position.y = spec.hipY - cur.drop - cur.crouch * 0.25 + Math.abs(Math.sin(gp)) * 0.05 * gait;
    body.rotation.set(cur.lean + breath, cur.twist, cur.sway);

    // head: pose + look tracking
    let ly = 0, lp = 0;
    if (st.look && cur.look > 0.02) {
      head.getWorldPosition(headWorld);
      lookLocal.set(st.look.x, st.look.y, st.look.z);
      group.worldToLocal(lookLocal);
      group.worldToLocal(tmpV.copy(headWorld));
      const dx = lookLocal.x - tmpV.x, dz = lookLocal.z - tmpV.z, dyy = lookLocal.y - tmpV.y;
      ly = clamp(Math.atan2(dx, Math.max(0.05, dz)) - cur.twist - cur.ry, -1.1, 1.1) * cur.look;
      lp = clamp(-Math.atan2(dyy, Math.hypot(dx, dz)), -0.6, 0.6) * cur.look;
    }
    head.rotation.set(cur.hp + lp + twitch, cur.hy + ly + drift, cur.hr);
    const slow = Math.sin(time * 1.6 + seed) * 0.03; // < 2 Hz tremor
    const jawOpen = clamp(cur.jaw + twitch * 1.5 + (st.pose === "jumpscare" ? slow : 0), 0, 1);
    jaw.rotation.set(jawOpen * jawMax, spec.jawBias?.yaw ?? 0, spec.jawBias?.roll ?? 0);

    // arms
    const swing = Math.sin(gp) * 0.9 * gait;
    const conduct = Math.sin(time * 5) * 0.25 * cur.conduct;
    arms.L.sh.rotation.set(-(cur.aLf) + (-swing), 0, -cur.aLo);
    arms.R.sh.rotation.set(-(cur.aRf + conduct) + swing, 0, cur.aRo);
    arms.L.el.rotation.set(-cur.aLe, 0, 0);
    arms.R.el.rotation.set(-cur.aRe, 0, 0);
    // legs
    if (piv.leg) {
      for (const [side, s] of [["L", 0], ["R", Math.PI]]) {
        const lg = piv.leg[side];
        const ph = gp + s;
        lg.hip.rotation.x = Math.sin(ph) * 0.8 * gait - cur.crouch * 1.2;
        lg.knee.rotation.x = (0.5 + 0.5 * Math.sin(ph + 1)) * 1.0 * gait + cur.crouch * 2.2;
      }
    }
    // extras (ears, lid, crank, ...)
    for (const ex of extras) {
      if (ex.anim) ex.anim(ex.obj, time, cur, ex.baseRot, twitch);
    }

    // eyes: smooth ramps only (no flashing).
    let eyeT = Math.max(cur.eye, eyeBase * (st.pose === "idle" ? 0.5 : 1));
    eyeT += tension * 0.25;
    if (st.blackout) eyeT = Math.max(eyeT, eyeGlow);
    eyeT = clamp(eyeT, 0, 4.5);
    st.eye += (eyeT - st.eye) * (1 - Math.exp(-dt / 0.12));
    eyeMat.emissiveIntensity = st.eye;

    // blackout body fade
    st.fade += ((st.blackout ? 0 : 1) - st.fade) * (1 - Math.exp(-dt / 0.35));
    applyMaterials();
  }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    if (group.parent) group.parent.remove(group);
    for (const g of geometries) g.dispose();
    eyeMat.dispose();
    releaseShared(THREE);
    for (const m of meshSet) m.geometry = null;
    meshSet.clear();
    bodyMeshes.length = 0;
  }

  function getState() {
    const jp = st.jump ? st.jump.t / JUMPSCARE_SECONDS : 0;
    return {
      pose: st.pose,
      jumpscaring: !!st.jump,
      jumpscareProgress: jp,
      latched: !!st.jump && jp >= 1,
      blackout: st.blackout,
      bodyFade: st.fade,
      visible: group.visible,
      eyeIntensity: st.eye,
      jaw: cur.jaw,
      disposed: st.disposed,
    };
  }

  group.userData.character = spec.id;
  applyMaterials();

  const api = {
    id: spec.id,
    group,
    eyeMaterial: eyeMat,
    poses: Object.keys(poses),
    stats: { triangles, vertices, meshes: meshSet.size, materials: usedMats.size },
    update, setPose, setLookTarget, jumpscare, setBlackout, setVisible, dispose, getState,
  };
  if (spec.api) Object.assign(api, spec.api(api));
  // settle to idle immediately so a fresh character is posed correctly.
  update(0.0001, 0);
  return api;
}

// ---------------------------------------------------------------------------
// Part-building helpers
// ---------------------------------------------------------------------------

function fingers(P, mat, n, { len = 0.1, r = 0.012, spread = 0.35, y = 0, z = 0, c = 0x555050, curl = 0.4 } = {}) {
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * spread;
    P.cyl(mat, [r * 0.7, r, len, 5], { p: [Math.sin(a) * 0.03, y - len / 2, z + Math.cos(a) * 0.01], r: [curl * 0.5, 0, -a], c });
  }
}

/** Standard arm: returns {upper, fore, ...}. Caller customises hands. */
function arm(K, { side, upperLen = 0.46, foreLen = 0.46, r = 0.045, sleeve = "body", sleeveC = 0x555, jointC = 0x8a6b3d, bare = false, foreMat, foreC } = {}) {
  const upper = new Part(K);
  upper.sph("metal", [r * 1.3, 7, 5], { c: jointC });
  upper.cyl(sleeve, [r, r * 0.88, upperLen, 8], { p: [0, -upperLen / 2, 0], c: sleeveC });
  const fore = new Part(K);
  fore.sph("metal", [r * 1.2, 7, 5], { c: jointC });
  fore.cyl(bare ? "metal" : foreMat || sleeve, [r * 0.85, r * 0.65, foreLen, 8], { p: [0, -foreLen / 2, 0], c: foreC ?? (bare ? 0x6a6258 : sleeveC) });
  return { upper, fore, upperLen, foreLen };
}

const SOCKET = 0x040303;
const BONE = 0xd8cfb4;

// ---------------------------------------------------------------------------
// BELLWETHER — tall brass-and-felt hare
// ---------------------------------------------------------------------------

export function bellwetherSpec(K, v = {}) {
  const felt = 0x6b3a3a, dust = 0x7a7468, brass = 0x9a7a3a, dark = 0x2a2420;
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("body", [0.06, 0.05, 0.5, 8], { p: [0, -0.25, 0], c: felt });
    th.tor("metal", [0.055, 0.01, 4, 8], { p: [0, -0.12, 0], r: [Math.PI / 2, 0, 0], c: brass });
    sh.sph("metal", [0.06, 7, 5], { c: brass });
    sh.cyl("metal", [0.04, 0.03, 0.48, 6], { p: [0, -0.25, 0], c: 0x6e5a32 });
    sh.box("body", [0.11, 0.05, 0.28], { p: [0, -0.5, 0.07], c: dark });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.11, 1.0, 0], thigh: th, knee: [0, -0.5, 0], shin: sh };
  }
  const body = new Part(K);
  body.cyl("metal", [0.14, 0.12, 0.14, 8], { p: [0, 0.05, 0], c: brass });
  body.cyl("body", [0.21, 0.14, 0.64, 10], { p: [0, 0.42, 0], c: felt });
  for (const y of [0.22, 0.56]) body.tor("metal", [y > 0.4 ? 0.185 : 0.155, 0.012, 4, 12], { p: [0, y, 0], r: [Math.PI / 2, 0, 0], c: brass });
  body.box("metal", [0.64, 0.07, 0.11], { p: [0, 0.74, 0], c: brass });
  // asymmetric tear: bare right flank exposing rods
  body.box("body", [0.12, 0.3, 0.1], { p: [0.12, 0.4, 0.1], r: [0, -0.5, 0], c: SOCKET });
  for (let i = 0; i < 4; i++) body.cyl("metal", [0.01, 0.01, 0.2, 5], { p: [0.12, 0.3 + i * 0.07, 0.15], r: [0.1, 0.2, Math.PI / 2 - 0.15 + i * 0.05], c: 0x7b7468 });
  body.cyl("metal", [0.012, 0.012, 0.42, 5], { p: [0.07, 0.4, 0.12], c: 0x7b7468 });
  // bell collar
  body.tor("metal", [0.09, 0.016, 5, 10], { p: [0, 0.8, 0], r: [Math.PI / 2, 0, 0], c: brass });
  body.sph("metal", [0.05, 8, 6], { p: [0, 0.72, 0.13], c: 0xc2a04a });
  body.sph("body", [0.015, 5, 4], { p: [0, 0.69, 0.17], c: SOCKET });
  body.cyl("body", [0.045, 0.06, 0.16, 7], { p: [0, 0.86, 0], c: dark });

  const head = new Part(K);
  head.sph("body", [0.17, 12, 9], { p: [0, 0.12, 0], s: [0.9, 1.15, 1], c: dust });
  head.sph("body", [0.12, 10, 7], { p: [0, 0.02, 0.2], s: [0.8, 0.7, 1.7], c: dust });
  head.sph("metal", [0.032, 6, 5], { p: [0, 0.05, 0.4], c: dark });
  for (const s of [-1, 1]) {
    const dim = s < 0 ? 0.7 : 1;
    head.sph("body", [0.06, 8, 6], { p: [s * 0.085, 0.15, 0.13], s: [1, 1.2, 0.6], c: SOCKET });
    head.sph("eye", [0.026 * dim, 7, 5], { p: [s * 0.085, 0.15, 0.15] });
    head.box("metal", [0.1, 0.016, 0.045], { p: [s * 0.09, 0.225, 0.14], r: [0, 0, s * 0.38], c: 0x5b4a2a });
  }
  head.teeth(7, { x0: -0.07, x1: 0.07, y: -0.065, z: 0.4, w: 0.022, h: 0.045, c: BONE });
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) head.box("body", [0.016, 0.04, 0.02], { p: [s * 0.07, -0.085, 0.13 + i * 0.045], c: scaleColor(BONE, i % 2 ? 0.8 : 1) });
  const jaw = new Part(K);
  jaw.box("body", [0.15, 0.035, 0.32], { p: [0, -0.02, 0.2], c: dust });
  jaw.box("metal", [0.04, 0.02, 0.2], { p: [0, -0.045, 0.22], c: brass });
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) jaw.box("body", [0.016, 0.04, 0.02], { p: [s * 0.058, 0.03, 0.1 + i * 0.055], c: scaleColor(BONE, 0.9) });

  const earR = new Part(K), earL = new Part(K);
  earR.sph("body", [0.05, 7, 5], { p: [0, 0.3, 0], s: [1, 5.5, 0.25], c: dust });
  earR.sph("metal", [0.032, 7, 5], { p: [0, 0.3, 0.015], s: [1, 5.2, 0.2], c: brass });
  if (!v.noEarL) {
    // cracked ear plate: stub + kinked, hanging upper half with a visible gap
    earL.sph("body", [0.05, 7, 5], { p: [0, 0.14, 0], s: [1, 2.6, 0.25], c: dust });
    earL.sph("metal", [0.034, 6, 4], { p: [0.05, 0.36, 0.01], s: [1, 3.4, 0.2], r: [0, 0, 1.1], c: brass });
    earL.box("metal", [0.03, 0.04, 0.012], { p: [0.01, 0.29, 0.01], r: [0, 0, 0.6], c: dark });
  }
  const noArm = !!v.noForeL;
  const aL = arm(K, { side: -1, sleeveC: felt, jointC: brass });
  const aR = arm(K, { side: 1, sleeveC: felt, jointC: brass, bare: true });
  if (noArm) aL.fore.items = aL.fore.items.slice(0, 1); // snapped off at the elbow
  for (const [A, bare] of [[aL, noArm], [aR, false]]) {
    if (bare) {
      A.fore.cyl("metal", [0.012, 0.004, 0.18, 4], { p: [0, -0.1, 0], r: [0.3, 0, 0.5], c: 0x8a8070 }); // sheared rod
      continue;
    }
    A.fore.sph("body", [0.05, 7, 5], { p: [0, -0.48, 0], c: dust });
    fingers(A.fore, "metal", 3, { len: 0.12, r: 0.011, y: -0.5, c: brass });
  }

  return {
    id: v.id || "bellwether", headScale: 1.3, hipY: 1.0, headTop: 2.15, jawMax: 0.8,
    eye: { color: 0xffd37a, base: 0.35, glow: 1.7 },
    wear: v.wear,
    legs, body,
    head: { pos: [0, 0.95, 0.02], part: head }, jaw: { pos: [0, -0.06, 0.08], part: jaw },
    arms: { L: { pos: [-0.34, 0.7, 0], upper: aL.upper, elbow: [0, -0.46, 0], fore: aL.fore }, R: { pos: [0.34, 0.7, 0], upper: aR.upper, elbow: [0, -0.46, 0], fore: aR.fore } },
    extras: [
      { name: "earR", parent: "head", pos: [0.08, 0.25, -0.02], rot: [0, 0, -0.12], part: earR, anim: (o, t, c, b, tw) => { o.rotation.z = b.z + Math.sin(t * 0.8) * 0.02 - tw * 0.6 - c.ear * 0.3; } },
      { name: "earL", parent: "head", pos: [-0.08, 0.25, -0.02], rot: [0, 0, 0.3], part: earL, anim: (o, t, c, b, tw) => { o.rotation.z = b.z + Math.sin(t * 0.6 + 1) * 0.03 + tw * 0.5; } },
    ],
    jawBias: { roll: 0, yaw: 0 },
    poses: {
      idle: { aL: [0.02, 0.12, 0.1], aR: [0.02, 0.12, 0.1], hp: 0.08 },
      stare: { hp: 0.04 },
    },
  };
}

// ---------------------------------------------------------------------------
// LARK — lanky bird automaton with bib, crooked beak hinge, creepy tray
// ---------------------------------------------------------------------------

export function larkSpec(K, v = {}) {
  const mustard = 0xa8913e, cream = 0xcfc3a0, red = 0x8a2a2a, beakC = 0xb06a1c, dark = 0x2a2620;
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("metal", [0.035, 0.03, 0.48, 6], { p: [0, -0.24, 0], c: 0x6e6a58 });
    sh.sph("metal", [0.045, 6, 5], { c: 0x8a7a4a });
    sh.cyl("metal", [0.028, 0.02, 0.46, 6], { p: [0, -0.23, 0], c: 0x6e6a58 });
    for (let i = -1; i <= 1; i++) sh.cyl("metal", [0.012, 0.018, 0.2, 4], { p: [i * 0.045, -0.47, 0.09], r: [Math.PI / 2 - 0.1, 0, -i * 0.3], c: 0x7a6a30 });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.09, 0.95, 0], thigh: th, knee: [0, -0.48, 0], shin: sh };
  }
  const body = new Part(K);
  body.sph("body", [0.2, 12, 9], { p: [0, 0.3, 0], s: [1, 1.35, 0.9], c: mustard });
  body.box("body", [0.27, 0.32, 0.025], { p: [0, 0.3, 0.18], r: [-0.12, 0, 0], c: cream }); // bib
  body.box("body", [0.1, 0.12, 0.012], { p: [0.05, 0.2, 0.195], r: [-0.12, 0, 0.1], c: 0x6d1d1d }); // stain
  body.box("body", [0.05, 0.06, 0.01], { p: [-0.07, 0.4, 0.19], r: [-0.12, 0, -0.3], c: 0x8a7a50 });
  body.tor("metal", [0.18, 0.012, 4, 12], { p: [0, 0.08, 0], r: [Math.PI / 2, 0, 0], c: 0x7a6a30 });
  // wing stubs / loose seam on the left
  body.box("body", [0.03, 0.34, 0.12], { p: [-0.2, 0.3, -0.02], r: [0, 0, 0.1], c: 0x806c2c });
  body.box("metal", [0.02, 0.18, 0.02], { p: [-0.12, 0.34, 0.16], r: [0, 0, 0.3], c: 0x9a9080 }); // exposed rod
  // long neck (segmented, slight S-curve)
  for (let i = 0; i < 4; i++) {
    body.cyl(i % 2 ? "metal" : "body", [0.034, 0.038, 0.17, 7], { p: [0, 0.6 + i * 0.15, i * 0.02 - (i === 3 ? 0.02 : 0)], r: [-0.08, 0, 0], c: i % 2 ? 0x7a6a30 : mustard });
  }

  const head = new Part(K);
  head.sph("body", [0.13, 11, 8], { p: [0, 0.1, 0], s: [0.9, 1, 1.05], c: mustard });
  head.sph("body", [0.058, 8, 6], { p: [-0.075, 0.13, 0.09], s: [1, 1.1, 0.6], c: SOCKET });
  head.sph("eye", [0.02, 6, 5], { p: [-0.075, 0.13, 0.105] });
  // sagging right socket: larger, lower, with no true pupil position
  head.sph("body", [0.068, 8, 6], { p: [0.075, 0.07, 0.085], s: [1, 1.3, 0.6], c: SOCKET });
  head.sph("eye", [0.03, 6, 5], { p: [0.075, 0.04, 0.1] });
  head.cone("metal", [0.065, 0.26, 6], { p: [0, 0.04, 0.2], r: [Math.PI / 2, 0, 0], s: [1, 1, 0.55], c: beakC });
  head.teeth(5, { x0: -0.035, x1: 0.035, y: 0.0, z: 0.17, w: 0.012, h: 0.03, c: BONE });
  for (let i = 0; i < 3; i++) head.cone("body", [0.016, 0.28 - i * 0.05, 4], { p: [(i - 1) * 0.04, 0.3, -0.02], r: [0.15 * (i - 1), 0, -0.4 * (i - 1)], c: red });
  const jaw = new Part(K);
  jaw.cone("metal", [0.05, 0.22, 6], { p: [0, -0.01, 0.12], r: [Math.PI / 2, 0, 0], s: [1, 1, 0.5], c: scaleColor(beakC, 0.85) });
  jaw.teeth(5, { x0: -0.03, x1: 0.03, y: 0.0, z: 0.14, w: 0.011, h: 0.028, dir: 1, c: BONE });

  // tray on the right forearm (local +Z is world-up when the arm is held forward)
  const tray = new Part(K);
  tray.cyl("metal", [0.18, 0.18, 0.015, 12], { p: [0, 0, 0], r: [Math.PI / 2, 0, 0], c: 0x8e8f90 });
  tray.cyl("metal", [0.19, 0.19, 0.008, 12], { p: [0, 0, -0.006], r: [Math.PI / 2, 0, 0], c: 0x5e5a50 });
  tray.hemi("metal", [0.12, 10, 5], { p: [0, 0, 0.012], r: [Math.PI / 2, 0, 0.0], c: 0x9a9a98 });
  // cloche lid is propped ajar: gap showing teeth and an eye
  tray.box("body", [0.2, 0.02, 0.02], { p: [0, 0.03, 0.02], c: SOCKET });
  tray.teeth(8, { x0: -0.09, x1: 0.09, y: 0.0, z: 0.0, w: 0.016, h: 0.03, dir: 1, c: BONE });
  for (let i = 0; i < 8; i++) tray.box("body", [0.016, 0.03, 0.016], { p: [(i - 3.5) * 0.024, 0.045, 0.04], c: BONE });
  tray.sph("eye", [0.018, 6, 5], { p: [0.02, 0.1, 0.03] });

  const aL = arm(K, { side: -1, upperLen: 0.5, foreLen: 0.5, r: 0.03, sleeveC: mustard, jointC: 0x7a6a30 });
  const aR = arm(K, { side: 1, upperLen: 0.5, foreLen: 0.5, r: 0.03, sleeveC: mustard, jointC: 0x7a6a30 });
  for (const A of [aL, aR]) {
    A.fore.sph("body", [0.035, 6, 5], { p: [0, -0.52, 0], c: dark });
    fingers(A.fore, "metal", 4, { len: 0.15, r: 0.008, y: -0.54, spread: 0.28, c: 0x6e6a58 });
  }

  const hold = { aR: [1.1, 0.15, 0.5] };
  return {
    id: v.id || "lark", headScale: 1.25, hipY: 0.95, headTop: 2.0, jawMax: 0.6,
    eye: { color: 0xffe9a0, base: 0.35, glow: 1.6 },
    wear: v.wear,
    legs, body,
    head: { pos: [0, 1.1, 0.07], part: head }, jaw: { pos: [0, -0.07, 0.04], part: v.noJaw ? new Part(K) : jaw },
    arms: { L: { pos: [-0.22, 0.52, 0], upper: aL.upper, elbow: [0, -0.5, 0], fore: aL.fore }, R: { pos: [0.22, 0.52, 0], upper: aR.upper, elbow: [0, -0.5, 0], fore: aR.fore } },
    extras: [{ name: "tray", parent: "foreR", pos: [0, -0.54, 0], part: v.noTray ? new Part(K) : tray, anim: (o, t) => { o.rotation.z = Math.sin(t * 1.3) * 0.03; } }],
    jawBias: { roll: 0.25, yaw: 0.2 }, // loose, crooked beak hinge
    poses: {
      idle: { ...hold, aL: [0.03, 0.14, 0.1], hp: 0.15, hr: 0.18 },
      stare: { ...hold, hr: 0.1, hp: 0.05 },
      peek: { hr: -0.35 },
      lean: { aR: [1.1, 0.15, 0.5], aL: [0.7, 0.3, 0.3], lean: 0.55 },
      jumpscare: { aR: [1.6, 0.4, 0.2], aL: [1.5, 0.6, 0.2] },
    },
  };
}

// ---------------------------------------------------------------------------
// RATCHET — hunched wiry runner; curtain stages 0..3 + sprint
// ---------------------------------------------------------------------------

export function ratchetSpec(K, v = {}) {
  const steel = 0x3a332e, rust = 0x6a4a30, tatter = 0x6a3a5c;
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("metal", [0.04, 0.03, 0.46, 6], { p: [0, -0.23, 0], c: steel });
    th.cyl("metal", [0.012, 0.012, 0.4, 4], { p: [0.04, -0.23, 0.03], c: rust });
    sh.sph("metal", [0.045, 6, 5], { c: rust });
    sh.cyl("metal", [0.03, 0.02, 0.44, 6], { p: [0, -0.22, 0], c: steel });
    for (let i = -1; i <= 1; i++) sh.cone("metal", [0.012, 0.16, 4], { p: [i * 0.04, -0.44, 0.1], r: [Math.PI / 2 + 0.1, 0, 0], c: rust });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.1, 0.85, 0], thigh: th, knee: [0, -0.46, 0], shin: sh };
  }
  const body = new Part(K);
  body.cyl("metal", [0.12, 0.1, 0.12, 7], { p: [0, 0.04, 0], c: rust });
  for (let i = 0; i < 6; i++) body.sph("metal", [0.028, 5, 4], { p: [0, 0.12 + i * 0.1, -0.06], c: steel }); // spine
  body.cyl("metal", [0.012, 0.012, 0.62, 5], { p: [0, 0.4, -0.06], c: 0x8a8070 });
  for (let i = 0; i < 6; i++) {
    const y = 0.16 + i * 0.09;
    const rad = 0.14 - Math.abs(i - 2.5) * 0.012;
    // ribs: left side partly missing (asymmetric damage)
    body.tor("metal", [rad, 0.011, 4, 8, Math.PI * (i > 3 ? 0.9 : 1.1)], { p: [0, y, -0.02], r: [Math.PI / 2, 0, -Math.PI * 0.05 + (i > 3 ? Math.PI * 0.55 : Math.PI * 0.45) ], c: steel });
  }
  body.cyl("metal", [0.035, 0.035, 0.08, 6], { p: [0.0, 0.3, 0.06], r: [Math.PI / 2, 0, 0], c: rust }); // exposed motor
  for (let i = 0; i < 5; i++) {
    body.box("body", [0.05 + (i % 2) * 0.03, 0.2 + (i % 3) * 0.05, 0.008], { p: [-0.13 + i * 0.065, 0.0, 0.06 - (i % 2) * 0.1], r: [0.2 * (i % 2 ? 1 : -1), 0, 0.1 * (i - 2)], c: tatter });
  }
  body.cyl("metal", [0.04, 0.05, 0.14, 7], { p: [0, 0.62, 0.02], c: steel });

  const head = new Part(K);
  head.sph("metal", [0.15, 11, 8], { p: [0, 0.1, 0], s: [0.9, 1, 1.1], c: steel });
  // missing faceplate: left half of the face is an open recess with gears
  head.sph("body", [0.1, 9, 6], { p: [-0.07, 0.07, 0.1], s: [1, 1.15, 0.7], c: SOCKET });
  head.cyl("metal", [0.04, 0.04, 0.012, 8], { p: [-0.07, 0.04, 0.14], r: [Math.PI / 2, 0, 0], c: rust });
  head.cyl("metal", [0.025, 0.025, 0.012, 7], { p: [-0.1, 0.11, 0.15], r: [Math.PI / 2, 0, 0], c: 0x8a8070 });
  head.cyl("metal", [0.007, 0.007, 0.16, 4], { p: [-0.03, 0.0, 0.16], r: [1.2, 0.2, 0.4], c: 0x9a6a30 }); // loose wire
  head.sph("body", [0.055, 8, 6], { p: [0.075, 0.12, 0.12], s: [1, 1.2, 0.6], c: SOCKET });
  head.sph("eye", [0.032, 7, 5], { p: [0.075, 0.12, 0.14] });
  head.box("metal", [0.1, 0.016, 0.04], { p: [0.075, 0.2, 0.13], r: [0, 0, 0.45], c: rust });
  head.teeth(9, { x0: -0.085, x1: 0.085, y: -0.015, z: 0.16, w: 0.02, h: 0.06, pointed: true, c: BONE });
  head.box("metal", [0.12, 0.02, 0.02], { p: [0, -0.012, 0.15], c: steel });
  const jaw = new Part(K);
  jaw.box("metal", [0.14, 0.03, 0.2], { p: [0, -0.02, 0.1], c: steel });
  jaw.teeth(8, { x0: -0.06, x1: 0.06, y: 0.0, z: 0.17, w: 0.018, h: 0.05, dir: 1, pointed: true, c: BONE });

  const aL = arm(K, { side: -1, upperLen: 0.42, foreLen: 0.5, r: 0.035, sleeve: "metal", sleeveC: steel, jointC: rust, bare: true });
  const aR = arm(K, { side: 1, upperLen: 0.44, foreLen: 0.52, r: 0.032, sleeve: "metal", sleeveC: steel, jointC: rust, bare: true });
  // hook hand (left)
  aL.fore.cyl("metal", [0.03, 0.025, 0.08, 6], { p: [0, -0.52, 0], c: rust });
  aL.fore.tor("metal", [0.11, 0.018, 5, 12, Math.PI * 1.35], { p: [0, -0.62, 0.0], r: [0, Math.PI / 2, 0.3], c: 0x8a8a8a });
  aL.fore.cone("metal", [0.02, 0.07, 5], { p: [0, -0.54, 0.1], r: [-2.6, 0, 0], c: 0x9a9a9a });
  // clawed right hand
  aR.fore.sph("metal", [0.04, 6, 5], { p: [0, -0.54, 0], c: rust });
  fingers(aR.fore, "metal", 3, { len: 0.24, r: 0.011, y: -0.56, spread: 0.45, c: 0x6a6258, curl: 0.8 });

  return {
    id: v.id || "ratchet", headScale: 1.2, hipY: 0.85, headTop: 1.5, jawMax: 0.9, tau: 0.3,
    eye: { color: 0xff6a3a, base: 0.0, glow: 2.0 },
    wear: v.wear,
    legs, body,
    head: { pos: [0, 0.7, 0.05], part: head }, jaw: { pos: [0, -0.05, 0.03], part: jaw },
    arms: { L: { pos: [-0.2, 0.58, 0], upper: aL.upper, elbow: [0, -0.42, 0], fore: aL.fore }, R: { pos: [0.2, 0.58, 0], upper: aR.upper, elbow: [0, -0.44, 0], fore: aR.fore } },
    extras: [],
    base: { lean: 0.55, hp: -0.3 },
    poses: {
      idle: { lean: 0.6, hp: -0.1, drop: 0.02, aL: [0.2, 0.15, 0.3], aR: [0.2, 0.15, 0.3] },
      stare: { lean: 0.5, hp: -0.25, jaw: 0.25 },
      peek: { lean: 0.55 },
      lean: { lean: 0.9, hp: -0.4, drop: 0.05 },
      jumpscare: { lean: 0.85, hp: -0.4, crouch: 0.2, aL: [1.5, 0.6, 0.2], aR: [1.6, 0.8, 0.1] },
      // curtain stages: distinct silhouette per stage
      stage0: { lean: 1.0, hp: 0.65, drop: 0.38, crouch: 0.3, look: 0, eye: 0.15, jaw: 0.04, aL: [0.2, 0.1, 1.2], aR: [0.15, 0.1, 1.3] },
      stage1: { lean: 0.9, hp: 0.2, drop: 0.3, crouch: 0.25, look: 1, eye: 0.8, jaw: 0.15, hr: 0.2, aL: [0.2, 0.1, 1.1], aR: [0.95, 0.35, 0.8] },
      stage2: { lean: 0.7, hp: -0.1, drop: 0.15, crouch: 0.15, rz: 0.15, look: 1, eye: 1.3, jaw: 0.5, hr: 0.38, aL: [1.0, 0.3, 0.5], aR: [1.05, 0.3, 0.5] },
      stage3: { lean: 0.4, hp: -0.2, drop: 0.02, rz: 0.32, look: 1, eye: 1.9, jaw: 0.7, hr: -0.15, aL: [1.25, 0.6, 0.3], aR: [1.3, 0.6, 0.3] },
      run: { lean: 0.95, hp: -0.45, jaw: 0.6, look: 0.5, eye: 1.7, gait: 1, aL: [0.3, 0.1, 0.6], aR: [0.3, 0.1, 0.6] },
    },
    api: (api) => ({ setStage: (n) => api.setPose("stage" + clamp(Math.round(n) || 0, 0, 3)) }),
  };
}

// ---------------------------------------------------------------------------
// MAESTRO — large top-hat conductor, enamel face, eyes that go black and glow
// ---------------------------------------------------------------------------

export function maestroSpec(K, v = {}) {
  const coat = 0x222a3d, enamel = 0xcac2ae, blood = 0x6a1414, felt = 0x121212, brass = 0x8a7040;
  const legs = {};
  for (const s of [-1, 1]) {
    const th = new Part(K), sh = new Part(K);
    th.cyl("body", [0.09, 0.075, 0.5, 8], { p: [0, -0.25, 0], c: 0x1b1f2a });
    sh.sph("metal", [0.07, 6, 5], { c: brass });
    sh.cyl("body", [0.07, 0.06, 0.46, 8], { p: [0, -0.23, 0], c: 0x1b1f2a });
    sh.box("body", [0.14, 0.06, 0.3], { p: [0, -0.48, 0.07], c: 0x0d0d0d });
    legs[s < 0 ? "L" : "R"] = { pos: [s * 0.13, 1.0, 0], thigh: th, knee: [0, -0.5, 0], shin: sh };
  }
  const body = new Part(K);
  body.cyl("body", [0.3, 0.26, 0.72, 12], { p: [0, 0.42, 0], c: coat });
  body.box("body", [0.17, 0.52, 0.02], { p: [0, 0.5, 0.275], r: [-0.08, 0, 0], c: 0xcfc8b4 }); // shirt
  body.box("body", [0.07, 0.4, 0.02], { p: [-0.14, 0.5, 0.27], r: [0, 0.2, 0.12], c: 0x15171f });
  body.box("body", [0.07, 0.4, 0.02], { p: [0.14, 0.5, 0.27], r: [0, -0.2, -0.12], c: 0x15171f });
  body.cone("body", [0.07, 0.14, 4], { p: [-0.07, 0.8, 0.27], r: [0, 0, Math.PI / 2], c: blood });
  body.cone("body", [0.07, 0.14, 4], { p: [0.07, 0.8, 0.27], r: [0, 0, -Math.PI / 2], c: blood });
  body.sph("body", [0.03, 6, 4], { p: [0, 0.8, 0.28], c: scaleColor(blood, 0.8) });
  for (let i = 0; i < 3; i++) body.sph("metal", [0.018, 5, 4], { p: [0.05, 0.62 - i * 0.14, 0.29], c: brass });
  for (const s of [-1, 1]) {
    body.sph("body", [0.14, 8, 6], { p: [s * 0.37, 0.75, 0], s: [1, 0.8, 1], c: coat });
    body.sph("metal", [0.05, 6, 4], { p: [s * 0.4, 0.82, 0], s: [1, 0.5, 1], c: brass });
    body.box("body", [0.2, 0.62, 0.04], { p: [s * 0.1, -0.12, -0.27], r: [0.28, 0, s * 0.06], c: scaleColor(coat, 0.85) });
  }
  // bare torn patch at the left hip showing endoskeleton
  body.box("body", [0.08, 0.14, 0.05], { p: [-0.26, 0.15, 0.1], r: [0, 0.6, 0], c: SOCKET });
  body.cyl("metal", [0.012, 0.012, 0.16, 5], { p: [-0.25, 0.15, 0.13], r: [0, 0, 0.4], c: 0x8a8070 });
  body.cyl("body", [0.07, 0.09, 0.14, 8], { p: [0, 0.86, 0], c: 0x15171f });

  const head = new Part(K);
  head.sph("body", [0.2, 12, 9], { p: [0, 0.2, 0], s: [1.05, 1.15, 1], c: enamel });
  for (const [x, y, a] of [[-0.05, 0.37, 0.7], [0.08, 0.34, -0.5], [0.12, 0.08, 0.3]]) head.box("body", [0.008, 0.1, 0.01], { p: [x, y, 0.15], r: [0, 0, a], c: 0x3a322a }); // cracks
  for (const s of [-1, 1]) {
    head.sph("body", [0.078, 9, 6], { p: [s * 0.09, 0.24, 0.15], s: [1, 1.18, 0.6], c: SOCKET });
    head.sph("eye", [0.04, 7, 5], { p: [s * 0.09, 0.24, 0.165] });
    head.box("body", [0.12, 0.022, 0.05], { p: [s * 0.09, 0.33, 0.16], r: [0, 0, s * 0.3], c: 0x1a1612 });
    head.box("body", [0.008, 0.14, 0.012], { p: [s * 0.175, 0.03, 0.09], c: 0x2a241e }); // jaw hinge seam
  }
  head.cone("body", [0.025, 0.06, 3], { p: [0, 0.15, 0.2], r: [Math.PI / 2, 0, 0], c: 0x2a241e });
  head.teeth(10, { x0: -0.11, x1: 0.11, y: 0.01, z: 0.165, w: 0.022, h: 0.05, curve: 1.6, c: BONE });
  if (!v.noHat) {
    head.cyl("body", [0.31, 0.31, 0.022, 14], { p: [0, 0.38, 0], r: [0, 0, 0.05], c: felt });
    head.cyl("body", [0.2, 0.225, 0.4, 12], { p: [0.01, 0.6, 0], r: [0, 0, 0.05], c: felt });
    head.cyl("body", [0.226, 0.228, 0.07, 12], { p: [0, 0.43, 0], r: [0, 0, 0.05], c: blood });
    head.sph("body", [0.1, 8, 5], { p: [-0.1, 0.81, 0.02], s: [1, 0.35, 1], c: 0x050505 }); // crushed dent
  } else {
    head.box("body", [0.12, 0.1, 0.2], { p: [0.05, 0.4, -0.02], r: [0, 0.3, 0.4], c: SOCKET }); // cracked-open skull
    head.cyl("metal", [0.008, 0.008, 0.18, 4], { p: [-0.05, 0.46, 0], r: [0, 0, 0.5], c: 0x8a8070 });
  }
  const jaw = new Part(K);
  jaw.box("body", [0.27, 0.075, 0.2], { p: [0, -0.04, 0.1], c: enamel });
  jaw.teeth(9, { x0: -0.1, x1: 0.1, y: 0.0, z: 0.185, w: 0.02, h: 0.045, dir: 1, curve: 1.6, c: BONE });

  const mk = (side) => arm(K, { side, upperLen: 0.5, foreLen: 0.46, r: 0.06, sleeveC: coat, jointC: brass });
  const aL = mk(-1), aR = mk(1);
  for (const A of [aL, aR]) {
    A.fore.cyl("body", [0.066, 0.066, 0.06, 8], { p: [0, -0.4, 0], c: 0xcfc8b4 }); // cuff
    A.fore.sph("body", [0.06, 7, 5], { p: [0, -0.5, 0], c: 0xb0a890 });
    fingers(A.fore, "metal", 4, { len: 0.12, r: 0.014, y: -0.52, spread: 0.3, c: 0x9a9080 });
  }
  aR.fore.cyl("metal", [0.007, 0.01, 0.55, 5], { p: [0.0, -0.78, 0.0], r: [0, 0, 0], c: 0xd0d0c0 }); // baton

  return {
    id: v.id || "maestro", headScale: 1.15, hipY: 1.0, headTop: 2.2, jawMax: 0.7,
    eye: { color: 0xe8f0ff, base: 0.05, glow: 2.2 },
    wear: v.wear,
    legs, body,
    head: { pos: [0, 0.92, 0.02], part: head }, jaw: { pos: [0, 0.02, 0.02], part: jaw },
    arms: { L: { pos: [-0.42, 0.74, 0], upper: aL.upper, elbow: [0, -0.5, 0], fore: aL.fore }, R: { pos: [0.42, 0.74, 0], upper: aR.upper, elbow: [0, -0.5, 0], fore: aR.fore } },
    extras: [],
    poses: {
      idle: { aR: [0.7, 0.35, 1.0], aL: [0.05, 0.25, 0.2], conduct: 1, eye: 0.05, hp: 0.05 },
      stare: { aR: [0.7, 0.35, 1.0], conduct: 0.4, eye: 0.15 },
      peek: { aR: [0.5, 1.2, 0.6] },
      lean: { aR: [1.3, 0.2, 0.3], aL: [1.2, 0.2, 0.3], eye: 0.3 },
      jumpscare: { aR: [1.7, 0.5, 0.1], aL: [1.6, 0.7, 0.1] },
    },
  };
}

// Distinct horror guests share the articulated rig, but have their own sculpted heads.
function horrorGuestSpec(K, id) {
  const clown = id === "pennywise";
  const spec = maestroSpec(K, {id, noHat:true});
  const head = new Part(K), jaw = new Part(K);
  const skin = clown ? 0xe0d5bd : 0xa6a899;
  head.sph("body",[.22,16,12],{p:[0,.21,0],s:[1.15,clown?1.35:1.1,.85],c:skin});
  for(const side of [-1,1]) {
    head.sph("body",[.105,12,8],{p:[side*.115,.24,.13],s:[1,1.12,.65],c:0x161210});
    head.sph("body",[clown?.055:.085,12,8],{p:[side*.115,.24,.18],c:0xe4dfbd});
    head.sph("eye",[.022,8,6],{p:[side*.115,.24,.235]});
    head.box("body",[.13,.026,.035],{p:[side*.115,.34,.17],r:[0,0,side*.3],c:0x17100e});
    if(clown) {
      head.box("body",[.018,.24,.018],{p:[side*.12,.21,.215],r:[0,0,-side*.25],c:0x7c1712});
      head.sph("body",[.14,10,8],{p:[side*.24,.29,-.04],s:[.8,1.3,1],c:0x8f3214});
    } else {
      for(let i=0;i<7;i++) head.cyl("body",[.014,.005,.55+i*.025,5],{p:[side*(.19+i*.009),.1,-.04+i*.012],r:[0,0,side*(.04+i*.035)],c:0x171813});
    }
    head.box("body",[.13,.018,.025],{p:[side*.12,.07,.18],r:[0,0,side*.32],c:0x641e18});
  }
  head.sph("body",[clown?.045:.035,10,8],{p:[0,.17,.205],s:[1,clown?1:1.7,1],c:clown?0x9f241c:skin});
  head.sph("body",[.13,12,8],{p:[0,.045,.135],s:[1.35,.65,.4],c:0x170a09});
  head.teeth(13,{x0:-.15,x1:.15,y:.065,z:.19,w:.018,h:.045,curve:1.5,c:0xcfc09b});
  jaw.box("body",[.29,.06,.16],{p:[0,-.035,.08],c:skin});
  jaw.teeth(12,{x0:-.14,x1:.14,y:0,z:.17,w:.018,h:.045,dir:1,curve:1.5,c:0xcfc09b});
  if(clown) for(let i=0;i<12;i++) {
    const a=i*Math.PI*2/12;
    spec.body.sph("body",[.08,8,5],{p:[Math.cos(a)*.28,.84,Math.sin(a)*.23],s:[1,.5,1],c:0xc3b9a4});
  }
  spec.head={pos:[0,.92,.02],part:head}; spec.jaw={pos:[0,.02,.02],part:jaw};
  spec.headScale=1.15; spec.eye={color:clown?0xffb64c:0xdce8c5,base:.1,glow:2.2};
  return spec;
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

export const CHARACTER_IDS = Object.freeze(["bellwether", "lark", "ratchet", "maestro"]);
export const SPECS = { bellwether: bellwetherSpec, lark: larkSpec, ratchet: ratchetSpec, maestro: maestroSpec, momo: K => horrorGuestSpec(K,"momo"), pennywise: K => horrorGuestSpec(K,"pennywise") };

export function createCharacter(THREE, id, options = {}) {
  const make = SPECS[id];
  if (!make) throw new Error(`unknown character id: ${id}`);
  const K = makeKit(THREE);
  return buildCharacter(THREE, make(K, {}), options);
}

const DEFAULT_ROOMS = {
  bellwether: { x: -3.0, z: -4.8, yaw: 0 },
  lark: { x: -1.0, z: -4.8, yaw: 0 },
  ratchet: { x: 1.0, z: -4.8, yaw: 0 },
  maestro: { x: 3.0, z: -4.8, yaw: 0 },
};

/** Build all four. rooms: optional {id: {x,y,z,yaw}} placement overrides. */
export function createCharacters(THREE, scene, rooms = {}, options = {}) {
  const characters = {};
  for (const id of CHARACTER_IDS) {
    const r = { ...DEFAULT_ROOMS[id], ...(rooms[id] || {}) };
    const c = createCharacter(THREE, id, { ...options, position: { x: r.x, y: r.y ?? 0, z: r.z }, rotationY: r.yaw ?? 0 });
    if (scene) scene.add(c.group);
    characters[id] = c;
  }
  const list = Object.values(characters);
  return {
    characters,
    list,
    update(dt, time, state) {
      for (const c of list) c.update(dt, time, (state && state[c.id]) || state || {});
    },
    setBlackout(b) { for (const c of list) c.setBlackout(b); },
    dispose() { for (const c of list) c.dispose(); },
  };
}
