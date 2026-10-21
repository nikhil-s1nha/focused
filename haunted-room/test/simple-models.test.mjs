import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { loadFigureModel, figureManifest, validateManifestEntry, dispose, countTriangles, LIMITS } from "../public/simple/models.mjs";
import { createFaceTexture, createLungeFace } from "../public/simple/face-texture.mjs";

const entry = (id, extra = {}) => ({
  id, file: `${id}.glb`, license: "CC0-1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  author: "t", sourceUrl: "https://example.com", attribution: "t", triangles: 12, notes: "n", ...extra,
});
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
const fakeScene = ({ h = 5, tris = 12, tex = 0, y0 = 3 } = {}) => {
  const g = new THREE.BoxGeometry(1, h, 1);
  const m = new THREE.MeshBasicMaterial();
  if (tex) m.map = Object.assign(new THREE.Texture(), { image: { width: tex, height: tex } });
  const mesh = new THREE.Mesh(g, m); mesh.position.set(4, y0 + h / 2, -2);
  const scene = new THREE.Group(); scene.add(mesh);
  if (tris > 12) { const big = new THREE.BufferGeometry(); big.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tris * 9), 3)); scene.add(new THREE.Mesh(big, m)); }
  return scene;
};
const loaderOf = (scene) => ({ loadAsync: async () => ({ scene, animations: [] }) });

test("unknown id and failing loader return null", async () => {
  const manifest = { models: [entry("a")] };
  await quiet(async () => {
    assert.equal(await loadFigureModel(THREE, "nope", { manifest, loader: loaderOf(fakeScene()) }), null);
    assert.equal(await loadFigureModel(THREE, "a", { manifest, loader: { loadAsync: async () => { throw new Error("boom"); } } }), null);
    assert.equal(await loadFigureModel(THREE, "a", { manifest: { models: [{ id: "a" }] }, loader: loaderOf(fakeScene()) }), null);
  });
});

test("normalizes to ~1.9 m with feet at y=0 and centered", async () => {
  const g = await loadFigureModel(THREE, "a", { manifest: { models: [entry("a")] }, loader: loaderOf(fakeScene({ h: 5 })) });
  const box = new THREE.Box3().setFromObject(g);
  assert.ok(Math.abs(box.max.y - box.min.y - LIMITS.targetHeight) < 1e-6);
  assert.ok(Math.abs(box.min.y) < 1e-6);
  assert.ok(Math.abs((box.min.x + box.max.x) / 2) < 1e-6 && Math.abs((box.min.z + box.max.z) / 2) < 1e-6);
});

test("rejects oversized triangle counts and textures", async () => {
  const manifest = { models: [entry("a")] };
  await quiet(async () => {
    assert.equal(await loadFigureModel(THREE, "a", { manifest, loader: loaderOf(fakeScene({ tris: 60001 })) }), null);
    assert.equal(await loadFigureModel(THREE, "a", { manifest, loader: loaderOf(fakeScene({ tex: 4096 })) }), null);
  });
  assert.ok(await loadFigureModel(THREE, "a", { manifest, loader: loaderOf(fakeScene({ tex: 2048 })) }));
});

test("manifest shape validation, and the shipped manifest is valid", () => {
  assert.deepEqual(validateManifestEntry(entry("ok")), []);
  assert.ok(validateManifestEntry({ id: "x" }).length > 0);
  assert.ok(validateManifestEntry(entry("x", { file: "../evil.glb" })).length > 0);
  assert.ok(validateManifestEntry(entry("x", { licenseUrl: "http://x" })).length > 0);
  const real = JSON.parse(readFileSync(new URL("../public/models/manifest.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(real.models));
  const ids = new Set();
  for (const e of real.models) {
    assert.deepEqual(validateManifestEntry(e), [], e.id);
    assert.ok(!ids.has(e.id)); ids.add(e.id);
    assert.ok(/^CC0|^CC-BY/.test(e.license));
    assert.ok(e.triangles <= LIMITS.maxTriangles);
  }
  assert.deepEqual(figureManifest({ models: [] }), { models: [] });
});

test("face texture falls back to DataTexture in Node and is deterministic when painted", () => {
  const t = createFaceTexture(THREE, { seed: 3 });
  assert.ok(t.isDataTexture);
  // a stub canvas context proves the painter runs end to end without throwing
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === "createRadialGradient" || k === "createLinearGradient") ? () => ({ addColorStop() {} }) : (...a) => { calls.push(k); } , set: () => true });
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const t2 = createFaceTexture(THREE, { seed: 3, createCanvas: () => canvas, size: 256 });
  assert.ok(t2.isCanvasTexture);
  assert.ok(calls.length > 1000);
});

test("lunge face budget: <8k triangles, one material, one texture", () => {
  const f = createLungeFace(THREE, { seed: 1 });
  const tris = countTriangles(f);
  assert.ok(tris > 2000 && tris < 8000, `tris ${tris}`);
  assert.ok(!Array.isArray(f.material));
  assert.ok(f.material.map);
  f.userData.dispose();
});

test("dispose frees geometry, material and textures", () => {
  const g = new THREE.Group(); const f = createLungeFace(THREE); g.add(f);
  let n = 0;
  f.geometry.addEventListener("dispose", () => n++);
  f.material.addEventListener("dispose", () => n++);
  f.material.map.addEventListener("dispose", () => n++);
  dispose(g);
  assert.equal(n, 3);
});
