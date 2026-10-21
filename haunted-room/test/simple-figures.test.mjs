import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFigures, FIGURE_IDS, SIDES, DOORWAYS, EYE, BUDGET, INSET, MAX_VISIBLE } from "../public/simple/figures.mjs";
import { MAX_TRIANGLES, FACE_DISTANCE } from "../public/fnaf/world/characters.mjs";

const DT = 1 / 60;
const run = (f, seconds, tension = 0) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) f.update(DT, i * DT, { tension });
};

test("each side can show every id, and every doorway is 0.3 m inside", () => {
  const f = createFigures(THREE, new THREE.Scene());
  for (const side of SIDES) {
    for (const id of FIGURE_IDS) {
      assert.equal(f.show(side, id), true, `${side}/${id}`);
      assert.equal(f.occupant(side), id);
      const fig = f.getFigure(side);
      const d = DOORWAYS[side];
      const inward = Math.hypot(fig.position.x - d.x, fig.position.z - d.z);
      assert.ok(Math.abs(inward - INSET) < 1e-6, `${side} stands ${inward} from doorway`);
      f.hide(side);
    }
  }
  f.dispose();
});

test("show replaces the previous figure and an id is only on one side", () => {
  const scene = new THREE.Scene();
  const f = createFigures(THREE, scene);
  const before = f.group.children.length;
  f.show("front", "lark");
  f.show("front", "ratchet");
  assert.equal(f.occupant("front"), "ratchet");
  assert.equal(f.getStats().figures, 1, "lark must be hidden after replacement");
  f.show("left", "ratchet");
  assert.equal(f.occupant("front"), null);
  assert.equal(f.occupant("left"), "ratchet");
  assert.equal(f.group.children.length, before, "no models created by show");
  f.dispose();
});

test("unknown side or id is refused without throwing", () => {
  const f = createFigures(THREE, new THREE.Scene());
  assert.equal(f.show("ceiling", "lark"), false);
  assert.equal(f.show("front", "nobody"), false);
  assert.equal(f.lunge("front"), false, "nothing shown");
  f.dispose();
});

test("hold freezes in peek pose; retreat hides after about 0.5 s", () => {
  const f = createFigures(THREE, new THREE.Scene());
  f.show("back", "maestro");
  assert.equal(f.hold("back"), true);
  run(f, 0.5);
  assert.equal(f.getFigure("back").pose, "peek");
  assert.equal(f.retreat("back"), true);
  run(f, 0.3);
  assert.equal(f.occupant("back"), "maestro", "still retreating at 0.3 s");
  run(f, 0.4);
  assert.equal(f.occupant("back"), null);
  f.dispose();
});

test("lunge ends about 0.42 m from the eye and never moves the camera", () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 50);
  camera.position.set(EYE.x, EYE.y, EYE.z);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  scene.add(camera);
  const cam0 = camera.matrixWorld.clone();

  const f = createFigures(THREE, scene);
  for (const side of SIDES) {
    f.show(side, "bellwether");
    f.lunge(side, 0.6);
    run(f, 1.0);
    const fig = f.getFigure(side);
    assert.equal(fig.phase, "latched", side);
    assert.ok(Math.abs(fig.faceDistanceToEye - FACE_DISTANCE) < 0.03,
      `${side} face ends ${fig.faceDistanceToEye} m from eye`);
    f.hide(side);
  }
  camera.updateMatrixWorld(true);
  assert.deepEqual(camera.matrixWorld.elements, cam0.elements, "camera must not move");
  f.dispose();
});

test("lunge with a view direction lands the face in front of the player, from any door", () => {
  const scene = new THREE.Scene();
  const f = createFigures(THREE, scene);
  for (const side of SIDES) {
    f.show(side, "bellwether");
    f.lunge(side, 0.22, { viewDir: { x: 1, z: 0 } }); // player faces +X (the right door)
    run(f, 0.6);
    const fig = f.getFigure(side);
    assert.ok(Math.abs(fig.faceDistanceToEye - FACE_DISTANCE) < 0.03, `${side} face ${fig.faceDistanceToEye}`);
    const dx = fig.headPosition.x - EYE.x, dz = fig.headPosition.z - EYE.z;
    assert.ok(dx > 0.3 && Math.abs(dz) < 0.1, `${side}: face is in front of the player (dx ${dx}, dz ${dz})`);
    f.hide(side);
  }
  f.dispose();
});

test("lunge lands the face at 0.42 m for every id", () => {
  const f = createFigures(THREE, new THREE.Scene());
  for (const id of FIGURE_IDS) {
    f.show("left", id);
    f.lunge("left", 0.6);
    run(f, 1.0);
    const fig = f.getFigure("left");
    assert.equal(fig.phase, "latched", id);
    assert.ok(Math.abs(fig.faceDistanceToEye - FACE_DISTANCE) < 0.03, `${id} face ${fig.faceDistanceToEye}`);
    assert.ok(Math.abs(fig.headPosition.y - EYE.y) < 0.35, `${id} head y ${fig.headPosition.y}`);
    f.hide("left");
  }
  f.dispose();
});

test("a faster lunge arrives sooner, a slower one takes longer", () => {
  const f = createFigures(THREE, new THREE.Scene());
  f.show("left", "lark");
  f.lunge("left", 0.3);
  run(f, 0.35);
  assert.equal(f.getFigure("left").phase, "latched");
  f.show("right", "lark");
  f.lunge("right", 1.2);
  run(f, 0.6);
  assert.equal(f.getFigure("right").phase, "lunge");
  run(f, 0.8);
  assert.equal(f.getFigure("right").phase, "latched");
  f.dispose();
});

test("caught latches until hide or clear and flares the eyes", () => {
  const f = createFigures(THREE, new THREE.Scene());
  f.show("front", "ratchet");
  f.show("right", "maestro");
  f.caught("front");
  run(f, 3);
  assert.equal(f.getFigure("front").phase, "caught");
  assert.ok(f.getFigure("front").eyeIntensity > 3.5, "max flare");
  run(f, 5);
  assert.equal(f.occupant("front"), "ratchet", "still latched after 8 s");
  f.hide("front");
  assert.equal(f.occupant("front"), null);
  f.caught("right");
  f.clear();
  assert.equal(f.getStats().figures, 0);
  f.dispose();
});

test("blackout fades bodies but keeps every visible eye lit", () => {
  const f = createFigures(THREE, new THREE.Scene());
  f.show("front", "bellwether");
  f.show("back", "lark");
  f.show("left", "ratchet");
  f.setBlackout(true);
  run(f, 2);
  for (const side of ["front", "back", "left"]) {
    const fig = f.getFigure(side);
    assert.ok(fig.bodyFade < 0.2, `${side} body fade ${fig.bodyFade}`);
    assert.ok(fig.eyeIntensity >= 1.4, `${side} eye ${fig.eyeIntensity}`);
  }
  f.setBlackout(false);
  run(f, 2);
  assert.equal(f.getStats().figures, 3);
  f.dispose();
});

test("eye brightness is smooth: no more than 3 direction changes per second", () => {
  const f = createFigures(THREE, new THREE.Scene());
  f.show("front", "lark");
  f.setBlackout(true);
  const samples = [];
  for (let i = 0; i < 6 * 60; i++) {
    if (i === 60) f.caught("front");
    if (i === 240) f.hide("front");
    f.update(DT, i * DT, { tension: 1 });
    if (f.occupant("front")) samples.push(f.getFigure("front").eyeIntensity);
  }
  let reversals = 0, lastSign = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i] - samples[i - 1];
    if (Math.abs(d) < 1e-9) continue;
    const sign = Math.sign(d);
    if (lastSign && sign !== lastSign) reversals++;
    lastSign = sign;
  }
  assert.ok(reversals <= 3 * 6, `eye reversed direction ${reversals} times in 6 s`);
  f.dispose();
});

test("budget: the worst visible set stays under draw-call and triangle limits", () => {
  const f = createFigures(THREE, new THREE.Scene());
  assert.equal(MAX_VISIBLE, 3);
  f.show("front", "bellwether");
  f.show("back", "lark");
  f.show("left", "maestro");
  assert.equal(f.show("right", "ratchet"), false, "fourth figure refused");
  f.caught("front");
  f.lunge("back");
  run(f, 0.8, 1);
  const s = f.getStats();
  assert.equal(s.figures, MAX_VISIBLE);
  assert.ok(s.drawCalls < BUDGET.maxDrawCalls, `draw calls ${s.drawCalls}`);
  assert.ok(s.triangles < BUDGET.maxTriangles, `triangles ${s.triangles}`);
  assert.ok(s.triangles < MAX_VISIBLE * MAX_TRIANGLES);
  // a replacement on an occupied side is still allowed at the cap
  assert.equal(f.show("front", "ratchet"), true);
  assert.equal(f.getStats().figures, MAX_VISIBLE);
  f.dispose();
});

test("worst triple of ids is under the draw-call budget", () => {
  const counts = {};
  const f = createFigures(THREE, new THREE.Scene());
  for (const id of FIGURE_IDS) {
    f.show("front", id);
    counts[id] = f.getStats().drawCalls;
    f.hide("front");
  }
  f.dispose();
  const ids = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const worst = ids.slice(0, MAX_VISIBLE).reduce((a, id) => a + counts[id], 0);
  assert.ok(worst < BUDGET.maxDrawCalls, `worst ${MAX_VISIBLE} draw calls ${worst}`);
});

test("dispose twice is safe and the module goes inert afterwards", () => {
  const scene = new THREE.Scene();
  const f = createFigures(THREE, scene);
  f.show("front", "lark");
  f.dispose();
  f.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(f.show("front", "lark"), false);
  assert.doesNotThrow(() => f.update(DT, 0, { tension: 1 }));
  assert.doesNotThrow(() => f.clear());
});

test("doorway figures stay silhouettes and burst lit at under 3 Hz", () => {
  const f = createFigures(THREE, new THREE.Scene());
  f.show("front", "maestro");
  let bursts = 0, wasLit = false, darkFrames = 0;
  const seconds = 12;
  for (let i = 0; i < seconds * 60; i++) {
    f.update(DT, i * DT, { tension: 0.5 });
    const fig = f.getFigure("front");
    if (fig.lit && !wasLit) bursts++;
    wasLit = fig.lit;
    if (fig.bodyFade < 0.2) darkFrames++;
  }
  assert.ok(darkFrames > seconds * 60 * 0.5, "silhouette most of the time");
  assert.ok(bursts >= 4 && bursts <= seconds, `bursts ${bursts}`);
  f.dispose();
});

test("ignored threat sweeps from the selected screen edge and lands close in view", () => {
  const f=createFigures(THREE,new THREE.Scene());
  for (const edge of [-1,1]) {
    f.show("back","bellwether");
    f.lunge("back",.13,{viewDir:{x:0,z:-1},entrySide:edge});
    f.update(.02,0,{tension:1});
    assert.ok(f.getFigure("back").headPosition.x*edge>.5,"enters from requested edge");
    run(f,.4);
    const end=f.getFigure("back");
    assert.ok(Math.abs(end.headPosition.x)<.1,"lands in view");
    assert.ok(Math.abs(end.faceDistanceToEye-FACE_DISTANCE)<.03,"close face distance preserved");
    f.hide("back");
  }
  f.dispose();
});
