# Entity system integration — wiring haunt.mjs / animatronic.mjs / ghost.mjs into app.mjs

FNAF-style scare mechanics (mechanics only; all entities are this project's
originals). Three modules, owned by the entity pass:

- `public/haunt.mjs` — pure-logic hunt coordinator (no THREE). Decides when
  entities move, retreat, and jumpscare. Emits events; never touches meshes.
- `public/animatronic.mjs` — the Attendant. Moves ONLY while unobserved,
  along waypoints; lunge jumpscare into the player's face; blackout eyes.
- `public/ghost.mjs` — the corridor ghost. OPPOSITE rule: staring drains it;
  ignoring it charges a rush + face-reveal jumpscare; blackout eye points.

All public surfaces used before this pass are unchanged (`STAGES`,
`createAnimatronic`, `GHOST_STATES`, `createGhost`, `setState`, `setStage`,
`trigger("advance"|"scare")`, `update(dt, time, visuals)`).

## 1. Imports

```js
import { createAnimatronic } from "./animatronic.mjs";
import { createGhost } from "./ghost.mjs";
import { Haunt, isObserved } from "./haunt.mjs";
```

`haunt.mjs` has zero THREE dependency and no DOM use.

## 2. Construction (once, at scene setup)

```js
// Waypoint path from the Attendant's corner toward the player rig (z=2).
// Final node ends near the player; safeRadius clamps it to >= 0.9 m.
const ATTENDANT_PATH = [
  { x: -2.2, z: -3.6 },
  { x: -1.4, z: -2.2 },
  { x: -0.8, z: -0.6 },
  { x: -0.3, z: 0.6 },
  { x: 0, z: 1.2 }, // clamped out to 0.9 m from the player automatically
];

const attendant = createAnimatronic(THREE, scene, {
  waypoints: ATTENDANT_PATH,
  safeRadius: 0.9,
});
const ghost = createGhost(THREE, scene);

const haunt = new Haunt({
  // rng/now are injectable for tests; in the app the defaults are fine.
  entities: [
    // waypoints here = node COUNT for the coordinator: home (0) plus the
    // 5 path nodes above => 6. Keep this in sync with ATTENDANT_PATH.length+1.
    { id: "attendant", kind: "stalker", aggression: 3, waypoints: ATTENDANT_PATH.length + 1 },
    { id: "ghost", kind: "charger", aggression: 4 },
  ],
});
```

The coordinator's waypoint index is the source of truth; the Attendant's own
`waypointIndex` follows it one "advance" at a time (see events below).

## 3. Session lifecycle

- On **Begin**: `haunt.start()`.
- On **Reset / end-of-session**: `haunt.reset(); attendant.setStage(0);
  ghost.setState("hidden");` — `setStage(0)` also un-latches a jumpscare and
  returns the Attendant to its pre-jump spot. To fully re-home the Attendant
  after a completed path, dispose/recreate it or leave it (WAIT decay handles
  the pose; position persists by design).
- Director WAIT already fully decays the coordinator each update.

## 4. Per-frame calls (render loop, after `director.step/snapshot`)

```js
const visuals = director.snapshot(now); // existing call

// (a) Observation: one cone test per entity from the active camera
// (renderer.xr.isPresenting ? xrCamera : desktopCamera).
const cam = {
  position: camera.position, // works with THREE.Vector3 directly ({x,y,z})
  quaternion: camera.quaternion, // or forward: {x,y,z}; either is accepted
};
const observed = {
  attendant: isObserved(cam, attendant.group.position),
  ghost: ghost.group.visible && isObserved(cam, ghost.group.position),
};
// Note: an invisible ghost can't be "seen"; gate its cone test on visibility.
attendant.setObserved(observed.attendant);
ghost.setObserved(observed.ghost);

// (b) Coordinator tick. elapsed = active session seconds (the same clock
// used for the 120s ending).
haunt.update(dt, {
  tension: visuals.tension,
  state: visuals.state,
  elapsed: visuals.elapsed,
  observed,
});

// (c) Apply coordinator events to the THREE-side entities + audio.
for (const ev of haunt.consumeEvents()) {
  switch (ev.type) {
    case "move": // ev.entity === "attendant": step one waypoint
      attendant.trigger("advance");
      break;
    case "near": // reached the node adjacent to the player
      // optional: nothing required; the grace clock runs inside Haunt.
      break;
    case "stage":
      if (ev.stage === "retreat" || ev.stage === "reset") {
        // Simplest faithful handling: on "reset" send the Attendant dormant
        // (setStage(0)); on "retreat" (RELIEF) also acceptable is a single
        // setStage(1) + leaving position (the room is calming down).
        if (ev.entity === "attendant" && ev.stage === "reset") attendant.setStage(0);
      }
      if (ev.stage === "manifest" && ev.entity === "ghost") {
        // The ghost's own PEAK logic usually shows it already; if hidden,
        // force the apparition so the charge reads on screen:
        if (ghost.state === "hidden") ghost.setState("apparition");
      }
      break;
    case "jumpscare":
      onJumpscare(ev); // see section 5
      break;
    case "cue":
      audioOnCue(ev.cue, ev.entity); // see section 6
      break;
  }
}

// (d) Existing per-frame entity updates (unchanged signatures):
attendant.update(dt, time, visuals);
ghost.update(dt, time, visuals);
```

Ordering matters: setObserved -> haunt.update -> apply events -> entity
update, all in the same frame.

## 5. Jumpscares

`haunt` fires at most ONE jumpscare per session (`{type:"jumpscare", entity,
kind}`; kind is `"lunge"` (attendant), `"rush"` (ghost) or `"blackout"`),
then freezes (`snapshot().ended === true`) until `reset()`.

```js
function onJumpscare(ev) {
  if (ev.entity === "attendant") attendant.trigger("jumpscare");
  else ghost.trigger("rush"); // "jumpscare" is an accepted alias
  audioOnCue("stinger", ev.entity); // already emitted as a cue event too
  // Recommended: end the session ~1.5s later (after the lunge/reveal lands):
  // show the summary/reset UI. VR comfort: NEVER move or shake the camera.
}
```

Behavior after triggering:
- Attendant: ~0.6 s accelerating lunge to 0.42 m in front of the player at
  raised eye height, jaw gaping, eyes at max flare; it stays latched in the
  player's face until `setStage(0)` (which restores its pre-jump position).
- Ghost: fast (~3.2 m/s) approach — allowed through the door line, stopping
  0.9 m out — brief face-reveal swell (~0.8 s), then it banishes itself.
  Track it via `ghost.mode` (`null | "approach" | "reveal"`).

## 6. Audio cues (hooks for the AudioEngine owner)

Haunt emits `{type:"cue", cue, entity?}` events. Map them onto synthesized
sounds — none of these autoplay; the engine's explicit opt-in gate applies:

| cue        | when                                        | suggested sound                 |
|------------|---------------------------------------------|---------------------------------|
| `footstep` | an entity advanced a waypoint (unseen)      | single dull knock/step, panned from the entity's position |
| `breath`   | entity reached the final waypoint / ghost manifested | close, slow breathing loop (stop on retreat/reset) |
| `stinger`  | jumpscare fired                             | loud short stinger (respect the master volume cap) |
| `eyes`     | blackout began (power-out image)            | low sub-drone + faint servo whine |

Spatialize using `attendant.group.position` / `ghost.group.position` at the
moment of the cue. A `stop-breath` isn't emitted; stop the breathing loop on
any `stage` event with `retreat`/`reset`, and on session reset.

## 7. Blackout (power-out set piece)

When integration decides the lights die (e.g. a future power mechanic or a
scripted beat), wire BOTH directions:

```js
// lights out:
attendant.setBlackout(true);
ghost.setBlackout(true);
haunt.notify("blackout"); // emits the "eyes" cue; jumpscare after ~3s if sustained
// lights back:
attendant.setBlackout(false);
ghost.setBlackout(false);
haunt.notify("blackout-end");
```

In blackout, entity bodies drop to near-zero opacity while the eyes stay
bright emissive points (Attendant: one bright amber + one dim flickering eye;
ghost: two pale points). The blackout jumpscare targets whichever entity is
furthest along; render it with the same `onJumpscare` handler.

## 8. Difficulty / creator controls

- `haunt.setAggression("attendant", 0..20)` or `haunt.setAggression(n)` for
  all — the FNAF AI-level dial; wire to studio UI sliders if desired.
- Effective aggression auto-escalates with `elapsed` (+2.5/min) and `tension`
  (+6 at tension 1), clamped to 20. LOW intensity => high tension => scarier,
  consistent with the existing Director mapping.
- `haunt.snapshot()` is cheap and UI-friendly: per-entity
  `{kind, aggression, effective, waypoint, waypoints, charge, graceT}` plus
  `{running, ended, blackout}` — good for the diagnostics panel and the
  session summary (no raw sensor data involved).

## 9. Invariants the integration must preserve

- Call `consumeEvents()` exactly once per frame (events are drained).
- Never move, shake, or teleport the camera for a scare — entity motion,
  light and sound only.
- Keep each entity's `update(dt, time, visuals)` running every frame even
  while observed/latched; freezing is internal state, not a skipped update.
- `isObserved` has no occlusion test by design (the cone IS the rule); don't
  add raycasts without re-tuning aggression.
- The Director contract and signal schema are untouched; the Haunt consumes
  the existing visuals snapshot fields only (`tension`, `state`, `elapsed`).
