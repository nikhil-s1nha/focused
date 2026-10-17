// Visual cues for the four-door room: eyes in a dark doorway, a shadow sliding past,
// a tall wall shadow, a far figure at the end of a hall.
// Cheap by design: 4 meshes (one per cue type), 4 shared materials, 2 textures,
// no real-time lights. Textures are painted on a canvas when one exists and fall back
// to the same pixels in a DataTexture (Node, tests).

export const SIDES = Object.freeze(['left', 'right', 'front', 'back']);
export const DOORWAYS = Object.freeze({
  front: { x: 0, z: -3.5 },
  back: { x: 0, z: 3.5 },
  left: { x: -3.5, z: 0 },
  right: { x: 3.5, z: 0 },
});
export const DOOR = Object.freeze({ width: 1.1, height: 2.1 });
export const EYE_HEIGHT = 1.6;
export const BUDGET = Object.freeze({ drawCalls: 12, meshes: 4 });
export const MIN_FADE = 0.3; // seconds: no cue changes opacity faster than ~3 Hz

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

// Alpha 0..1 for the eye pair at pixel (u, v) in 0..1, v down.
function eyeAlpha(u, v) {
  let a = 0;
  for (const cx of [0.3, 0.7]) {
    const dx = (u - cx) / 0.1;
    const dy = (v - 0.5) / 0.28;
    const d = Math.hypot(dx, dy);
    a = Math.max(a, d < 0.55 ? 1 : Math.exp(-((d - 0.55) ** 2) * 6) * 0.6);
  }
  return a;
}

// Soft standing silhouette; v = 0 at the top (head), 1 at the feet.
function bodyAlpha(u, v) {
  const x = Math.abs(u - 0.5);
  let half;
  if (v < 0.16) half = 0.13 * Math.sqrt(Math.max(0, 1 - ((v - 0.09) / 0.09) ** 2)); // head
  else if (v < 0.2) half = 0.06; // neck
  else if (v < 0.32) half = 0.06 + 0.3 * smooth((v - 0.2) / 0.1); // shoulders
  else half = 0.36 - 0.06 * smooth((v - 0.32) / 0.68); // coat / body
  const edge = 0.05;
  const a = clamp((half - x) / edge, 0, 1);
  const fade = smooth((1 - v) / 0.06) * (0.55 + 0.45 * smooth(v / 0.2)); // soft feet, denser head
  return a * a * (3 - 2 * a) * fade;
}

function makeTexture(THREE, w, h, alphaFn, createCanvas) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = clamp(alphaFn((x + 0.5) / w, (y + 0.5) / h), 0, 1);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  let tex = null;
  try {
    const canvas = createCanvas ? createCanvas(w, h) : typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const ctx = canvas?.getContext?.('2d');
    if (ctx?.createImageData) {
      canvas.width = w;
      canvas.height = h;
      const img = ctx.createImageData(w, h);
      img.data.set(data);
      ctx.putImageData(img, 0, 0);
      tex = new THREE.CanvasTexture(canvas);
    }
  } catch {
    tex = null;
  }
  if (!tex) {
    tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.flipY = false;
    tex.needsUpdate = true;
  }
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export function createCues(THREE, scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'cues';
  scene?.add?.(group);
  let disposed = false;

  const eyeTex = makeTexture(THREE, 64, 24, eyeAlpha, opts.createCanvas);
  const bodyTex = makeTexture(THREE, 48, 128, bodyAlpha, opts.createCanvas);
  // Canvas rows go top-down; DataTexture here is built with flipY=false and row 0 at the top,
  // so flip the canvas-less texture's V to keep the head up in both paths.
  if (!eyeTex.isCanvasTexture) {
    eyeTex.repeat.set(1, -1);
    eyeTex.offset.set(0, 1);
    eyeTex.wrapT = THREE.RepeatWrapping;
    bodyTex.repeat.set(1, -1);
    bodyTex.offset.set(0, 1);
    bodyTex.wrapT = THREE.RepeatWrapping;
  }

  const base = { transparent: true, depthTest: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide, fog: false };
  const mats = {
    eyes: new THREE.MeshBasicMaterial({ ...base, map: eyeTex, color: 0xdfe8ff, blending: THREE.AdditiveBlending, toneMapped: false }),
    shadowPass: new THREE.MeshBasicMaterial({ ...base, map: bodyTex, color: 0x000000 }),
    wallShadow: new THREE.MeshBasicMaterial({ ...base, map: bodyTex, color: 0x000000, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    farFigure: new THREE.MeshBasicMaterial({ ...base, map: bodyTex, color: 0x020203 }),
  };
  const unit = new THREE.PlaneGeometry(1, 1);
  const geoms = [unit];
  const slots = {};
  for (const [name, mat] of Object.entries(mats)) {
    const mesh = new THREE.Mesh(unit, mat);
    mesh.name = `cue-${name}`;
    mesh.visible = false;
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    group.add(mesh);
    slots[name] = { mesh, mat, active: false, side: null, t: 0, seconds: 0, max: 1, fade: MIN_FADE, vanish: -1 };
  }

  const door = (side) => DOORWAYS[side];
  // Axis pointing out of the room through the door, and the tangent along the wall.
  const outward = (side) => {
    const d = door(side);
    return { nx: Math.sign(d.x), nz: Math.sign(d.z), tx: d.x === 0 ? 1 : 0, tz: d.z === 0 ? 1 : 0 };
  };
  const face = (mesh) => {
    mesh.rotation.set(0, Math.atan2(-mesh.position.x, -mesh.position.z), 0);
  };

  function arm(name, side, seconds, max, minSeconds) {
    if (disposed || !SIDES.includes(side)) return false;
    const s = slots[name];
    const dur = clamp(Number.isFinite(seconds) ? seconds : minSeconds, minSeconds, 30);
    Object.assign(s, { active: true, side, t: 0, seconds: dur, max, vanish: -1 });
    s.fade = clamp(dur * 0.3, MIN_FADE, 0.8);
    s.mat.opacity = 0;
    s.mesh.visible = true;
    return s;
  }

  function eyes(side, seconds) {
    const s = arm('eyes', side, seconds, 1, 0.8);
    if (!s) return false;
    const o = outward(side);
    const d = door(side);
    s.mesh.scale.set(0.34, 0.13, 1);
    s.mesh.position.set(d.x + o.nx * 0.35, 1.68, d.z + o.nz * 0.35);
    face(s.mesh);
    return true;
  }

  function shadowPass(side, seconds) {
    const s = arm('shadowPass', side, seconds, 0.82, 0.8);
    if (!s) return false;
    s.mesh.scale.set(0.95, DOOR.height - 0.05, 1);
    s.mesh.position.y = (DOOR.height - 0.05) / 2;
    return true;
  }

  function wallShadow(side, seconds) {
    const s = arm('wallShadow', side, seconds, 0.7, 0.8);
    if (!s) return false;
    s.wallDir = side === 'left' || side === 'front' ? 1 : -1; // which way it leans along the wall
    return true;
  }

  function farFigure(side, seconds) {
    const s = arm('farFigure', side, seconds, 0.95, 0.8);
    if (!s) return false;
    const o = outward(side);
    const d = door(side);
    const dist = 7.5;
    s.mesh.scale.set(0.62, 1.75, 1);
    s.mesh.position.set(d.x + o.nx * dist, 0.875, d.z + o.nz * dist);
    face(s.mesh);
    return true;
  }

  function setObserved(side) {
    // A far figure is gone when the player looks at its door (fast, but not a pop).
    const s = slots.farFigure;
    if (s.active && side === s.side && s.vanish < 0) s.vanish = 0;
  }

  function hide(s) {
    s.active = false;
    s.mesh.visible = false;
    s.mat.opacity = 0;
  }

  function envelope(s) {
    const inT = smooth(s.t / s.fade);
    const outT = 1 - smooth((s.t - (s.seconds - s.fade)) / s.fade);
    return Math.min(inT, outT);
  }

  function update(dt) {
    if (disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    for (const [name, s] of Object.entries(slots)) {
      if (!s.active) continue;
      s.t += step;
      if (s.t >= s.seconds) { hide(s); continue; }
      let k = envelope(s);
      if (s.vanish >= 0) {
        s.vanish += step;
        k *= 1 - smooth(s.vanish / 0.2);
        if (s.vanish >= 0.2) { hide(s); continue; }
      }
      s.mat.opacity = s.max * k;
      const p = s.t / s.seconds;
      const o = outward(s.side);
      const d = door(s.side);
      if (name === 'shadowPass') {
        const along = (p - 0.5) * 1.7; // slides across the void just beyond the door
        s.mesh.position.x = d.x + o.nx * 0.3 + o.tx * along;
        s.mesh.position.z = d.z + o.nz * 0.3 + o.tz * along;
        face(s.mesh);
      } else if (name === 'wallShadow') {
        const grow = smooth(p / 0.7);
        const h = 2.0 + grow * 1.6;
        const w = 0.9 + grow * 1.7;
        s.mesh.scale.set(w, h, 1);
        const along = s.wallDir * (1.7 + grow * 0.6);
        s.mesh.position.set(d.x - o.nx * 0.03 + o.tx * along, h / 2 - 0.1, d.z - o.nz * 0.03 + o.tz * along);
        face(s.mesh);
      }
    }
  }

  function clear() {
    for (const s of Object.values(slots)) hide(s);
  }

  function getStats() {
    const visible = Object.values(slots).filter((s) => s.mesh.visible);
    return { active: visible.length, drawCalls: visible.length, maxDrawCalls: Object.keys(slots).length };
  }

  function getState(name) {
    const s = slots[name];
    return s ? { active: s.active, side: s.side, opacity: s.mat.opacity, seconds: s.seconds, fade: s.fade, position: s.mesh.position.clone() } : null;
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    group.removeFromParent?.();
    for (const g of geoms) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    eyeTex.dispose();
    bodyTex.dispose();
  }

  return {
    group,
    eyes,
    shadowPass,
    wallShadow,
    farFigure,
    setObserved,
    update,
    clear,
    getStats,
    getState,
    dispose,
  };
}
