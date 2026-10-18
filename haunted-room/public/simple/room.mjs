import { fluorescentMultiplier } from "../lighting-patterns.mjs";
import { loadRoomSurfaces } from "./surface-materials.mjs";
// Simple horror room: a square plaster chamber, four walls, one door per wall,
// one ceiling lamp. The player stands still at the origin looking toward -Z.
//
// Procedural only: geometry is built into a few merged BufferGeometries and
// canvas textures are painted at runtime (skipped where no canvas exists).
// Budget: <60 draw calls, 2 real-time lights (ceiling point lamp + one spot
// that is moved to whichever door is glowing). Everything else is emissive
// or baked-look. Zero fixture power removes all room self-illumination.

import { paintWall, paintCeiling, paintFloor, paintWood, paintSheet, paintWetPool, paintBeam, paintWeb, paintRelief } from "./decor.mjs";

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
const LAMP_Y = 2.63; // bulb centre
const LAMP_MAX = 48; // candela at full light level
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
  const contactTex = keepTex(paint(THREE, opts, 128, 128, (c,w,h) => {
    const g=c.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);
    g.addColorStop(0,"rgba(0,0,0,.8)");g.addColorStop(.45,"rgba(0,0,0,.58)");g.addColorStop(1,"rgba(0,0,0,0)");
    c.fillStyle=g;c.fillRect(0,0,w,h);
  },1104));
  const mat = (m) => (materials.push(m), m);

  const relief = keepTex(paint(THREE, opts, 1280, 512, (c,w,h,r) => paintRelief(c,w,h,r), 1102));
  const floorRelief = keepTex(paint(THREE, opts, 1024, 1024, (c,w,h,r) => paintRelief(c,w,h,r,"floor"), 1103));
  // Height maps must be linear data, unlike the sRGB albedo maps.
  for (const texture of [relief, floorRelief]) if (texture && THREE.NoColorSpace !== undefined) texture.colorSpace = THREE.NoColorSpace;
  // Restrained fill preserves readability without flattening physically lit surfaces.
  const lit = (map, extra = {}) => mat(new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xb3b7a2, emissiveIntensity: 0.1, roughness: 0.95, metalness: 0, ...extra }));
  const wallMat = lit(tealTex, { bumpMap: relief, bumpScale: .016 });
  const wallRedMat = lit(redTex, { bumpMap: relief, bumpScale: .016 });
  const ceilingMat = lit(ceilTex, { bumpMap: relief, bumpScale: .008 });
  const floorMat = lit(floorTex, { roughness: 0.67, bumpMap: floorRelief, bumpScale: .012 });
  const furnMat = lit(woodTex, { color: 0x777c70, roughness: 0.83 });
  const sheetMat = lit(sheetTex, { color: 0x9c9a86, roughness: 0.96 });
  const emissiveMats = [
    [wallMat, 0.13, 0.12], [wallRedMat, 0.13, 0.12],
    [ceilingMat, 0.075, 0.055], [floorMat, 0.12, 0.095],
    [furnMat, 0.11, 0.07], [sheetMat, 0.12, 0.08],
  ];
  const metalMat = mat(new THREE.MeshStandardMaterial({ color: 0x5a5e5a, emissive: 0x1c201e, roughness: 0.5, metalness: 0.5 }));
  const cableMat = mat(new THREE.MeshStandardMaterial({ color: 0x151515, emissive: 0x0a0a0a, roughness: 0.6 }));
  const trimMat = mat(new THREE.MeshStandardMaterial({ color: 0x41473d, emissive: 0x0d100c, roughness: 0.7 }));
  const doorMat = mat(new THREE.MeshStandardMaterial({ map: woodTex, color: 0x777a68, emissive: 0x100f0a, roughness: 0.87 }));
  const brassMat = mat(new THREE.MeshStandardMaterial({ color: 0x777a71, metalness: 0.7, roughness: 0.48, emissive: 0x0a0b08 }));
  const voidMat = mat(new THREE.MeshBasicMaterial({ color: 0x000000 }));
  const shadeMat = mat(new THREE.MeshStandardMaterial({ color: 0x343b33, emissive: 0x040604, roughness: 0.9, side: THREE.DoubleSide }));
  const lampShadeMat = mat(new THREE.MeshStandardMaterial({ color: 0x464c40, emissive: 0x10140e, emissiveIntensity: 0.08, roughness: 0.9, side: THREE.DoubleSide }));
  const BULB_BASE = new THREE.Color(0xe6ead9);
  const bulbMat = mat(new THREE.MeshBasicMaterial({ color: BULB_BASE.clone() }));
  const poolMat = mat(new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0.2, depthWrite: false, color: 0xffc080 }));
  const wetMat = mat(
    new THREE.MeshStandardMaterial({
      map: wetTex,
      emissiveMap: wetTex,
      emissive: 0x070201,
      color: wetTex ? 0xffffff : 0x35100b,
      roughness: 0.28,
      metalness: 0.1,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const dropMat = mat(new THREE.MeshStandardMaterial({ color: 0x38110b, emissive: 0x060201, roughness: 0.15 }));
  const rippleMat = mat(new THREE.MeshBasicMaterial({ color: 0x513329, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const webMat = mat(new THREE.MeshBasicMaterial({ map: webTex, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, color: 0xc4ccc4 }));
  const windowMat = mat(new THREE.MeshBasicMaterial({ color: 0x34493d }));
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
    sydBox(trimB,side,-DOOR_HALF-.07,-DOOR_HALF,0,DOOR_H+.07,-.35,.018);
    sydBox(trimB,side,DOOR_HALF,DOOR_HALF+.07,0,DOOR_H+.07,-.35,.018);
    sydBox(trimB,side,-DOOR_HALF,DOOR_HALF,DOOR_H,DOOR_H+.07,-.35,.018);
    sydBox(trimB, side, -HALF, -DOOR_HALF - JAMB, 0, 0.12, 0, 0.025);
    sydBox(trimB, side, DOOR_HALF + JAMB, HALF, 0, 0.12, 0, 0.025);
    sydBox(trimB, side, -HALF, HALF, CEIL - 0.12, CEIL, 0, 0.08);
    sydBox(trimB, side, -DOOR_HALF - JAMB, -DOOR_HALF, 0, DOOR_H + JAMB, 0, FRAME_D);
    sydBox(trimB, side, DOOR_HALF, DOOR_HALF + JAMB, 0, DOOR_H + JAMB, 0, FRAME_D);
    sydBox(trimB, side, -DOOR_HALF - JAMB, DOOR_HALF + JAMB, DOOR_H, DOOR_H + JAMB, 0, FRAME_D);
  }

  // Fixed industrial architecture: ceramic dado rails, conduit clips and
  // ceiling grid. All pieces merge into existing trim/metal batches.
  for (const side of SIDES) {
    for (const [a,b] of [[-HALF,-.66],[.66,HALF]]) {
      sydBox(trimB,side,a,b,1.17,1.20,0,.025);
      sydBox(trimB,side,a,b,.05,.08,0,.035);
    }
    for (const x of [-3.2,-2.4,-1.6,1.6,2.4,3.2]) {
      sydBox(trimB,side,x-.025,x+.025,2.57,2.67,.015,.07);
    }
    // Narrow reinforcement and kick plates remain part of each swinging slab.
  }
  for(const x of [-2.3,0,2.3]) trimB.box([x-.018,CEIL-.035,-HALF],[x+.018,CEIL,HALF]);
  for(const z of [-2.3,0,2.3]) trimB.box([-HALF,CEIL-.035,z-.018],[HALF,CEIL,z+.018]);

  const floorB = makeBuilder(THREE);
  const ceilB = makeBuilder(THREE);
  const flatUv = (p) => [(p.x + HALF) / (2 * HALF), (p.z + HALF) / (2 * HALF)];
  const flatQuad = (builder, y, normalY) => {
    const c = [V(-HALF, y, -HALF), V(-HALF, y, HALF), V(HALF, y, HALF), V(HALF, y, -HALF)];
    builder.quad(c, V(0, normalY, 0), c.map(flatUv));
  };
  flatQuad(floorB, 0, 1);
  flatQuad(ceilB, CEIL, -1);

  // Ceiling-mounted fluorescent service fixture, opaque metal housing and
  // a recessed diffuser. No oversized pendant cone or orange floor disk.
  const cordB = makeBuilder(THREE);
  cordB.box([-.68,CEIL-.13,-.15],[.68,CEIL-.015,.15]);
  const shadeB = makeBuilder(THREE);
  shadeB.box([-.7,CEIL-.15,-.19],[.7,CEIL-.1,-.14]);
  shadeB.box([-.7,CEIL-.15,.14],[.7,CEIL-.1,.19]);
  const bulbB = makeBuilder(THREE);
  bulbB.box([-.61,CEIL-.145,-.11],[.61,CEIL-.13,.11]);
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




    const handleB = makeBuilder(THREE);
    handleB.box([.055,.045,SLAB_T/2+.002],[DOOR_W-.055,.26,SLAB_T/2+.008]);
    for(const y of [.34,1.76]) handleB.box([.025,y,SLAB_T/2],[.075,y+.09,SLAB_T/2+.012]);
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
  // Institutional waiting bench: restrained metal structure replaces the
  // domestic wooden bed and lamps. No oversized primitive blood-soaked linens.
  metalB.box([1.55,.43,-3.38],[2.97,.48,-2.93]);
  metalB.box([1.55,.48,-3.43],[2.97,.91,-3.38]);
  for(const x of [1.62,2.84])metalB.box([x,.01,-3.36],[x+.055,.43,-2.98]);
  // One folded dust cloth, small enough to read as fabric rather than geometry.
  sheetB.box([2.58,.48,-3.3],[2.91,.505,-3.01]);
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
  // Abandoned observation station tucked behind the player; original props,
  // with the four door lanes and central standing space deliberately clear.
  furnB.box([-3.15,.77,2.35],[-1.05,.84,3.28]);
  for(const x of [-3.08,-1.16]) metalB.box([x,0,2.45],[x+.055,.77,3.18]);
  const consoleB = makeBuilder(THREE), screenB = makeBuilder(THREE);
  for(const x of [-2.65,-1.65]) {
    consoleB.box([x-.33,.84,2.72],[x+.33,1.36,3.14]);
    consoleB.box([x-.12,.84,2.7],[x+.12,.9,3.16]);
    screenB.box([x-.27,.91,2.711],[x+.27,1.29,2.719]);
    // Vents and two rows of grubby hardware buttons share metal geometry.
    for(let i=0;i<7;i++) metalB.box([x-.22+i*.065,1.32,2.708],[x-.20+i*.065,1.335,2.721]);
  }
  consoleB.box([-2.85,.84,2.4],[-1.35,.89,2.65]);
  for(let row=0;row<3;row++)for(let col=0;col<16;col++) {
    metalB.box([-2.77+col*.084,.889,2.43+row*.06],[-2.71+col*.084,.9,2.47+row*.06]);
  }
  // Wall-mounted ventilation grille and service pipe return. No new lights.
  metalB.box([-3.47,1.78,1.45],[-3.4,2.27,2.27]);
  for(let i=0;i<9;i++) consoleB.box([-3.395,1.82+i*.047,1.5],[-3.385,1.84+i*.047,2.22]);
  for(const x of [1.3,1.45]) metalB.box([x,2.56,3.38],[x+.045,CEIL,3.44]);

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
  winShape.lineTo(0.45, 2.25);
  winShape.lineTo(-0.45, 2.25);
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
  const beamB = makeBuilder(THREE);
  const bUv = [[0, 1], [1, 1], [1, 0], [0, 0]];
  beamB.quad([V(3.45, 2.35, winZ - 0.45), V(3.45, 2.35, winZ + 0.45), V(1.3, 0.02, winZ + 1.1), V(1.3, 0.02, winZ - 1.1)], V(-0.76, 0.65, 0), bUv);
  beamB.quad([V(3.45, 1.9, winZ - 0.4), V(3.45, 1.9, winZ + 0.4), V(2.2, 0.02, winZ + 0.8), V(2.2, 0.02, winZ - 0.8)], V(-0.76, 0.65, 0), bUv);
  // Observation glazing recess and rubber-gasket crossbars.
  winB.box([3.35,1.28,winZ-.54],[3.49,1.35,winZ+.54]);
  winB.box([3.35,2.25,winZ-.54],[3.49,2.32,winZ+.54]);
  winB.box([3.35,1.35,winZ-.54],[3.49,2.25,winZ-.46]);
  winB.box([3.35,1.35,winZ+.46],[3.49,2.25,winZ+.54]);
  // Wet blood decals disabled: photographic floor carries localized staining.

  const wetB = makeBuilder(THREE);
  for (const [cx, cz, r] of []) {
    wetB.quad([V(cx - r, 0.008, cz - r), V(cx - r, 0.008, cz + r), V(cx + r, 0.008, cz + r), V(cx + r, 0.008, cz - r)], V(0, 1, 0), [[0, 0], [0, 1], [1, 1], [1, 0]]);
  }

  const addMesh = (builder, material, name) => {
    if (builder.isEmpty()) return null;
    const m = new THREE.Mesh(keepGeo(builder.build()), material);
    m.name = name;
    group.add(m);
    return m;
  };
  // One merged contact-occlusion layer anchors heavy props to the floor.
  // Transparent black, never additive; no shadowmap pass on standalone Quest.
  const contactB=makeBuilder(THREE);
  for(const [x,z,rx,rz] of [[-2.8,-3.15,.85,.6],[2.25,-3.15,1,.65],[-3.1,-1.8,.65,1.2],[2.86,-1.7,.75,1.35],[-2.1,2.8,1.4,.85],[-1.65,-2,.6,.65]]) {
    contactB.quad([V(x-rx,.004,z-rz),V(x-rx,.004,z+rz),V(x+rx,.004,z+rz),V(x+rx,.004,z-rz)],V(0,1,0),[[0,0],[0,1],[1,1],[1,0]]);
  }
  addMesh(contactB,mat(new THREE.MeshBasicMaterial({ map:contactTex, color:0x000000, transparent:true, opacity:.85, depthWrite:false, polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1 })),"prop-contact-occlusion");
  addMesh(consoleB, cableMat, "observation-console");
  const screenMat = mat(new THREE.MeshStandardMaterial({ color: 0x101b16, emissive: 0x193c2e, emissiveIntensity: .32, roughness: .32, metalness: .15 }));
  addMesh(screenB, screenMat, "dead-observation-screens");
  addMesh(floorB, floorMat, "floor");
  addMesh(ceilB, ceilingMat, "ceiling");
  addMesh(wallB, wallMat, "walls");
  addMesh(wallRB, wallRedMat, "walls-red");
  addMesh(voidB, voidMat, "hall-voids");
  addMesh(trimB, trimMat, "trim");
  addMesh(cordB, trimMat, "lamp-cord");
  addMesh(shadeB, shadeMat, "lamp-shade");
  addMesh(bulbB, bulbMat, "lamp-bulb");

  addMesh(furnB, furnMat, "furniture");
  addMesh(sheetB, sheetMat, "bloody-linen");
  addMesh(metalB, metalMat, "metal-props");
  addMesh(lampB, lampShadeMat, "broken-lamps");
  addMesh(cabB, cableMat, "cables-static");
  addMesh(webB, webMat, "cobwebs");
  addMesh(winB, trimMat, "window-boards");

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
  if (false && poolTex) {
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
  const lamp = new THREE.PointLight(0xcbd5bc, 0, 7, 2);
  lamp.name = "ceiling-lamp";
  lamp.position.set(0, LAMP_Y, 0);
  group.add(lamp);

  const hallSpot = new THREE.SpotLight(0x95adae, 0, 6, 0.36, 0.85, 2);
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
  let flickDuration = 0;
  let anim = 0;
  function flickerMultiplier() {
    return fluorescentMultiplier(flickAge, flickDuration, flickAmt);
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
    flickDuration = s;
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
    // At 0 power there is no emissive readability floor. All apparent light
    // comes from the fixture and explicitly requested cold door spill.
    const power = Math.pow(L, 1.8) * mult;
    lamp.intensity = LAMP_MAX * power;
    for (const m of materials) if (m.isMeshStandardMaterial) m.emissiveIntensity = power * .045;
    bulbMat.color.copy(BULB_BASE).multiplyScalar(Math.pow(L, .85) * mult);
    bulbMat.visible = L > 0;
    windowMat.color.setHex(0x34493d).multiplyScalar(power * .15);
    webMat.opacity = .06 * power;
    motes.material.opacity = .18 * power;
    group.userData.lightLevel = L;
    group.userData.fixturePower = power;
    if (hallSpot.userData.base) {
      const hm = Number.isFinite(time) ? 0.85 + 0.15 * Math.sin(time * 2.1) * Math.sin(time * 0.37) : 1;
      hallSpot.intensity = hallSpot.userData.base * hm;
    }
    const breathe = Number.isFinite(time) ? 1 + 0.03 * Math.sin(time * 1.3) : 1;
    poolMat.opacity = Math.min(1, (0.025 + 0.22 * L) * mult * breathe);
    if (halo) halo.material.opacity = Math.min(1, (0.025 + 0.14 * L) * mult);
    if (lampGlow) lampGlow.material.opacity = (0.12 + 0.035 * Math.sin(anim * 0.9)) * (0.6 + 0.4 * mult);
    beamMat.opacity = 0.10 + 0.025 * Math.sin(anim * 0.35);

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
        rippleMat.opacity = 0.18 * (1 - u) * power;
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

  loadRoomSurfaces(THREE, {
    keepTexture: keepTex, alive: () => !disposed,
    apply(photo) {
      for(const m of [wallMat,wallRedMat]) {m.map=m.emissiveMap=photo.wall;m.color.setHex(0xffffff);m.bumpMap=photo.plasterBump;m.bumpScale=.025;m.needsUpdate=true;}
      ceilingMat.map=ceilingMat.emissiveMap=photo.plaster;ceilingMat.bumpMap=photo.plasterBump;ceilingMat.needsUpdate=true;
      floorMat.map=floorMat.emissiveMap=photo.floor;floorMat.bumpMap=null;floorMat.roughness=.78;floorMat.needsUpdate=true;
      for(const m of [doorMat,furnMat,trimMat]){m.map=photo.steel;m.color.setHex(0x9b9e91);m.bumpMap=photo.steelBump;m.bumpScale=.01;m.metalness=.35;m.roughness=.78;m.needsUpdate=true;}
      // Desaturated stained fabric, no repeated painted blood target patterns.
      sheetMat.map=sheetMat.emissiveMap=photo.plaster;sheetMat.bumpMap=photo.plasterBump;sheetMat.color.setHex(0x939080);sheetMat.needsUpdate=true;
      group.userData.photographicSurfacesReady=true;
    },
  });

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
