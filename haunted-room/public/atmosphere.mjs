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
  // Lockdown: oppressive near-black dread. Ambient collapses toward nothing
  // as tension climbs, the window is a dead pane, and the only readable thing
  // in the room is the single warm pool under the lamp (which flickers hard).
  lockdown: Object.freeze({
    label: "Lockdown",
    background: "#020303",
    fog: "#050706",
    fogBase: 0.03,
    fogFear: 0.16,
    ambientSky: "#5c665e",
    ambientGround: "#030403",
    ambientBase: 0.22,
    ambientFear: 0.015,
    lampColor: "#ffc37a",
    lampBase: 16,
    lampFear: 7,
    flickerDepth: 0.55,
    windowColor: "#3d4a50",
    windowBase: 2,
    windowFear: 0.25,
    tensionCurve: 1.5,
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

  // ---- light failure: flicker / blackout / lights-cut ----------------------
  // These are transient multipliers applied AFTER the slow smoothing, so they
  // can be fast (a sputter must read as a sputter) without fighting the glide.
  let blackout = false; // sticky until setBlackout(false)
  let cutRemaining = 0; // seconds left of a lightsCut beat
  let blackLevel = 0; // smoothed 0..1 toward (blackout || cut) ? 1 : 0
  const flick = { remaining: 0, duration: 0, intensity: 0, pattern: "stutter" };
  let flickClock = 0; // advances only while a flicker runs

  // Deterministic per-step pseudo-random (no Math.random): integer hash.
  function hash01(n) {
    let h = (n | 0) ^ 0x5bf03635;
    h = Math.imul(h ^ (h >>> 13), 0x9e3779b1);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  /**
   * Trigger a light sputter. intensity 0..1 is how deep the lamp drops,
   * duration in seconds. pattern: "stutter" (fluorescent on/off chatter) or
   * "sag" (one smooth brown-out dip and recovery).
   */
  function flicker(intensity = 0.7, duration = 1.2, pattern = "stutter") {
    flick.intensity = clamp01(intensity);
    flick.duration = Number.isFinite(duration) && duration > 0 ? duration : 1;
    flick.remaining = flick.duration;
    flick.pattern = pattern === "sag" ? "sag" : "stutter";
    flickClock = 0;
  }

  /** Kill practically all light (tiny emissive remnants only) until false. */
  function setBlackout(on) {
    blackout = !!on;
  }

  /** Sudden all-lights-cut beat: instant darkness, restore after `seconds`. */
  function lightsCut(seconds = 1.5) {
    cutRemaining = Number.isFinite(seconds) && seconds > 0 ? seconds : 1.5;
    blackLevel = 1; // the cut itself is instantaneous — no glide down
  }

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
      const flickerMod =
        1 -
        preset.flickerDepth *
          shaped *
          (0.5 + 0.5 * Math.sin(t0 * 3.7) * Math.sin(t0 * 2.1));
      lampTarget = lerp(preset.lampBase, preset.lampFear, shaped) * flickerMod;
      // Lockdown grading at PEAK: ambient is pulled near-black and the window
      // dies, while the lamp keeps one warm readable pool under it.
      if (visuals.state === "PEAK") {
        ambientTarget *= 1 - 0.8 * shaped;
        windowTarget *= 1 - 0.6 * shaped;
      }
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

    // ---- light failure overlays (fast, post-smoothing) ----------------------
    if (cutRemaining > 0) cutRemaining = Math.max(0, cutRemaining - step);
    const blackTarget = blackout || cutRemaining > 0 ? 1 : 0;
    // Fast ~0.12s easing: darkness slams in, light crawls back.
    const kb = 1 - Math.exp(-step / (blackTarget > blackLevel ? 0.05 : 0.5));
    blackLevel += (blackTarget - blackLevel) * kb;
    let sputter = 1;
    if (flick.remaining > 0) {
      flick.remaining = Math.max(0, flick.remaining - step);
      flickClock += step;
      const p = clamp01(flickClock / flick.duration);
      if (flick.pattern === "sag") {
        // One smooth brown-out dip and recovery.
        sputter = 1 - flick.intensity * Math.sin(Math.PI * p);
      } else {
        // Fluorescent chatter: deterministic on/off, decaying. Photosensitivity
        // guard: 5 steps/s means at most ~2.5 on/off pairs per second (< 3 Hz),
        // and the dip depth is capped so it never reads as a full strobe.
        const slot = Math.floor(flickClock * 5);
        const off = hash01(slot) < 0.55;
        sputter = off ? 1 - Math.min(0.8, flick.intensity) * (1 - p * 0.6) : 1;
      }
    }
    // Blackout leaves ~2% lamp remnant so emissives/silhouettes still read.
    const lampMul = sputter * lerp(1, 0.02, blackLevel);
    const ambientMul = lerp(1, 0.015, blackLevel) * lerp(1, sputter, 0.4);
    const windowMul = lerp(1, 0, blackLevel);
    const colorMul = lerp(1, 0.06, blackLevel);

    // ---- apply to the scene ------------------------------------------------
    if (scene) {
      if (scene.background && scene.background.isColor) {
        scene.background.copy(live.background).multiplyScalar(colorMul);
      } else {
        scene.background = live.background;
      }
      if (scene.fog) {
        if (scene.fog.color)
          scene.fog.color.copy(live.fog).multiplyScalar(colorMul);
        if ("density" in scene.fog) scene.fog.density = scalars.fogDensity;
      }
    }
    if (ambient) {
      if (ambient.color) ambient.color.copy(live.ambientSky);
      if (ambient.groundColor) ambient.groundColor.copy(live.ambientGround);
      ambient.intensity = scalars.ambient * ambientMul;
    }
    if (lamp) {
      if (lamp.color) lamp.color.copy(live.lamp);
      lamp.intensity = scalars.lamp * lampMul;
    }
    if (windowLight) {
      if (windowLight.color) windowLight.color.copy(live.window);
      windowLight.intensity = scalars.window * windowMul;
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
    flicker,
    setBlackout,
    lightsCut,
    get blackout() {
      return blackout;
    },
    get blackLevel() {
      return blackLevel;
    },
    get cutRemaining() {
      return cutRemaining;
    },
    setDomOverlay,
    get overlayElement() {
      return overlayEl;
    },
    dispose,
  };
}
