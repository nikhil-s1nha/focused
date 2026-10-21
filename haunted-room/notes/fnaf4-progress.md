# FNAF4 mode, progress model, phone calls (integration API)

Files: `public/fnaf/modes/fnaf4.mjs`, `public/fnaf/progress.mjs`, `public/fnaf/phone.mjs`. Pure logic (no THREE, no DOM, no storage). Tests: `test/fnaf-mode4.test.mjs`, `test/fnaf-progress.test.mjs`.

## Fnaf4Mode ("The Bedroom")
```js
import { Fnaf4Mode } from './fnaf/modes/fnaf4.mjs';
const m = new Fnaf4Mode({ night, rng, now, secondsPerHour = 45, ai = null, smallRule = null });
m.start(); m.update(dt, input); m.consumeEvents(); m.snapshot();
m.setAiLevelMultiplier(x); m.setAiLevel(who, n);   // who: hollowjaw|gristle|marrow|sable|small
```
`night` 1..6, or any other value (e.g. `'custom'`) = all levels 0 except `ai`. Night 6 = nightmare. Fixed 0.1 s sim step; `rng` is the only randomness.

**input**: `{ facing: 'left'|'right'|'closet'|'hall'|'bed'|null, hold: bool, flashlight: bool }`. `hold` only counts when facing a door and closes that door; flashlight only works at a door that is not held. Changing facing while holding = release.

**Characters** (original): hollowjaw (left), gristle (right), marrow (closet), sable (hall stalker), small ones nib/tuck/wisp/pinch (closet, up to 4). Night 6 variant ids: `<name>-n` (`snapshot().characters[id].variant`).

**Rooms in move events**: `<door>-far` -> `<door>-near` -> `<door>-door`; small ones `closet-shelf` <-> `closet`.

**Events** (same shapes as other modes): `move {who,from,to,reason?}` (reasons: door-held, flashed, wandered-off), `jumpscare {who,reason}`, `hour {hour,label}`, `night-win {night}`, `phone-call-start/end {id:'night<n>', interrupted?}`, `cue {id, door?, who?}` with ids creak, breathing, skitter, door-close, door-open, wasted-close, agitated.
Jumpscare reasons: `released-early`, `door-open`, `flashlit`, `swarm`.

**snapshot()**: mode, night, running, dead, won, scare, deathReason, hour, elapsed, progress, secondsPerHour, facing, holding, holdProgress (0..1), flashlight{on}, doors{door:{closed,holdProgress,occupant}}, characters{id:{door,stage 0-2,room,level,atDoor,lit,variant,timeLeft}}, small{names,count,rule,level,swarm}, heat, nightmare, multiplier, and **audioCues**: `[{pos:'left'|'right'|'closet'|'hall', kind:'breathing'|'creak'|'skitter', gain, muffled?}]`. Breathing is only listed (gain 1) for the door being faced; a held door with someone behind it gives muffled breathing at 0.5. Creak (gain 0.3) is audible for any approaching (stage 1) character. Nothing at a door = no breathing cue = clear.

### Rules and constants (`C4`, all tunable)
- Opportunity per door every `interval*k` s (left/right 4.0, closet 5.0, hall 3.5; `k = secondsPerHour/60`): success if `floor(rng*20)+1 <= level`. Stage 1 dwell 3-6 s (x k), then stage 2 (breathing). At stage 2 the door timeout is 7 s (left/right), 6 (closet), 5 (hall) plus 0-1.5 s jitter (x0.8 on night 6); expiry = `door-open` jumpscare. The timer is paused while the door is held.
- Hold: 1.75 s continuous (2.0 on night 6) turns the character away (stage 1 also turned away, no penalty). Release after 0.25 s but before the need = `released-early` jumpscare; shorter taps are ignored.
- Closing an empty door for >= 0.75 s = wasted close: heat +1 (+0.15/s beyond that), heat decays 0.05/s, max 6. Level bonus per heat: hall x1.5, left/right x0.5, closet 0.
- Flashlight on a character at the door: 1.5 s accumulated lit time = `flashlit` jumpscare; decays 0.5/s when not lit.
- Small ones: arrival roll every 6 s x k. Rule `flash` (nights 1-5): flashing the open closet for 0.7 s chases off one; all four present for 6 s = `swarm` jumpscare. Rule `ignore` (night 6): they leave on their own after 7 s, never attack; flashing them forces marrow to the closet door (cooldown 10 s).
- Comfort: max 2 simultaneous approachers. No camera motion; jumpscare is entity motion + sound for the renderer.
- AI levels (nights 1-6): hollowjaw 3,2,4,6,8,12; gristle 1,2,3,6,8,12; marrow 0,0,3,5,8,11; sable 0,0,1,3,5,9; small 0,3,4,5,7,10. These are original tuning, not copies of any official table.
- Phone: mode emits call start at 2 s with a per-night length (`C4.CALL_LEN`); the real script player is `PhoneCall` below.

## progress.mjs
`createProgress()`, `sanitizeProgress(raw)` (null if unusable), `serializeProgress(p)`, `deserializeProgress(str)` (fresh on any failure), `recordWin(p, mode, night|'custom', {custom})`, `recordLoss(p, mode, reason)` (all immutable), `availableNights(p, mode)`, `isNightUnlocked`, `starsFor`, `totalStars`, `validateCustomConfig(mode, cfg, {roster})` -> `{ok,errors,config}` (integers 0-20, rosters known for fnaf1/2/4; fnaf3 pattern-checked), `DIFFICULTY_PRESETS` (easy 0.6, normal 1, nightmare 1.5), `setDifficulty`, `setAdaptive(p,{enabled,multiplier})` (reserved; clamp 0.25-2), `aiMultiplier(p.settings)` -> value to pass to `setAiLevelMultiplier`, `describeEnding(kind,{...})`, `endingFromSnapshot(snap)`, `GAME_OVER_REASONS`. Stars: night 5 = 1, night 6 = 2, custom all-20 = 3. Persist the string yourself via localStorage in try/catch.

## phone.mjs
`getPhoneScript(mode, night)` -> `{id:'<mode>-night<n>', lines:[{index,text,at,dur}], duration}` (modes fnaf1-4, nights 1-6; 24 original scripts). `new PhoneCall({mode, night, script?, muted})`: `start()`, `update(dt)`, `skip()`, `interrupt()` (call from the host on a `jumpscare` event), `setMuted(b)`, `consumeEvents()`, `snapshot()` (`subtitle` = current line text or null).
Events: `phone-call-start {id,...}`, `phone-line {index,text,dur,muted,last}`, `phone-line-end {index,cut?}`, `phone-call-end {id,reason:'finished'|'skipped'|'interrupted',interrupted}`. Audio is not produced here; speak/play `phone-line` unless `muted`. Subtitles always available.
Integration note: do not run both the mode's built-in `phone-call-*` events and a `PhoneCall` for the same night; use mode events as the trigger (start `PhoneCall` on `phone-call-start`, skip/interrupt on its end or a jumpscare). Mode call lengths (60/50/40/35/30/25 s) are not synced to script durations; the PhoneCall player governs what is shown.
