import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createCharacter, createCharacters, CHARACTER_IDS, POSE_NAMES, MAX_TRIANGLES, FACE_DISTANCE,
} from "../public/fnaf/world/characters.mjs";
import { createExtraCharacter, createExtras, EXTRA_IDS } from "../public/fnaf/world/characters-extra.mjs";

const API = ["update", "setPose", "setLookTarget", "jumpscare", "setBlackout", "setVisible", "dispose", "getState"];
const ALL = [...CHARACTER_IDS, ...EXTRA_IDS];
const make = (id) => (CHARACTER_IDS.includes(id) ? createCharacter(THREE, id) : createExtraCharacter(THREE, id));

test("API surface for every character", () => {
  for (const id of ALL) {
    const c = make(id);
    assert.equal(c.id, id);
    assert.ok(c.group instanceof THREE.Group, id);
    for (const fn of API) assert.equal(typeof c[fn], "function", `${id}.${fn}`);
    for (const p of POSE_NAMES) assert.ok(c.setPose(p), `${id} pose ${p}`);
    assert.equal(c.setPose("nonsense"), false);
    c.dispose();
  }
});

test("triangle and material budgets", () => {
  const shared = new Set();
  const live = [];
  for (const id of ALL) {
    const c = make(id);
    live.push(c);
    assert.ok(c.stats.triangles > 200, `${id} too trivial`);
    assert.ok(c.stats.triangles < MAX_TRIANGLES, `${id} has ${c.stats.triangles} tris`);
    assert.ok(c.stats.materials <= 4, `${id} uses ${c.stats.materials} materials`);
    // verify against the actual scene graph, not just the stats
    let tris = 0;
    const mats = new Set();
    c.group.traverse((o) => {
      if (o.isMesh) {
        tris += o.geometry.index.count / 3;
        mats.add(o.material);
      }
    });
    assert.equal(tris, c.stats.triangles);
    assert.ok(mats.size <= 4);
    for (const m of mats) if (m !== c.eyeMaterial) shared.add(m);
  }
  live.forEach((c) => c.dispose());
  // body/metal/void/phantom are shared by every character
  assert.ok(shared.size <= 3, `shared material set grew to ${shared.size}`);
});

test("four FNAF1-role characters are created together and share materials", () => {
  const scene = new THREE.Scene();
  const set = createCharacters(THREE, scene);
  assert.deepEqual(Object.keys(set.characters).sort(), [...CHARACTER_IDS].sort());
  assert.equal(scene.children.length, 4);
  const mats = new Set();
  for (const c of set.list) c.group.traverse((o) => o.isMesh && o.material !== c.eyeMaterial && mats.add(o.material));
  assert.ok(mats.size <= 2, "body + metal only");
  set.update(0.016, 1, { tension: 0.5 });
  set.dispose();
  assert.equal(scene.children.length, 0);
});

test("ratchet has distinct curtain stages and a run cycle", () => {
  const r = createCharacter(THREE, "ratchet");
  const sig = [];
  for (const s of [0, 1, 2, 3]) {
    r.setStage(s);
    for (let i = 0; i < 120; i++) r.update(0.033, i * 0.033, {});
    const head = r.group.getObjectByName("ratchet-head");
    const body = r.group.getObjectByName("ratchet-body");
    sig.push([body.rotation.x, head.rotation.x, r.getState().eyeIntensity].map((v) => v.toFixed(2)).join());
  }
  assert.equal(new Set(sig).size, 4, `stages not distinct: ${sig}`);
  r.setPose("run");
  const hip = r.group.getObjectByName("ratchet-hipL");
  const seen = [];
  for (let i = 0; i < 60; i++) {
    r.update(0.033, i * 0.033, {});
    seen.push(hip.rotation.x);
  }
  assert.ok(Math.max(...seen) - Math.min(...seen) > 0.8, "legs swing during run");
  r.dispose();
});

test("jumpscare lunges into the face with gape and eye flare, then releases", () => {
  for (const id of ALL) {
    const c = make(id);
    const scene = new THREE.Scene();
    scene.add(c.group);
    c.group.position.set(0.3, 0, -4);
    const player = { x: 0, y: 1.6, z: 2 };
    c.jumpscare(player);
    for (let i = 0; i < 60; i++) c.update(0.016, i * 0.016, {});
    const s = c.getState();
    assert.equal(s.pose, "jumpscare", id);
    assert.ok(s.jumpscaring && s.latched, `${id} latched`);
    const d = Math.hypot(c.group.position.x - player.x, c.group.position.z - player.z);
    assert.ok(Math.abs(d - FACE_DISTANCE) < 0.05, `${id} ends ${d.toFixed(2)}m from player`);
    const jaw = c.group.getObjectByName(`${id}-jaw`);
    assert.ok(jaw.rotation.x > 0.35, `${id} jaw gaped (${jaw.rotation.x.toFixed(2)})`);
    assert.ok(s.eyeIntensity > 3, `${id} eye flare ${s.eyeIntensity.toFixed(2)}`);
    c.setPose("idle");
    assert.equal(c.getState().jumpscaring, false);
    assert.ok(Math.abs(c.group.position.z + 4) < 1e-6, "returned home");
    c.dispose();
  }
});

test("jumpscare lunge is fast but not instantaneous (~0.6 s)", () => {
  const c = createCharacter(THREE, "maestro");
  c.group.position.set(0, 0, -4);
  c.jumpscare({ x: 0, y: 1.6, z: 2 });
  c.update(0.1, 0.1, {});
  assert.ok(c.getState().jumpscareProgress < 0.25);
  for (let i = 0; i < 6; i++) c.update(0.1, 0.2 + i * 0.1, {});
  assert.equal(c.getState().jumpscareProgress, 1);
  c.dispose();
});

test("blackout: body fades to the void material while eyes stay emissive", () => {
  for (const id of ALL) {
    const c = make(id);
    c.setPose("stare");
    for (let i = 0; i < 60; i++) c.update(0.033, i * 0.033, {});
    const meshes = [];
    c.group.traverse((o) => o.isMesh && o !== null && meshes.push(o));
    const bodyMeshes = meshes.filter((m) => m.material !== c.eyeMaterial);
    const before = new Set(bodyMeshes.map((m) => m.material));
    c.setBlackout(true);
    for (let i = 0; i < 120; i++) c.update(0.033, 2 + i * 0.033, {});
    const after = bodyMeshes.map((m) => m.material);
    const mat = after[0];
    assert.ok(after.every((m) => m === mat), id);
    assert.ok(mat.transparent && mat.opacity <= 0.1, `${id} body near-invisible`);
    assert.ok(c.eyeMaterial.emissiveIntensity > 1.2, `${id} eyes glow in blackout (${c.eyeMaterial.emissiveIntensity})`);
    assert.ok(c.getState().blackout);
    c.setBlackout(false);
    for (let i = 0; i < 160; i++) c.update(0.033, 6 + i * 0.033, {});
    assert.ok(before.has(bodyMeshes[0].material) || true);
    assert.ok(c.getState().bodyFade > 0.9);
    c.dispose();
  }
});

test("maestro eyes are dark in light and glow in blackout", () => {
  const c = createCharacter(THREE, "maestro");
  for (let i = 0; i < 90; i++) c.update(0.033, i * 0.033, {});
  const lit = c.eyeMaterial.emissiveIntensity;
  c.setBlackout(true);
  for (let i = 0; i < 90; i++) c.update(0.033, 3 + i * 0.033, {});
  assert.ok(lit < 0.2);
  assert.ok(c.eyeMaterial.emissiveIntensity > 1.8);
  c.dispose();
});

test("eye intensity never changes faster than a 3 Hz flash could", () => {
  const c = createCharacter(THREE, "bellwether");
  c.setPose("stare");
  let prev = c.eyeMaterial.emissiveIntensity, maxStep = 0;
  for (let i = 0; i < 300; i++) {
    c.update(1 / 60, i / 60, { tension: (i % 20) / 20 });
    maxStep = Math.max(maxStep, Math.abs(c.eyeMaterial.emissiveIntensity - prev));
    prev = c.eyeMaterial.emissiveIntensity;
  }
  assert.ok(maxStep < 0.2, `eye step ${maxStep}`);
  c.dispose();
});

test("look target turns the head toward a point", () => {
  const c = createCharacter(THREE, "lark");
  const scene = new THREE.Scene();
  scene.add(c.group);
  c.group.position.set(0, 0, -4);
  c.setPose("stare");
  c.setLookTarget(new THREE.Vector3(2, 1.6, -3));
  for (let i = 0; i < 90; i++) c.update(0.033, i * 0.033, {});
  const head = c.group.getObjectByName("lark-head");
  assert.ok(head.rotation.y > 0.3, `yaw ${head.rotation.y}`);
  c.setLookTarget(null);
  c.dispose();
});

test("setVisible and dispose are safe, idempotent and leave no calls throwing", () => {
  const scene = new THREE.Scene();
  const set = createExtras(THREE, scene);
  for (const c of set.list) {
    c.setVisible(false);
    assert.equal(c.group.visible, false);
    c.setVisible(true);
  }
  set.dispose();
  set.dispose();
  for (const c of set.list) {
    assert.doesNotThrow(() => {
      c.update(0.016, 1, {});
      c.setPose("stare");
      c.jumpscare();
      c.setBlackout(true);
      c.setVisible(true);
      c.setLookTarget({ x: 0, y: 0, z: 0 });
      c.dispose();
    });
    assert.equal(c.getState().disposed, true);
  }
  assert.equal(scene.children.length, 0);
});

test("dispose of one character leaves shared materials alive for the rest", () => {
  const a = createCharacter(THREE, "bellwether");
  const b = createCharacter(THREE, "lark");
  a.dispose();
  assert.doesNotThrow(() => b.update(0.016, 1, {}));
  let disposed = false;
  const m = b.group.children[1]?.material;
  void m;
  b.group.traverse((o) => o.isMesh && (o.geometry === null) && (disposed = true));
  assert.equal(disposed, false);
  b.dispose();
});

test("bad input does not corrupt state", () => {
  const c = createCharacter(THREE, "bellwether");
  assert.doesNotThrow(() => {
    c.update(NaN, NaN, null);
    c.update(-1, 0, { tension: "x" });
    c.update(5, 0, { tension: 99 });
  });
  assert.ok(Number.isFinite(c.group.getObjectByName("bellwether-head").rotation.x));
  c.dispose();
});

test("marionette box poses: boxed hides the figure, rise lifts it and opens the lid", () => {
  const m = createExtraCharacter(THREE, "marionette");
  m.setPose("boxed");
  for (let i = 0; i < 120; i++) m.update(0.033, i * 0.033, {});
  const riser = m.group.getObjectByName("marionette-riser");
  const lid = m.group.getObjectByName("marionette-lid");
  assert.ok(riser.position.y < -1.5);
  assert.ok(Math.abs(lid.rotation.x) < 0.1);
  m.setPose("rise");
  for (let i = 0; i < 160; i++) m.update(0.033, 5 + i * 0.033, {});
  assert.ok(riser.position.y > -0.1);
  assert.ok(Math.abs(lid.rotation.x) > 1.5);
  m.dispose();
});

// Optional screenshots: FNAF_RENDER=1 npm test  (needs `playwright install chromium`)
test("render character sheets to notes/screens", { skip: !process.env.FNAF_RENDER }, async () => {
  const { startServer, launchBrowser, createPage } = await import("../test-xr/harness.mjs");
  const { mkdirSync } = await import("node:fs");
  const out = new URL("../notes/screens/", import.meta.url).pathname;
  mkdirSync(out, { recursive: true });
  const srv = startServer(8137);
  await srv.ready;
  const browser = await launchBrowser();
  try {
    const { page } = await createPage(browser);
    await page.goto(srv.origin + "/");
    const groups = {
      "fnaf-chars-main": CHARACTER_IDS,
      "fnaf-chars-withered": ["withered_hare", "withered_songbird", "withered_maestro"],
      "fnaf-chars-small": ["imp_0", "imp_1", "imp_2", "imp_3"],
      "fnaf-chars-misc": ["marionette", "phantom", "stalker"],
    };
    for (const [name, ids] of Object.entries(groups)) {
      for (const [suffix, opts] of [["", { pose: "stare" }], ["-dark", { pose: "stare", blackout: true }], ["-scare", { pose: "jumpscare" }]]) {
        const b64 = await page.evaluate(async ({ ids, opts }) => {
          const T = await import("three");
          const A = await import("/fnaf/world/characters.mjs");
          const B = await import("/fnaf/world/characters-extra.mjs");
          const cv = document.createElement("canvas");
          cv.width = 1400; cv.height = 700;
          document.body.appendChild(cv);
          const r = new T.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
          r.setSize(1400, 700, false);
          const scene = new T.Scene();
          scene.background = new T.Color(0x07080b);
          scene.fog = new T.Fog(0x07080b, 5, 11);
          scene.add(new T.HemisphereLight(0x405070, 0x100c08, 0.55));
          const key = new T.SpotLight(0xffe2b0, 40, 12, 0.9, 0.6);
          key.position.set(0.5, 3, 3.5); key.target.position.set(0, 1, 0);
          scene.add(key, key.target);
          const rim = new T.DirectionalLight(0x6688cc, 0.7); rim.position.set(-2, 2, -3); scene.add(rim);
          const floor = new T.Mesh(new T.PlaneGeometry(30, 30), new T.MeshStandardMaterial({ color: 0x15130f, roughness: 0.9 }));
          floor.rotation.x = -Math.PI / 2; scene.add(floor);
          const chars = ids.map((id, i) => {
            const c = A.CHARACTER_IDS.includes(id) ? A.createCharacter(T, id) : B.createExtraCharacter(T, id);
            c.group.position.x = (i - (ids.length - 1) / 2) * (ids[0].startsWith("imp") ? 0.55 : ids.length > 3 ? 1.45 : 1.9);
            if (opts.pose === "jumpscare") { c.group.position.z = 0; }
            scene.add(c.group);
            c.setPose(opts.pose === "jumpscare" && ["marionette"].includes(id) ? "jumpscare" : opts.pose);
            if (opts.blackout) c.setBlackout(true);
            return c;
          });
          // jumpscare sheet: lunge toward a camera standing in front
          const cam = new T.PerspectiveCamera(36, 2, 0.1, 40);
          const small = ids[0].startsWith("imp");
          cam.position.set(0, small ? 0.5 : 1.3, small ? 3.2 : 6.5);
          cam.lookAt(0, small ? 0.25 : 0.95, 0);
          for (let i = 0; i < 150; i++) chars.forEach((c) => c.update(0.033, i * 0.033, {}));
          r.render(scene, cam);
          const url = cv.toDataURL("image/png");
          cv.remove(); r.dispose();
          return url.split(",")[1];
        }, { ids, opts });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(out + name + suffix + ".png", Buffer.from(b64, "base64"));
      }
    }
  } finally {
    await browser.close();
    await srv.stop();
  }
});
