# simple-figures: doorway figures for the four-door room

Module: `public/simple/figures.mjs`. Tests: `test/simple-figures.test.mjs` (16 tests, all pass).
Characters are the existing FNAF builds (`public/fnaf/world/characters.mjs`), used unchanged, plus an original `doll` (`public/simple/doll.mjs`).

## Geometry

Player stands at the origin, eye at (0, 1.6, 0), facing -Z.

| side  | doorway (wall opening) | figure stands (0.3 m inside) | faces |
|-------|------------------------|------------------------------|-------|
| front | (0, 0, -3.2)           | (0, 0, -2.9)                 | eye   |
| back  | (0, 0, 3.2)            | (0, 0, 2.9)                  | eye   |
| left  | (-3.2, 0, 0)           | (-2.9, 0, 0)                 | eye   |
| right | (3.2, 0, 0)            | (2.9, 0, 0)                  | eye   |

## API

```js
import { createFigures, FIGURE_IDS, SIDES, DOORWAYS, EYE, MAX_VISIBLE, BUDGET } from "./public/simple/figures.mjs";
const figs = createFigures(THREE, scene, { shadows?, createCanvas? });
```

- `figs.group`: THREE.Group added to `scene`. Nothing else is added to the scene.
- `figs.show(side, id) -> bool`: place figure `id` in the doorway on `side`. Replaces whoever was on that side. An id is only ever on one side (showing it elsewhere moves it). Returns false for an unknown side or id, or when `MAX_VISIBLE` (3) other figures are already on screen.
- `figs.hold(side) -> bool`: freeze in the doorway, pose `peek` (half out, head turned). Only from a waiting figure (shown or hold).
- `figs.retreat(side) -> bool`: pull back 0.9 m into the dark over 0.5 s, then hide.
- `figs.lunge(side, seconds = 0.6) -> bool`: fast accelerating lunge. The head ends 0.42 m from the eye; the jaw gapes and the eyes flare. Stays latched until hide/clear. `seconds` is clamped to 0.15..2.
- `figs.caught(side) -> bool`: lunge, then stays latched with max eye flare (4.5). Holds until `hide` or `clear`.
- `figs.hide(side) -> bool`: remove the figure on that side (use for `recover`).
- `figs.clear()`: remove all figures.
- `figs.setBlackout(bool)`: body fades to dark on every figure, eyes stay lit as points.
- `figs.update(dt, time, { tension })`: call every frame. Handles idle, breathing, twitch, lunge, bursts, eye smoothing, and tension sway (only when tension > 0.6).
- `figs.occupant(side) -> id | null`
- `figs.getFigure(side) -> { id, side, phase, pose, position, horizontalDistanceToEye, headPosition, faceDistanceToEye, eyeIntensity, bodyFade, lit } | null`
- `figs.getStats() -> { figures, drawCalls, triangles }` for visible figures.
- `figs.dispose()`: safe to call twice. All later calls return false or no-op.

Phases reported by `getFigure`: `shown`, `hold`, `lunge`, `latched`, `caught`, `retreat`.

## Director wiring

| director event | call |
|----------------|------|
| `figure` (side, id) | `show(side, id)` |
| `hold` (side)       | `hold(side)` |
| `retreat` (side)    | `retreat(side)` |
| `lunge` (side, seconds) | `lunge(side, seconds)` |
| `caught` (side)     | `caught(side)` |
| `recover` (side)    | `hide(side)` |
| `end`               | `clear()` |

Call `update(dt, time, { tension })` each rendered frame. Call `setBlackout(true)` for a blackout beat.

## Look (doorway)

- Waiting figures are near-black silhouettes with pale eyes. The body is dark via the character blackout, and the eyes are lit.
- Harsh bursts: every 1.2 to 3.0 s the body lights for 0.35 s and the eyes brighten. `getFigure().lit` is true during a burst, so the scene's hall light can sync to it.
- Lunge: the face fills the view. The camera never moves; only the figure does.

## Safety and budgets

- No camera motion anywhere. The module never receives or touches a camera.
- Eye brightness is low-passed (0.12 s time constant, cutoff about 1.3 Hz). Bursts are at most about 1 per second. The test caps eye direction changes at 3 per second.
- Tension sway is under 0.4 Hz and only on waiting figures.
- MAX_VISIBLE = 3. Each character builds 15 to 27 meshes (bellwether 27, lark 22, maestro 19, ratchet 15), so four figures at once would be about 83 draw calls, over the 80 budget. Any three is at most 68. Triangles per figure are 2.2k to 2.8k, so three is at most about 8.5k (budget 60k).
- Pool: one character per id (4 total), built in `createFigures`. No models are created at runtime.

## Known limits

- Face distance is calibrated per id (`HEAD_REACH` in figures.mjs) from the built-in lunge pose. A character rig change needs a recalibration; the test checks all ids land at 0.42 +/- 0.03 m.
- The burst lights only the figure's own silhouette via the character's blackout fade (0.35 s time constant). Bursts are softer than a true hard light. A per-figure light would be the stronger option but costs shader variants.
- Recover is an instant hide with no snap-back animation.
- Lunge close-up is low-poly (the existing character models). Jaw gape is out of the frame from the front view.

## Doll (id `doll`)

Original tall, thin porcelain mannequin: elongated segmented neck, cracked china head, stitched wide smile, one oversized glassy eye and one small eye, long dark hair over the left side of the face (a parting lets the small eye peek through), faded long dress with torn hem. Built with the shared character rig in `public/simple/doll.mjs` (`createDoll`, `dollSpec`). 13 draw calls, 2.8k triangles. `FIGURE_IDS` is now bellwether, lark, ratchet, maestro, doll. Worst visible triple is still bellwether + lark + maestro (68 draws).

## Lunge face hook

`createFigures` imports `createLungeFace` from `public/simple/face-texture.mjs`. For ids in `LUNGE_FACE_IDS` (default: `doll`), a face mesh is parented to the head pivot (hidden). Once the lunge passes 55% progress, and while latched or caught, the face shows and the doll's own head, jaw, eyes and front hair curtain hide (back hair stays). Reset on hide, retreat-end, or show.

Swap points:
- `createFigures(THREE, scene, { createLungeFace: (THREE, { seed, createCanvas, scale }) => Mesh })`: replacement face. It must face +Z and may set `mesh.userData.dispose`.
- `createFigures(..., { lungeFaceIds: ["doll", "lark"] })`: which ids get a close-up face. Any id works, but the face replaces that character's head in the lunge.
- Face scale is 0.165 in `figures.mjs`. The face adds one draw call and about 6k triangles only while visible, and hides about 3 head draws.

Screenshots: `notes/screens/simple-doll-lit.png` (lit burst frame), `notes/screens/simple-doll-lunge.png`.

Known doll weak spots: porcelain uses the shared matte body material (no gloss). Back hair is rigid rods, which read as bars in close-up. The lunge face is the other agent's gaunt sculpt, not the doll's own egg head, so the head shape changes at the swap.
