import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTENDANT_NODE_COUNT,
  ATTENDANT_PATH,
  ATTENDANT_ZONES,
  BlackoutTimeline,
  BLACKOUT_SCARE_DELAY,
  DIFFICULTY,
  JumpscareFlow,
  SessionStats,
  attendantZone,
  clampAi,
  describeCause,
  difficultyFor,
  entityObserved,
  floodlightHits,
  formatEta,
  ghostZone,
  powerTier,
} from "../public/session-flow.mjs";
import { Haunt, isObserved } from "../public/haunt.mjs";
import { PowerSystem } from "../public/power.mjs";

test("zone map covers every waypoint node and matches default camera zones", () => {
  assert.equal(ATTENDANT_ZONES.length, ATTENDANT_NODE_COUNT);
  assert.equal(ATTENDANT_NODE_COUNT, ATTENDANT_PATH.length + 1);
  const cams = new Set(["far-corner", "doorway", "cabinet", "rear"]);
  for (const z of ATTENDANT_ZONES) assert.ok(cams.has(z), z);
  assert.equal(attendantZone(0), "cabinet");
  assert.equal(attendantZone(99), "rear", "clamped");
  assert.equal(attendantZone(NaN), "cabinet");
  assert.equal(ghostZone(-7), "doorway");
  assert.equal(ghostZone(-2), "far-corner");
  assert.equal(ghostZone(1), "rear");
  assert.equal(ghostZone(NaN), "doorway");
});

test("entityObserved: view cone OR watched zone; invisible never observed", () => {
  assert.equal(entityObserved({ camObserved: true, watchedZone: null, zone: "rear" }), true);
  assert.equal(entityObserved({ camObserved: false, watchedZone: "rear", zone: "rear" }), true);
  assert.equal(entityObserved({ camObserved: false, watchedZone: "cabinet", zone: "rear" }), false);
  assert.equal(entityObserved({ camObserved: false, watchedZone: null, zone: "rear" }), false);
  assert.equal(
    entityObserved({ camObserved: true, watchedZone: "rear", zone: "rear", visible: false }),
    false,
  );
});

test("floodlight beam is narrower than the view cone", () => {
  const cam = { position: { x: 0, y: 1.6, z: 2 }, forward: { x: 0, y: 0, z: -1 } };
  const off30 = { x: Math.tan(0.52) * 4, y: 1.6, z: -2 }; // ~30 deg off axis, 4 m out
  assert.equal(isObserved(cam, off30), true);
  assert.equal(floodlightHits(cam, off30), false);
  assert.equal(floodlightHits(cam, { x: 0, y: 1.6, z: -3 }), true);
});

test("JumpscareFlow: telegraph (duck + one cut) -> lunge+stinger -> end, once", () => {
  const f = new JumpscareFlow();
  const a = f.trigger({ entity: "attendant", kind: "lunge" });
  assert.deepEqual(a.map((x) => x.type), ["duck", "lightsCut"]);
  assert.equal(a[0].seconds, 0.8);
  assert.deepEqual(f.trigger({ entity: "ghost", kind: "rush" }), [], "second trigger ignored");
  const run = (secs) => {
    const out = [];
    for (let t = 0; t < secs - 1e-9; t += 0.05) out.push(...f.update(0.05));
    return out;
  };
  assert.deepEqual(run(0.4), []);
  const lunge = run(0.45);
  assert.deepEqual(lunge.map((x) => x.type), ["lunge", "stinger"]);
  assert.equal(lunge[0].entity, "attendant");
  assert.deepEqual(run(1.0), []);
  const end = run(0.6);
  assert.deepEqual(end.map((x) => x.type), ["end"]);
  assert.match(end[0].cause, /Attendant/);
  assert.equal(f.phase, "done");
  assert.deepEqual(f.update(5), []);
  f.reset();
  assert.equal(f.phase, "idle");
});

test("JumpscareFlow: blackout scare adds no extra cut-to-dark", () => {
  const f = new JumpscareFlow();
  const a = f.trigger({ entity: "attendant", kind: "blackout" });
  assert.deepEqual(a.map((x) => x.type), ["duck"]);
  assert.match(describeCause({ kind: "blackout" }), /power/i);
  assert.match(describeCause({ entity: "ghost", kind: "rush" }), /ghost/i);
});

test("JumpscareFlow never emits a camera-motion action", () => {
  const f = new JumpscareFlow();
  const types = new Set(f.trigger({ entity: "ghost", kind: "rush" }).map((x) => x.type));
  for (let i = 0; i < 100; i++) for (const x of f.update(0.05)) types.add(x.type);
  for (const t of types) assert.ok(["duck", "lightsCut", "lunge", "stinger", "end"].includes(t), t);
});

test("BlackoutTimeline fires dark -> musicBox -> eyes once each, in order", () => {
  const b = new BlackoutTimeline();
  assert.deepEqual(b.step(false, 0), []);
  assert.deepEqual(b.step(true, 0.01), ["dark"]);
  assert.deepEqual(b.step(true, 2.9), []);
  assert.deepEqual(b.step(true, 3.1), ["musicBox"]);
  assert.deepEqual(b.step(true, 7.9), []);
  assert.deepEqual(b.step(true, 8.2), ["eyes"]);
  assert.deepEqual(b.step(true, 20), []);
  b.reset();
  assert.deepEqual(b.step(true, 9), ["dark", "musicBox", "eyes"]);
});

test("power helpers: tiers, eta, difficulty", () => {
  assert.equal(powerTier(80), "ok");
  assert.equal(powerTier(20), "warning");
  assert.equal(powerTier(10), "critical");
  assert.equal(powerTier(0), "out");
  assert.equal(powerTier(50, true), "out");
  assert.equal(formatEta(Infinity, 60), "steady");
  assert.match(formatEta(30, 120), /^~0:30$/);
  assert.match(formatEta(300, 60), /^lasts/);
  assert.equal(clampAi(99), 20);
  assert.equal(clampAi(-4), 0);
  assert.equal(clampAi("abc"), 5);
  assert.equal(difficultyFor(DIFFICULTY.nightmare.ai), "nightmare");
  assert.equal(difficultyFor(7), "custom");
});

test("SessionStats: derived values only, no raw sensor fields", () => {
  const s = new SessionStats();
  s.tick(10, { monitorUp: true, floodlightOn: false });
  s.tick(10, { monitorUp: false, floodlightOn: true });
  s.noteMove("attendant");
  s.noteMove("attendant");
  s.noteMove("ghost");
  s.noteJumpscare({ entity: "attendant", kind: "lunge" }, 41.234);
  s.blackoutAt = 70;
  s.ai = 5;
  const j = s.toJSON(12);
  assert.equal(j.endedBy, "caught");
  assert.equal(j.cameraUptimePercent, 50);
  assert.equal(j.entityMoves.attendant, 2);
  assert.equal(j.jumpscare.atElapsed, 41.2);
  assert.equal(j.powerAtEndPercent, 12);
  assert.ok(!/intensity|signal_quality|timestamp/.test(JSON.stringify(j)));
});

// ---- headless end-to-end of the coordinator + power + sequencing ----

function simulate({ observe, seconds = 400, tension = 1, rng = () => 0.0, haunt, tick }) {
  haunt ??= new Haunt({ rng, entities: [
    { id: "attendant", kind: "stalker", aggression: 20, waypoints: ATTENDANT_NODE_COUNT },
    { id: "ghost", kind: "charger", aggression: 0 },
  ] });
  haunt.start();
  const events = [];
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    haunt.update(dt, {
      tension, state: "PEAK", elapsed: t,
      observed: { attendant: observe(t), ghost: observe(t) },
    });
    for (const ev of haunt.consumeEvents()) events.push({ t, ...ev });
    tick?.(t, haunt);
  }
  return { haunt, events };
}

test("e2e: attendant advances only while looked away, then catches the player", () => {
  const { events } = simulate({ observe: () => false, seconds: 60 });
  const moves = events.filter((e) => e.type === "move");
  assert.equal(moves.length, ATTENDANT_NODE_COUNT - 1, "walks the whole path");
  assert.ok(events.some((e) => e.type === "jumpscare" && e.entity === "attendant" && e.kind === "lunge"));
});

test("e2e: staring (cone or monitor zone) freezes the attendant", () => {
  const { events, haunt } = simulate({ observe: () => true, seconds: 120 });
  assert.equal(events.filter((e) => e.type === "move").length, 0);
  assert.equal(events.filter((e) => e.type === "jumpscare").length, 0);
  assert.equal(haunt.snapshot().entities.attendant.waypoint, 0);
});

test("e2e: blackout sequence -> blackout jumpscare 13 s after the grid dies", () => {
  const power = new PowerSystem();
  const haunt = new Haunt({
    blackoutDelay: BLACKOUT_SCARE_DELAY,
    rng: () => 1, // attendant never rolls a move
    entities: [{ id: "attendant", kind: "stalker", aggression: 0, waypoints: ATTENDANT_NODE_COUNT }],
  });
  haunt.start();
  const timeline = new BlackoutTimeline();
  power.start();
  power.setLoad("monitor", true);
  power.setLoad("floodlight", true);
  let darkAt = null, scareAt = null;
  const beats = [];
  const dt = 0.05;
  for (let t = 0; t < 200 && scareAt === null; t += dt) {
    power.update(dt);
    for (const e of power.consumeEvents()) if (e.type === "blackout") darkAt = t;
    const st = power.getState();
    for (const b of timeline.step(st.blackout, st.blackoutElapsed)) {
      beats.push([b, t]);
      if (b === "eyes") haunt.notify("blackout");
    }
    haunt.update(dt, { tension: 0.2, state: "BUILD", elapsed: t, observed: {} });
    for (const ev of haunt.consumeEvents()) if (ev.type === "jumpscare") { scareAt = t; assert.equal(ev.kind, "blackout"); }
  }
  assert.ok(darkAt !== null && scareAt !== null);
  assert.deepEqual(beats.map((b) => b[0]), ["dark", "musicBox", "eyes"]);
  const total = scareAt - darkAt;
  assert.ok(total > 12.5 && total < 14, `blackout scare ${total.toFixed(1)}s after dark`);
});
