// volumetrics.mjs — stereo-safe volumetric light cones with no post-processing.
//
// Adapted from jeromeetienne/threex.volumetricspotlight (MIT).
//
// Technique: an open-ended cone (CylinderGeometry, translated so its apex sits
// at the local origin pointing down -Y) rendered with an additive
// ShaderMaterial. Fragment brightness =
//   distance falloff from the apex (spotPosition uniform)
//   x pow(abs(dot(N, V)), anglePower)   — the silhouette/axis term
// where V is derived from the GLSL BUILT-IN `cameraPosition`.
//
// WHY cameraPosition and never a hand-updated camera uniform: three.js
// re-uploads the built-in `cameraPosition` for every render pass — including
// once PER EYE in a WebXR stereo frame. A manually-maintained uniform is only
// written once per rAF, so it would be correct for at most one eye and the
// cone would shimmer / mismatch between eyes. Using the built-in makes the
// glow term exact for whichever eye is currently being drawn.
//
// Intended uses: hanging-lamp cone, window light shafts, corridor bulb.
// Parent `mesh` under the lamp (or place it in the scene) and call
// `updateFrom(lampObject3d)` once per frame so the apex uniform tracks the
// emitter's world position. transparent + additive + depthWrite:false means
// draw order never fights the rest of the room.

const VERTEX = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPosition;
void main() {
  // World-space normal (cone is built with uniform scale).
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 lightColor;
uniform vec3 spotPosition;
uniform float attenuation;
uniform float anglePower;
uniform float intensity;
varying vec3 vNormalW;
varying vec3 vWorldPosition;
void main() {
  float falloff =
    clamp(1.0 - distance(vWorldPosition, spotPosition) / attenuation, 0.0, 1.0);
  // cameraPosition is a three.js built-in, re-set per render pass (per eye in
  // WebXR), so this view vector is always correct for the eye being drawn.
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  float angleFade = pow(abs(dot(normalize(vNormalW), viewDir)), anglePower);
  gl_FragColor = vec4(lightColor, falloff * angleFade * intensity);
}
`;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// Deterministic mulberry32 PRNG — no Math.random, reproducible in tests.
function makeRand(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createVolumetricCone(
  THREE,
  {
    radiusTop = 0.08,
    radiusBottom = 0.9,
    height = 2.2,
    color = 0xffe2b0,
    anglePower = 4.0,
    attenuation = height * 1.15,
  } = {},
) {
  // Open-ended cone; apex (radiusTop ring) moved to the origin so the body
  // hangs below it, pointing local -Y. Low segment counts: Quest-friendly.
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    24,
    6,
    true,
  );
  geometry.translate(0, -height / 2, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      lightColor: { value: new THREE.Color(color) },
      spotPosition: { value: new THREE.Vector3() },
      attenuation: { value: attenuation },
      anglePower: { value: anglePower },
      intensity: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "volumetric-cone";
  // Additive glow: exclude from shadow passes entirely.
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  let disposed = false;

  return {
    mesh,
    material,
    /** Master brightness, clamped to 0..1 (non-finite input reads as 0). */
    setIntensity(v) {
      material.uniforms.intensity.value = clamp01(v);
    },
    /**
     * Per-frame hook: copy an emitter's WORLD position into the apex uniform
     * (e.g. the lamp bulb the cone is parented to). This is scene-state, not
     * camera-state, so updating it once per frame is stereo-safe.
     */
    updateFrom(object3d) {
      if (!object3d || disposed) return;
      object3d.getWorldPosition(material.uniforms.spotPosition.value);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent?.();
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * createDustMotes — a drifting dust cloud living inside a light cone.
 *
 * Same local convention as createVolumetricCone: apex at the local origin,
 * the body hanging down -Y over `height`, radius growing from near zero at
 * the apex to `radiusBottom` at the base. Parent `points` under the same
 * object as the cone mesh and the motes sit inside the beam for free.
 *
 * One THREE.Points draw call, positions mutated in place every update —
 * zero per-frame allocations. `count` is hard-capped at 200 (Quest budget).
 *
 *   const motes = createDustMotes(THREE, { count: 140 });
 *   lamp.add(motes.points);
 *   motes.update(dt);          // per frame
 *   motes.agitate(1);          // when an entity moves: the dust stirs
 *   motes.setIntensity(0.8);   // follows the cone's brightness
 */
export function createDustMotes(
  THREE,
  {
    count = 140,
    radiusBottom = 0.9,
    height = 2.2,
    color = 0xe8dcc0,
    size = 0.014,
    seed = 20261,
  } = {},
) {
  const n = Math.max(1, Math.min(200, Math.floor(count) || 1));
  const rand = makeRand(seed >>> 0 || 1);
  const pos = new Float32Array(n * 3);
  const drift = new Float32Array(n * 3); // per-mote base drift velocities
  const phase = new Float32Array(n); // per-mote swirl phase offsets

  // y measured downward from the apex (0..height); radius shrinks toward it.
  function respawn(i) {
    const y = rand() * height;
    const r = (y / height) * radiusBottom * Math.sqrt(rand());
    const a = rand() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = -y;
    pos[i * 3 + 2] = Math.sin(a) * r;
    drift[i * 3] = (rand() - 0.5) * 0.015;
    drift[i * 3 + 1] = -(0.01 + rand() * 0.025); // settling downward
    drift[i * 3 + 2] = (rand() - 0.5) * 0.015;
    phase[i] = rand() * Math.PI * 2;
  }
  for (let i = 0; i < n; i++) respawn(i);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const material = new THREE.PointsMaterial({
    color,
    size,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.name = "dust-motes";

  let turbulence = 0; // 0 calm .. 1 freshly stirred; decays over ~2.5 s
  let time = 0;
  let disposed = false;
  const baseOpacity = 0.35;

  return {
    points,
    material,
    /** How stirred the cloud currently is (decays back to calm). */
    get turbulence() {
      return turbulence;
    },
    /** An entity moved: kick the dust. strength 0..1 (default full kick). */
    agitate(strength = 1) {
      turbulence = Math.max(turbulence, clamp01(strength));
    },
    /** Follows the owning cone's brightness: scales mote visibility. */
    setIntensity(v) {
      material.opacity = baseOpacity * clamp01(v);
    },
    update(dt) {
      if (disposed) return;
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
      if (step === 0) return;
      time += step;
      turbulence = Math.max(0, turbulence - step * 0.4);
      const stir = 1 + turbulence * 7; // stirred dust rushes
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        // Gentle swirl around the beam axis plus base drift, all scaled by
        // the current turbulence.
        const sw = 0.008 * stir;
        pos[o] += (drift[o] + Math.sin(time * 0.7 + phase[i]) * sw) * step * stir;
        pos[o + 1] += drift[o + 1] * step * stir;
        pos[o + 2] += (drift[o + 2] + Math.cos(time * 0.6 + phase[i]) * sw) * step * stir;
        // Fell out of the beam: respawn near the apex.
        const y = -pos[o + 1];
        const rAllowed = Math.max(0.02, (y / height) * radiusBottom * 1.1);
        if (
          y > height ||
          y < 0 ||
          pos[o] * pos[o] + pos[o + 2] * pos[o + 2] > rAllowed * rAllowed
        ) {
          respawn(i);
          pos[o + 1] = -Math.min(height * 0.25, height) * rand();
        }
      }
      geometry.attributes.position.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      points.removeFromParent?.();
      geometry.dispose();
      material.dispose();
    },
  };
}
