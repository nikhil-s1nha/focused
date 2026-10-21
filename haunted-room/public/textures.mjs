// textures.mjs — procedural material library for The Quiet Room.
//
// Generates every surface texture on a canvas at startup: no external assets,
// no CDN, no Math.random. All pixels come from a seeded mulberry32 PRNG plus
// layered value noise, written into a Uint8ClampedArray and uploaded with a
// single putImageData per canvas — so the output is fully deterministic and
// testable with a stub canvas whose 2d context only records putImageData.
//
// Painting techniques (plank seams, grain streaks, knots, water stains,
// speckle) adapted from the MIT-licensed bridge-horror-house Textures.js
// reference, re-implemented as deterministic buffer writes.
//
// API:
//   makeNoise(seed) => () => [0,1)   deterministic PRNG (mulberry32)
//   createMaterialLibrary(THREE, { createCanvas, seed = 1337 } = {})
//     => { materials: { wallPlaster, wainscot, woodDark, floorPlanks,
//                       ceiling, metalAged, fabricWorn, corridorWall },
//          dispose() }
//
// Headless behaviour: createCanvas(w, h) defaults to
// document.createElement("canvas"). When no DOM exists AND no createCanvas is
// injected (e.g. plain Node), the library never throws — it returns the same
// eight keys as flat, untextured MeshStandardMaterials with tuned colors, and
// dispose() still works.
//
// Quest 3S budget: 256–512 px power-of-two textures, color map + grayscale
// bump map per role, texture instances reused across materials where sensible
// (corridorWall reuses wallPlaster's bump).

export function makeNoise(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- seeded, tiling value noise ---------------------------------------------

const smooth = (t) => t * t * (3 - 2 * t);

function makeValueNoise(rand, period = 64) {
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  return function sample(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const a = lattice[y0 * period + x0];
    const b = lattice[y0 * period + x1];
    const c = lattice[y1 * period + x0];
    const d = lattice[y1 * period + x1];
    const u = smooth(fx);
    const v = smooth(fy);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

// Fractal (layered-octave) value noise in [0,1].
function makeFbm(rand, period = 64) {
  const base = makeValueNoise(rand, period);
  return function fbm(x, y, octaves = 4) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += base(x, y) * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2;
      y *= 2;
    }
    return sum / norm;
  };
}

// --- float field (r,g,b in 0..255-ish, h height 0..1) and buffer helpers ----

function createField(size) {
  const n = size * size;
  return {
    size,
    r: new Float32Array(n),
    g: new Float32Array(n),
    b: new Float32Array(n),
    h: new Float32Array(n).fill(0.5),
  };
}

const wrap = (v, size) => ((v % size) + size) % size;

function blendPx(f, x, y, r, g, b, a, dh = 0) {
  const i = wrap(y | 0, f.size) * f.size + wrap(x | 0, f.size);
  f.r[i] += (r - f.r[i]) * a;
  f.g[i] += (g - f.g[i]) * a;
  f.b[i] += (b - f.b[i]) * a;
  f.h[i] += dh * a;
}

// Soft radial blot (stains, knots, rust, scuffs); wraps across edges.
function blot(f, cx, cy, radius, [r, g, b], alpha, dh = 0) {
  const rad = Math.max(1, radius);
  const r2 = rad * rad;
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const fall = 1 - Math.sqrt(d2) / rad;
      blendPx(f, cx + dx, cy + dy, r, g, b, alpha * fall * fall, dh * fall);
    }
  }
}

// Jittered random-walk stroke (cracks, scratches); width in pixels.
function stroke(f, rand, opts) {
  const {
    x0, y0, dirX, dirY, steps, jitter, color, alpha, width = 1, dh = 0,
  } = opts;
  let x = x0;
  let y = y0;
  let dx = dirX;
  let dy = dirY;
  for (let s = 0; s < steps; s++) {
    for (let w = 0; w < width; w++)
      blendPx(f, x + w, y, color[0], color[1], color[2], alpha, dh);
    dx += (rand() - 0.5) * jitter;
    dy += (rand() - 0.5) * jitter;
    const len = Math.hypot(dx, dy) || 1;
    x += (dx / len) * (1 + rand() * 2);
    y += (dy / len) * (1 + rand() * 2);
  }
}

// Fine speckled dust/grain dots.
function speckle(f, rand, count, alpha, dark = true) {
  const size = f.size;
  for (let i = 0; i < count; i++) {
    const shade = dark ? rand() * 55 : 170 + rand() * 85;
    blendPx(
      f,
      rand() * size,
      rand() * size,
      shade,
      shade * 0.94,
      shade * 0.85,
      0.04 + rand() * alpha,
      dark ? -0.02 : 0.02,
    );
  }
}

// Convert the float field into color (RGBA) and grayscale bump (RGBA) bytes.
function fieldToBuffers(f) {
  const n = f.size * f.size;
  const color = new Uint8ClampedArray(n * 4);
  const bump = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    color[o] = f.r[i];
    color[o + 1] = f.g[i];
    color[o + 2] = f.b[i];
    color[o + 3] = 255;
    const hv = Math.max(0, Math.min(1, f.h[i])) * 255;
    bump[o] = hv;
    bump[o + 1] = hv;
    bump[o + 2] = hv;
    bump[o + 3] = 255;
  }
  return { color, bump };
}

// --- per-role painters ------------------------------------------------------

// Aged Victorian plaster: soft mottling, fine grain, faint vertical water
// stains, hairline cracks. grime=1 turns it into the corridor variant.
function paintPlaster(f, rand, base, grime = 0) {
  const size = f.size;
  const mottle = makeFbm(rand, 64);
  const grain = makeFbm(rand, 64);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const m = mottle(x * inv * 9, y * inv * 9, 4) - 0.5;
      const g = grain(x * inv * 90, y * inv * 90, 2) - 0.5;
      const l = 1 + m * 0.24 + g * 0.1 - grime * 0.1;
      const i = y * size + x;
      f.r[i] = base[0] * l;
      f.g[i] = base[1] * l;
      f.b[i] = base[2] * l;
      f.h[i] = 0.5 + m * 0.3 + g * 0.14;
    }
  }
  // Vertical water stains dripping from the top edge.
  const stains = 4 + Math.round(grime * 4);
  for (let s = 0; s < stains; s++) {
    const sx = rand() * size;
    const w = 8 + rand() * 24;
    const len = size * (0.3 + rand() * 0.55) * (1 + grime * 0.4);
    for (let y = 0; y < len && y < size; y++) {
      const fade = (1 - y / len) * (0.3 + grime * 0.35);
      for (let dx = -w; dx <= w; dx++) {
        const edge = 1 - Math.abs(dx) / w;
        blendPx(f, sx + dx, y, 24, 26, 22, fade * edge * edge * 0.9, -0.05);
      }
    }
  }
  // Hairline cracks wandering mostly downward.
  const cracks = 3 + Math.round(grime * 2);
  for (let c = 0; c < cracks; c++) {
    stroke(f, rand, {
      x0: rand() * size,
      y0: rand() * size * 0.5,
      dirX: (rand() - 0.5) * 0.6,
      dirY: 1,
      steps: 60 + rand() * 60,
      jitter: 0.5,
      color: [16, 15, 13],
      alpha: 0.5,
      width: 1,
      dh: -0.2,
    });
  }
  // Grime blotches (heavy in the corridor variant).
  const blots = 3 + Math.round(grime * 9);
  for (let s = 0; s < blots; s++)
    blot(f, rand() * size, rand() * size, 20 + rand() * 50, [18, 20, 16],
      0.18 + grime * 0.2, -0.06);
  speckle(f, rand, 500 + grime * 700, 0.08 + grime * 0.05);
}

// Wood: long horizontal grain streaks, knots, varnish variation.
function paintWood(f, rand, base, { knots = 4, varnish = 0.2 } = {}) {
  const size = f.size;
  const grain = makeFbm(rand, 64);
  const sheen = makeFbm(rand, 64);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Low x-frequency, high y-frequency => streaks running along x.
      const s = grain(x * inv * 3.2, y * inv * 46, 4) - 0.5;
      const v = (sheen(x * inv * 5, y * inv * 5, 2) - 0.5) * varnish;
      const l = 1 + s * 0.55 + v;
      const i = y * size + x;
      f.r[i] = base[0] * l;
      f.g[i] = base[1] * l;
      f.b[i] = base[2] * l;
      f.h[i] = 0.5 + s * 0.42;
    }
  }
  for (let k = 0; k < knots; k++) {
    const kx = rand() * size;
    const ky = rand() * size;
    const kr = 4 + rand() * 7;
    blot(f, kx, ky, kr * 2.2, [base[0] * 0.55, base[1] * 0.5, base[2] * 0.45],
      0.5, -0.1);
    blot(f, kx, ky, kr, [14, 9, 5], 0.85, -0.22);
  }
  speckle(f, rand, 350, 0.08);
}

// Floorboards: distinct planks, dark seam lines every ~64 px, per-plank tone,
// staggered end seams, scuff wear.
function paintPlanks(f, rand, base) {
  const size = f.size;
  const plankH = 64;
  const rows = size / plankH;
  const grain = makeFbm(rand, 64);
  const tone = [];
  const offset = [];
  const seamX = [];
  for (let r = 0; r < rows; r++) {
    tone.push(0.82 + rand() * 0.36);
    offset.push(rand() * 61);
    seamX.push(Math.floor(rand() * size));
  }
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / plankH) % rows;
    const t = tone[row];
    for (let x = 0; x < size; x++) {
      const s =
        grain(x * inv * 3, (y + offset[row] * 37) * inv * 52, 4) - 0.5;
      const l = t * (1 + s * 0.5);
      const i = y * size + x;
      f.r[i] = base[0] * l;
      f.g[i] = base[1] * l;
      f.b[i] = base[2] * l;
      f.h[i] = 0.5 + s * 0.35;
      const yy = y % plankH;
      if (yy < 2 || Math.abs(x - seamX[row]) < 2) {
        // Long seam between plank rows + staggered butt seam.
        f.r[i] *= 0.22;
        f.g[i] *= 0.22;
        f.b[i] *= 0.22;
        f.h[i] = 0.08;
      }
    }
  }
  // Knots and scuffed/worn patches.
  for (let k = 0; k < 6; k++)
    blot(f, rand() * size, rand() * size, 4 + rand() * 6, [16, 10, 6], 0.8, -0.2);
  for (let s = 0; s < 7; s++)
    blot(f, rand() * size, rand() * size, 24 + rand() * 60,
      [base[0] * 1.3, base[1] * 1.3, base[2] * 1.25], 0.16, 0.03);
  for (let s = 0; s < 4; s++)
    blot(f, rand() * size, rand() * size, 30 + rand() * 60, [10, 7, 5], 0.3, -0.04);
  speckle(f, rand, 900, 0.1);
}

// Dark smoke-stained ceiling plaster.
function paintCeiling(f, rand, base) {
  const size = f.size;
  const smoke = makeFbm(rand, 64);
  const grain = makeFbm(rand, 64);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sm = smoke(x * inv * 6, y * inv * 6, 4);
      const g = grain(x * inv * 70, y * inv * 70, 2) - 0.5;
      const l = (1 - sm * 0.5) * (1 + g * 0.1);
      const i = y * size + x;
      f.r[i] = base[0] * l;
      f.g[i] = base[1] * l;
      f.b[i] = base[2] * l;
      f.h[i] = 0.5 - sm * 0.2 + g * 0.12;
    }
  }
  for (let c = 0; c < 4; c++)
    stroke(f, rand, {
      x0: rand() * size,
      y0: rand() * size,
      dirX: rand() - 0.5,
      dirY: rand() - 0.5,
      steps: 50 + rand() * 50,
      jitter: 0.7,
      color: [10, 10, 8],
      alpha: 0.5,
      dh: -0.2,
    });
  speckle(f, rand, 1200, 0.08);
}

// Dull patinated metal: scratches and rust specks.
function paintMetal(f, rand, base) {
  const size = f.size;
  const patina = makeFbm(rand, 64);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = patina(x * inv * 8, y * inv * 8, 4) - 0.5;
      const i = y * size + x;
      f.r[i] = base[0] * (1 + p * 0.3) - p * 14;
      f.g[i] = base[1] * (1 + p * 0.34);
      f.b[i] = base[2] * (1 + p * 0.26) - p * 10;
      f.h[i] = 0.5 + p * 0.2;
    }
  }
  for (let s = 0; s < 14; s++)
    stroke(f, rand, {
      x0: rand() * size,
      y0: rand() * size,
      dirX: rand() - 0.5,
      dirY: rand() - 0.5,
      steps: 20 + rand() * 40,
      jitter: 0.12,
      color: [168, 172, 160],
      alpha: 0.28,
      dh: 0.1,
    });
  for (let r = 0; r < 46; r++)
    blot(f, rand() * size, rand() * size, 1 + rand() * 3, [96, 54, 28], 0.6, -0.06);
  for (let r = 0; r < 4; r++)
    blot(f, rand() * size, rand() * size, 10 + rand() * 20, [82, 48, 26], 0.3, -0.05);
  speckle(f, rand, 350, 0.08);
}

// Threadbare woven fabric with stains; wear flattens the weave.
function paintFabric(f, rand, base) {
  const size = f.size;
  const wear = makeFbm(rand, 64);
  const fiber = makeFbm(rand, 64);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const over = (x % 4 < 2) !== (y % 4 < 2) ? 1 : -1;
      const amp = 0.25 + 0.75 * wear(x * inv * 5, y * inv * 5, 3);
      const th = (fiber(x * inv * 80, y * inv * 80, 2) - 0.5) * 0.14;
      const l = 1 + over * 0.09 * amp + th;
      const i = y * size + x;
      f.r[i] = base[0] * l;
      f.g[i] = base[1] * l;
      f.b[i] = base[2] * l;
      f.h[i] = 0.5 + over * 0.12 * amp + th;
    }
  }
  for (let s = 0; s < 5; s++)
    blot(f, rand() * size, rand() * size, 18 + rand() * 40, [22, 16, 13], 0.3, -0.04);
  speckle(f, rand, 700, 0.1);
}

// Peeling paint over dark undercoat: start from grimy plaster, then flake
// patches away — dark exposed plaster inside, pale curled paint lip around
// the edge — plus long drips running from the worst patches.
function paintPeeling(f, rand, base) {
  paintPlaster(f, rand, base, 0.5);
  const size = f.size;
  const patches = 7 + Math.round(rand() * 4);
  for (let p = 0; p < patches; p++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = 14 + rand() * 42;
    // Pale curled lip first, then the dark exposed core punched inside it.
    blot(f, cx, cy, r * 1.25, [168, 162, 148], 0.5, 0.2);
    blot(f, cx + (rand() - 0.5) * 6, cy + (rand() - 0.5) * 6, r,
      [38, 33, 27], 0.9, -0.3);
    // Hairline crack radiating off the flake.
    stroke(f, rand, {
      x0: cx,
      y0: cy,
      dirX: rand() - 0.5,
      dirY: 0.5 + rand(),
      steps: 30 + rand() * 40,
      jitter: 0.6,
      color: [18, 16, 14],
      alpha: 0.5,
      dh: -0.2,
    });
    // Grime drip running down from the patch.
    const dripLen = 40 + rand() * 90;
    for (let y = 0; y < dripLen; y++)
      blendPx(f, cx + (rand() - 0.5) * 2, cy + r * 0.6 + y, 26, 25, 21,
        0.35 * (1 - y / dripLen), -0.04);
  }
  speckle(f, rand, 900, 0.1);
}

// Long claw drags: tight groups of parallel diagonal gouges torn through the
// plaster, each with a bright torn lip above the dark groove.
function paintScratches(f, rand, base) {
  paintPlaster(f, rand, base, 0.35);
  const size = f.size;
  const groups = 4;
  for (let g = 0; g < groups; g++) {
    const x0 = rand() * size * 0.7;
    const y0 = size * 0.12 + rand() * size * 0.3;
    const dirX = 0.25 + rand() * 0.35; // dragging down-right
    const dirY = 0.9;
    const claws = 3 + (rand() < 0.5 ? 1 : 0);
    const spread = 9 + rand() * 7;
    for (let c = 0; c < claws; c++) {
      const ox = c * spread;
      const steps = 90 + rand() * 70;
      // Torn pale lip just above the gouge...
      stroke(f, rand, {
        x0: x0 + ox - 1, y0: y0 - 1, dirX, dirY, steps,
        jitter: 0.1, color: [150, 146, 134], alpha: 0.5, width: 1, dh: 0.22,
      });
      // ...and the deep dark groove itself.
      stroke(f, rand, {
        x0: x0 + ox, y0, dirX, dirY, steps,
        jitter: 0.1, color: [12, 10, 9], alpha: 0.85, width: 2, dh: -0.42,
      });
    }
  }
  speckle(f, rand, 500, 0.08);
}

// A child's drawing in wax crayon on yellowed paper. ORIGINAL content, drawn
// so it reads wrong: a house, a sun, a small family holding hands — and a
// fourth, far taller figure scribbled in black standing just outside the
// house, watching. Tape smudges darken the corners.
function paintDrawing(f, rand) {
  const size = f.size;
  const fiber = makeFbm(rand, 64);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (fiber(x * inv * 40, y * inv * 40, 2) - 0.5) * 0.08;
      const age = fiber(x * inv * 4, y * inv * 4, 3) * 0.12; // yellowing
      const i = y * size + x;
      f.r[i] = 228 * (1 - age * 0.3 + t);
      f.g[i] = 220 * (1 - age * 0.5 + t);
      f.b[i] = 198 * (1 - age * 0.9 + t);
      f.h[i] = 0.5 + t;
    }
  }
  // Crayon line: short wobbly segments, double-struck like a child pressing.
  const crayon = (x0, y0, x1, y1, color, w = 2) => {
    const steps = Math.max(2, Math.hypot(x1 - x0, y1 - y0) | 0);
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const jx = (rand() - 0.5) * 2.4;
        const jy = (rand() - 0.5) * 2.4;
        for (let ww = 0; ww < w; ww++)
          blendPx(f, x0 + (x1 - x0) * t + jx + ww, y0 + (y1 - y0) * t + jy,
            color[0], color[1], color[2], 0.5, -0.03);
      }
    }
  };
  const u = size / 256; // layout in 256-space, scaled to the canvas
  const RED = [196, 64, 52];
  const BLUE = [64, 88, 172];
  const GREEN = [70, 130, 64];
  const YELL = [214, 178, 60];
  const BLACK = [24, 22, 24];
  // Ground and sun.
  crayon(10 * u, 218 * u, 246 * u, 220 * u, GREEN, 3);
  blot(f, 224 * u, 36 * u, 13 * u, YELL, 0.8, 0);
  for (let r = 0; r < 7; r++) {
    const a = (r / 7) * Math.PI * 2;
    crayon(224 * u + Math.cos(a) * 17 * u, 36 * u + Math.sin(a) * 17 * u,
      224 * u + Math.cos(a) * 27 * u, 36 * u + Math.sin(a) * 27 * u, YELL, 1);
  }
  // House with a door and one window.
  crayon(30 * u, 150 * u, 30 * u, 216 * u, RED, 2);
  crayon(100 * u, 150 * u, 100 * u, 216 * u, RED, 2);
  crayon(30 * u, 216 * u, 100 * u, 216 * u, RED, 2);
  crayon(30 * u, 150 * u, 65 * u, 118 * u, RED, 2);
  crayon(65 * u, 118 * u, 100 * u, 150 * u, RED, 2);
  crayon(55 * u, 216 * u, 55 * u, 182 * u, BLUE, 2);
  crayon(55 * u, 182 * u, 72 * u, 182 * u, BLUE, 2);
  crayon(72 * u, 182 * u, 72 * u, 216 * u, BLUE, 2);
  crayon(82 * u, 165 * u, 94 * u, 165 * u, BLUE, 1);
  crayon(82 * u, 165 * u, 82 * u, 177 * u, BLUE, 1);
  crayon(94 * u, 165 * u, 94 * u, 177 * u, BLUE, 1);
  crayon(82 * u, 177 * u, 94 * u, 177 * u, BLUE, 1);
  // Family of three holding hands.
  const figure = (cx, headY, h, color) => {
    blot(f, cx, headY, 6 * u, color, 0.55, -0.02); // head
    crayon(cx, headY + 6 * u, cx, headY + h, color, 2); // body
    crayon(cx - 10 * u, headY + 14 * u, cx + 10 * u, headY + 14 * u, color, 1);
    crayon(cx, headY + h, cx - 8 * u, headY + h + 14 * u, color, 1);
    crayon(cx, headY + h, cx + 8 * u, headY + h + 14 * u, color, 1);
  };
  figure(136 * u, 176 * u, 26 * u, RED);
  figure(160 * u, 180 * u, 22 * u, BLUE);
  figure(182 * u, 184 * u, 18 * u, GREEN);
  crayon(136 * u, 190 * u, 182 * u, 196 * u, RED, 1); // held hands
  // The wrong one: a fourth figure, three times too tall, scribbled black,
  // standing beside the house. No held hand. It is looking at the family.
  for (let s = 0; s < 14; s++)
    crayon(108 * u + (rand() - 0.5) * 7 * u, 96 * u + rand() * 4 * u,
      108 * u + (rand() - 0.5) * 7 * u, 214 * u - rand() * 4 * u, BLACK, 2);
  blot(f, 108 * u, 88 * u, 9 * u, BLACK, 0.85, -0.03); // head
  blendPx(f, 105 * u, 87 * u, 236, 234, 228, 0.95, 0); // two pale eyes
  blendPx(f, 111 * u, 87 * u, 236, 234, 228, 0.95, 0);
  // Tape smudges in the corners.
  for (const [tx, ty] of [[10, 10], [size - 10, 10], [10, size - 10], [size - 10, size - 10]])
    blot(f, tx, ty, 14, [168, 158, 128], 0.5, 0.06);
}

// --- role table -------------------------------------------------------------

const C = {
  plaster: [88, 94, 86],
  plasterDark: [46, 51, 46],
  wainscot: [86, 64, 45],
  woodDark: [56, 40, 28],
  planks: [108, 95, 72],
  ceiling: [48, 54, 47],
  metal: [106, 110, 94],
  fabric: [78, 60, 52],
};

const ROLES = {
  wallPlaster: {
    size: 512,
    repeat: [2, 1],
    mat: { roughness: 0.95, metalness: 0, bumpScale: 0.03 },
    paint: (f, rand) => paintPlaster(f, rand, C.plaster, 0),
  },
  wainscot: {
    size: 256,
    repeat: [2, 1],
    mat: { roughness: 0.78, metalness: 0, bumpScale: 0.025 },
    paint: (f, rand) => paintWood(f, rand, C.wainscot, { knots: 3, varnish: 0.3 }),
  },
  woodDark: {
    size: 256,
    repeat: [1, 1],
    mat: { roughness: 0.85, metalness: 0, bumpScale: 0.02 },
    paint: (f, rand) => paintWood(f, rand, C.woodDark, { knots: 5, varnish: 0.16 }),
  },
  floorPlanks: {
    size: 512,
    repeat: [2, 2],
    mat: { roughness: 0.9, metalness: 0, bumpScale: 0.04 },
    paint: (f, rand) => paintPlanks(f, rand, C.planks),
  },
  ceiling: {
    size: 256,
    repeat: [2, 2],
    mat: { roughness: 1, metalness: 0, bumpScale: 0.02 },
    paint: (f, rand) => paintCeiling(f, rand, C.ceiling),
  },
  metalAged: {
    size: 256,
    repeat: [1, 1],
    mat: { roughness: 0.55, metalness: 0.45, bumpScale: 0.02 },
    paint: (f, rand) => paintMetal(f, rand, C.metal),
  },
  fabricWorn: {
    size: 256,
    repeat: [3, 3],
    mat: { roughness: 1, metalness: 0, bumpScale: 0.03 },
    paint: (f, rand) => paintFabric(f, rand, C.fabric),
  },
  corridorWall: {
    size: 512,
    repeat: [2, 1],
    mat: { roughness: 1, metalness: 0, bumpScale: 0.035 },
    paint: (f, rand) => paintPlaster(f, rand, C.plasterDark, 1),
    // Shares wallPlaster's bump texture instance (same plaster family;
    // saves one 512x512 GPU upload on Quest).
    bumpFrom: "wallPlaster",
  },
  // Decay set — peeling paint, claw drags and the taped-up drawing.
  wallDamaged: {
    size: 512,
    repeat: [1, 1],
    mat: { roughness: 0.97, metalness: 0, bumpScale: 0.045 },
    paint: (f, rand) => paintPeeling(f, rand, C.plaster),
  },
  scratchedPlaster: {
    size: 512,
    repeat: [1, 1],
    mat: { roughness: 0.95, metalness: 0, bumpScale: 0.05 },
    paint: (f, rand) => paintScratches(f, rand, C.plaster),
  },
  paperDrawing: {
    size: 256,
    repeat: [1, 1],
    mat: { roughness: 1, metalness: 0, bumpScale: 0.01 },
    paint: (f, rand) => paintDrawing(f, rand),
  },
};

// Flat fallback colors (match environment.mjs defaults) for headless Node.
const FLAT = {
  wallPlaster: { color: 0x3d433c, roughness: 1 },
  wainscot: { color: 0x34281d, roughness: 0.85 },
  woodDark: { color: 0x251a12, roughness: 0.9 },
  floorPlanks: { color: 0x463d2f, roughness: 0.95 },
  ceiling: { color: 0x20251f, roughness: 1 },
  metalAged: { color: 0x565a4b, roughness: 0.7, metalness: 0.3 },
  fabricWorn: { color: 0x3b2d27, roughness: 1 },
  corridorWall: { color: 0x1a1e1b, roughness: 1 },
  wallDamaged: { color: 0x37392f, roughness: 1 },
  scratchedPlaster: { color: 0x3a403a, roughness: 1 },
  paperDrawing: { color: 0xcfc8b4, roughness: 1 },
};

// --- library ----------------------------------------------------------------

export function createMaterialLibrary(THREE, { createCanvas, seed = 1337 } = {}) {
  let makeCanvas = createCanvas;
  if (!makeCanvas && typeof document !== "undefined") {
    makeCanvas = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    };
  }

  const materials = {};
  const ownedTextures = new Set();
  const ownedMaterials = [];

  // Headless fallback: no DOM, nothing injected — flat tuned materials.
  if (!makeCanvas) {
    for (const [key, def] of Object.entries(FLAT)) {
      const m = new THREE.MeshStandardMaterial(def);
      materials[key] = m;
      ownedMaterials.push(m);
    }
    return { materials, dispose: () => disposeAll(ownedTextures, ownedMaterials) };
  }

  // Paint a field into two canvases (color + bump) and wrap as textures.
  const paintToCanvas = (size, bytes) => {
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx || typeof ctx.putImageData !== "function") return null;
    // Real 2d contexts provide createImageData; minimal stubs may not, in
    // which case a plain { data, width, height } record is handed over.
    const image =
      typeof ctx.createImageData === "function"
        ? ctx.createImageData(size, size)
        : { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
    image.data.set(bytes);
    ctx.putImageData(image, 0, 0);
    return canvas;
  };

  const makeTexture = (canvas, { srgb, repeat, anisotropy = 4 }) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    tex.repeat.set(repeat[0], repeat[1]);
    ownedTextures.add(tex);
    return tex;
  };

  const entries = Object.entries(ROLES);
  const bumpByKey = {};
  let canvasBroken = false;

  for (let i = 0; i < entries.length; i++) {
    const [key, role] = entries[i];
    if (canvasBroken) break;
    // Independent PRNG per role so paint order never shifts another role.
    const rand = makeNoise((seed + i * 0x9e3779b9) >>> 0);
    const field = createField(role.size);
    role.paint(field, rand);
    const { color, bump } = fieldToBuffers(field);
    const colorCanvas = paintToCanvas(role.size, color);
    if (!colorCanvas) {
      canvasBroken = true;
      break;
    }
    const map = makeTexture(colorCanvas, { srgb: true, repeat: role.repeat });
    let bumpMap;
    if (role.bumpFrom && bumpByKey[role.bumpFrom]) {
      bumpMap = bumpByKey[role.bumpFrom]; // shared instance
    } else {
      const bumpCanvas = paintToCanvas(role.size, bump);
      bumpMap = bumpCanvas
        ? makeTexture(bumpCanvas, { srgb: false, repeat: role.repeat })
        : null;
    }
    bumpByKey[key] = bumpMap;
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughness: role.mat.roughness,
      metalness: role.mat.metalness,
    });
    if (bumpMap) {
      mat.bumpMap = bumpMap;
      mat.bumpScale = role.mat.bumpScale;
    }
    materials[key] = mat;
    ownedMaterials.push(mat);
  }

  // A createCanvas that yields no usable 2d context degrades to flat, too.
  if (canvasBroken) {
    for (const tex of ownedTextures) tex.dispose();
    ownedTextures.clear();
    for (const m of ownedMaterials) m.dispose();
    ownedMaterials.length = 0;
    for (const [key, def] of Object.entries(FLAT)) {
      const m = new THREE.MeshStandardMaterial(def);
      materials[key] = m;
      ownedMaterials.push(m);
    }
  }

  return { materials, dispose: () => disposeAll(ownedTextures, ownedMaterials) };
}

function disposeAll(textures, mats) {
  for (const tex of textures) tex.dispose();
  textures.clear();
  for (const m of mats) m.dispose();
  mats.length = 0;
}
