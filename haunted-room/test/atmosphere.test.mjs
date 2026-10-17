import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createAtmosphere,
  ATMOSPHERES,
  DEFAULT_PRESET,
} from "../public/atmosphere.mjs";

const visuals = (over = {}) => ({
  tension: 0,
  state: "BUILD",
  elapsed: 0,
  lighting: true,
  fog: true,
  shadow: true,
  shadowPosition: "back",
  quality: 1,
  phase: 0,
  xrPresenting: false,
  ...over,
});

// Build the same rig app.mjs owns: scene with Color background + FogExp2,
// hemisphere ambient, warm lamp point light, cool window point light.
function rig() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0a100f");
  scene.fog = new THREE.FogExp2(0x18221e, 0.055);
  const ambient = new THREE.HemisphereLight(0x99b1a2, 0x10130e, 0.65);
  const lamp = new THREE.PointLight(0xf0d6a0, 20, 12, 2);
  const windowLight = new THREE.PointLight(0x759fa4, 8, 9, 2);
  scene.add(ambient, lamp, windowLight);
  return { scene, ambient, lamp, windowLight };
}

// Run fixed-step updates long enough for the ~2s smoothing to converge.
function settle(atmo, v, seconds = 20, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) atmo.update(dt, t, v);
}

function colorDistance(color, hex) {
  const ref = new THREE.Color(hex);
  return (
    Math.abs(color.r - ref.r) +
    Math.abs(color.g - ref.g) +
    Math.abs(color.b - ref.b)
  );
}

test("ATMOSPHERES exposes the three presets with required keys", () => {
  assert.deepEqual(Object.keys(ATMOSPHERES).sort(), [
    "cold",
    "ember",
    "observatory",
  ]);
  const colorKeys = [
    "background",
    "fog",
    "ambientSky",
    "ambientGround",
    "lampColor",
    "windowColor",
  ];
  const numberKeys = [
    "fogBase",
    "fogFear",
    "ambientBase",
    "ambientFear",
    "lampBase",
    "lampFear",
    "flickerDepth",
    "windowBase",
    "windowFear",
    "tensionCurve",
  ];
  for (const [name, preset] of Object.entries(ATMOSPHERES)) {
    for (const key of colorKeys) {
      assert.equal(typeof preset[key], "string", `${name}.${key}`);
      assert.match(preset[key], /^#[0-9a-f]{6}$/i, `${name}.${key} hex`);
    }
    for (const key of numberKeys) {
      assert.ok(Number.isFinite(preset[key]), `${name}.${key} finite`);
    }
    assert.ok(preset.fogFear > preset.fogBase, `${name} fog rises with fear`);
    assert.ok(
      preset.ambientFear < preset.ambientBase,
      `${name} ambient falls with fear`,
    );
    assert.ok(preset.lampFear < preset.lampBase, `${name} lamp falls with fear`);
    assert.ok(Object.isFrozen(preset), `${name} frozen`);
  }
  assert.equal(DEFAULT_PRESET, "observatory");
});

test("observatory at tension 0 matches the app baseline closely", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  assert.equal(atmo.getPreset(), "observatory");
  settle(atmo, visuals({ tension: 0 }));
  const p = ATMOSPHERES.observatory;
  assert.ok(Math.abs(parts.ambient.intensity - p.ambientBase) < 0.02);
  assert.ok(Math.abs(parts.lamp.intensity - p.lampBase) < 0.5);
  assert.ok(Math.abs(parts.windowLight.intensity - p.windowBase) < 0.2);
  assert.ok(Math.abs(parts.scene.fog.density - p.fogBase) < 0.005);
  assert.ok(colorDistance(parts.scene.background, p.background) < 0.03);
  assert.ok(colorDistance(parts.scene.fog.color, p.fog) < 0.03);
  assert.ok(colorDistance(parts.lamp.color, p.lampColor) < 0.03);
});

test("setPreset('cold') glides scene colors to the cold targets", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  settle(atmo, visuals());
  assert.equal(atmo.setPreset("cold"), true);
  assert.equal(atmo.getPreset(), "cold");
  settle(atmo, visuals());
  const p = ATMOSPHERES.cold;
  assert.ok(colorDistance(parts.scene.background, p.background) < 0.03);
  assert.ok(colorDistance(parts.scene.fog.color, p.fog) < 0.03);
  assert.ok(colorDistance(parts.lamp.color, p.lampColor) < 0.03);
  assert.ok(colorDistance(parts.windowLight.color, p.windowColor) < 0.03);
  assert.ok(Math.abs(parts.lamp.intensity - p.lampBase) < 0.3);
  assert.ok(Math.abs(parts.windowLight.intensity - p.windowBase) < 0.5);
});

test("high tension dims ambient and lamp and thickens fog vs calm", () => {
  for (const name of Object.keys(ATMOSPHERES)) {
    const calm = rig();
    const calmAtmo = createAtmosphere(THREE, calm, { preset: name });
    settle(calmAtmo, visuals({ tension: 0 }));

    const afraid = rig();
    const afraidAtmo = createAtmosphere(THREE, afraid, { preset: name });
    settle(afraidAtmo, visuals({ tension: 1 }));

    assert.ok(
      afraid.ambient.intensity < calm.ambient.intensity,
      `${name} ambient dims`,
    );
    assert.ok(afraid.lamp.intensity < calm.lamp.intensity, `${name} lamp dims`);
    assert.ok(
      afraid.scene.fog.density > calm.scene.fog.density,
      `${name} fog thickens`,
    );
  }
});

test("WAIT forces the atmosphere back to base even with tension input", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  settle(atmo, visuals({ tension: 1 }));
  assert.ok(parts.lamp.intensity < 10, "frightened first");
  settle(atmo, visuals({ tension: 1, state: "WAIT" }));
  const p = ATMOSPHERES.observatory;
  assert.ok(Math.abs(parts.ambient.intensity - p.ambientBase) < 0.02);
  assert.ok(Math.abs(parts.lamp.intensity - p.lampBase) < 0.5);
  assert.ok(Math.abs(parts.scene.fog.density - p.fogBase) < 0.005);
});

test("lighting:false holds lights near base through tension 1", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  settle(atmo, visuals({ tension: 1, lighting: false }));
  const p = ATMOSPHERES.observatory;
  assert.ok(Math.abs(parts.lamp.intensity - p.lampBase) < 0.5);
  assert.ok(Math.abs(parts.ambient.intensity - p.ambientBase) < 0.02);
  assert.ok(Math.abs(parts.windowLight.intensity - p.windowBase) < 0.2);
  // fog still reacts (only lighting was disabled)
  assert.ok(parts.scene.fog.density > p.fogBase + 0.03);
});

test("fog:false holds density at base through tension 1", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  settle(atmo, visuals({ tension: 1, fog: false }));
  const p = ATMOSPHERES.observatory;
  assert.ok(Math.abs(parts.scene.fog.density - p.fogBase) < 0.005);
  // lights still react
  assert.ok(parts.lamp.intensity < 10);
});

test("PEAK adds slow fog breathing around the fear density", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  settle(atmo, visuals({ tension: 1, state: "PEAK" }), 30);
  // Sample one full ~7s breathing cycle and confirm the density oscillates.
  let min = Infinity;
  let max = -Infinity;
  for (let t = 30; t < 38; t += 1 / 30) {
    atmo.update(1 / 30, t, visuals({ tension: 1, state: "PEAK" }));
    min = Math.min(min, parts.scene.fog.density);
    max = Math.max(max, parts.scene.fog.density);
  }
  assert.ok(max - min > 0.005, `breathes (${min} .. ${max})`);
  const p = ATMOSPHERES.observatory;
  assert.ok(min > p.fogBase, "stays well above base");
  assert.ok(max < p.fogFear * 1.12, "never exceeds +10% envelope by much");
});

test("unknown preset returns false and keeps the current preset", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  atmo.setPreset("cold");
  assert.equal(atmo.setPreset("volcano"), false);
  assert.equal(atmo.setPreset(""), false);
  assert.equal(atmo.setPreset("toString"), false); // prototype key guard
  assert.equal(atmo.getPreset(), "cold");
  settle(atmo, visuals());
  assert.ok(colorDistance(parts.scene.background, ATMOSPHERES.cold.background) < 0.03);
});

test("smoothing: one step only moves values part way (no popping)", () => {
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  settle(atmo, visuals());
  const lampBefore = parts.lamp.intensity;
  atmo.setPreset("ember");
  atmo.update(0.1, 0, visuals());
  const p = ATMOSPHERES.ember;
  const moved = Math.abs(parts.lamp.intensity - lampBefore);
  const remaining = Math.abs(p.lampBase - parts.lamp.intensity);
  assert.ok(moved > 0, "moved at all");
  assert.ok(remaining > Math.abs(p.lampBase - lampBefore) * 0.5, "most of the gap remains");
  // Relative check: after one 0.1s step most of the color gap must remain.
  const bgGap = colorDistance(parts.scene.background, p.background);
  const bgTotal = colorDistance(
    new THREE.Color(ATMOSPHERES.observatory.background),
    p.background,
  );
  assert.ok(bgGap > bgTotal * 0.5, "background still gliding");
});

test("headless: imports and updates without document; overlay is a no-op", () => {
  assert.equal(typeof document, "undefined");
  const parts = rig();
  const atmo = createAtmosphere(THREE, parts);
  atmo.setDomOverlay(true); // must not throw without a DOM
  assert.equal(atmo.overlayElement, null);
  atmo.update(1 / 60, 0, visuals({ tension: 0.5 }));
  atmo.update(1 / 60, 0.016); // visuals omitted entirely
  atmo.dispose();
});

test("overlay: created lazily, opacity tracks tension, hidden in XR, removed on dispose", () => {
  // Minimal fake DOM so the overlay path runs under node.
  const body = {
    children: [],
    appendChild(el) {
      el.parentNode = body;
      body.children.push(el);
    },
    removeChild(el) {
      body.children = body.children.filter((c) => c !== el);
      el.parentNode = null;
    },
  };
  globalThis.document = {
    body,
    createElement: () => ({ style: {}, setAttribute() {}, parentNode: null }),
  };
  try {
    const parts = rig();
    const atmo = createAtmosphere(THREE, parts);
    assert.equal(atmo.overlayElement, null);
    atmo.setDomOverlay(true);
    const el = atmo.overlayElement;
    assert.ok(el, "created on enable");
    assert.equal(el.parentNode, body);
    assert.match(el.style.cssText, /pointer-events:none/);
    assert.match(el.style.cssText, /z-index:5/);
    assert.match(el.style.cssText, /radial-gradient/);

    settle(atmo, visuals({ tension: 0 }));
    assert.equal(el.style.display, "block");
    assert.ok(Math.abs(parseFloat(el.style.opacity) - 0.15) < 0.02);

    settle(atmo, visuals({ tension: 1 }));
    assert.ok(parseFloat(el.style.opacity) > 0.55, "darkens with tension");

    atmo.update(1 / 60, 0, visuals({ tension: 1, xrPresenting: true }));
    assert.equal(el.style.display, "none", "hidden while presenting in XR");

    atmo.update(1 / 60, 0.016, visuals({ tension: 1 }));
    assert.equal(el.style.display, "block", "returns after XR exit");

    atmo.setDomOverlay(false);
    atmo.update(1 / 60, 0.032, visuals({ tension: 1 }));
    assert.equal(el.style.display, "none", "disabled hides it");

    atmo.dispose();
    assert.equal(atmo.overlayElement, null);
    assert.equal(body.children.length, 0, "removed from DOM");
  } finally {
    delete globalThis.document;
  }
});
