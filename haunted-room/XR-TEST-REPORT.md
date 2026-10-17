# XR portability test report — automated harness (no headset)

Last run: 2026-10-17 against branch `vr-scene-expansion`, after the expanded scene landed (environment/textures/atmosphere/ghost/animatronic/monitor modules). **8/8 pass.** Re-run after any further integration.

## What this is

An automated suite in `test-xr/` that proves, as far as possible **without a physical Meta Quest 3S**, that the experience will port to the Quest browser. It runs the real server and the real app in headless Chromium (software WebGL via SwiftShader) and emulates a Quest-class headset with **Meta's IWER** (immersive-web-emulation-runtime, the same emulation core behind Meta's Immersive Web Emulator).

Run it:

```sh
cd haunted-room
npm ci
npm run test:xr:install   # one-time: downloads the Playwright Chromium binary
npm run test:xr
```

The harness starts its own server instances on ports **8097/8098** (never 8080), so it cannot collide with a running `npm start`. `npm test` (unit tests) is unaffected and still passes at the time of this report.

## Architecture

- `test-xr/harness.mjs` — shared fixtures: spawns `node server.mjs` on a dedicated port, launches headless Chromium (`--enable-unsafe-swiftshader`), and wires two `addInitScript` layers **before any app script runs**:
  1. always: a `preserveDrawingBuffer` patch (so canvas pixels stay readable after a frame) plus uncaught-error capture on `window.__xrTest`;
  2. XR tests only: the IWER **UMD bundle** (`node_modules/iwer/build/iwer.min.js`, injected verbatim — no bundler needed), then `new IWER.XRDevice(IWER.metaQuest3)` + `installRuntime({ forceInstall: true })` (force needed because headless Chromium ships a stub `navigator.xr`). `navigator.xr.requestSession` is instrumented to count sessions and XR animation frames and to observe `renderState.baseLayer`.
- `test-xr/smoke-render.test.mjs` — flat (non-XR) contract, port 8097.
- `test-xr/xr-session.test.mjs` — emulated-Quest contract, port 8098.
- Plain `node:test` runner (`node --test --test-concurrency=1`), Playwright used as a library. No Playwright config, no imports from `test/`.

The suite deliberately asserts on **stable contracts** (page serves, canvas draws non-black varied pixels, VRButton state machine, session entry, pose-driven view change, error-free input), never on specific scene content, so it survives the concurrent scene/UI rewrites.

Two resilience mechanisms for the mid-rewrite window:

- **Failed-resource capture** — any HTTP >= 400 response is recorded per page and asserted empty, so a missing ESM module fails with the exact URL (e.g. `404 /textures.mjs`) instead of an opaque selector timeout (a 404 on one import silently kills the whole module graph).
- **Boot-blocker skip guard** — before the tests run, `appBootBlockers()` walks the local `./*.mjs` import graph from `app.mjs` through the live server. If any module is missing (another agent's half-landed rewrite), every test **skips with the reason and the missing URLs** rather than failing on a defect in files this harness does not own. The suite self-reactivates the moment the app's module graph is whole again.

`metaQuest3` is the closest published IWER profile to the Quest 3S (same Touch Plus controllers and browser stack); IWER has no dedicated 3S profile.

## Results (current app state)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | smoke: page loads, zero console/page errors, `#viewport` canvas mounted | PASS | HTTP 200, `#VRButton` present |
| 2 | smoke: without XR the VR button degrades gracefully | PASS | settles on "VR NOT SUPPORTED", no crash |
| 3 | render: canvas draws a non-black, non-uniform image | PASS | mean luminance above black, >50 distinct colors |
| 4 | xr-entry: ENTER VR offered, immersive-vr session starts, frames flow | PASS | button flips to "EXIT VR", 1 session, frame loop live, zero errors |
| 5 | stereo: base layer stereo-sized, both eye halves render content | PASS | wide framebuffer observed via `renderState.baseLayer`; left/right halves each non-black and varied |
| 6 | head-pose: moving/yawing the emulated headset changes the rendered view | PASS | 90° yaw + positional offset → large pixel-signature change |
| 7 | input: synthetic right-trigger squeeze/release (primary action → select) | PASS | session survives, zero uncaught/console errors |
| 8 | perf-signal: ~5s in-session FPS + draw stats | PASS | FPS ~10 under headless SwiftShader — a liveness signal only, **not** representative of Quest silicon. The app exposes `window.__renderer`, so draw stats are gated: **238 draw calls per stereo frame = 119/eye** (three renders both eye passes without multiview), within the ≤150/eye Quest budget but with limited headroom — triangles 7,060, geometries 31, textures 21. Watch this number as the scene grows. |

No tests skipped or fixme'd at this run; all eight pass against the current (post-expansion) app. During the mid-rewrite window the suite correctly skipped with reason "missing modules: /textures.mjs" and self-reactivated once the module landed.

## Dependencies added (devDependencies only)

| Package | Version | License | Why |
|---|---|---|---|
| `playwright` | 1.64.1 | Apache-2.0 | headless Chromium automation (library mode, no test-runner config) |
| `iwer` | 2.6.0 | MIT (Meta) | WebXR runtime emulation, Quest-class `XRDevice` |

`npm audit` after adding: 0 vulnerabilities.

## What this harness CANNOT prove — still requires the physical Quest 3S

Everything in the README's "Quest 3S — prove this before polishing art" manual acceptance checklist, specifically:

- Real stereo presentation, lens distortion, IPD comfort, and perceived depth on device.
- Actual Quest Browser behavior: secure-context/certificate trust (HTTPS/WSS route), its WebXR permission prompts, and any Quest Browser-specific quirks.
- Real head tracking and 6DOF quality, controller haptics and physical input feel, hand tracking.
- Performance on Quest silicon (frame-rate, thermals, long-session stability) — the SwiftShader FPS number here is meaningless for that.
- Spatial audio perception and HUD legibility/comfort in-headset.
- The full 120-second session run in-headset.

IWER emulates the WebXR API surface faithfully, but an emulated runtime passing does not guarantee the Quest Browser's implementation (reference-space grants, frame timing, foveation, layer limits) behaves identically.

## Re-run after integration

```sh
cd haunted-room && npm run test:xr
```

If the rewritten app renames `#viewport`, stops using three's `VRButton` (which provides the `#VRButton` id), or moves the canvas, update the selectors in `test-xr/smoke-render.test.mjs` / `test-xr/xr-session.test.mjs` — everything else is contract-level and should hold.
