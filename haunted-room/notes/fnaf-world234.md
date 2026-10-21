# FNAF 2/3/4 world spaces — wiring notes

Files: `public/fnaf/world/space-fnaf{2,3,4}.mjs` (standalone, THREE injected, no imports; each embeds a ~50-line
mini-kit). Tests: `test/fnaf-world234.test.mjs`. Screens: `notes/screens/f2-*.png f3-*.png f4-*.png`
(headless Playwright/SwiftShader renders; ad-hoc script, not committed).

## Common contract
```js
import { createSpaceFnaf2 } from "./fnaf/world/space-fnaf2.mjs";
const space = createSpaceFnaf2(THREE, scene, { materials?, onInteract?(id, info) });
// { group, update(dt,time,state), interactables:[{id,label,mesh,onInteract}], dispose(), setPowerOut(b), ...api, debug }
```
- `createSpace*` adds `group` to `scene` (scene may be null); `dispose()` removes it and frees owned geo/mat/tex.
- `update(dt, time, state)`: `state` optional `{ tension 0..1, powerOut bool }` (FNAF2 also `eye {x,y,z}`). dt is clamped to 0.1.
  Call once per rendered frame (it does no per-frame allocations of geometry/materials; canvas textures redraw only on change).
- Interactables: `mesh` is a Group/Mesh whose every node has `userData.interactableId`. Each includes an invisible
  proxy hitbox (`mesh.visible=false`, `userData.proxy`) so small props are easy to ray-pick (Raycaster hits invisible meshes).
  Raycast against `interactables.map(i=>i.mesh)` recursively; call `item.onInteract()` — it applies the toggle,
  invokes `options.onInteract(id, result)` and returns the result.
- `options.materials` (textures.mjs library) is optionally used for `wallPlaster/woodDark/metalAged`; everything else is local.
- Player eye assumed ~ (0,1.2,0) facing -Z (FNAF4: (0,1.1,0.25)). Nothing ever moves the player or camera.
- Budget (guarded by tests): <120 meshes (draw calls) with default state, <=2 real-time non-hemi lights (+1 hemisphere), <70 materials.
  FNAF4 worst case with all 5 occupants lit simultaneously is ~133 (impossible with one flashlight cone; realistic <=100).

## FNAF2 — open office, no doors
API: `setFlashlight(on, aimDir)`, `setVentLight('left'|'right', on)`, `setMask(on)`, `setWindLevel(0..1)`,
`setEyePosition(x,y,z | {x,y,z})`, `setHallFigure(zOrNull)` (silhouette+eyes visible only while flashlight on),
`setVentLurker(side,on)` (eyes in vent), `getState()`.
Interactables: `flashlight, mask, monitor, vent-left, vent-right, musicbox`.
- Mask visor: world-space ring (`debug.visor`, child of `space.group`, NEVER camera-parented) placed 0.28 m in front of the
  eye position given by `setEyePosition` / `state.eye` (feed it `camera.position` each frame; in VR use the XR head pose).
  Fades 0.15 s, 0.9 max alpha, clear centre ~35deg, no shake. The hanging mask hides while worn.
- Flashlight: SpotLight (intensity 55 when on; flickers above tension 0.7) + faint additive cone.
- Music box: `setWindLevel` drives ring colour, 6 pips and crank spin; interactable `musicbox` kicks the crank and fires `onInteract('musicbox')`.
  Game logic should respond by calling `setWindLevel(min(1,level+x))` itself.
Wiring: `const s2 = createSpaceFnaf2(THREE, scene, {onInteract:(id)=>game.onInteract(id)})`; each frame
`s2.setEyePosition(camera.position); s2.update(dt, t, {tension, powerOut})`.

## FNAF3 — vent office, heater green
API: `setVentSealed(i 0..2, bool)`, `setSystemFault('audio'|'camera'|'ventilation'|'vent', bool)`, `pulseLure(roomId)`,
`setPanel('audio'|'camera'|'vent')`, `getState()`. Invalid names/indices return false.
Interactables: `btn-audio, btn-camera, btn-vent` (on-screen buttons; select the panel), `vent-0..2` (toggle seal), `lure`, `fan`.
- Monitor shows fault list (blinking red on fault) and a per-panel readout; canvas redrawn only on change and at 2.5 Hz blink while a fault exists.
- Faults: audio -> speaker dead; camera -> screen jitter; ventilation -> fan stutters, green light flickers.
- Seal plates slide down over grates (hidden when open). Lure ring pulses 1.2 s on `pulseLure`.

## FNAF4 — bedroom
API: `setDoor('left'|'right'|'hall', closed)`, `setClosetDoor('left'|'right', open)`, `setFlashlight(on, aimDir)`, `setNightlight(on)`,
`setOccupant(place, charId|null)`, `setBreathing(place, bool)`, `getState()`.
Places: `left, right, closet-left, closet-right, hall`. Side/hall doors default OPEN, closets default CLOSED.
Interactables: `door-left, door-right, door-hall, closet-left, closet-right, flashlight, nightlight`.
- Occupant silhouette + eyes show only when its opening is open AND the flashlight beam hits it (dot > 0.93 from the flashlight origin).
  Eyes colour/ear style derive deterministically from `charId` (4 variants). `charId` is opaque (map your own ids).
- Breathing/eyes-in-dark hint = faint additive mist sprite at the opening (never the only cue; visual hint only).
- Hall door is behind the player (z=+2.2); the user must turn around.

## Honest gaps
- Not integrated into app.mjs; no game logic (AI/power/timers) — pure presentation + state setters.
- Procedural box/sphere art; readable but low-poly. Characters are generic silhouettes (no named designs by intent).
- No audio. Not run in a headset: visor/flashlight comfort and Quest perf are unverified (draw-call counts only; SwiftShader shows 33–65 calls per view).
- Flashlight aim is a world direction supplied by the caller (convert controller/camera forward yourself); the lamp origin is fixed.
- FNAF2 flashlight origin is fixed at the desk; FNAF4 at chest height.
