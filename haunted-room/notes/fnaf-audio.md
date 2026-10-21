# FNAF audio (public/fnaf/audio)

All sound is synthesized WebAudio; no samples, no official melodies or voices. `FnafAudio` composes with an existing `AudioEngine`: it reuses `engine.ctx`, hangs a bus (gain 0.8) on `engine.graph.master` (so the engine's master cap 0.4 and limiter apply), and uses `engine.listener` for positional audio. It never creates a context. Before `await engine.setEnabled(true)` (user gesture) every method is a no-op returning false. If the engine is disabled again, calls no-op again.

## API
```js
import { AudioEngine } from "../audio-engine.mjs";
import { FnafAudio, SubtitlePlayer } from "./fnaf/audio/fnaf-audio.mjs";
const fa = new FnafAudio(engine, { rng });   // rng injectable (default Math.random)
fa.play(name, { position:{x,z} | side:'left'|'right'|'center', intensity 0..1, variant, wind, count, duration })
fa.stop(name, { side? })      // fades loops out; one-shots ring out
fa.setAmbience('office1'|'office2'|'office3'|'bedroom4'|'blackout')
fa.update(snapshot, camera)   // call every frame
fa.handleEvent(engineEvent)   // maps FNAF events to sounds
fa.dispose()
```
`update` tracks listener from `camera.position`, schedules distant thumps/clanks (audio-clock based, no timers, via injected rng), re-pans positioned loops, and honours `snapshot.maskOn` (starts/stops `maskBreath`) and `snapshot.paused`.

Sounds. Loops (stop with `stop`): fan, lightBuzz (side), cameraStatic, maskBreath, musicBoxTick (opts.wind 0..1 sets tick rate/level).
Office: fan doorSlam lightBuzz monitorUp monitorDown cameraBlip cameraStatic doorBang(count 2|3) powerOut sixAM hourChime phoneRing callStart radioCrackle.
Animatronic: footsteps(count) ventCrawl ventBang pans laugh breathing(variant left|right|closet|hall, or side) maskBreath musicBoxTick powerOutJingle(+eyes cue) eyes jumpscare victimSting gameOver murmur(duration).

## Event to sound map (handleEvent)
| engine event | sound |
|---|---|
| `move` | footsteps; `room:'kitchen'` -> pans; `vent:true` -> ventCrawl (pass side/position) |
| `door-knock` | doorBang (count) |
| `jumpscare` | jumpscare (default intensity 0.8) |
| `power-warning` | hourChime (soft) |
| `power-out` | powerOut + powerOutJingle (+eyes) |
| `hour` | hourChime |
| `night-win` | sixAM |
| `static` | cameraStatic (loop; `stop('cameraStatic')` to end) |
| `phone-call-start` / `-end` | phoneRing + callStart / callStart |
| `cue {name}` | breathing, laugh, eyes, vent-bang, vent-crawl, pans, door-slam, light-buzz, monitor-up, monitor-down, camera-switch, victim-sting, game-over, radio-crackle, music-box (optional `variant`, `wind`) |

Direct calls the integrator should make (no engine event): `play('fan')` at night start, `setAmbience(...)` per mode/night, `play('doorSlam',{side})` on door close, `play('lightBuzz',{side})`/stop on light hold, `monitorUp/Down` on monitor flip, `cameraBlip` on camera switch, `victimSting`/`gameOver` after a jumpscare.

## Comfort limits
Per-voice level <= 0.5; jumpscare <= 0.4 with 12 ms attack, ~1 s; all through engine master (<=0.4) and limiter.

## Phone calls
`new SubtitlePlayer(fa, { onSubtitle, manifest, playFile })`; `await sp.play({id,text,duration})` emits `{type:'show',text,duration,id}` (render it), then plays a murmur length-matched to `duration`; `sp.stop()` emits `hide`. Pre-generated voice (e.g. ElevenLabs later): ship `{ "night1-call": "/audio/voice/night1.mp3" }` as `manifest` and pass `playFile(url,line)` (decode+play through the engine ctx/bus, resolve true). Missing entry or a rejected/false result falls back to murmur. Subtitles always show.

## Jingle
`jingles.mjs` exports `POWER_OUT_JINGLE` (original note data, D-minor/chromatic, 58 bpm, distinct from MELODY; tested for no shared 4-note phrase), `scheduleJingle`, `jingleDuration`, `midiToHz`.

## Gaps
Synthesis by ear is untuned (tested via stubs only, no real listening, no Quest). Event payload fields (side, room, vent) are my assumed shape; adapt `handleEvent`. Voices are not cleaned up beyond stop times (GC). Positioned loops re-pan but do not re-attenuate. No HRTF; stereo pan only.
