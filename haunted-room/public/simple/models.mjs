// Loads vetted .glb figure models listed in /models/manifest.json.
// Returns null on any problem so callers fall back to the procedural character.

export const LIMITS = { maxTriangles: 60000, maxTexture: 2048, targetHeight: 1.9 };

let injectedManifest = null;

/** Synchronous manifest access. Pass an object to inject (tests / preloaded). */
export function figureManifest(obj) {
  if (obj !== undefined) injectedManifest = obj;
  const m = injectedManifest;
  if (!m || !Array.isArray(m.models)) return { models: [] };
  return m;
}

const REQUIRED = ["id", "file", "license", "licenseUrl", "author", "sourceUrl", "attribution", "triangles", "notes"];

export function validateManifestEntry(e) {
  const problems = [];
  if (!e || typeof e !== "object") return ["entry is not an object"];
  for (const k of REQUIRED) {
    if (e[k] === undefined || e[k] === null || e[k] === "") problems.push(`missing ${k}`);
  }
  if (typeof e.file === "string" && !/^[\w.-]+\.glb$/i.test(e.file)) problems.push("file must be a plain .glb name");
  if (e.triangles !== undefined && !(Number.isFinite(e.triangles) && e.triangles >= 0)) problems.push("triangles must be a number");
  if (typeof e.licenseUrl === "string" && !/^https:\/\//.test(e.licenseUrl)) problems.push("licenseUrl must be https");
  return problems;
}

export function countTriangles(root) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    n += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
  });
  return Math.floor(n);
}

const TEX_KEYS = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "bumpMap"];

function eachTexture(root, fn) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material || [])) {
      for (const k of TEX_KEYS) {
        const t = m[k];
        if (t && !seen.has(t)) { seen.add(t); fn(t); }
      }
    }
  });
}

export function maxTextureSize(root) {
  let max = 0;
  eachTexture(root, (t) => {
    const im = t.image;
    if (im) max = Math.max(max, im.width || 0, im.height || 0);
  });
  return max;
}

/** Frees geometries, materials and textures under root. */
export function dispose(root) {
  if (!root) return;
  const mats = new Set();
  root.traverse((o) => {
    if (o.geometry?.dispose) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) mats.add(m);
  });
  eachTexture(root, (t) => t.dispose?.());
  for (const m of mats) m.dispose?.();
}

function normalize(THREE, scene, rotationY = 0) {
  const holder = new THREE.Group();
  holder.add(scene);
  if (rotationY) scene.rotation.y = rotationY;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const h = box.max.y - box.min.y;
  if (!(h > 0) || !Number.isFinite(h)) return null;
  const s = LIMITS.targetHeight / h;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  scene.position.set(-cx, -box.min.y, -cz);
  const out = new THREE.Group();
  out.name = "figure-model";
  holder.position.set(0, 0, 0);
  holder.scale.setScalar(s);
  // scale applies about origin, offsets above are pre-scale: position scene then scale holder
  out.add(holder);
  out.updateMatrixWorld(true);
  return out;
}

export async function loadFigureModel(THREE, id, opts = {}) {
  try {
    let manifest = opts.manifest;
    if (!manifest) {
      if (injectedManifest) manifest = injectedManifest;
      else {
        const res = await (opts.fetch || fetch)(opts.manifestUrl || "/models/manifest.json");
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        manifest = injectedManifest = await res.json();
      }
    }
    const entry = (manifest.models || []).find((m) => m.id === id);
    if (!entry) return null;
    const bad = validateManifestEntry(entry);
    if (bad.length) { console.warn(`[models] ${id}: bad manifest entry: ${bad.join(", ")}`); return null; }

    let loader = opts.loader;
    if (!loader) {
      const mod = await import("/vendor/addons/loaders/GLTFLoader.js");
      loader = new mod.GLTFLoader();
    }
    const url = (opts.baseUrl || "/models/") + entry.file;
    const gltf = loader.loadAsync ? await loader.loadAsync(url) : await new Promise((ok, no) => loader.load(url, ok, undefined, no));
    const scene = gltf?.scene;
    if (!scene) { console.warn(`[models] ${id}: no scene`); return null; }

    const tris = countTriangles(scene);
    if (tris > LIMITS.maxTriangles) {
      console.warn(`[models] ${id}: rejected, ${tris} triangles > ${LIMITS.maxTriangles}`);
      dispose(scene);
      return null;
    }
    const tex = maxTextureSize(scene);
    if (tex > LIMITS.maxTexture) {
      console.warn(`[models] ${id}: rejected, texture ${tex}px > ${LIMITS.maxTexture}`);
      dispose(scene);
      return null;
    }
    const group = normalize(THREE, scene, entry.rotationY || 0);
    if (!group) { console.warn(`[models] ${id}: degenerate bounds`); dispose(scene); return null; }
    group.userData.attribution = entry.attribution;
    group.userData.animations = gltf.animations || [];
    return group;
  } catch (err) {
    console.warn(`[models] ${id}: load failed: ${err?.message || err}`);
    return null;
  }
}
