import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { makeNoise, createMaterialLibrary } from "../public/textures.mjs";

const KEYS = [
  "wallPlaster",
  "wainscot",
  "woodDark",
  "floorPlanks",
  "ceiling",
  "metalAged",
  "fabricWorn",
  "corridorWall",
];

// Minimal stub canvas: the 2d context only records putImageData payloads,
// which is exactly the surface textures.mjs paints through.
function makeStubCanvasFactory() {
  const calls = [];
  const createCanvas = (width, height) => {
    const canvas = {
      width,
      height,
      stub: true,
      getContext(type) {
        if (type !== "2d") return null;
        return {
          putImageData(image, dx, dy) {
            calls.push({ canvas, image, dx, dy });
          },
        };
      },
    };
    return canvas;
  };
  return { createCanvas, calls };
}

test("makeNoise: deterministic, in [0,1), seed-sensitive", () => {
  const a = makeNoise(42);
  const b = makeNoise(42);
  const c = makeNoise(43);
  const seqA = Array.from({ length: 50 }, a);
  const seqB = Array.from({ length: 50 }, b);
  const seqC = Array.from({ length: 50 }, c);
  assert.deepEqual(seqA, seqB, "same seed replays the same sequence");
  assert.notDeepEqual(seqA, seqC, "different seed diverges");
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
});

test("all 8 keys are MeshStandardMaterials with wrapped canvas map + bump", () => {
  const { createCanvas } = makeStubCanvasFactory();
  const lib = createMaterialLibrary(THREE, { createCanvas });
  assert.deepEqual(Object.keys(lib.materials).sort(), [...KEYS].sort());
  for (const key of KEYS) {
    const mat = lib.materials[key];
    assert.ok(mat.isMeshStandardMaterial, `${key} is MeshStandardMaterial`);
    for (const slot of ["map", "bumpMap"]) {
      const tex = mat[slot];
      assert.ok(tex && tex.isCanvasTexture, `${key}.${slot} is a CanvasTexture`);
      assert.equal(tex.wrapS, THREE.RepeatWrapping, `${key}.${slot} wrapS`);
      assert.equal(tex.wrapT, THREE.RepeatWrapping, `${key}.${slot} wrapT`);
      assert.equal(tex.anisotropy, 4, `${key}.${slot} anisotropy`);
      assert.ok(tex.image.stub, `${key}.${slot} backed by injected canvas`);
      const size = tex.image.width;
      assert.equal(tex.image.height, size, `${key}.${slot} square`);
      assert.ok(
        size >= 256 && size <= 512 && (size & (size - 1)) === 0,
        `${key}.${slot} power-of-two 256-512, got ${size}`,
      );
    }
    assert.equal(mat.map.colorSpace, THREE.SRGBColorSpace, `${key} map sRGB`);
    assert.notEqual(
      mat.bumpMap.colorSpace,
      THREE.SRGBColorSpace,
      `${key} bump stays linear`,
    );
    assert.ok(mat.map.repeat.x > 0 && mat.map.repeat.y > 0, `${key} repeat set`);
  }
  // Texture reuse across materials: corridorWall shares wallPlaster's bump.
  assert.equal(
    lib.materials.corridorWall.bumpMap,
    lib.materials.wallPlaster.bumpMap,
    "corridorWall reuses wallPlaster bump instance",
  );
  lib.dispose();
});

test("painting is deterministic per seed and seed-sensitive", () => {
  const paint = (seed) => {
    const { createCanvas, calls } = makeStubCanvasFactory();
    const lib = createMaterialLibrary(THREE, { createCanvas, seed });
    lib.dispose();
    assert.ok(calls.length >= 8, "painted at least one buffer per key");
    return calls.map((c) => c.image.data);
  };
  const a = paint(7);
  const b = paint(7);
  const c = paint(8);
  assert.equal(a.length, b.length);
  const N = 4096;
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(
      Array.from(a[i].slice(0, N)),
      Array.from(b[i].slice(0, N)),
      `same seed, identical bytes in painted buffer ${i}`,
    );
  }
  const differs = Array.from(a[0].slice(0, N)).some(
    (v, i) => v !== c[0][i],
  );
  assert.ok(differs, "different seed changes the painted pixels");
});

test("headless without createCanvas: flat materials, never throws", () => {
  assert.equal(typeof document, "undefined", "test expects no DOM");
  const lib = createMaterialLibrary(THREE);
  assert.deepEqual(Object.keys(lib.materials).sort(), [...KEYS].sort());
  for (const key of KEYS) {
    const mat = lib.materials[key];
    assert.ok(mat.isMeshStandardMaterial, `${key} flat MeshStandardMaterial`);
    assert.equal(mat.map, null, `${key} flat fallback has no map`);
  }
  lib.dispose();
});

test("broken 2d context also degrades to flat materials", () => {
  const lib = createMaterialLibrary(THREE, {
    createCanvas: (w, h) => ({ width: w, height: h, getContext: () => null }),
  });
  assert.deepEqual(Object.keys(lib.materials).sort(), [...KEYS].sort());
  for (const key of KEYS)
    assert.ok(lib.materials[key].isMeshStandardMaterial);
  lib.dispose();
});

test("dispose() disposes every created texture and material", () => {
  const { createCanvas } = makeStubCanvasFactory();
  const lib = createMaterialLibrary(THREE, { createCanvas });
  const textures = new Set();
  const mats = Object.values(lib.materials);
  for (const mat of mats) {
    textures.add(mat.map);
    textures.add(mat.bumpMap);
  }
  let texDisposed = 0;
  let matDisposed = 0;
  for (const tex of textures)
    tex.addEventListener("dispose", () => texDisposed++);
  for (const mat of mats)
    mat.addEventListener("dispose", () => matDisposed++);
  lib.dispose();
  assert.equal(texDisposed, textures.size, "every unique texture disposed");
  assert.equal(matDisposed, mats.length, "every material disposed");
});
