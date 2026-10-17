// atmosphere.mjs — scene-space mood grading for the haunted room.
//
// WebXR constraint: NO post-processing, EffectComposer or render targets.
// Everything here is plain scene state — fog density/color, light colors and
// intensities, scene background — which is stereo-safe by construction, plus
// one OPTIONAL desktop-only DOM vignette that is hidden whenever the session
// is presenting in XR.
//
// The app owns the lights and passes them in; this module only writes values:
//   const atmosphere = createAtmosphere(THREE, { scene, ambient, lamp, windowLight });
//   atmosphere.setDomOverlay(true);
//   atmosphere.update(dt, time, visuals); // every frame
//   atmosphere.setPreset("cold");         // on UI change — values GLIDE over
//
// Every live value is exponentially smoothed toward its target with a ~2s
// time constant, so preset switches and tension swings never pop.

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const lerp = (a, b, t) => a + (b - a) * t;

// Each preset is flat, frozen data (colors as hex strings) so it can be
// inspected, serialized or diffed without touching THREE.
export const ATMOSPHERES = Object.freeze({
  // The default green-teal haunted study. At tension 0 this matches the
  // app's construction-time baseline (ambient 0.65, lamp 20, window 8).
  observatory: Object.freeze({
    label: "Observatory",
    background: "#0a100f",
    fog: "#18221e",
    fogBase: 0.035,
    fogFear: 0.135,
    ambientSky: "#99b1a2",
    ambientGround: "#10130e",
    ambientBase: 0.65,
    ambientFear: 0.15,
    lampColor: "#f0d6a0",
    lampBase: 20,
    lampFear: 3,
    flickerDepth: 0.25,
    windowColor: "#759fa4",
    windowBase: 8,
    windowFear: 4,
    tensionCurve: 1.4,
  }),
  // Moonlit blue-grey: the pale window moonlight dominates, the lamp is a
  // weak cool glow, shadows fall to near-black blue, fog is thin and crisp.
  cold: Object.freeze({
    label: "Cold",
    background: "#05070d",
    fog: "#0b111c",
    fogBase: 0.02,
    fogFear: 0.08,
    ambientSky: "#8fa3c0",
    ambientGround: "#05070c",
    ambientBase: 0.45,
    ambientFear: 0.1,
    lampColor: "#cfd8e6",
    lampBase: 7,
    lampFear: 1.5,
    flickerDepth: 0.15,
    windowColor: "#bcd2f0",
    windowBase: 16,
    windowFear: 7,
    tensionCurve: 1.2,
  }),
  // Dying firelight: strong warm orange lamp with a deep, unsteady flicker,
  // red-brown background and heavy smoky fog, window reduced to a faint
  // warm glimmer.
  ember: Object.freeze({
    label: "Ember",
    background: "#120806",
    fog: "#241009",
    fogBase: 0.055,
    fogFear: 0.18,
    ambientSky: "#b08264",
    ambientGround: "#160a06",
    ambientBase: 0.5,
    ambientFear: 0.12,
    lampColor: "#ff9a3c",
    lampBase: 24,
    lampFear: 4,
    flickerDepth: 0.45,
    windowColor: "#c08a5a",
    windowBase: 2.5,
    windowFear: 1,
    tensionCurve: 1.6,
  }),
});

export const DEFAULT_PRESET = "observatory";

export function createAtmosphere(
  THREE,
  { scene, ambient, lamp, windowLight },
  options = {},
) {
  // ~2s exponential time constant: one update step only moves values
  // partially, so preset changes glide instead of popping.
  const tau = options.timeConstant > 0 ? options.timeConstant : 2;

  let presetName = ATMOSPHERES[options.preset] ? options.preset : DEFAULT_PRESET;
  let preset = ATMOSPHERES[presetName];

  // ---- preallocated colors: zero per-frame allocations -------------------
  const live = {
    background: new THREE.Color(preset.background),
    fog: new THREE.Color(preset.fog),
    ambientSky: new THREE.Color(preset.ambientSky),
    ambientGround: new THREE.Color(preset.ambientGround),
    lamp: new THREE.Color(preset.lampColor),
    window: new THREE.Color(preset.windowColor),
  };
  const target = {
    background: new THREE.Color(preset.background),
    fog: new THREE.Color(preset.fog),
    ambientSky: new THREE.Color(preset.ambientSky),
    ambientGround: new THREE.Color(preset.ambientGround),
    lamp: new THREE.Color(preset.lampColor),
    window: new THREE.Color(preset.windowColor),
  };

  // Seed live state from the actual scene/lights when available so attaching
  // the atmosphere never visibly jumps at startup.
  if (scene && scene.background && scene.background.isColor) {
    live.background.copy(scene.background);
  }
  if (scene && scene.fog && scene.fog.color) live.fog.copy(scene.fog.color);
  if (ambient) {
    if (ambient.color) live.ambientSky.copy(ambient.color);
    if (ambient.groundColor) live.ambientGround.copy(ambient.groundColor);
  }
  if (lamp && lamp.color) live.lamp.copy(lamp.color);
  if (windowLight && windowLight.color) live.window.copy(windowLight.color);

  const scalars = {
    fogDensity:
      scene && scene.fog && Number.isFinite(scene.fog.density)
        ? scene.fog.density
        : preset.fogBase,
    ambient: ambient && Number.isFinite(ambient.intensity)
      ? ambient.intensity
      : preset.ambientBase,
    lamp: lamp && Number.isFinite(lamp.intensity)
      ? lamp.intensity
      : preset.lampBase,
    window: windowLight && Number.isFinite(windowLight.intensity)
      ? windowLight.intensity
      : preset.windowBase,
    vignette: 0, // smoothed shaped tension driving overlay opacity
  };

  function retarget() {
    target.background.set(preset.background);
    target.fog.set(preset.fog);
    target.ambientSky.set(preset.ambientSky);
    target.ambientGround.set(preset.ambientGround);
    target.lamp.set(preset.lampColor);
    target.window.set(preset.windowColor);
  }
  retarget();

  // ---- optional desktop-only DOM vignette --------------------------------
  let overlayEnabled = false;
  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl || typeof document === "undefined") return;
    overlayEl = document.createElement("div");
    overlayEl.setAttribute?.("data-atmosphere-overlay", "");
    overlayEl.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:5;" +
      "background:radial-gradient(ellipse at center," +
      "rgba(0,0,0,0) 42%,rgba(0,0,0,0.85) 100%);" +
      "opacity:0.15;";
    if (document.body) document.body.appendChild(overlayEl);
  }

  function setDomOverlay(enabled) {
    overlayEnabled = !!enabled;
    if (overlayEnabled) ensureOverlay();
    if (overlayEl && !overlayEnabled) overlayEl.style.display = "none";
  }

  function setPreset(name) {
    if (!Object.prototype.hasOwnProperty.call(ATMOSPHERES, name)) return false;
    presetName = name;
    preset = ATMOSPHERES[name];
    retarget(); // live values glide toward the new targets in update()
    return true;
  }

  const TAU2PI_7 = (Math.PI * 2) / 7; // ~7 s fog "breathing" period at PEAK

  function update(dt, time, visuals = {}) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const t0 = Number.isFinite(time) ? time : 0;

    // WAIT (idle / stale feed) forces tension toward zero.
    let t = visuals.state === "WAIT" ? 0 : clamp01(visuals.tension);
    const shaped = Math.pow(t, preset.tensionCurve);

    const lightingOn = visuals.lighting !== false;
    const fogOn = visuals.fog !== false;

    // ---- scalar targets ---------------------------------------------------
    let fogTarget = fogOn
      ? lerp(preset.fogBase, preset.fogFear, shaped)
      : preset.fogBase;
    if (fogOn && visuals.state === "PEAK") {
      fogTarget *= 1 + 0.1 * Math.sin(t0 * TAU2PI_7); // slow +/-10% breathing
    }

    let ambientTarget = preset.ambientBase;
    let lampTarget = preset.lampBase;
    let windowTarget = preset.windowBase;
    if (lightingOn) {
      ambientTarget = lerp(preset.ambientBase, preset.ambientFear, shaped);
      windowTarget = lerp(preset.windowBase, preset.windowFear, shaped);
      // Gentle flicker: two slow incommensurate sines, depth scaled by
      // tension, and the 2s smoothing below damps it further — never strobes.
      const flicker =
        1 -
        preset.flickerDepth *
          shaped *
          (0.5 + 0.5 * Math.sin(t0 * 3.7) * Math.sin(t0 * 2.1));
      lampTarget = lerp(preset.lampBase, preset.lampFear, shaped) * flicker;
    }

    // ---- exponential smoothing (~tau seconds) ------------------------------
    const k = 1 - Math.exp(-step / tau);
    scalars.fogDensity += (fogTarget - scalars.fogDensity) * k;
    scalars.ambient += (ambientTarget - scalars.ambient) * k;
    scalars.lamp += (lampTarget - scalars.lamp) * k;
    scalars.window += (windowTarget - scalars.window) * k;
    scalars.vignette += (shaped - scalars.vignette) * k;

    live.background.lerp(target.background, k);
    live.fog.lerp(target.fog, k);
    live.ambientSky.lerp(target.ambientSky, k);
    live.ambientGround.lerp(target.ambientGround, k);
    live.lamp.lerp(target.lamp, k);
    live.window.lerp(target.window, k);

    // ---- apply to the scene ------------------------------------------------
    if (scene) {
      if (scene.background && scene.background.isColor) {
        scene.background.copy(live.background);
      } else {
        scene.background = live.background;
      }
      if (scene.fog) {
        if (scene.fog.color) scene.fog.color.copy(live.fog);
        if ("density" in scene.fog) scene.fog.density = scalars.fogDensity;
      }
    }
    if (ambient) {
      if (ambient.color) ambient.color.copy(live.ambientSky);
      if (ambient.groundColor) ambient.groundColor.copy(live.ambientGround);
      ambient.intensity = scalars.ambient;
    }
    if (lamp) {
      if (lamp.color) lamp.color.copy(live.lamp);
      lamp.intensity = scalars.lamp;
    }
    if (windowLight) {
      if (windowLight.color) windowLight.color.copy(live.window);
      windowLight.intensity = scalars.window;
    }

    // ---- overlay: desktop only, hidden while presenting in XR --------------
    if (overlayEl) {
      if (!overlayEnabled || visuals.xrPresenting) {
        overlayEl.style.display = "none";
      } else {
        overlayEl.style.display = "block";
        overlayEl.style.opacity = String(0.15 + 0.5 * scalars.vignette);
      }
    }
  }

  function dispose() {
    if (overlayEl) {
      if (overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = null;
    }
    overlayEnabled = false;
  }

  return {
    setPreset,
    getPreset: () => presetName,
    update,
    setDomOverlay,
    get overlayElement() {
      return overlayEl;
    },
    dispose,
  };
}
