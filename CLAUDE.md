# Claude handoff — Focused / The Quiet Room

## Current user request and scope

The user is handing this project to Claude. They asked to push all existing code and an honest checkpoint, **not to continue the expansion in this handoff turn**.

They own the VR/scene side of an adaptive horror hackathon project; their friend owns sensor acquisition, processing, calibration and quality. They want a complete, polished desktop-testable system, with physical Meta Quest 3S testing deferred. The headset exists but was **not connected**. They explicitly requested multiple background agents for visual/system expansion. Three agents were dispatched, then stopped for this handoff. **All three confirmed they wrote no files.** Their proposals below are plans, not delivered features.

## Repository and active application

Repository: https://github.com/nikhil-s1nha/focused

**Use `haunted-room/` for all current product work.** The repository root also contains an older EEG visualizer prototype; its message format and dependency tree are separate and must not be confused with the current experience.

```sh
cd haunted-room
npm ci
npm test
npm start
```

Open http://127.0.0.1:8080 on the laptop running Node. The server is localhost-only by default. A previous process may still occupy port 8080 in the original Codex session. `npm start` is a plain Node process, not a watch server; restart it after server changes, reload the page after client changes.

Active dependencies: Three.js 0.186.1 and ws 8.22.0; no framework or bundler. All runtime modules are served locally. Node >=20.19. Package lock is committed. `npm audit` for **haunted-room** reported zero vulnerabilities at the checkpoint. The historical root package uses older dependencies and is not the current audited runtime.

## Implemented now

- Original procedural single-room scene: walls, floor, doorway, chair, cabinet, hanging lamp, window and shadow figure. Art is **basic**, not the requested final visual quality.
- WebXR renderer/VR entry using Three.js VRButton, local-floor reference space, tracked controller rays and world-space text/button panels.
- Desktop drag-to-look from a fixed position; no WASD locomotion, physics, forced camera travel, hand tracking, or room-scale collision system.
- Manual slider, browser synthetic mode, and real POST-to-WebSocket signal integration.
- Director: BUILD, PEAK, RELIEF, WAIT; smoothing/dwell thresholds, tension cap, three-second freshness gate, poor-quality easing.
- Lighting/dimming, fog, shadow visibility/position and explicit opt-in synthesized spatial drone.
- Start, reset, 120-active-second ending; effect toggles and low/high threshold controls. Shadow placement is disabled while running.
- Clear manual/synthetic labeling. Hardware source is bridge-reported, not independently verified.
- WebSocket retries, generation guards, latest frame receipt freshness (monotonic), malformed packet handling.
- Server 8 KiB publisher limit, strict allowlist forwarding, optional bearer `PUBLISH_TOKEN`, HTTP/HTTPS support and local module serving.
- `README.md`, `TEST-REPORT.md`, `preview.jpg` in the active project.

No physical sensor acquisition, calibration implementation, raw waveform processing, actual fear/emotion recognition, LLM director, persistent session storage, analytics history, pause/resume, encounter scheduler, session export, authoring UI in VR, preset import/export or external art assets are implemented.

## Signal contract — preserve this for the friend

The friend publishes approximately 10 Hz to POST `/api/signal` on the scene host:

```json
{"type":"signal","source":"hardware","intensity":0.42,"signal_quality":0.9,"timestamp":1792256400.0}
```

- `source`: hardware | synthetic | manual, truthfully labeled.
- `intensity`, `signal_quality`: finite 0–1.
- `timestamp`: runtime Unix **seconds**.
- Accepted: 204; invalid: 400; too large: 413; token mismatch: 401 when enabled.
- Server broadcasts only those five fields at `/signals` (ws/wss matches page scheme).
- No raw electrode values are forwarded or stored. Current freshness uses monotonic browser receipt time, not the publisher clock. No capture-to-photon latency claim.
- Source and quality are experimental control input, not a validated fear classifier.

Run `npm run mock` in a second terminal, choose Live stream and Begin. The feed is a labeled mathematical synthetic source, not BrainFlow. Stop it to verify WAIT. For another host use `HOST=0.0.0.0 npm start`; publisher must use the scene laptop address, not its own localhost. Optional `PUBLISH_TOKEN` must match publisher Authorization bearer header.

## Testing actually completed

Six active tests passed (`npm test`): input validation; low input reaches/caps PEAK; high input RELIEF; poor quality/dropout easing; reset/end; actual HTTP-to-WebSocket relay including stripping extras, authorization, payload limit and serving modules.

Desktop browser was inspected through the Codex in-app browser. Observed room rendering, begin/reset, manual low input at PEAK/tension 0.85, high input reducing tension, live mock showing SYNTHETIC with quality 0.95 and RELIEF, stopping mock producing WAIT with tension zero. Browser console had no errors when checked. `TEST-REPORT.md` records limits.

**Not verified:** physical Quest entry/stereo/head tracking/controller actions, HUD comfort, perceived spatial audio, trusted certificate on Quest, real hardware input or long device performance run. The desktop browser displayed VR NOT SUPPORTED; that is not evidence of a Quest defect. The 120s ending is unit-tested, not a recorded complete headset run.

## Important usability issue the user reported

They said “nothing seems to be working.” The inspected page was still Ready, with slider at 1.00. Begin had not been pressed; high input calms the room. Starting at 0.00 produced PEAK after ~15–20 seconds. This reveals weak onboarding and subtle feedback, not proof the current controls are broken.

Make the next version obvious:

1. Press Begin (Reset returns to ready and stops the experience).
2. Manual slider **left/low builds tension**, right/high gives relief. Neutral 0.5 holds; it does not automatically build.
3. Smoothing plus dwell means changes take seconds, not instant jumps.
4. Live stream waits if no publisher is running.
5. Sound must be explicitly opted into.
6. Desktop VR NOT SUPPORTED is expected; test flat rendering independently.

## Current source ownership / structure

- `haunted-room/public/app.mjs`: monolithic Three.js scene, UI handlers, source connection, desktop and XR controls, audio and render loop (~550 lines). Primary integration point.
- `public/director.mjs`: pure Director + validSignal/CONFIG; existing API constructor(config), reset(), start(), receive(message,now), step(dt,now), snapshot(now).
- `public/index.html`, `public/style.css`: current UI; large hero overlay obscures room. Replace with clearer compact studio controls.
- `server.mjs`: Node HTTP/HTTPS server + ws relay; `relay.mjs`: validation/allowlist.
- `mock-feed.mjs`: network simulation.
- `test/*.test.mjs`: active tests.
- Root `src/`, `tests/`, `index.html`, `vite.config.js`, `mock-server.js`, package files: historical observatory, intentionally retained for reference, not integrated.

## Approved expansion backlog (NOT IMPLEMENTED)

User: “expand this feature ... build out the entire system apart from [the headset] ... multiple background agents ... finish the rendering of individual parts ... as sick as possible.” Carry that forward with working behavior and clear source labeling, rather than just a decorative landing page.

### 1. Detailed procedural environment (agent plan only)

Extract `public/environment.mjs`:

```js
createEnvironment(THREE, scene)
// => { update(dt, time, visuals), interactables, dispose? }
// visuals: tension,state,elapsed,lighting,fog,shadow,shadowPosition,quality,phase
// interactables: [{id,label,mesh,onInteract?}]
```

Victorian/industrial observation chamber; detailed paneling, floor materials, antique clock/radio/door interactables, animated props, dust/window beams, layered light, distinctive gradual shadow entity. Original code/assets or retain upstream licenses. Aim for hardware-friendly geometry and draw calls. Existing room bounds x ±3.5, z -5.5..3.5, player rig starts z=2 with desktop eye y=1.6 looking -Z. Keep floor/static architecture fixed; avoid forced movement. Environment needs to read well at calm intensity too.

### 2. Director + audio (agent plan only)

Preserve existing API and signal schema. Add deterministic encounter scheduling/cooldowns, capped peak duration, pause/resume/end, selectable duration, event timeline and `getSession()` summary (no raw sensor logging). Suggested extended snapshot fields: elapsed, progress, encounter. Tests must cover behavior and failure recovery.

Separate AudioEngine: explicit async setEnabled(bool) from user gesture, update(snapshot,camera), setVolume(0..1), dispose(). Original spatial drone, sparse footsteps/knocks, volume caps, no autoplay.

### 3. Director studio UI (agent plan only)

Room-first layout: compact header, unobstructed scene, collapsible console, lower diagnostics, clear Begin/next-action guidance, build/relief quick presets, help, pause, export summary, creator preset save/import/export, failure scenarios and sensible mobile layout. No remote font/CDN requirement.

Existing IDs to preserve or explicitly migrate in app:
`overlay, viewport, start, reset, source, intensity, intensityValue, sound, lighting, fog, shadow, position, low, high, sessionState, connection, error, sourceStat, stateStat, tensionStat, qualityStat, timeStat`.

Proposed new controls (none exist):
`pause, exportSession, presetCalm, presetTense, quality, qualityValue, volume, volumeValue, duration, progressBar, encounterStat, fpsStat, rateStat, signalAgeStat, helpToggle, helpPanel, consoleToggle, directorConsole, savePreset, exportPreset, resetPreset, importPreset, scenario, atmosphere, crosshair, interactHint, toast, summaryPanel, summaryContent, dismissSummary`.

Suggested scenarios: cycle/low/high/dropout/artifacts. Atmosphere presets: observatory/cold/ember. Suggested keys: Space start/pause, R reset, 1 build, 2 relief, E interact, H help, F fullscreen. Wire behavior and accessibility; do not add inert controls.

### 4. Integration owner plan (not started)

Extract robust SignalClient with statistics (receive rate, packet age, reconnect state, dropped/malformed counts); simulation ~10 Hz instead of per rendered frame. Optional health endpoint and websocket heartbeat. Creator preset validation/persistence. Readable session results and portable export. End-to-end desktop checks for all source modes, poor quality, dropout, pause/reset, presets and interactions. Improve actual scene quality before claiming “complete.”

Do not mark future features as implemented simply because their APIs are described here. No expansion code landed before this checkpoint.

## Quest path for later

`adb` was not found in the local shell and the Quest was not connected. USB route to test once set up: developer mode, authorize USB debugging personally, `adb reverse tcp:8080 tcp:8080`, open http://localhost:8080 in Quest Browser. Trusted Wi-Fi route: server TLS_CERT/TLS_KEY matching a hostname and issuer trusted on Quest; HTTPS + WSS. Do not bypass certificate protections. See active README for full acceptance checklist. Acquisition electrical/configuration review is the sensor owner's responsibility before body-connected use.

## Session 2 status (Claude, October 17, 2026) — plan only, no code landed

Pulled checkpoint `3a8d98e`, ran `npm ci` + `npm test` in `haunted-room/`: 6/6 pass. Three parallel background agents were dispatched with the file ownership and contracts below; **all three died from an API connection error (ECONNRESET) before writing any files.** Nothing in this section is implemented. Re-dispatch them (same split) or build them sequentially.

### File ownership (keeps parallel agents from colliding)

| Workstream | Owns |
|---|---|
| Environment | `public/environment.mjs`, `test/environment.test.mjs` |
| Director + audio + scenarios | `public/director.mjs`, `public/audio.mjs`, `public/scenarios.mjs`, `test/director.test.mjs`, `test/scenarios.test.mjs` |
| Studio UI + presets | `public/index.html`, `public/style.css`, `public/studio.mjs`, `public/presets.mjs`, `test/presets.test.mjs` |
| Integrator (main session) | `public/signal-client.mjs`, `server.mjs` health/heartbeat, then rewrite `public/app.mjs` as glue |

### Contracts

**environment.mjs** — `createEnvironment(scene, options) → { update(dt, time, visuals), interactables: [{id,label,mesh,onInteract}], anchors: {door,radio,clock,cabinet,window,lamp,figure: Vector3}, stats() → {meshes,drawCalls,lights}, dispose() }`; `ATMOSPHERES = ["observatory","cold","ember"]`. Owns all room geometry, lights, `scene.fog`, `scene.background` and the shadow entity (app.mjs then drops ambient/lamp/windowLight/figure/silhouette). `visuals = { tension, state, phase, elapsed, progress, quality, lighting, fog, shadow, shadowPosition, atmosphere, encounter }`. Budget: <120 draw calls, ≤6 lights, no shadow maps, canvas textures guarded for Node. Victorian/industrial observation chamber; door, clock, radio interactables; dust, moonlight shaft; no fast movement toward the player; floor/walls fixed.

**director.mjs** (keep existing API, CONFIG keys and `validSignal`) — add phases `paused`; `pause()`, `resume()` (clears dwell/smoothing), `end()`, `setDuration(s)` (not while running, clamp 30–600); `maxPeakSeconds` (20) forces RELIEF; seeded deterministic encounter scheduler (`encounters: [{id,anchor,minTension,duration,cooldown}]`, `encounterGap` ≈9 s, `seed`) only in BUILD/PEAK, cancelled on WAIT. Encounter ids/anchors: `lamp-flicker`/lamp, `door-creak`/door, `knock`/cabinet, `radio-static`/radio, `shadow-step`/figure. Snapshot adds `elapsed, progress, duration, paused, encounter: {id,anchor,t,seq}|null`. Event timeline (capped 500) and `getSession()` aggregates only (timeInState, peak/mean tension, encounters, relief/peak counts, sources, mean quality, events) — no raw samples.

**audio.mjs** — `class AudioEngine { enabled; async setEnabled(on); setVolume(v); update(snapshot, listenerObject3D, anchors); dispose() }`. Synthesized only, opt-in, HRTF drone at figure, RELIEF warmth, one-shot per new `encounter.seq` at its anchor, silent outside running/usable signal.

**scenarios.mjs** — `SCENARIOS = ["cycle","low","high","dropout","artifacts"]`, `syntheticSample(name, t) → {intensity, signal_quality} | null` (null = dropout), deterministic, drive at ~10 Hz instead of per frame.

**studio.mjs** — `createStudio(handlers) → { inputs(), render(view), toast(msg, kind), showSummary(session), setError(msg), setSound(on), setPresenting(bool), applyPreset(p) }`. Handlers: begin, reset, togglePause, source, scenario, sound, volume, effects, shadowPosition, thresholds (returns error|null), duration, atmosphere, interact, exportSession, fullscreen. `view = { snapshot, mode, dwell:{low,high,needed}, connection:{state,fresh,rate,age,dropped,malformed}, fps, audioEnabled, interactHint }`. Room-first layout, next-action guidance, slider direction hint, dwell progress, summary panel. Keys: Space begin/pause, R reset, 1 build, 2 relief, E interact, H help, F fullscreen, C console. Preserve and add the IDs listed under backlog item 3.

**presets.mjs** — `DEFAULT_PRESET` (version 1, effects, shadowPosition, thresholds, duration, atmosphere, volume), `validatePreset(obj) → {ok,preset,errors}` (never throws), `loadPreset/savePreset(storage[, preset])` key `focused.preset.v1`, `presetToJSON/presetFromJSON` (16 KiB cap).
