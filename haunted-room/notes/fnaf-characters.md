# FNAF-style characters (original designs)

Files: `public/fnaf/world/characters.mjs` (rig, four main characters),
`public/fnaf/world/characters-extra.mjs` (extras), `test/fnaf-characters.test.mjs`.
All designs are original; THREE is injected; no external assets.

## API (identical for every character)

```js
import * as THREE from "three";
import { createCharacter, createCharacters } from "./fnaf/world/characters.mjs";
import { createExtraCharacter, createExtras } from "./fnaf/world/characters-extra.mjs";

const c = createCharacter(THREE, "bellwether", { position:{x,y,z}, rotationY, player:{x,y,z}, shadows:false });
scene.add(c.group);
c.update(dt, time, { tension: 0..1, observed: bool });   // call every frame
c.setPose("idle"|"stare"|"peek"|"lean"|"jumpscare"|<character pose>);  // false if unknown
c.setLookTarget(vec3 | null);   // head tracks a WORLD point while pose.look > 0
c.jumpscare([playerPos]);       // lunge to 0.42 m from the player's eye, 0.6 s, latches
c.setBlackout(bool);            // body fades to a near-invisible void material, eyes stay emissive
c.setVisible(bool); c.dispose(); // dispose is idempotent; every call is a no-op afterwards
c.getState(); c.stats; c.eyeMaterial; c.poses; c.id; c.group
```

- ids: `bellwether`, `lark`, `ratchet`, `maestro`; extras `marionette`,
  `withered_hare`, `withered_songbird`, `withered_maestro`, `imp_0..imp_3`,
  `phantom`, `stalker`.
- `createCharacters(THREE, scene, rooms?, opts?)` -> `{characters, list, update(dt,time,stateOrMap), setBlackout, dispose}`;
  `rooms` is `{id:{x,y,z,yaw}}` (default: a row at z=-4.8). `createExtras` is the same for extras.
- Characters face local +Z. Place them so +Z points into the room.
- Jumpscare: only the character moves (never the camera). Leaving it with any other
  `setPose` snaps the character back to its pre-jump spot. Sound is handled elsewhere.
- Ratchet extras: `setStage(0..3)` (poses `stage0..stage3`, distinct silhouettes) and pose `run`
  (in-place run cycle ~1.4 Hz stride; the scene translates the group).
- Marionette poses: `boxed` (hidden, lid shut), `rise`, plus the standard ones; lid and crank animate.
- Stalker extra poses: `loom` (arms on the door frame), `bedside`.
- `peek` assumes a door-frame edge at local x ~ +0.45 (about half the body hides behind it).
- Maestro: eyes read as black voids in light (emissive ~0.05) and glow white in blackout.

## Budgets (asserted in tests)

Every character < 6000 triangles (measured from the actual scene graph), <= 4 materials:
shared `body` (vertex-coloured, grime canvas texture, rim-light patch), shared `metal`,
shared `void` (blackout fade), plus one per-character eye material. The phantom uses the shared
translucent `phantom` material instead of body/metal. Materials are reference-counted per THREE
instance; disposing one character never frees them for others. Geometry is merged per body
part and material (about 15-25 draw calls per character).

## Comfort

Eye intensity eases with a 0.12 s time constant (no flashing); no camera motion; ramps are
smooth, so nothing exceeds 3 Hz.

## Screenshots

`FNAF_RENDER=1 npm test` renders sheets to `notes/screens/fnaf-chars-{main,withered,small,misc}[-dark|-scare].png`
(needs `npx playwright install chromium`).

## Known gaps

- Blackout fade is a two-step swap (opaque -> near-invisible), not a smooth alpha ramp, because
  materials are shared across characters.
- No curtain or door-frame geometry is included; the scene supplies them.
- Eyes do not move independently of the head; the pupil is a single glowing sphere.
- Limbs are rigid cylinders (stiff, puppet-like); the look relies on faces, damage and silhouette.
- Not yet tested on Quest hardware or inside the real scene lighting.
