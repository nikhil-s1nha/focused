import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  BEATS, BeatPlanner, validBeatEvent, lightTransitions, FLASH_LIMIT_HZ, SIDES,
} from "../public/simple/beats.mjs";
import { ScareDirector, BASE_FIGURES, WITHERED_FIGURES } from "../public/simple/scare.mjs";
import { createCues, BUDGET, DOORWAYS } from "../public/simple/cues.mjs";

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plans n beats back to back at the given tension, advancing time by each beat's duration + wait.
function plan(seed, n, tension = 0.5, extra = {}) {
  const p = new BeatPlanner({ rng: rngFrom(seed) });
  const out = [];
  let elapsed = 0;
  for (let i = 0; i < n; i += 1) {
    const b = p.next({ tension, state: "BUILD", elapsed, ...extra });
    assert.ok(b, "planner returned no beat");
    out.push(b);
    elapsed += b.duration + 4;
  }
  return out;
}

const REQUIRED = [
  "stutter", "sag", "cut-and-return", "hall-light", "door-crack", "knock", "empty-open", "false-lunge", "glimpse",
  "eyes", "shadow-pass", "wall-shadow", "far-figure", "footsteps-behind", "whisper", "breath", "silence", "heartbeat-spike",
];

test("library has every required beat with tension range, weight, cooldown and duration", () => {
  for (const name of REQUIRED) {
    const b = BEATS[name];
    assert.ok(b, name);
    assert.ok(b.min >= 0 && b.max <= 1 && b.min < b.max, `${name} range`);
    assert.ok(b.weight > 0 && b.cooldown >= 0, `${name} weight/cooldown`);
    assert.ok(b.duration[0] > 0 && b.duration[1] >= b.duration[0], `${name} duration`);
  }
});

test("planner is deterministic for a seed and varies across seeds", () => {
  const names = (seed) => plan(seed, 40).map((b) => b.name).join(",");
  assert.equal(names(5), names(5));
  assert.notEqual(names(5), names(6));
  const a = JSON.stringify(plan(9, 10).map((b) => b.steps));
  assert.equal(a, JSON.stringify(plan(9, 10).map((b) => b.steps)));
});

test("built beats stay inside their declared duration range and end after their last step", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    for (const b of plan(seed, 30, (seed % 10) / 10)) {
      const [lo, hi] = BEATS[b.name].duration;
      assert.ok(b.duration >= lo - 1e-9 && b.duration <= hi + 1e-9, `${b.name} ${b.duration} not in ${lo}..${hi}`);
      for (const s of b.steps) assert.ok(s.at <= b.duration, `${b.name} step after end`);
    }
  }
});

test("selection follows tension: low favours sound and light, high favours fakes and cues", () => {
  const share = (tension, cats) => {
    let hit = 0;
    let all = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      for (const b of plan(seed, 20, tension)) {
        all += 1;
        if (cats.includes(b.category)) hit += 1;
      }
    }
    return hit / all;
  };
  assert.ok(share(0.1, ["sound", "light"]) > share(0.95, ["sound", "light"]) + 0.15);
  assert.ok(share(0.95, ["fake", "cue"]) > share(0.1, ["fake", "cue"]) + 0.2);
  for (const b of plan(3, 60, 0.05)) assert.ok(BEATS[b.name].min <= 0.35, `${b.name} too heavy for low tension`);
  const lowFalse = plan(4, 80, 0.2).filter((b) => b.name === "false-lunge");
  assert.equal(lowFalse.length, 0);
});

test("the same beat never plays twice in a row", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const beats = plan(seed, 60, (seed % 5) / 4);
    for (let i = 1; i < beats.length; i += 1) assert.notEqual(beats[i].name, beats[i - 1].name);
  }
});

test("never more than 2 heavy beats in a row, and a release follows a real scare", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const beats = plan(seed, 80, 1);
    let run = 0;
    for (const b of beats) {
      run = b.heavy ? run + 1 : 0;
      assert.ok(run <= 2, `seed ${seed}: ${run} heavy in a row`);
    }
  }
  const p = new BeatPlanner({ rng: rngFrom(8) });
  let elapsed = 0;
  for (let i = 0; i < 30; i += 1) {
    p.noteScare(elapsed);
    const b = p.next({ tension: 1, state: "PEAK", elapsed });
    assert.ok(b.release, `after a scare got ${b.name}`);
    elapsed += 20;
  }
});

test("dread rises with heavy beats and release beats lower it", () => {
  const p = new BeatPlanner({ rng: rngFrom(2) });
  p.noteScare(0);
  const before = p.dread;
  const b = p.next({ tension: 1, state: "PEAK", elapsed: 0 });
  assert.ok(b.release);
  assert.ok(p.dread < before);
});

test("a fake or light beat appears at least every 5 beats", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const tension of [0, 0.5, 1]) {
      const beats = plan(seed, 60, tension);
      let sinceFL = 0;
      for (const b of beats) {
        sinceFL = b.category === "fake" || b.category === "light" ? 0 : sinceFL + 1;
        assert.ok(sinceFL <= 4, `seed ${seed} t ${tension}: ${sinceFL} non-fake/light beats in a row`);
      }
    }
  }
});

test("weights override: zero disables, a boost dominates, and mix is reported", () => {
  const noFake = plan(1, 60, 0.9, { weights: { fake: 0 } });
  assert.ok(noFake.every((b) => b.category !== "fake" || b.release));
  const off = plan(2, 40, 0.9, { weights: { knock: 0, eyes: 0 } });
  assert.ok(off.every((b) => b.name !== "knock" && b.name !== "eyes"));
  const count = (w) => plan(3, 120, 0.6, { weights: w }).filter((b) => b.name === "whisper").length;
  assert.ok(count({ whisper: 30 }) > count({}));
  const b = plan(1, 1, 0.5)[0];
  const sum = Object.values(b.mix).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.deepEqual(Object.keys(b.mix).sort(), ["cue", "fake", "light", "release", "sound"]);
});

test("every emitted beat event has a valid shape", () => {
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const b of plan(seed, 40, (seed % 10) / 9, { elapsed: seed % 2 ? 0 : 100 })) {
      for (const s of b.steps) {
        assert.ok(validBeatEvent(s.event), JSON.stringify(s.event));
        seen.add(s.event.type);
        if (s.event.id) assert.ok([...BASE_FIGURES, ...WITHERED_FIGURES].includes(s.event.id));
      }
      for (const c of b.cleanup) assert.ok(validBeatEvent(c.event));
    }
  }
  for (const type of ["fake-door", "knock", "empty-open", "false-lunge", "glimpse", "eyes", "shadow-pass", "wall-shadow",
    "far-figure", "hall-light", "light-pattern", "footsteps", "whisper", "silence", "heartbeat-spike", "flicker", "creak", "breath"]) {
    assert.ok(seen.has(type), `never saw ${type}`);
  }
  assert.equal(validBeatEvent({ type: "knock", side: "left", count: 9 }), false);
  assert.equal(validBeatEvent({ type: "nope" }), false);
});

test("beat specifics: door-crack opens 10-20% then closes, glimpse 0.3-0.5 s, cut returns with a hall light", () => {
  const find = (name) => {
    for (let seed = 1; seed < 400; seed += 1) {
      const out = plan(seed, 30, 1).find((b) => b.name === name);
      if (out) return out;
    }
    throw new Error(`no ${name}`);
  };
  const crack = find("door-crack").steps.map((s) => s.event).filter((e) => e.type === "fake-door");
  assert.ok(crack[0].open >= 0.1 && crack[0].open <= 0.2);
  assert.equal(crack[1].open, 0);
  const cut = find("cut-and-return");
  assert.equal(cut.steps[0].event.pattern, "cut-return");
  assert.ok(cut.steps[0].event.seconds >= 0.4 && cut.steps[0].event.seconds <= 1);
  assert.equal(cut.steps[1].event.type, "hall-light");
  assert.ok(cut.steps[1].at > cut.steps[0].event.seconds);
  const fp = find("footsteps-behind").steps[0].event;
  assert.notEqual(fp.from, fp.to);
});

// ---- director integration --------------------------------------------------
function run(seed, { seconds = 180, tension = 0.35, state = "BUILD", weights } = {}) {
  const dir = new ScareDirector({ rng: rngFrom(seed), durationSeconds: seconds });
  if (weights) dir.setBeatWeights(weights);
  dir.start();
  const trace = [];
  for (let i = 0; i < Math.ceil(seconds / 0.05) + 5; i += 1) {
    dir.update(0.05, { tension, state, observed: null });
    const t = dir.snapshot().elapsed;
    for (const e of dir.consumeEvents()) trace.push({ e, t });
  }
  return { dir, trace };
}

test("director emits the new events and snapshot.lastBeat tracks the planner", () => {
  const types = new Set();
  for (let seed = 1; seed <= 12; seed += 1) {
    const { dir, trace } = run(seed, { tension: seed % 2 ? 0.2 : 0.5 });
    for (const { e } of trace) types.add(e.type);
    assert.ok(dir.snapshot().lastBeat === null || BEATS[dir.snapshot().lastBeat]);
  }
  for (const t of ["knock", "fake-door", "eyes", "footsteps", "light-pattern", "hall-light"]) {
    assert.ok(types.has(t), `director never emitted ${t}`);
  }
  const d = new ScareDirector({ rng: rngFrom(1) });
  assert.equal(d.snapshot().lastBeat, null);
});

test("director beats are deterministic and respect setBeatWeights", () => {
  const a = JSON.stringify(run(4, { seconds: 60 }).trace);
  assert.equal(a, JSON.stringify(run(4, { seconds: 60 }).trace));
  const { trace } = run(4, { weights: { fake: 0, cue: 0 } });
  const banned = ["knock", "fake-door", "empty-open", "false-lunge", "glimpse", "eyes", "shadow-pass", "wall-shadow", "far-figure"];
  assert.ok(trace.every(({ e }) => !banned.includes(e.type)));
});

test("beats never start so late that they delay a real scare past its gap", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const { trace } = run(seed, { tension: 1 });
    const scareSilences = trace.filter(({ e }) => e.type === "silence" && e.side !== null).map(({ t }) => t);
    assert.ok(scareSilences.length >= 8, `seed ${seed} only ${scareSilences.length} scares`);
  }
});

test("a fake or light beat shows up regularly in a live session", () => {
  const FL = new Set(["knock", "fake-door", "empty-open", "false-lunge", "glimpse", "light-pattern", "hall-light", "flicker"]);
  for (let seed = 1; seed <= 10; seed += 1) {
    const { trace } = run(seed, { tension: 0.35 });
    const times = trace.filter(({ e }) => FL.has(e.type)).map(({ t }) => t);
    assert.ok(times.length >= 4, `seed ${seed}: ${times.length} fake/light events in 180 s`);
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] < 90);
  }
});

test("3 Hz flash safety: no 1 s window holds more than 3 light transitions", () => {
  for (const [tension, state] of [[0, "WAIT"], [0.5, "BUILD"], [1, "PEAK"]]) {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { trace } = run(seed, { tension, state });
      const times = [];
      for (const { e, t } of trace) {
        for (const rel of lightTransitions(e)) times.push(t + rel);
      }
      times.sort((x, y) => x - y);
      for (let i = 0; i < times.length; i += 1) {
        let n = 0;
        for (let j = i; j < times.length && times[j] < times[i] + 1 - 1e-6; j += 1) n += 1;
        assert.ok(n <= FLASH_LIMIT_HZ, `seed ${seed} ${state}: ${n} transitions within 1 s at ${times[i].toFixed(2)}`);
      }
    }
  }
  // Light events declared by the library, in isolation.
  for (const name of ["stutter", "sag", "cut-and-return", "hall-light", "flicker"]) {
    for (let seed = 1; seed <= 20; seed += 1) {
      const b = BEATS[name].build({ roll: rngFrom(seed), between: ([lo, hi]) => lo + (hi - lo) * rngFrom(seed)(), int: () => 1, pick: (l) => l[0] }, { side: "left" });
      for (const s of b.steps) {
        const ts = lightTransitions(s.event);
        for (let i = 1; i < ts.length; i += 1) assert.ok(ts[i] - ts[i - 1] >= 1 / FLASH_LIMIT_HZ - 1e-9, `${name} flashes faster than 3 Hz`);
      }
    }
  }
});

test("cutting a beat short with trigger closes a half-open door", () => {
  let closed = 0;
  for (let seed = 1; seed <= 60 && !closed; seed += 1) {
    const dir = new ScareDirector({ rng: rngFrom(seed) });
    dir.start();
    let open = null;
    for (let i = 0; i < 1200; i += 1) {
      dir.update(0.05, { tension: 0.35, state: "BUILD", observed: null });
      for (const e of dir.consumeEvents()) {
        if (e.type === "fake-door" && e.open > 0) open = e.side;
      }
      if (open && dir.snapshot().activeBeat === "door-crack") {
        dir.trigger("front");
        dir.update(0.05, { tension: 0.35, state: "BUILD", observed: null });
        const evs = dir.consumeEvents();
        if (evs.some((e) => e.type === "fake-door" && e.open === 0 && e.side === open)) closed = 1;
        break;
      }
    }
  }
  assert.ok(closed, "expected a cleanup fake-door close event");
});

// ---- cues ----------------------------------------------------------------
test("cues API exists, stays inside the draw-call budget and animates smoothly", () => {
  const scene = new THREE.Scene();
  const cues = createCues(THREE, scene);
  for (const k of ["group", "eyes", "shadowPass", "wallShadow", "farFigure", "update", "clear", "dispose"]) {
    assert.ok(cues[k], k);
  }
  assert.ok(scene.children.includes(cues.group));
  assert.equal(cues.eyes("nowhere", 2), false);
  for (const side of SIDES) {
    assert.equal(cues.eyes(side, 2), true);
    assert.equal(cues.shadowPass(side, 2), true);
    assert.equal(cues.wallShadow(side, 2), true);
    assert.equal(cues.farFigure(side, 4), true);
  }
  assert.ok(cues.getStats().drawCalls <= BUDGET.drawCalls);
  assert.ok(cues.getStats().maxDrawCalls <= BUDGET.drawCalls);
  let lights = 0;
  cues.group.traverse((o) => { if (o.isLight) lights += 1; });
  assert.equal(lights, 0);
  cues.clear();
  assert.equal(cues.getStats().active, 0);
  assert.ok(cues.group.children.length <= BUDGET.meshes);
  cues.dispose();
  cues.dispose();
  assert.equal(scene.children.includes(cues.group), false);
  assert.equal(cues.eyes("left", 1), false);
});

test("eyes sit in the door void, fade in and out no faster than 3 Hz, then end", () => {
  const cues = createCues(THREE, new THREE.Scene());
  cues.eyes("front", 2);
  const p = cues.getState("eyes").position;
  assert.ok(p.z < DOORWAYS.front.z, "eyes are beyond the door plane");
  assert.ok(Math.abs(p.x) < 0.2 && p.y > 1.4 && p.y < 2);
  let prev = 0;
  let maxRate = 0;
  const peaks = [];
  for (let i = 0; i < 150; i += 1) {
    cues.update(1 / 60, i / 60);
    const o = cues.getState("eyes").opacity;
    maxRate = Math.max(maxRate, Math.abs(o - prev) * 60);
    prev = o;
    peaks.push(o);
  }
  assert.ok(Math.max(...peaks) > 0.9, "eyes reach full brightness");
  assert.ok(maxRate <= 1 / 0.3 + 0.2, `fade rate ${maxRate}/s is faster than a 0.3 s fade`);
  assert.equal(cues.getState("eyes").active, false);
  cues.dispose();
});

test("shadow pass slides across the doorway, wall shadow grows then vanishes, far figure leaves when observed", () => {
  const cues = createCues(THREE, new THREE.Scene());
  cues.shadowPass("left", 1.6);
  const zs = [];
  for (let i = 0; i < 90; i += 1) {
    cues.update(1 / 60, i / 60);
    const s = cues.getState("shadowPass");
    if (s.active) zs.push(s.position.z);
  }
  assert.ok(zs[zs.length - 1] - zs[0] > 0.8, "silhouette travels along the doorway");
  cues.wallShadow("right", 2);
  let tallest = 0;
  for (let i = 0; i < 130; i += 1) {
    cues.update(1 / 60, i / 60);
    tallest = Math.max(tallest, cues.group.children.find((m) => m.name === "cue-wallShadow").scale.y);
  }
  assert.ok(tallest > 3);
  assert.equal(cues.getState("wallShadow").active, false);
  cues.farFigure("back", 5);
  for (let i = 0; i < 60; i += 1) cues.update(1 / 60, i / 60);
  assert.ok(cues.getState("farFigure").opacity > 0.5);
  cues.setObserved("front"); // looking elsewhere changes nothing
  cues.update(1 / 60, 1);
  assert.equal(cues.getState("farFigure").active, true);
  cues.setObserved("back");
  for (let i = 0; i < 20; i += 1) cues.update(1 / 60, 2);
  assert.equal(cues.getState("farFigure").active, false);
  assert.ok(cues.getState("farFigure").position.z > DOORWAYS.back.z + 5);
  cues.dispose();
});

test("cues work with no canvas available (DataTexture fallback) and with a failing canvas", () => {
  const a = createCues(THREE, new THREE.Scene());
  assert.equal(a.eyes("left", 1), true);
  a.dispose();
  const b = createCues(THREE, new THREE.Scene(), { createCanvas: () => { throw new Error("no canvas"); } });
  assert.equal(b.farFigure("right", 1), true);
  b.update(0.1, 0);
  b.dispose();
});
