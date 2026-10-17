import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createDustMotes, createVolumetricCone } from "../public/volumetrics.mjs";

test("exports: createVolumetricCone is still present alongside the motes", () => {
  assert.equal(typeof createVolumetricCone, "function");
  assert.equal(typeof createDustMotes, "function");
});

test("dust motes: one Points draw call, count hard-capped at 200", () => {
  const motes = createDustMotes(THREE, { count: 5000 });
  assert.ok(motes.points.isPoints);
  assert.equal(motes.points.geometry.attributes.position.count, 200);
  motes.dispose();
  const small = createDustMotes(THREE, { count: 40 });
  assert.equal(small.points.geometry.attributes.position.count, 40);
  assert.equal(small.material.depthWrite, false, "never fights draw order");
  assert.equal(small.material.transparent, true);
  small.dispose();
});

test("motes spawn inside the cone volume and stay inside while drifting", () => {
  const height = 2.2;
  const radiusBottom = 0.9;
  const motes = createDustMotes(THREE, { count: 120, height, radiusBottom });
  const check = () => {
    const p = motes.points.geometry.attributes.position.array;
    for (let i = 0; i < 120; i++) {
      const y = -p[i * 3 + 1];
      assert.ok(y >= 0 && y <= height, `y in beam (${y})`);
      const r = Math.hypot(p[i * 3], p[i * 3 + 2]);
      assert.ok(
        r <= (y / height) * radiusBottom * 1.1 + 0.03,
        `radius ${r} within cone at depth ${y}`,
      );
    }
  };
  check();
  for (let t = 0; t < 30; t += 1 / 30) motes.update(1 / 30);
  check();
  motes.dispose();
});

test("update drifts positions in place with no reallocation", () => {
  const motes = createDustMotes(THREE, { count: 60 });
  const attr = motes.points.geometry.attributes.position;
  const before = Array.from(attr.array);
  const versionBefore = attr.version;
  motes.update(1 / 30);
  assert.equal(attr.array, motes.points.geometry.attributes.position.array);
  assert.ok(attr.version > versionBefore, "buffer flagged for re-upload");
  const after = Array.from(attr.array);
  assert.notDeepEqual(before, after, "motes actually moved");
  motes.update(NaN); // garbage dt is ignored, never corrupts the cloud
  motes.update(-1);
  for (const v of attr.array) assert.ok(Number.isFinite(v));
  motes.dispose();
});

test("agitate(): stirred dust moves much further, then settles back calm", () => {
  const travel = (motes, seconds) => {
    const p = motes.points.geometry.attributes.position.array;
    const before = Array.from(p);
    for (let t = 0; t < seconds; t += 1 / 30) motes.update(1 / 30);
    let sum = 0;
    for (let i = 0; i < p.length; i++) sum += Math.abs(p[i] - before[i]);
    return sum;
  };
  const calm = createDustMotes(THREE, { count: 100, seed: 7 });
  const calmTravel = travel(calm, 1);
  const stirred = createDustMotes(THREE, { count: 100, seed: 7 });
  stirred.agitate(1);
  assert.equal(stirred.turbulence, 1);
  const stirredTravel = travel(stirred, 1);
  assert.ok(
    stirredTravel > calmTravel * 2,
    `stirred ${stirredTravel} vs calm ${calmTravel}`,
  );
  // Turbulence decays on its own; agitate clamps garbage input.
  for (let t = 0; t < 4; t += 1 / 30) stirred.update(1 / 30);
  assert.equal(stirred.turbulence, 0, "settled");
  stirred.agitate(NaN);
  assert.equal(stirred.turbulence, 0);
  stirred.agitate(0.5);
  stirred.agitate(0.2); // weaker kick never reduces existing turbulence
  assert.equal(stirred.turbulence, 0.5);
  calm.dispose();
  stirred.dispose();
});

test("setIntensity scales opacity; dispose releases and update goes quiet", () => {
  const motes = createDustMotes(THREE, { count: 10 });
  const full = motes.material.opacity;
  motes.setIntensity(0.5);
  assert.ok(Math.abs(motes.material.opacity - full * 0.5) < 1e-9);
  motes.setIntensity(9);
  assert.ok(motes.material.opacity <= full + 1e-9, "clamped");
  let geoDisposed = false;
  motes.points.geometry.addEventListener("dispose", () => (geoDisposed = true));
  motes.dispose();
  assert.ok(geoDisposed);
  motes.update(1 / 30); // no-op after dispose
  motes.dispose(); // idempotent
});
