// Simple horror room: a square plaster chamber, four walls, one door per wall,
// one ceiling lamp. The player stands still at the origin looking toward -Z.
//
// Procedural only: geometry is built into a few merged BufferGeometries and
// canvas textures are painted at runtime (skipped where no canvas exists).
// Budget: ~15 draw calls, 2 real-time lights (ceiling point lamp + one spot
// that is moved to whichever door is glowing). Everything else is emissive
// or baked-look, so the room stays readable at low light.

import { paintWall, paintCeiling, paintFloor, paintWood, paintSheet, paintWetPool, paintBeam, paintWeb } from "./decor.mjs";

const HALF = 3.5; // room half-size (walls at +/-HALF)
const CEIL = 2.8; // ceiling height
const DOOR_W = 1.1;
const DOOR_H = 2.1;
const DOOR_HALF = DOOR_W / 2;
const JAMB = 0.08; // frame width around the opening
const FRAME_D = 0.05; // frame protrusion into the room
const SLAB_T = 0.05; // door slab thickness
const DOOR_TIME = 0.6; // seconds for a full open/close
const DOOR_SWING = 1.45; // radians (~83 degrees) at fully open
const LAMP_Y = 2.12; // bulb centre
const LAMP_MAX = 30; // candela at full light level
const HALL_MAX = 16; // spot intensity at full hall glow
const FLICKER_DIP = 0.22; // seconds per stutter dip (slow, never a strobe)

const SIDES = ["left", "right", "front", "back"];
// Yaw that maps the canonical "front" wall (z = -HALF, room on +Z side) onto
// each side. Door swing is the same +angle for every side in canonical space.
const SIDE_ANGLE = { front: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 };

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const smooth = (t) => t * t * (3 - 2 * t);

// Small deterministic PRNG so textures and flicker timing are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBuilder(THREE) {
  const pos = [];
  const nrm = [];
  const uvs = [];
  const idx = [];
  const DEFAULT_UV = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  let M = null; // optional transform applied to everything emitted after setMatrix
  const setMatrix = (m) => {
    M = m;
  };

  // Corners must be in cyclic order around the quad. Winding is fixed so the
  // front face points along n, whatever order the caller used.
  function quad(c, n, uv = DEFAULT_UV) {
    if (M) {
      c = c.map((p) => p.clone().applyMatrix4(M));
      n = n.clone().transformDirection(M);
    }
    const ab = c[1].clone().sub(c[0]);
    const ac = c[2].clone().sub(c[0]);
    const order = ab.cross(ac).dot(n) < 0 ? [0, 3, 2, 1] : [0, 1, 2, 3];
    const base = pos.length / 3;
    for (const k of order) {
      const p = c[k];
      pos.push(p.x, p.y, p.z);
      nrm.push(n.x, n.y, n.z);
      uvs.push(uv[k][0], uv[k][1]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Axis-aligned box from min [x,y,z] to max [x,y,z].
  function box(a, b) {
    const [x0, y0, z0] = a;
    const [x1, y1, z1] = b;
    quad([V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), V(x1, y0, z1)], V(1, 0, 0));
    quad([V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)], V(-1, 0, 0));
    quad([V(x0, y1, z0), V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0)], V(0, 1, 0));
    quad([V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)], V(0, -1, 0));
    quad([V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)], V(0, 0, 1));
    quad([V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0), V(x1, y0, z0)], V(0, 0, -1));
  }

  // Surface of revolution around a vertical axis at c. profile: [[r, y], ...].
  function lathe(profile, segs, c) {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const P = (a, r, y) => V(c[0] + r * Math.cos(a), c[1] + y, c[2] + r * Math.sin(a));
      for (let j = 0; j < profile.length - 1; j++) {
        const [r0, y0] = profile[j];
        const [r1, y1] = profile[j + 1];
        let nr = -(y1 - y0);
        let ny = r1 - r0;
        const len = Math.hypot(nr, ny) || 1;
        nr /= len;
        ny /= len;
        quad(
          [P(a0, r0, y0), P(a1, r0, y0), P(a1, r1, y1), P(a0, r1, y1)],
          V(nr * Math.cos(am), ny, nr * Math.sin(am)),
        );
      }
    }
  }

  function build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
  }

  return { quad, box, lathe, build, setMatrix, V, isEmpty: () => idx.length === 0 };
}


// Canvas painter wrapper. Returns a CanvasTexture, or null when no canvas exists (tests).
function paint(THREE, opts, w, h, painter, seed = w * 31 + h) {
  let canvas = null;
  if (typeof opts.createCanvas === "function") canvas = opts.createCanvas(w, h);
  else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  if (!ctx) return null;
  painter(ctx, w, h, rng(seed));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function poolPainter(ctx, w, h) {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, "rgba(255,200,120,1)");
  g.addColorStop(0.4, "rgba(255,170,80,0.7)");
  g.addColorStop(0.7, "rgba(255,150,70,0.25)");
  g.addColorStop(1, "rgba(255,140,60,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// Concatenate indexed geometries (position/normal/uv) into one.
function mergeGeos(THREE, list) {
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  let base = 0;
  for (const g of list) {
    const p = g.attributes.position;
    pos.push(...p.array);
    nrm.push(...g.attributes.normal.array);
    uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(i + base);
    base += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

/**
 * Build the simple room into `scene`.
 * @param {typeof import("three")} THREE  Three.js namespace (injected)
 * @param {THREE.Scene} scene
 * @param {{createCanvas?: (w:number,h:number)=>HTMLCanvasElement}} [opts]
 */
export function createSimpleRoom(THREE, scene, opts = {}) {
  if (!scene || typeof scene.add !== "function") throw new TypeError("scene is required");

  const group = new THREE.Group();
  group.name = "simple-room";
  const geometries = [];
  const materials = [];
  const textures = [];
  let disposed = false;
  function keepGeo(g) {
    geometries.push(g);
    return g;
  }

  // ----- shared textures and materials -----
  const keepTex = (t) => (t ? (textures.push(t), t) : null);
  // Wall UVs span the full 7 m x 2.8 m wall, so the texture keeps the same 2.5:1 aspect.
  const tealTex = keepTex(paint(THREE, opts, 2560, 1024, (c, w, h, r) => paintWall(c, w, h, r, "teal"), 101));
  const redTex = keepTex(paint(THREE, opts, 2560, 1024, (c, w, h, r) => paintWall(c, w, h, r, "red"), 202));
  const ceilTex = keepTex(paint(THREE, opts, 1024, 1024, paintCeiling, 303));
  const floorTex = keepTex(paint(THREE, opts, 1024, 1024, paintFloor, 404));
  const woodTex = keepTex(paint(THREE, opts, 256, 256, paintWood, 505));
  const sheetTex = keepTex(paint(THREE, opts, 256, 256, paintSheet, 606));
  const wetTex = keepTex(paint(THREE, opts, 256, 256, paintWetPool, 707));
  const poolTex = keepTex(paint(THREE, opts, 256, 256, poolPainter, 808));
  const beamTex = keepTex(paint(THREE, opts, 64, 256, paintBeam, 909));
  const webTex = keepTex(paint(THREE, opts, 256, 256, paintWeb, 1001));
  const mat = (m) => (materials.push(m), m);

  // Walls, floor and props carry their own map as emissive so the room stays
  // readable at every light level; setLight() scales the emissive gain.
  const lit = (map, extra = {}) => mat(new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.95, metalness: 0, ...extra }));
  const wallMat = lit(tealTex);
  const wallRedMat = lit(redTex);
  const ceilingMat = lit(ceilTex);
  const floorMat = lit(floorTex, { roughness: 0.75 });
  const furnMat = lit(woodTex, { color: 0x6e6054, roughness: 0.8 });
  const sheetMat = lit(sheetTex, { color: 0x8a7a6c, roughness: 0.9 });
  const emissiveMats = [
    [wallMat, 0.48, 0.3],
    [wallRedMat, 0.48, 0.3],
    [ceilingMat, 0.26, 0.14],
    [floorMat, 0.42, 0.28],
    [furnMat, 0.36, 0.2],
    [sheetMat, 0.42, 0.2],
  ];
  const metalMat = mat(new THREE.MeshStandardMaterial({ color: 0x5a5e5a, emissive: 0x1c201e, roughness: 0.5, metalness: 0.5 }));
  const cableMat = mat(new THREE.MeshStandardMaterial({ color: 0x151515, emissive: 0x0a0a0a, roughness: 0.6 }));
  const trimMat = mat(new THREE.MeshStandardMaterial({ color: 0x3a2e22, emissive: 0x1a130c, roughness: 0.7 }));
  const doorMat = mat(new THREE.MeshStandardMaterial({ map: woodTex, color: 0xa08068, emissive: 0x20140c, roughness: 0.6 }));
  const brassMat = mat(new THREE.MeshStandardMaterial({ color: 0x8a6a2e, metalness: 0.7, roughness: 0.35, emissive: 0x221300 }));
  const voidMat = mat(new THREE.MeshBasicMaterial({ color: 0x000000 }));
  const shadeMat = mat(new THREE.MeshStandardMaterial({ color: 0x6a4a28, emissive: 0x3a2610, roughness: 0.9, side: THREE.DoubleSide }));
  const lampShadeMat = mat(new THREE.MeshStandardMaterial({ color: 0x8a6a40, emissive: 0xc07830, emissiveIntensity: 0.5, roughness: 0.9, side: THREE.DoubleSide }));
  const BULB_BASE = new THREE.Color(0xffe2a8);
  const bulbMat = mat(new THREE.MeshBasicMaterial({ color: BULB_BASE.clone() }));
  const poolMat = mat(new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, color: 0xffc080 }));
  const wetMat = mat(
    new THREE.MeshStandardMaterial({
      map: wetTex,
      emissiveMap: wetTex,
      emissive: 0x500606,
      color: wetTex ? 0xffffff : 0x7a0a0a,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const dropMat = mat(new THREE.MeshStandardMaterial({ color: 0x6a0808, emissive: 0x3a0404, roughness: 0.15 }));
  const rippleMat = mat(new THREE.MeshBasicMaterial({ color: 0x9a1212, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const webMat = mat(new THREE.MeshBasicMaterial({ map: webTex, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, color: 0xc4ccc4 }));
  const windowMat = mat(new THREE.MeshBasicMaterial({ color: 0xb4d0e2 }));
  const beamMat = mat(
    new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, color: 0xffffff }),
  );

  // ----- geometry -----
  const rotY = {};
  for (const side of SIDES) rotY[side] = new THREE.Matrix4().makeRotationY(SIDE_ANGLE[side]);
  // Canonical (front-wall) space: s along the wall, y up, d = depth into the room.
  const wp = (side, s, y, d) => new THREE.Vector3(s, y, -HALF + d).applyMatrix4(rotY[side]);
  const wn = (side) => new THREE.Vector3(0, 0, 1).applyMatrix4(rotY[side]);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  const RYm = (a) => new THREE.Matrix4().makeRotationY(a);
  const RXm = (a) => new THREE.Matrix4().makeRotationX(a);
  const RZm = (a) => new THREE.Matrix4().makeRotationZ(a);

  const sydBox = (builder, side, s0, s1, y0, y1, d0, d1) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const s of [s0, s1])
      for (const y of [y0, y1])
        for (const d of [d0, d1]) {
          const p = wp(side, s, y, d);
          const a = [p.x, p.y, p.z];
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], a[k]);
            max[k] = Math.max(max[k], a[k]);
          }
        }
    builder.box(min, max);
  };
  // Box in a local frame transformed by matrix m.
  const tbox = (builder, m, a, b) => {
    builder.setMatrix(m);
    builder.box(a, b);
    builder.setMatrix(null);
  };

  const wallB = makeBuilder(THREE);
  const wallRB = makeBuilder(THREE);
  const voidB = makeBuilder(THREE);
  const trimB = makeBuilder(THREE);
  const uvFor = (s, y) => [(s + HALF) / (2 * HALF), y / CEIL];
  const wallQuad = (b, side, s0, s1, y0, y1) =>
    b.quad(
      [wp(side, s0, y0, 0), wp(side, s1, y0, 0), wp(side, s1, y1, 0), wp(side, s0, y1, 0)],
      wn(side),
      [uvFor(s0, y0), uvFor(s1, y0), uvFor(s1, y1), uvFor(s0, y1)],
    );

  for (const side of SIDES) {
    const wb = side === "left" || side === "right" ? wallRB : wallB;
    wallQuad(wb, side, -HALF, -DOOR_HALF, 0, CEIL);
    wallQuad(wb, side, DOOR_HALF, HALF, 0, CEIL);
    wallQuad(wb, side, -DOOR_HALF, DOOR_HALF, DOOR_H, CEIL);
    voidB.quad(
      [wp(side, -DOOR_HALF, 0, -0.6), wp(side, DOOR_HALF, 0, -0.6), wp(side, DOOR_HALF, DOOR_H, -0.6), wp(side, -DOOR_HALF, DOOR_H, -0.6)],
      wn(side),
    );
    sydBox(trimB, side, -HALF, -DOOR_HALF - JAMB, 0, 0.12, 0, 0.025);
    sydBox(trimB, side, DOOR_HALF + JAMB, HALF, 0, 0.12, 0, 0.025);
    sydBox(trimB, side, -HALF, HALF, CEIL - 0.12, CEIL, 0, 0.08);
    sydBox(trimB, side, -DOOR_HALF - JAMB, -DOOR_HALF, 0, DOOR_H + JAMB, 0, FRAME_D);
    sydBox(trimB, side, DOOR_HALF, DOOR_HALF + JAMB, 0, DOOR_H + JAMB, 0, FRAME_D);
    sydBox(trimB, side, -DOOR_HALF - JAMB, DOOR_HALF + JAMB, DOOR_H, DOOR_H + JAMB, 0, FRAME_D);
  }

  const floorB = makeBuilder(THREE);
  const ceilB = makeBuilder(THREE);
  const flatUv = (p) => [(p.x + HALF) / (2 * HALF), (p.z + HALF) / (2 * HALF)];
  const flatQuad = (builder, y, normalY) => {
    const c = [V(-HALF, y, -HALF), V(-HALF, y, HALF), V(HALF, y, HALF), V(HALF, y, -HALF)];
    builder.quad(c, V(0, normalY, 0), c.map(flatUv));
  };
  flatQuad(floorB, 0, 1);
  flatQuad(ceilB, CEIL, -1);

  // Ceiling lamp.
  const cordB = makeBuilder(THREE);
  cordB.box([-0.008, CEIL - 0.36, -0.008], [0.008, CEIL, 0.008]);
  const shadeB = makeBuilder(THREE);
  shadeB.lathe([[0.11, CEIL - 0.34], [0.3, CEIL - 0.58]], 24, [0, 0, 0]);
  const bulbB = makeBuilder(THREE);
  const BULB_R = 0.07;
  const bulbProfile = [];
  for (let i = 0; i <= 8; i++) {
    const phi = (i / 8) * Math.PI;
    bulbProfile.push([BULB_R * Math.sin(phi), LAMP_Y + BULB_R * Math.cos(phi)]);
  }
  bulbB.lathe(bulbProfile, 12, [0, 0, 0]);
  const poolB = makeBuilder(THREE);
  const POOL_R = 3.0;
  poolB.quad(
    [V(-POOL_R, 0.012, -POOL_R), V(-POOL_R, 0.012, POOL_R), V(POOL_R, 0.012, POOL_R), V(POOL_R, 0.012, -POOL_R)],
    V(0, 1, 0),
    [[0, 0], [0, 1], [1, 1], [1, 0]],
  );

  // Doors: pivot at the left edge, slab and handle.
  const doors = {};
  for (const side of SIDES) {
    const pivot = new THREE.Group();
    pivot.name = `door-${side}`;
    pivot.position.copy(wp(side, -DOOR_HALF, 0, SLAB_T / 2));
    pivot.rotation.y = SIDE_ANGLE[side];
    const slabB = makeBuilder(THREE);
    slabB.box([0, 0, -SLAB_T / 2], [DOOR_W, DOOR_H, SLAB_T / 2]);
    slabB.box([0.1, 1.2, SLAB_T / 2], [0.5, 1.9, SLAB_T / 2 + 0.01]);
    slabB.box([0.6, 1.2, SLAB_T / 2], [1.0, 1.9, SLAB_T / 2 + 0.01]);
    slabB.box([0.1, 0.15, SLAB_T / 2], [0.5, 1.0, SLAB_T / 2 + 0.01]);
    slabB.box([0.6, 0.15, SLAB_T / 2], [1.0, 1.0, SLAB_T / 2 + 0.01]);
    const handleB = makeBuilder(THREE);
    handleB.box([0.86, 0.95, SLAB_T / 2], [0.9, 1.0, SLAB_T / 2 + 0.025]);
    handleB.box([0.9, 0.97, SLAB_T / 2 + 0.025], [0.98, 0.98, SLAB_T / 2 + 0.06]);
    const slab = new THREE.Mesh(keepGeo(slabB.build()), doorMat);
    slab.name = `door-slab-${side}`;
    const handle = new THREE.Mesh(keepGeo(handleB.build()), brassMat);
    handle.name = `door-handle-${side}`;
    pivot.add(slab, handle);
    group.add(pivot);
    doors[side] = { side, pivot, value: 0, target: 0, dur: DOOR_TIME };
  }

  // ----- props (merged by material: a handful of draw calls) -----
  const furnB = makeBuilder(THREE);
  const sheetB = makeBuilder(THREE);
  const metalB = makeBuilder(THREE);
  const lampB = makeBuilder(THREE);

  // Ruined cabinet, front-left corner: carcass, shelves, one door hanging, one fallen.
  furnB.box([-3.4, 0, -3.45], [-2.3, 1.9, -3.43]);
  furnB.box([-3.4, 0, -3.45], [-3.37, 1.9, -2.95]);
  furnB.box([-2.33, 0, -3.45], [-2.3, 1.9, -2.95]);
  furnB.box([-3.42, 1.9, -3.47], [-2.28, 1.94, -2.93]);
  furnB.box([-3.4, 0, -3.45], [-2.3, 0.1, -2.95]);
  furnB.box([-2.86, 0.1, -3.43], [-2.84, 1.9, -2.96]);
  for (const y of [0.6, 1.1, 1.5]) furnB.box([-3.37, y, -3.43], [-2.33, y + 0.03, -2.97]);
  tbox(furnB, T(-3.4, 0, -2.95).multiply(RYm(-1.15)), [0, 0.1, -0.02], [0.54, 1.88, 0.02]);
  tbox(furnB, T(-1.9, 0.03, -2.55).multiply(RYm(0.5)), [-0.25, 0, -0.9], [0.25, 0.03, 0.9]);
  // Jars and bottles left on the cabinet shelves.
  for (let i = 0; i < 5; i++) metalB.lathe([[0.04, 0], [0.045, 0.14], [0.02, 0.19], [0.02, 0.24]], 8, [-3.25 + i * 0.2, 1.53, -3.2]);
  // Bed: head against the front wall at x ~2.2, frame and blood-soaked mattress.
  furnB.box([1.62, 0.3, -3.48], [2.78, 1.2, -3.43]); // headboard
  furnB.box([1.62, 0.3, -1.55], [2.78, 0.8, -1.5]); // footboard
  furnB.box([1.62, 0.28, -3.43], [1.67, 0.4, -1.55]);
  furnB.box([2.73, 0.28, -3.43], [2.78, 0.4, -1.55]);
  for (const [x, z] of [[1.62, -3.48], [2.74, -3.48], [1.62, -1.55], [2.74, -1.55]]) furnB.box([x, 0, z], [x + 0.05, 0.3, z + 0.05]);
  sheetB.box([1.67, 0.4, -3.42], [2.73, 0.62, -1.58]); // mattress
  tbox(sheetB, T(2.0, 0.62, -3.15).multiply(RXm(-0.08)), [-0.2, 0, -0.17], [0.2, 0.1, 0.17]); // pillow
  tbox(sheetB, T(2.45, 0.62, -3.1).multiply(RYm(0.2)), [-0.2, 0, -0.17], [0.2, 0.09, 0.17]);
  sheetB.box([1.72, 0.62, -2.6], [2.68, 0.7, -1.62]); // crumpled blanket
  tbox(sheetB, T(1.67, 0.55, -2.2).multiply(RZm(0.5)), [-0.34, -0.02, -0.5], [0, 0.02, 0.5]); // blanket sagging off the side
  // Nightstand and its dented lamp.
  furnB.box([2.86, 0, -3.46], [3.38, 0.62, -3.0]);
  furnB.box([2.84, 0.62, -3.48], [3.4, 0.66, -2.98]);
  lampB.lathe([[0.1, 0.0], [0.05, 0.04], [0.02, 0.3]], 10, [3.12, 0.66, -3.25]);
  lampB.setMatrix(T(3.12, 0.66, -3.25).multiply(RZm(0.18)));
  lampB.lathe([[0.1, 0.3], [0.19, 0.5]], 14, [0, 0, 0]);
  lampB.setMatrix(null);
  // Lab counter along the left wall with spilled drawers, bottles and a shelf.
  furnB.box([-3.45, 0, -2.8], [-2.9, 0.84, -0.9]);
  furnB.box([-3.48, 0.84, -2.84], [-2.82, 0.9, -0.86]);
  tbox(furnB, T(-2.72, 0.5, -2.2).multiply(RYm(0.3)), [-0.2, 0, -0.24], [0.28, 0.2, 0.24]);
  tbox(furnB, T(-2.65, 0.02, -1.35).multiply(RYm(-0.4)), [-0.2, 0, -0.24], [0.28, 0.2, 0.24]);
  furnB.box([-3.48, 1.55, -2.6], [-3.15, 1.58, -1.2]);
  furnB.box([-3.48, 1.4, -2.55], [-3.44, 1.55, -2.45]);
  furnB.box([-3.48, 1.4, -1.35], [-3.44, 1.55, -1.25]);
  for (let i = 0; i < 4; i++) metalB.lathe([[0.04, 0], [0.045, 0.16], [0.018, 0.21], [0.018, 0.27]], 8, [-3.3, 1.58, -2.4 + i * 0.3]);
  for (let i = 0; i < 4; i++) metalB.lathe([[0.04, 0], [0.04, 0.16], [0.015, 0.2], [0.015, 0.26]], 8, [-3.2 + (i % 2) * 0.1, 0.9, -2.55 + i * 0.4]);
  // Gurney on the right wall with a soaked, crumpled sheet.
  metalB.box([2.5, 0.8, -2.7], [3.2, 0.84, -0.7]);
  for (const [x, z] of [[2.5, -2.7], [3.16, -2.7], [2.5, -0.74], [3.16, -0.74]]) metalB.box([x, 0.1, z], [x + 0.04, 0.8, z + 0.04]);
  metalB.box([2.52, 0.18, -2.66], [3.18, 0.21, -2.62]);
  metalB.box([2.52, 0.18, -0.78], [3.18, 0.21, -0.74]);
  for (const [x, z] of [[2.52, -2.68], [3.18, -2.68], [2.52, -0.76], [3.18, -0.76]]) metalB.lathe([[0.05, 0], [0.05, 0.1]], 8, [x, 0, z]);
  sheetB.box([2.52, 0.84, -2.66], [3.18, 0.88, -0.74]);
  sheetB.box([2.7, 0.88, -2.3], [3.05, 0.97, -1.5]);
  sheetB.box([2.62, 0.88, -1.3], [3.0, 0.94, -0.9]);
  tbox(sheetB, T(2.5, 0.84, -1.9).multiply(RZm(0.9)), [-0.4, -0.02, -0.3], [0, 0.02, 0.3]);
  // Toppled chair.
  {
    const m = T(-1.6, 0.22, -2.0).multiply(RYm(0.6)).multiply(RZm(1.45));
    tbox(furnB, m, [-0.2, 0.4, -0.2], [0.2, 0.44, 0.2]);
    for (const [x, z] of [[-0.19, -0.19], [0.16, -0.19], [-0.19, 0.16], [0.16, 0.16]]) tbox(furnB, m, [x, 0, z], [x + 0.03, 0.4, z + 0.03]);
    tbox(furnB, m, [-0.2, 0.44, -0.2], [0.2, 0.9, -0.17]);
  }
  // Broken floor lamp, shade crushed, near the back corner.
  lampB.lathe([[0.1, 0], [0.04, 0.03], [0.02, 0.5]], 8, [1.2, 0.0, 1.8]);
  // Cables fixed along the ceiling edge, drooping at the ends.
  const cabB = makeBuilder(THREE);
  cabB.box([-3.4, 2.64, -3.46], [1.2, 2.66, -3.44]);
  cabB.box([1.2, 2.5, -3.46], [1.22, 2.66, -3.44]);
  cabB.box([1.0, 2.48, -3.46], [1.22, 2.5, -3.44]);
  cabB.box([-3.46, 2.7, -3.4], [-3.44, 2.72, 1.5]);
  cabB.box([-3.46, 2.4, 1.5], [-3.44, 2.72, 1.52]);
  cabB.box([3.44, 2.6, -3.4], [3.46, 2.62, 0.4]);
  cabB.box([3.44, 2.2, 0.4], [3.46, 2.62, 0.42]);
  cabB.box([-1.5, 2.77, -3.4], [-1.488, 2.782, 3.4]); // conduit across the ceiling
  // Cobwebs hanging in the four upper corners.
  const webB = makeBuilder(THREE);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const a = V(sx * (HALF - 0.8), CEIL - 0.02, sz * HALF);
    const b = V(sx * HALF, CEIL - 0.02, sz * (HALF - 0.8));
    webB.quad([a, b, b.clone().setY(CEIL - 0.95), a.clone().setY(CEIL - 0.95)], V(-sx, 0, -sz).normalize(), [[0, 1], [1, 1], [1, 0], [0, 0]]);
  }
  // Boarded, broken window high on the right wall, pale light and a shaft.
  const winZ = -1.8;
  const winShape = new THREE.Shape();
  winShape.moveTo(-0.45, 1.35);
  winShape.lineTo(0.45, 1.35);
  winShape.lineTo(0.45, 2.0);
  winShape.absarc(0, 2.0, 0.45, 0, Math.PI, false);
  winShape.lineTo(-0.45, 1.35);
  const winMesh = new THREE.Mesh(keepGeo(new THREE.ShapeGeometry(winShape, 10)), windowMat);
  winMesh.name = "window";
  winMesh.position.set(HALF - 0.012, 0, winZ);
  winMesh.rotation.y = -Math.PI / 2;
  const winB = makeBuilder(THREE);
  winB.box([3.43, 1.31, winZ - 0.5], [3.49, 1.35, winZ + 0.5]); // sill
  winB.box([3.44, 1.35, winZ - 0.02], [3.48, 2.4, winZ + 0.02]); // mullion
  winB.box([3.44, 1.35, winZ - 0.5], [3.48, 2.0, winZ - 0.46]);
  winB.box([3.44, 1.35, winZ + 0.46], [3.48, 2.0, winZ + 0.5]);
  tbox(winB, T(3.42, 1.55, winZ).multiply(RXm(0.3)), [-0.02, -0.07, -0.62], [0.02, 0.07, 0.62]); // boards nailed across
  tbox(winB, T(3.42, 1.85, winZ).multiply(RXm(-0.22)), [-0.02, -0.07, -0.6], [0.02, 0.07, 0.6]);
  tbox(winB, T(3.42, 2.1, winZ + 0.1).multiply(RXm(0.12)), [-0.02, -0.06, -0.4], [0.02, 0.06, 0.4]);
  const beamB = makeBuilder(THREE);
  const bUv = [[0, 1], [1, 1], [1, 0], [0, 0]];
  beamB.quad([V(3.45, 2.35, winZ - 0.45), V(3.45, 2.35, winZ + 0.45), V(1.3, 0.02, winZ + 1.1), V(1.3, 0.02, winZ - 1.1)], V(-0.76, 0.65, 0), bUv);
  beamB.quad([V(3.45, 1.9, winZ - 0.4), V(3.45, 1.9, winZ + 0.4), V(2.2, 0.02, winZ + 0.8), V(2.2, 0.02, winZ - 0.8)], V(-0.76, 0.65, 0), bUv);
  // Wet blood decals (glossy fresh pools).
  const wetB = makeBuilder(THREE);
  for (const [cx, cz, r] of [[1.15, -1.0, 0.8], [-1.2, -1.8, 0.4], [-0.3, 1.4, 0.5]]) {
    wetB.quad([V(cx - r, 0.008, cz - r), V(cx - r, 0.008, cz + r), V(cx + r, 0.008, cz + r), V(cx + r, 0.008, cz - r)], V(0, 1, 0), [[0, 0], [0, 1], [1, 1], [1, 0]]);
  }

  const addMesh = (builder, material, name) => {
    if (builder.isEmpty()) return null;
    const m = new THREE.Mesh(keepGeo(builder.build()), material);
    m.name = name;
    group.add(m);
    return m;
  };
  addMesh(floorB, floorMat, "floor");
  addMesh(ceilB, ceilingMat, "ceiling");
  addMesh(wallB, wallMat, "walls");
  addMesh(wallRB, wallRedMat, "walls-red");
  addMesh(voidB, voidMat, "hall-voids");
  addMesh(trimB, trimMat, "trim");
  addMesh(cordB, trimMat, "lamp-cord");
  addMesh(shadeB, shadeMat, "lamp-shade");
  addMesh(bulbB, bulbMat, "lamp-bulb");
  addMesh(poolB, poolMat, "lamp-pool");
  addMesh(furnB, furnMat, "furniture");
  addMesh(sheetB, sheetMat, "bloody-linen");
  addMesh(metalB, metalMat, "metal-props");
  addMesh(lampB, lampShadeMat, "broken-lamps");
  addMesh(cabB, cableMat, "cables-static");
  addMesh(webB, webMat, "cobwebs");
  addMesh(winB, trimMat, "window-boards");
  addMesh(beamB, beamMat, "window-beam");
  addMesh(wetB, wetMat, "wet-blood");
  group.add(winMesh);

  // Swaying hanging wires: each bundle pivots from the ceiling.
  const wr = rng(77);
  const bundles = [];
  for (const [bx, bz, n, ln] of [[-2.6, -0.4, 4, 1.4], [2.3, -2.2, 3, 1.6], [-0.7, -2.9, 4, 1.1], [1.8, 2.4, 3, 1.3], [-2.0, 2.2, 3, 1.0]]) {
    const parts = [];
    for (let k = 0; k < n; k++) {
      const L = ln * (0.55 + wr() * 0.6);
      const ox = (wr() - 0.5) * 0.18;
      const oz = (wr() - 0.5) * 0.18;
      const pts = [V(ox, 0, oz), V(ox + 0.03, -L * 0.35, oz - 0.02), V(ox - 0.04, -L * 0.7, oz + 0.03), V(ox + (wr() - 0.5) * 0.14, -L, oz + (wr() - 0.5) * 0.1)];
      parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.007 + wr() * 0.005, 5, false));
    }
    const mesh = new THREE.Mesh(keepGeo(mergeGeos(THREE, parts)), cableMat);
    mesh.name = "hanging-wires";
    const piv = new THREE.Group();
    piv.position.set(bx, CEIL, bz);
    piv.add(mesh);
    group.add(piv);
    bundles.push({ piv, ph: wr() * 6.28, amp: 0.05 + wr() * 0.05 });
  }

  // Ceiling lamp halo and the nightstand lamp's warm glow (additive sprites).
  let halo = null;
  let lampGlow = null;
  if (poolTex) {
    halo = new THREE.Sprite(mat(new THREE.SpriteMaterial({ map: poolTex, color: 0xffb860, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })));
    halo.name = "lamp-halo";
    halo.position.set(0, LAMP_Y - 0.1, 0);
    halo.scale.set(1.6, 1.6, 1);
    group.add(halo);
    const wash = new THREE.Sprite(mat(new THREE.SpriteMaterial({ map: poolTex, color: 0x7fa6c8, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })));
    wash.name = "window-wash";
    wash.position.set(3.3, 1.9, winZ);
    wash.scale.set(2.6, 2.6, 1);
    group.add(wash);
    lampGlow = new THREE.Sprite(mat(new THREE.SpriteMaterial({ map: poolTex, color: 0xffa850, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
    lampGlow.name = "nightstand-glow";
    lampGlow.position.set(3.1, 1.0, -3.2);
    lampGlow.scale.set(2.2, 2.2, 1);
    group.add(lampGlow);
  }

  // Slowly dripping blood: bead swells at a ceiling stain, falls, ripples in the pool.
  const DROP = { x: -1.2, z: -1.8, period: 4.4, fallStart: 3.5, fall: 0.75 };
  const dropMesh = (() => {
    const b = makeBuilder(THREE);
    b.lathe([[0, 0.03], [0.006, 0.014], [0.009, 0], [0.006, -0.01], [0, -0.015]], 8, [0, 0, 0]);
    const m = new THREE.Mesh(keepGeo(b.build()), dropMat);
    m.name = "blood-drop";
    group.add(m);
    return m;
  })();
  const ripple = new THREE.Mesh(keepGeo(new THREE.RingGeometry(0.8, 1, 24).rotateX(-Math.PI / 2)), rippleMat);
  ripple.name = "blood-ripple";
  ripple.position.set(DROP.x, 0.012, DROP.z);
  group.add(ripple);

  // Dust motes drifting in the room (one Points draw).
  const MOTES = 70;
  const mr = rng(5);
  const moteBase = new Float32Array(MOTES * 3);
  const moteArr = new Float32Array(MOTES * 3);
  const motePh = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    moteBase[i * 3] = (mr() - 0.5) * 6;
    moteBase[i * 3 + 1] = 0.3 + mr() * 2.2;
    moteBase[i * 3 + 2] = (mr() - 0.5) * 6;
    motePh[i] = mr() * 6.28;
  }
  moteArr.set(moteBase);
  const moteGeo = keepGeo(new THREE.BufferGeometry());
  moteGeo.setAttribute("position", new THREE.BufferAttribute(moteArr, 3));
  const motes = new THREE.Points(moteGeo, mat(new THREE.PointsMaterial({ color: 0xd8e4ee, size: 0.022, transparent: true, opacity: 0.45, depthWrite: false })));
  motes.name = "dust-motes";
  motes.frustumCulled = false;
  group.add(motes);

  // ----- lights: exactly two real-time lights -----
  const lamp = new THREE.PointLight(0xffd9a0, 0, 0, 2);
  lamp.name = "ceiling-lamp";
  lamp.position.set(0, LAMP_Y, 0);
  group.add(lamp);

  const hallSpot = new THREE.SpotLight(0xffb868, 0, 9, 0.5, 0.9, 2);
  hallSpot.name = "hall-glow";
  hallSpot.target.name = "hall-glow-target";
  hallSpot.position.copy(wp("front", 0, 2.0, -1.4));
  hallSpot.target.position.copy(wp("front", 0, 0, 1.6));
  group.add(hallSpot, hallSpot.target);
  const hall = { left: 0, right: 0, front: 0, back: 0 };

  scene.add(group);

  // ----- state -----
  let lightLevel = 0;
  let flickLeft = 0;
  let flickAmt = 0;
  let flickAge = 0;
  let dipStart = -1;
  let nextDip = 0;
  let flickRng = rng(1);
  let anim = 0;
  const DIP_GAP = [0.5, 1.2];

  function flickerMultiplier() {
    if (flickLeft <= 0) return 1;
    const t = flickAge;
    let m = 1 - flickAmt * 0.18 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 0.7 * t));
    if (dipStart >= 0) {
      const u = (t - dipStart) / FLICKER_DIP;
      if (u >= 1) {
        dipStart = -1;
        nextDip = t + DIP_GAP[0] + flickRng() * (DIP_GAP[1] - DIP_GAP[0]);
      } else {
        m *= 1 - flickAmt * 0.7 * Math.sin(Math.PI * u);
      }
    } else if (t >= nextDip) {
      dipStart = t;
    }
    return m;
  }

  // ----- public API -----
  function setDoor(side, open, seconds) {
    const d = doors[side];
    if (!d) throw new RangeError(`unknown door side: ${side}`);
    d.target = clamp01(open);
    d.dur = Number.isFinite(seconds) ? Math.min(8, Math.max(0.2, seconds)) : DOOR_TIME;
  }

  function getDoor(side) {
    const d = doors[side];
    if (!d) throw new RangeError(`unknown door side: ${side}`);
    return d.value;
  }

  function setLight(level) {
    lightLevel = clamp01(level);
  }

  function flicker(seconds, intensity = 0.6) {
    const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    flickLeft = s;
    flickAmt = clamp01(intensity);
    flickAge = 0;
    dipStart = -1;
    flickRng = rng(s * 1000 + 17);
    nextDip = 0.5 + flickRng() * 0.5;
  }

  function setHallLight(side, level) {
    if (!(side in hall)) throw new RangeError(`unknown door side: ${side}`);
    hall[side] = clamp01(level);
    let best = null;
    for (const s of SIDES) if (hall[s] > 0 && (best === null || hall[s] > hall[best])) best = s;
    if (best === null) {
      hallSpot.intensity = 0;
      hallSpot.userData.base = 0;
      return;
    }
    hallSpot.position.copy(wp(best, 0, 2.0, -1.4));
    hallSpot.target.position.copy(wp(best, 0, 0, 1.6));
    hallSpot.intensity = hall[best] * HALL_MAX;
    hallSpot.userData.base = hallSpot.intensity;
  }

  function update(dt = 0, time = 0) {
    const step = Number.isFinite(dt) ? Math.min(0.5, Math.max(0, dt)) : 0;
    anim += step;

    for (const side of SIDES) {
      const d = doors[side];
      const diff = d.target - d.value;
      const lim = step / d.dur;
      if (Math.abs(diff) <= lim) d.value = d.target;
      else d.value += Math.sign(diff) * lim;
      d.pivot.rotation.y = SIDE_ANGLE[side] + DOOR_SWING * smooth(d.value);
    }

    let mult = 1;
    if (flickLeft > 0) {
      flickLeft = Math.max(0, flickLeft - step);
      flickAge += step;
      mult = flickLeft > 0 ? flickerMultiplier() : 1;
    }

    const L = lightLevel;
    lamp.intensity = LAMP_MAX * Math.pow(L, 1.1) * mult;
    const fm = 0.85 + 0.15 * mult;
    for (const [m, base, gain] of emissiveMats) m.emissiveIntensity = (base + gain * L) * fm;
    bulbMat.color.copy(BULB_BASE).multiplyScalar((0.2 + 0.8 * L) * mult);
    if (hallSpot.userData.base) {
      const hm = Number.isFinite(time) ? 0.85 + 0.15 * Math.sin(time * 2.1) * Math.sin(time * 0.37) : 1;
      hallSpot.intensity = hallSpot.userData.base * hm;
    }
    const breathe = Number.isFinite(time) ? 1 + 0.03 * Math.sin(time * 1.3) : 1;
    poolMat.opacity = Math.min(1, (0.05 + 0.75 * L) * mult * breathe);
    if (halo) halo.material.opacity = Math.min(1, (0.08 + 0.5 * L) * mult);
    if (lampGlow) lampGlow.material.opacity = (0.4 + 0.15 * Math.sin(anim * 0.9)) * (0.6 + 0.4 * mult);
    beamMat.opacity = 0.3 + 0.1 * Math.sin(anim * 0.35);

    // Life: slow wire sway, dripping blood, drifting dust (all well under 3 Hz).
    for (const b of bundles) {
      b.piv.rotation.z = b.amp * Math.sin(anim * 0.55 + b.ph);
      b.piv.rotation.x = b.amp * 0.7 * Math.sin(anim * 0.43 + b.ph * 1.7);
    }
    const ph = anim % DROP.period;
    if (ph < DROP.fallStart) {
      const s = ph / DROP.fallStart;
      dropMesh.position.set(DROP.x, CEIL - 0.03 - 0.02 * s, DROP.z);
      dropMesh.scale.setScalar(0.4 + 0.9 * s);
      rippleMat.opacity = 0;
    } else {
      const tau = ph - DROP.fallStart;
      const y = Math.max(0.03, CEIL - 0.05 - 4.9 * tau * tau);
      dropMesh.position.set(DROP.x, y, DROP.z);
      dropMesh.scale.setScalar(1.3);
      const landed = tau - DROP.fall;
      if (landed > 0) {
        dropMesh.visible = false;
        const u = Math.min(1, landed / 0.9);
        ripple.scale.setScalar(0.03 + 0.22 * u);
        rippleMat.opacity = 0.5 * (1 - u);
      } else dropMesh.visible = true;
    }
    if (ph < DROP.fallStart) dropMesh.visible = true;
    for (let i = 0; i < MOTES; i++) {
      const p = motePh[i];
      moteArr[i * 3] = moteBase[i * 3] + 0.22 * Math.sin(anim * 0.12 + p);
      moteArr[i * 3 + 1] = moteBase[i * 3 + 1] + 0.12 * Math.sin(anim * 0.2 + p * 2);
      moteArr[i * 3 + 2] = moteBase[i * 3 + 2] + 0.22 * Math.cos(anim * 0.1 + p);
    }
    moteGeo.attributes.position.needsUpdate = true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(group);
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    geometries.length = 0;
    materials.length = 0;
    textures.length = 0;
    group.clear();
  }

  update(0, 0);

  return {
    group,
    doors,
    setDoor,
    getDoor,
    setLight,
    flicker,
    setHallLight,
    update,
    dispose,
    playerPosition: { x: 0, y: 1.6, z: 0 },
  };
}
