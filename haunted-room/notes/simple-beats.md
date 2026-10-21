# simple-beats: beat library for the four-door room

Files: `public/simple/beats.mjs` (pure planner + beat scripts), `public/simple/cues.mjs` (THREE cues), `public/simple/scare.mjs` (director now plays beats).
Tests: `test/simple-beats.test.mjs` (21), `test/simple-scare.test.mjs` (18). Run: `node --test test/simple-beats.test.mjs test/simple-scare.test.mjs`.

## ScareDirector changes
- Between-scare beats come from `BeatPlanner`. Old ambient code is gone; `flicker`, `creak`, `breath` are still emitted (as beats).
- `setBeatWeights({name|category: multiplier>=0})` (0 disables; categories: sound, light, fake, cue, release).
- `snapshot()` adds `lastBeat`, `activeBeat`, `dread`.
- A beat in progress is never cut by the gap timer: beats are only chosen if they fit before the next scare (`duration[0] <= gap-0.3`). `trigger()` cancels a running beat and emits its cleanup (closes a cracked door, turns off a hall glow).
- After a real scare the enforced quiet wait (`TIMING.postScare` 3-5 s) counts as the release.
- Changed TIMING: `ambient` [4,8] scaled 1.2x (no pressure) to 0.6x (full); `flickerSeconds`/`flickerSpacing` removed; flicker is now 0.5-0.8 s (2 transitions, so under 3 Hz).
- `silence` with `side:null` (beat) vs a side string (the real scare's pre-hit silence). simple-scare tests now filter on `side !== null`.

## Event contract (all plain objects; `side`/`from`/`to` in left|right|front|back)
```
{type:'fake-door', side, open, seconds}     // ease door to `open` (0..1) over `seconds`; open 0 = close
{type:'knock', side, count}                 // 1..3 knocks, door stays shut
{type:'empty-open', side, seconds}          // swing fully open onto nothing, stay `seconds`, then close
{type:'false-lunge', side, id}              // figure appears, lunges, stops ~1.4 m short, retreats (~3 s total); player NOT caught
{type:'glimpse', side, id, seconds}         // figure in doorway 0.3-0.5 s then hide
{type:'eyes', side, seconds}                // cues.eyes
{type:'shadow-pass', side, seconds}         // cues.shadowPass
{type:'wall-shadow', side, seconds}         // cues.wallShadow
{type:'far-figure', side, seconds}          // cues.farFigure (call cues.setObserved(side) every frame from the look test)
{type:'hall-light', side, level, seconds}   // glow on for `seconds` then off; level 0 = off now (cleanup)
{type:'light-pattern', pattern:'stutter'|'sag'|'cut-return', seconds}
{type:'footsteps', from, to, seconds}       // pan from one side to another behind the walls
{type:'whisper', side}
{type:'silence', side:null, seconds}        // bed ducks to nothing, then nothing happens
{type:'heartbeat-spike', seconds}
legacy, still valid: {type:'flicker', seconds} {type:'creak', side} {type:'breath', side}
```
App hints:
- `light-pattern` stutter: 2 dips per second at most, for `seconds`. sag: ramp light down over ~60% of `seconds`, hold, ramp back. cut-return: light to ~0.03 immediately, back after `seconds` (0.4-1 s). Then the beat sends a `hall-light` ~0.3-0.5 s later.
- `fake-door` open on creak: door-crack sends `creak` first. `empty-open`: opens in ~0.6 s.
- `false-lunge` id is a BASE (or withered after 90 s) figure id; stop the lunge when the head is ~1.4 m from the eye (`figures.lunge` goes to 0.42 m, so use a custom approach or a shortened call and then `retreat`).
- Never send the real `lights` event for beats; beats only use light-pattern/flicker/hall-light.
- Exports `lightTransitions(event)`: times of light changes per event, used by the 3 Hz test (no 1 s window holds more than 3).

## Beat list (weight, tension range, cooldown s, dread, duration s)
| beat | cat | w | tension | cd | dread | dur |
|---|---|---|---|---|---|---|
| stutter | light | 1.0 | 0-.8 | 25 | .10 | 2.4-3.4 |
| sag | light | .9 | 0-.7 | 35 | .10 | 3.5-5 |
| cut-and-return | light | .8 | .15-1 | 40 | .20 | 3.95-6.8 |
| hall-light | light | .9 | 0-.9 | 30 | .10 | 4.5-7.5 |
| flicker (legacy) | light | .7 | 0-1 | 15 | .05 | 1.2-1.5 |
| door-crack | fake | 1.0 | .1-1 | 25 | .20 | 2.6-3.6 |
| knock | fake | 1.0 | .1-1 | 25 | .20 | 2.2-3.6 |
| empty-open | fake | .8 | .3-1 | 45 | .30 heavy | 4.5-7.5 |
| false-lunge | fake | 1.0 | .45-1 | 50 | .55 heavy | 3 |
| glimpse | fake | .9 | .3-1 | 40 | .40 heavy | 1.8-2 |
| eyes | cue | .9 | .25-1 | 35 | .30 heavy | 2.3-3.8 |
| shadow-pass | cue | .8 | .25-1 | 35 | .30 heavy | 2-2.8 |
| wall-shadow | cue | .8 | .25-1 | 40 | .30 heavy | 2.3-3.3 |
| far-figure | cue | .7 | .3-1 | 50 | .25 | 3.8-6.8 |
| footsteps-behind | sound | 1.1 | 0-1 | 25 | .15 | 3.6-5.6 |
| whisper | sound | .9 | 0-1 | 30 | .15 | 3 |
| breath | sound | 1.0 | 0-1 | 15 | .10 | 3 |
| creak | sound | .9 | 0-1 | 15 | .10 | 2 |
| silence | sound, release | .8 | 0-1 | 30 | -.35 | 2-3.5 |
| heartbeat-spike | sound | .8 | .4-1 | 35 | .30 heavy | 2-3.5 |
| rest | release | .5 | 0-1 | 0 | -.20 | 3-6 |

Category bias by tension t: sound 1+1.5(1-t), light 1+(1-t), fake .4+1.8t, cue .4+1.5t. Release beats get x(1+3*dread) (+2 if no release in 45 s). RELIEF/WAIT scale tension by 0.35.

## Pacing rules (BeatPlanner.next)
Never repeats the previous beat; per-beat cooldown; max 2 heavy beats in a row (a real scare counts as heavy); dread budget (non-release beat excluded if dread+its dread > 1, dread decays 0.04/s); after a real scare a release is forced; a fake or light beat is forced after 2-4 non-fake/light beats (so every 3rd-5th beat). Constraints relax in order cooldown, tension range, dread if nothing is eligible; returns `null` only if nothing fits `maxDuration`.
Return value: `{name, category, heavy, release, dread, mix:{sound,light,fake,cue,release}, side, duration, steps:[{at,event}], cleanup:[{from,to,event}]}`. `weights` argument = same object as `setBeatWeights`.

## cues.mjs
`createCues(THREE, scene, {createCanvas?})` -> `{group, eyes, shadowPass, wallShadow, farFigure, setObserved(side), update(dt,time), clear(), getStats(), getState(name), dispose()}`. Each method returns false for a bad side or after dispose. One slot per cue type (a new call replaces), so max 4 meshes / 4 draw calls, 4 materials, 2 textures, no lights. Eyes sit 0.35 m beyond the door plane at y 1.68, additive, depth-tested (hidden by a closed door); fade >= 0.3 s each way, minimum 0.8 s total. Textures: canvas ImageData when available, else DataTexture. Call `update(dt, time)` every frame and `setObserved(lookedAtSide|null)` so the far figure vanishes (0.2 s) when its door is looked at.

## Weak spots
- Cues and the app handlers are untested visually; art is simple gradients and one silhouette shared by three cues. Orientation of the wall shadow beside the door and the DataTexture V flip were reasoned, not seen.
- At high tension real scares leave little room for beats (gaps 4-8 s, plus a 3-5 s quiet after each); beats show up mostly at low-mid tension.
- `false-lunge` stop distance is app-side work; the director only emits the intent.
