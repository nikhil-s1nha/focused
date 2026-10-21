# FNAF world 1: office, rooms, camera feed

New modules (THREE injected, import cleanly in Node, no external assets):

- `public/fnaf/world/office.mjs` - `createOffice(THREE, scene, { materials?, autoToggle=false })`
- `public/fnaf/world/rooms.mjs` - `createRooms(THREE, scene, { seed? })`, plus exports `ROOM_IDS`, `CHAR_IDS`, `ROOM_META`, `makePlaceholderKit`, `canvasOf`
- `public/fnaf/world/camera-feed.mjs` - `createCameraFeed(THREE, renderer, scene, rooms, opts)`
- Tests: `test/fnaf-world1.test.mjs` (14 tests). Screens: `notes/fnaf-world1-*.png`.

Room ids (11 camera rooms; `office` is handled by office.mjs): showstage, dining, backstage, cove, hall-west, hall-west-corner, supply, kitchen, restrooms, hall-east, hall-east-corner. Characters: bellwether, lark, ratchet, maestro. Door sides: 'left' | 'right'.

## Wiring into app.mjs

Construction (office is at the origin, player seat (0,1.2,0) looking -Z; rooms sit at z <= -40, hidden):

```js
import { createOffice } from "./fnaf/world/office.mjs";
import { createRooms } from "./fnaf/world/rooms.mjs";
import { createCameraFeed } from "./fnaf/world/camera-feed.mjs";
const office = createOffice(THREE, scene, { materials: textureLib.materials }); // materials optional
const rooms  = createRooms(THREE, scene);
const feed   = createCameraFeed(THREE, renderer, scene, rooms);
office.setMonitorTextures(feed.texture, feed.getMapTexture());
```
Replace environment.mjs/monitor.mjs usage with these (do not create both; they overlap spatially). Remove the old room geometry from the scene. The old environment lighting rig should be dropped: the office brings its own ambient + lamp + two hall point lights (3 real lights + cheap ambient). Rooms add no lights.

Per frame (before `renderer.render`; run once per frame, never inside an XR sub-pass):
```js
office.update(dt, time, { tension });                       // dt is clamped to 0.1 internally
feed.update(dt, time, { active: office.isMonitorUp() && !office.isPowerOut(),
                        interference: haunt?.interference ?? 0, clockText: "2:35 AM" });
rooms.update(dt, time);                                     // light-pool flicker (visible room only)
```
The feed renders ~12 fps only while `active`; it hides all rooms again after its pass, takes care of `renderer.xr.enabled`, scene.background and scene.fog, and restores render target. Do not call setVisibleRoom yourself except for debugging.

Game-state -> world calls:
- Doors: `office.setDoor('left'|'right', closed)` (slides ~0.4 s). `office.getDoor(side)` -> `{closed, progress 0..1, moving}`; gameplay should treat a door as blocking once `progress === 1`.
- Hall lights: `office.setHallLight(side, on)` (app implements hold-to-light by calling it on press/release; or timing). Occupant at a door: `office.setDoorOccupant(side, charId|null)`. Body+eyes are visible only while light is on; in the dark nothing shows; during power out only the eyes show. Hall light flickers while occupied.
- Power: `office.setPowerOut(true)` and `feed.setPowerOut(true)` (everything dark, fan winds down, buttons dead, screens off, only door-occupant eyes).
- Monitor: `office.setMonitorUp(bool)` (screens only show textures while up).
- Cameras: `feed.select(roomId)` (static burst 0.35 s; kitchen shows CAMERA DISABLED / AUDIO ONLY via `opts.disabledRooms/audioOnlyRooms`), `feed.triggerSignalLost(sec)`, `feed.getState()`.
- Characters in rooms: `rooms.setOccupants(roomId, [charIds])` shows built-in silhouette placeholders (created lazily). To use real models: `rooms.usePlaceholders(false)` and `rooms.getAnchor(roomId, charId).add(model)` (anchor is positioned/rotated to face that room's camera; the app should toggle `anchor.visible` itself or keep calling setOccupants which toggles anchor visibility). `rooms.setCoveCurtain(0..1)` opens the cove curtain.

Interaction (existing raycaster over `office.interactables`): ids `door-left, light-left, door-right, light-right, monitor, monitor-map`. Call `item.onInteract(hit)`. By default onInteract only animates the button and emits events (game rules stay in the app); `autoToggle: true` toggles door/light/monitor directly (demo/testing).
```js
office.on('press', ({ id, kind, side }) => { /* kind: door|light|monitor|map */ });
office.on('press-dead', ...);                 // button pressed during power out
office.on('camera-pick', ({ uv }) => { const r = feed.pickCameraAt(uv); if (r) feed.select(r); });
```
For `monitor-map` pass the intersection (`hit.uv`) to `onInteract(hit)`; the office emits `camera-pick` with plain `{x,y}`. Other events: `door`, `door-start`, `door-done`, `light`, `monitor`, `power`, `fan` ({speed}).

Sound hooks: `office.anchors.{fan,radio,lamp,doorLeft,doorRight,hallLeft,hallRight}` are Object3Ds for positional audio; `office.getFanState()` -> `{speed 0..1, angle, position}`; events `door-start/door-done` for slam sounds; `fan` for spin-down; `rooms.getAnchor(...)` for footsteps.

## Budgets (enforced by test)
Office <= 80 visible draw calls (about 63 with nothing at the doors), largest room 34, office + current room < 115 (worst case with 4 occupants checked <= 120). Geometries shared (17 in rooms). 4 light objects in the office (3 real). Canvas textures: 128-256 px, deterministic seeds. In Node (no `document`) materials fall back to flat colors and the OSD/map textures are null.

## Honest gaps
- Not run on a Quest. Render-to-texture inside an XR frame (feed pass with xr disabled) is untested on device; use `opts.xrSafe=false` to freeze the feed while presenting if it hitches.
- Character silhouettes are crude placeholders (capsule + head + eyes) for the character agent to replace.
- Kitchen, supply, restrooms, corners are low-detail dressing; no animated props in rooms besides light flicker and the cove curtain setter.
- Hall light is a toggle (no built-in hold/release or power drain; app owns that). Doors have no audio, no slam camera shake.
- Posters/clock text are tiny canvases; no custom font. Map screen buttons have no hover state.
- Viewed via headless SwiftShader screenshots only (4 saved in notes/). The feed's noise reads heavier in screenshots right after a camera switch (intentional static burst).
