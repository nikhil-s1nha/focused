import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FnafSession,
  FNAF_MODES,
  KEYMAP,
  SCARE_MODEL,
  normalizeEvent,
  scareModelFor,
} from "../public/fnaf-session.mjs";
import { CHARACTER_IDS } from "../public/fnaf/world/characters.mjs";
import { EXTRA_IDS } from "../public/fnaf/world/characters-extra.mjs";

const seeded = (seed = 1) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};

test("normalizeEvent: FNAF1 cue.name and modes' cue.id both become kind:cue with id", () => {
  assert.deepEqual(normalizeEvent("fnaf1", { type: "cue", name: "kitchen-noise", who: "lark", room: "kitchen" }),
    { mode: "fnaf1", kind: "cue", id: "kitchen-noise", who: "lark", room: "kitchen" });
  assert.equal(normalizeEvent("fnaf2", { type: "cue", id: "musicbox", state: "low" }).id, "musicbox");
  assert.equal(normalizeEvent("fnaf4", { type: "cue", id: "creak", door: "left", who: "hollowjaw" }).side, "left");
  assert.equal(normalizeEvent("fnaf1", { type: "cue" }), null, "nameless cue dropped");
});

test("normalizeEvent: hour uses n (FNAF1) or hour (modes 2-4); jumpscare keeps who/reason", () => {
  assert.equal(normalizeEvent("fnaf1", { type: "hour", n: 2 }).n, 2);
  assert.equal(normalizeEvent("fnaf3", { type: "hour", hour: 0, label: "12 AM" }).n, 0);
  assert.deepEqual(
    { who: normalizeEvent("fnaf3", { type: "jumpscare", who: "scrapjack", reason: "vent" }).who },
    { who: "scrapjack" },
  );
  assert.equal(normalizeEvent("fnaf1", { type: "something-else" }), null);
  assert.equal(normalizeEvent("fnaf1", null), null);
});

test("every mode's scare victim has a model in the original character set", () => {
  const models = new Set([...CHARACTER_IDS, ...EXTRA_IDS]);
  for (const [who, model] of Object.entries(SCARE_MODEL))
    assert.ok(models.has(model), `${who} -> ${model}`);
  assert.equal(scareModelFor("unknown-thing"), "stalker");
});

test("each mode has a key map for the hint bar", () => {
  for (const m of FNAF_MODES) assert.ok(KEYMAP[m].length >= 4, m);
});

test("FnafSession rejects unknown modes and starts idle -> running once", () => {
  assert.throws(() => new FnafSession({ mode: "fnaf9" }));
  const s = new FnafSession({ mode: "fnaf1", rng: seeded(3) });
  assert.equal(s.phase, "idle");
  assert.equal(s.start(), true);
  assert.equal(s.start(), false);
  assert.equal(s.phase, "running");
});

for (const mode of FNAF_MODES) {
  test(`${mode}: an unattended night ends in a scare or a win, with a canonical jumpscare`, () => {
    const s = new FnafSession({ mode, night: 1, secondsPerHour: 30, rng: seeded(11) });
    s.start();
    const seen = [];
    for (let t = 0; t < 3000 && s.phase === "running"; t++) {
      s.update(0.1);
      seen.push(...s.consumeEvents());
    }
    assert.ok(s.phase === "dead" || s.phase === "won", `${mode} ended ${s.phase}`);
    if (s.phase === "dead") {
      const j = seen.find((e) => e.kind === "jumpscare");
      assert.ok(j, "dead implies a canonical jumpscare event");
      assert.equal(j.mode, mode);
      assert.ok(s.lastScare && s.lastScare.who === j.who);
    }
  });
}

test("phone calls: PhoneCall governs the call; skip ends it with reason 'skipped'", () => {
  const s = new FnafSession({ mode: "fnaf1", rng: seeded(5) });
  s.start();
  for (let t = 0; t < 40 && !s.phone; t++) s.update(0.1);
  assert.ok(s.phone, "phone call started by the engine's phone-call-start");
  assert.equal(s.phone.snapshot().active, true);
  assert.equal(s.skipPhone(), true);
  const ends = s.consumeEvents().filter((e) => e.kind === "phone-call-end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, "skipped");
  assert.equal(s.skipPhone(), false, "skip is once only");
});

test("phone calls: a jumpscare interrupts a live call", () => {
  const s = new FnafSession({ mode: "fnaf1", rng: seeded(5) });
  s.start();
  for (let t = 0; t < 40 && !s.phone; t++) s.update(0.1);
  s.phone.setMuted(true);
  s.interruptPhone();
  const ends = s.consumeEvents().filter((e) => e.kind === "phone-call-end");
  assert.equal(ends[0].reason, "interrupted");
});

test("controls: FNAF3 edge pulses are cleared after one frame", () => {
  const s = new FnafSession({ mode: "fnaf3", rng: seeded(2) });
  s.start();
  s.controls.lure = "lobby";
  s.controls.seal = "A";
  s.update(0.1);
  assert.equal(s.controls.lure, null);
  assert.equal(s.controls.seal, null);
});

test("controls: holding FNAF1 doors changes the engine's door state", () => {
  const s = new FnafSession({ mode: "fnaf1", rng: seeded(4) });
  s.start();
  s.controls.doorL = true;
  s.update(0.1);
  assert.equal(s.snapshot().engine.doors.left, true);
});

test("reset returns a clean idle session with no phone, scare or events", () => {
  const s = new FnafSession({ mode: "fnaf4", rng: seeded(9), secondsPerHour: 30 });
  s.start();
  for (let t = 0; t < 2000 && s.phase === "running"; t++) s.update(0.1);
  assert.equal(s.phase, "dead");
  s.reset();
  assert.equal(s.phase, "idle");
  assert.equal(s.lastScare, null);
  assert.equal(s.phone, null);
  assert.deepEqual(s.consumeEvents(), []);
  assert.equal(s.start(), true);
});

import { applyPress } from "../public/fnaf-session.mjs";

test("applyPress: FNAF1 office buttons toggle the matching engine controls", () => {
  const s = new FnafSession({ mode: "fnaf1", rng: seeded(1) });
  assert.equal(applyPress(s, "door-left"), true);
  assert.equal(s.controls.doorL, true);
  applyPress(s, "door-left");
  assert.equal(s.controls.doorL, false);
  applyPress(s, "monitor");
  assert.equal(s.controls.monitor, true);
  applyPress(s, "camera", { room: "cove" });
  assert.equal(s.controls.room, "cove");
  assert.equal(applyPress(s, "not-a-button"), false);
});

test("applyPress: FNAF2 mask, camera, vent light (exclusive per side), music box", () => {
  const s = new FnafSession({ mode: "fnaf2", rng: seeded(1) });
  applyPress(s, "mask");
  assert.equal(s.controls.mask, true);
  applyPress(s, "vent-left");
  assert.equal(s.controls.ventLight, "left");
  applyPress(s, "vent-right");
  assert.equal(s.controls.ventLight, "right");
  applyPress(s, "vent-right");
  assert.equal(s.controls.ventLight, null);
  applyPress(s, "musicbox");
  assert.equal(s.controls.wind, true);
});

test("applyPress: FNAF3 seals and system reboots are edge pulses; lure uses the current room", () => {
  const s = new FnafSession({ mode: "fnaf3", rng: seeded(1) });
  applyPress(s, "vent-1");
  assert.equal(s.controls.seal, "B");
  applyPress(s, "btn-audio");
  assert.equal(s.controls.reboot, "audio");
  applyPress(s, "lure");
  assert.equal(s.controls.lure, "hall1");
  s.start();
  s.update(0.1);
  assert.equal(s.controls.seal, null);
  assert.equal(s.controls.lure, null);
});

test("applyPress: FNAF4 door buttons set facing; props toggle", () => {
  const s = new FnafSession({ mode: "fnaf4", rng: seeded(1) });
  applyPress(s, "closet-right");
  assert.equal(s.controls.facing, "closet");
  applyPress(s, "flashlight");
  assert.equal(s.controls.flashlight, true);
  applyPress(s, "door-hall");
  assert.equal(s.controls.facing, "hall");
});
