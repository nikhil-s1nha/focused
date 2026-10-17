# Atmosphere / soundscape integration notes

New dread-layer API across the six scene/audio modules. Every pre-existing
export and constructor signature is unchanged — everything below is additive.
All audio remains fully synthesized, opt-in only (`setEnabled(true)` from a
user gesture), and behind the existing volume caps (AudioEngine 0.4, MusicBox
0.35) plus a new limiter.

## atmosphere.mjs — oppressive darkness + light failure

Existing: `createAtmosphere(THREE, {scene, ambient, lamp, windowLight}, opts)`,
`ATMOSPHERES`, `DEFAULT_PRESET`, `api.update(dt, time, visuals)`,
`setPreset(name)`, `setDomOverlay(bool)`, `dispose()`.

New:

- `ATMOSPHERES.lockdown` — fourth preset. Near-black ambience; at PEAK the
  ambient collapses to ~nothing while one warm readable pool stays under the
  lamp. `atmosphere.setPreset("lockdown")` glides into it like any preset.
- Built-in PEAK grading (all presets): while `visuals.state === "PEAK"`,
  ambient gets an extra `×(1 − 0.8·shapedTension)` sag and the window
  `×(1 − 0.6·shapedTension)`. The lamp is deliberately NOT extra-dimmed —
  that is the FNAF "one warm pool" read. No call needed; it follows the
  snapshot already passed to `update`.
- `api.flicker(intensity = 0.7, duration = 1.2, pattern = "stutter")` —
  transient lamp sputter, applied post-smoothing so it reads fast.
  Patterns: `"stutter"` (deterministic fluorescent on/off chatter, decaying)
  and `"sag"` (one smooth brown-out dip). Ambient is dragged along at 40%
  depth. Expires on its own. Power/haunt owners: call this on brown-outs.
- `api.setBlackout(bool)` — sticky. Kills practically all light: lamp drops
  to a 2% remnant, ambient to 1.5%, window to 0, background/fog colors are
  crushed ×0.06. Darkness slams in (~0.05 s ease), light crawls back
  (~0.5 s ease) when cleared. Pair with
  `audio.cue("blackoutPowerDown")` + `musicBox.setWind(0)`.
- `api.lightsCut(seconds = 1.5)` — one-beat scare: instant darkness
  (blackLevel snaps to 1, no glide down), restores by itself after
  `seconds`. Classic pre-scare beat: `audio.duck(seconds)` +
  `atmosphere.lightsCut(seconds)` then `audio.cue("stinger")` on restore.
- Read-only getters for wiring/diagnostics: `api.blackout` (bool),
  `api.blackLevel` (0..1 current darkness), `api.cutRemaining` (seconds).

Per-frame: unchanged — keep calling `atmosphere.update(dt, timeSeconds,
visuals)` once per frame; flicker/blackout/cut are resolved inside it.

## audio-engine.mjs — FNAF sound design

Existing: `new AudioEngine({contextClass})`, `setEnabled(on)`, `setVolume(v)`,
`update(snapshot, camera)`, `dispose()`. All unchanged. Encounter-driven
one-shots from `snapshot.encounter` still fire exactly as before.

New graph (built on first enable): master-cap gain → DynamicsCompressor
limiter (threshold −12 dB, ratio 16 — when the context supports one) →
destination. A `bed` bus now carries the continuous layers (drone, new
detuned-saw pair with slow LFO breathing, shimmer); one-shot cues route
straight to master so they can land inside a duck.

- `engine.update(snapshot, camera)` now also tracks the listener's floor
  position from `camera.position` ({x,z}) for positional cues. Keep passing
  `renderer.xr.isPresenting ? renderer.xr.getCamera() : camera`.
- `engine.cue(name, opts = {})` → boolean (false before enable / unknown
  name — strictly no sound before opt-in). `opts`:
  - `intensity` 0..1 (default 0.6) — loudness/weight.
  - `position: {x, z}` — pans (x offset / 3.5) and attenuates
    (`1/(1 + 0.35·(dist−1))`) relative to the tracked listener. Or pass a
    raw `pan` (−1..1) instead.
  - `pitch` 0..1 (footstep only) — heavier/duller at 0.
  Names:
  | cue | sound | suggested use |
  |---|---|---|
  | `footstep` | lowpassed noise thud + sub knock, one step per call | entity movement: call per step with its `{x,z}` |
  | `thump` | deep single impact | something hit a wall/ceiling |
  | `knock` | double (or `count: 3`) pitched-down raps | door/cabinet pokes |
  | `breath` | bandpassed noise, inhale + closer exhale (~3 s) | entity near, unseen |
  | `static` | bandpassed noise sputter | monitor/camera switch |
  | `powerWarning` | dull low double-beep | power threshold crossings |
  | `blackoutPowerDown` | descending saw whine + closing filter (~1.7 s) | the moment power dies |
  | `stinger` | dissonant saw cluster + highpassed noise burst, loud but capped/limited | the jumpscare itself |
  | `eyes` | faint beating high-sine shimmer | eyes visible in the dark |
- `engine.duck(seconds = 2)` → boolean. The silence trick: ramps the bed to
  near-silence in 0.3 s, holds for `seconds`, creeps back over 1.2 s. Cues
  bypass the bed, so `duck(2)` … wait … `cue("stinger")` plays the sting
  into true silence. `engine.duckedUntil` is the audio-clock release time.

## music-box.mjs — wind-down dread

Existing: `MusicBox`, `MELODY` (original lullaby — unchanged), `setEnabled`,
`setVolume`, `update(snapshot)`, `hardCut()`, `tick()`, `dispose()`.

New:

- `box.setWind(v)` → clamped 0..1 (default 1 = fully wound, old behavior
  exactly). As wind falls: tempo drags (BPM × (0.35 + 0.65·wind)), pitch
  sags flat (−35 cents at 0 wind, on top of the tension waver), notes drop
  out (`+0.5·(1−wind)` drop probability, capped 0.9). At 0 the box stops —
  the bus fades like WAIT. Integration: tie to power
  (`box.setWind(power.level)`) and call `setWind(0)` on blackout. Fully
  deterministic for a given injected rng.
- `box.setMuffled(bool)` → the box plays as if behind a wall: a lowpass in
  the chain drops to 620 Hz (restores to 16 kHz). Safe to call any time,
  including before enable. (Only audible when the AudioContext supports
  BiquadFilter; the flag tracks regardless.)

## environment.mjs — decay + new interactables

Existing contract preserved: `createEnvironment(THREE, scene, {materials})`
→ `{update, interactables, dispose, debug}`; ids `clock`, `radio`,
`corridor-door` behave as before.

New:

- Two new interactables (total now five):
  - `drawing` — a child's crayon drawing (procedural `paperDrawing`
    texture: house, sun, family — and a too-tall black fourth figure) taped
    crooked to the front wall. `onInteract()` makes the paper stir for ~4 s;
    it also trembles on its own at high tension.
  - `wire` — a dangling ceiling wire by the corridor mouth with a sparking
    tip (emissive flicker only — no extra light, stays inside the 2-light
    budget). Arcs sporadically on a deterministic pattern, more under
    tension; `onInteract()` provokes a 1.6 s arc shower. Pair sparks with
    `audio.cue("static", {position: {x: 0.95, z: -5.05}, intensity: 0.3})`.
- `env.creakDoor(delta = 0.12)` → new API: nudges the leaning corridor door
  open by `delta` radians, clamped 0..1.45; returns the new target. Lets
  the director/haunt creak the door without faking an interaction. The old
  PEAK self-drift and WAIT settling are unchanged.
- Set dressing (no API): peeling-paint patch (left wall), long claw drags
  (right wall by the corridor), two swaying cobwebs. These pick up the
  injected `wallDamaged` / `scratchedPlaster` / `paperDrawing` materials
  (flat fallbacks built otherwise).
- `debug` additions: `spark`, `drawing`, `doorTarget`.

## textures.mjs — three new material roles

`createMaterialLibrary` now returns eleven keys: the original eight plus
`wallDamaged` (peeling paint over dark undercoat, drips), `scratchedPlaster`
(parallel claw gouges with torn lips, cut deep into the bump map) and
`paperDrawing` (the taped drawing, 256 px). Same guarantees: deterministic
per seed, headless flat fallback, `dispose()` covers them. Integration:
nothing to change — `app.mjs` already passes `library.materials` into
`createEnvironment`, which picks the new keys up by role name.

## volumetrics.mjs — dust motes in the beams

`createVolumetricCone` unchanged. New export:

- `createDustMotes(THREE, {count = 140, radiusBottom = 0.9, height = 2.2,
  color, size, seed})` → `{points, material, update(dt), agitate(strength),
  setIntensity(v), turbulence, dispose()}`.
  - Same local convention as the cone (apex at origin, body down −Y), so
    parent `motes.points` under the same object as the cone mesh and the
    dust sits inside the beam. One Points draw call, `count` hard-capped at
    200, positions mutated in place (zero per-frame allocations), motes
    respawn near the apex when they drift out of the cone.
  - Per frame: `motes.update(dt)`; drive `motes.setIntensity(x)` with the
    same value as `cone.setIntensity(x)`.
  - `motes.agitate(strength = 1)`: kick when an entity moves through or
    near the beam (ghost step, door swing, lights cut) — the dust rushes
    (~7× drift) and settles back over ~2.5 s. Takes the max of current and
    new, so repeated small kicks never calm it.

## Suggested wiring (per frame, in app/integration order)

```js
// 1. visuals snapshot from the director as today
environment.update(dt, t, visuals);
atmosphere.update(dt, t, visuals);
lampMotes.update(dt);            // createDustMotes under the lamp cone
audio.update(snapshot, xrOrDesktopCamera);
musicBox.update(snapshot);
```

Event beats (from director/haunt/power owners):

```js
// brown-out:       atmosphere.flicker(0.6, 1.5, "sag"); audio.cue("powerWarning");
// entity step:     audio.cue("footstep", {position: p, intensity: 0.7}); lampMotes.agitate(0.6);
// pre-scare:       audio.duck(2.5); atmosphere.lightsCut(2.5); musicBox.hardCut();
// the scare:       audio.cue("stinger", {intensity: 1});
// power dying:     musicBox.setWind(power.level); atmosphere.flicker(0.5, 1, "stutter");
// blackout:        atmosphere.setBlackout(true); audio.cue("blackoutPowerDown"); musicBox.setWind(0);
// recover:         atmosphere.setBlackout(false); musicBox.setWind(1);
```

All new one-shot cue calls are optional and safe before `setEnabled(true)`
(they return false and make no sound), so integration can wire beats without
guarding on the audio toggle.
