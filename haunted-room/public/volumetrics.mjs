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
