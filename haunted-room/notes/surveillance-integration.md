# Surveillance + Power integration guide

How to wire the security-camera console (`public/monitor.mjs`) and the power
resource system (`public/power.mjs`) into `app.mjs`. Both modules are tested in
`test/wow-modules.test.mjs` (monitor) and `test/power.test.mjs` (power); this
file is the contract for the integration pass. Mechanics are original-themed
(the Attendant / the ghost / the observation chamber) — no third-party IP.

## The loop in one paragraph

The player can pull up the security console to watch four room zones, but the
monitor is a power load. Power drains passively through the 120-second session;
watching drains it faster, the floodlight faster still. Careless usage blacks
out the room before the session ends (dark -> music -> eyes -> scare, owned by
other modules); careful glances survive. Entity AI reads
`monitor.getWatchedZone()` to know what the player is observing.

## monitor.mjs

### Construction (unchanged export)

```js
import { createMonitor } from "./monitor.mjs";
const monitor = createMonitor(THREE, renderer, scene, {
  // all optional; defaults sit on the cabinet and face the player
  active: false, // recommended: start with the console down; Begin leaves it to the player
});
```

Defaults preserved: position `(-2.55, 1.4, -3.7)`, RT 256x192, feed re-render
every 4th `update()` (~10–18 fps at desktop/Quest frame rates), RT frozen while
`renderer.xr.isPresenting` unless `{ xrSafe: true }`.

### Default cameras (override via `options.cameras` if the environment moved props)

| index | id | label | zone |
|---|---|---|---|
| 0 | `far-corner` | `CAM 01 — FAR CORNER` | `far-corner` |
| 1 | `doorway` | `CAM 02 — DOORWAY` (covers the corridor + ghost spawn at z≈-7) | `doorway` |
| 2 | `cabinet` | `CAM 03 — CABINET` (cabinet/window side) | `cabinet` |
| 3 | `rear` | `CAM 04 — REAR` (behind the player) | `rear` |

Camera entries are `{id, label, zone, position:[x,y,z], lookAt:[x,y,z]}`.
Legacy `{position, lookAt}`-only entries still work (ids/zones generated).

### API surface

- `monitor.update(dt, time, visuals)` — call every frame with the director
  visuals (`tension`, `lighting`, and now also `elapsed` for the OSD
  timestamp). Cheap when down/disabled.
- `monitor.setActive(bool)` — pull the console up / put it down. Down = tube
  off, zero RT renders, `getWatchedZone() === null`. **Wire this to
  `power.setLoad("monitor", bool)` in the same handler.**
- `monitor.isActive()`
- `monitor.selectCamera(index)` — switch channel; invalid input ignored (never
  kills the feed). `setFeed(index|-1)` retains old semantics (-1 = dead
  channel, pure static).
- `monitor.getCamera()` -> `{index, count, id, label, zone}` (nulls / -1 when
  the feed is dead).
- `monitor.getWatchedZone()` -> zone id or `null`. **Entity-AI contract:**
  non-null only while the console is up AND the feed is live AND the signal is
  intact. Treat "player watching the CAM of my zone" as observed; a lost
  signal or lowered monitor means unobserved. Poll it per AI tick; don't cache.
- `monitor.staticBurst(duration=0.4)` — VHS interference spike. **Fire it from
  the integration whenever an entity teleports/advances while its zone is being
  watched** (the "it moved while you watched" beat): e.g.
  `if (monitor.getWatchedZone() === entityZone) monitor.staticBurst(0.6)`.
- `monitor.setSignalLost(bool)` — full static + "SIGNAL LOST" OSD, RT renders
  stop. Use when (a) an entity is right at the selected camera, or (b) power
  has blacked out (see below).
- `monitor.getOsd()` -> `{label, zone, rec, timestamp, signalLost, active}` —
  mirrors what the screen shows (label, blinking REC dot, HH:MM:SS from
  `visuals.elapsed`); useful for the desktop HUD so DOM text matches the prop.
- `monitor.getState()` -> `{active, signalLost, camera, cameraCount,
  burstRemaining, disposed}`.
- `monitor.dispose()`.

### Per-frame call site in app.mjs

In the render loop, after `director.snapshot(now)`:

```js
monitor.update(dt, time, {
  tension: snap.tension,
  lighting: effects.lighting,
  elapsed: snap.elapsed, // new: feeds the OSD timestamp
});
```

## power.mjs (new, pure logic — no THREE, no DOM)

```js
import { PowerSystem } from "./power.mjs";
const power = new PowerSystem(); // optional {seed, rng, now, passiveDrain, loadDrains, ...}
```

### API surface

- `power.reset()` — full charge, loads cleared, all events re-armed. Call from
  the existing Reset handler alongside `director.reset()`.
- `power.start()` / `power.stop()` — begin/pause draining. Call `start()` from
  Begin; `stop()` on pause/end.
- `power.setLoad(name, bool)` — named loads. Tuned names: `"monitor"`
  (+0.65 %/s) and `"floodlight"` (+0.9 %/s); unknown names drain at 0.5 %/s.
  Passive drain is 0.35 %/s. No-op after blackout.
- `power.update(dt)` — per frame (internally sliced, frame-rate independent),
  or `power.step(now)` with a seconds clock (gaps > 30 s are treated as clock
  discontinuities and not billed).
- `power.getLevel()` -> 0..1.
- `power.getDrainRate()` / `power.isLoadActive(name)`.
- `power.consumeEvents()` -> array, each event delivered exactly once:
  - `{type:"warning", level:0.2}` — once per session at 20%.
  - `{type:"critical", level:0.1}` — once per session at 10%.
  - `{type:"blackout"}` — once per session at 0%; loads force-cleared.
  - `{type:"flicker", level}` — repeating below 25%, deterministic cadence
    (seeded rng; inject `{rng}` to control it).
- `power.getBlackoutElapsed()` -> seconds since blackout (0 before it). Use it
  to time the power-out sequence: e.g. 0 s dark, ~3 s distant music-box, ~8 s
  eyes in the dark, ~12–15 s scare/session end — the actual beats live in the
  ghost/music-box/audio modules; power just provides the clock.
- `power.getState()` -> `{level, percent, running, blackout, blackoutElapsed,
  activeLoads, drainRate, secondsRemaining}` for the HUD.

### Tuning sanity (unit-tested)

Passive-only ends 120 s at >50%. Monitor pinned up the whole session dies
around ~100 s; monitor+floodlight around ~62 s. Intermittent watching survives.

### Event wiring in app.mjs

```js
power.update(dt);
for (const e of power.consumeEvents()) {
  switch (e.type) {
    case "warning":  // HUD notice + audio cue "powerWarning"
    case "critical": // stronger HUD notice + audio cue "powerCritical"
      break;
    case "flicker":  // momentary lamp dip via atmosphere/lighting owner + audio cue "lightFlicker"
      break;
    case "blackout":
      monitor.setActive(false);     // console dies with the grid
      monitor.setSignalLost(true);  // if re-rendered at all, it's static
      // kill lamp/floodlight through the lighting owner; audio cue "blackout";
      // then drive the sequence from power.getBlackoutElapsed()
      break;
  }
}
```

On Reset: `power.reset(); monitor.setSignalLost(false); monitor.setActive(false); monitor.selectCamera(0);`

## Named audio cue hooks wanted (audio is owned elsewhere)

- `"static"` — short white-noise burst; fire alongside `monitor.staticBurst()`
  and on `setSignalLost(true)`.
- `"cameraSwitch"` — soft CRT blip on `selectCamera()` changes.
- `"monitorUp"` / `"monitorDown"` — on `setActive(true/false)`.
- `"powerWarning"`, `"powerCritical"` — on those events.
- `"lightFlicker"` — ballast buzz on `flicker` events.
- `"blackout"` — grid shutdown thunk + room tone drop; the post-blackout music
  cue is the music-box module's job, keyed off `getBlackoutElapsed()`.

## UI needs

Desktop (studio console additions):
- Power readout: percent number + horizontal charge bar that recolors at 20%
  (warning) and 10% (critical); small per-load usage pips from
  `getState().activeLoads` and an estimated-time readout from
  `secondsRemaining` (cap the display at the session remainder).
- Monitor toggle button ("Cameras") reflecting `isActive()`, plus CAM 1–4
  buttons (disabled while down) highlighting `getCamera().index`; suggested
  keys: `C` toggle console, `1..4` select camera — note keys 1/2 are already
  proposed for build/relief presets in the backlog, so resolve that collision
  in the UI pass (e.g. use plain digits for cameras only while the console is
  up).
- Blackout state: grey the whole console, show "POWER OUT".

VR (no DOM):
- The physical CRT is the interface. Suggested mapping: a controller button
  (e.g. B/Y or grip) toggles `setActive`; trigger while pointing at the CRT
  cycles `selectCamera((i+1)%count)`. The OSD on the screen already shows
  which CAM is up; signal-lost and bursts are visible on the prop itself.
- Power percent in VR: reuse the existing world-space text panel system for a
  small readout near the CRT, or map charge onto the monitor LED blink rate at
  low power. Never attach UI to the camera (comfort).

## Perf notes (already enforced by the modules)

- RT is 256x192, re-rendered every 4th update, only while the console is up,
  the feed live, signal intact, lighting on, and (by default) not during XR
  presentation. `setActive(false)` is the cheap state — default to down.
- OSD canvas redraws at most ~2x/s plus on state changes. All noise is
  procedural (DataTexture fallback keeps Node imports working).
- `power` is pure math; negligible cost.
