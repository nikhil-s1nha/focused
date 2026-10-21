# FNAF core rules engine (public/fnaf/core)

Pure logic (no THREE/DOM). Import from `public/fnaf/core/index.mjs`. Files: `data.mjs` (constants, tables, jingle, progress helpers), `night.mjs` (`FnafNight`).

## API
```js
const night = new FnafNight({ night: 1..6 | 'custom', rng: () => [0,1), now: () => number,
                              secondsPerHour: 'classic' | 'short' | number, ai: {maestro,bellwether,lark,ratchet} });
night.start();                       // idle -> running; emits phone-call-start on nights 1-5
night.update(dt, input);             // dt real seconds; call every frame with current input
night.consumeEvents();               // returns and clears the queue (once-only)
night.snapshot();
night.setAiLevelMultiplier(x);       // ADAPTIVE HOOK: effective AI = clamp(base*x, 0, 20)
night.setAiLevel(who, n);            // ADAPTIVE HOOK: clamps 0-20; also stops wake schedule overriding that character
night.muteCall(); night.reset();
```
`input = { doors:{left,right} (true = closed), lights:{left,right} (true = held), monitorUp, cameraRoom }`.
The engine sanitizes input: a closed door cancels that side's light; during power-out everything is forced off.
`cameraRoom` is a room id (`cameraRoom(i)` / `cameraIndex(room)` map camera 1..11; `kitchen` = cam 8 is audio-only, `snapshot().cameraVideo` is false).
States: `idle | running | power-out | won | dead`. Rooms/characters use the shared ids. `ts` in events = `now()`, `t` = night progress in hours.

## Events (`{type, t, ts, ...}`)
move{who,from,to} (to may be `office` when an attacker is inside); door-knock{who:'ratchet',side,powerLoss};
jumpscare{who}; power-warning{level 20|10}; power-out; hour{n 1..6}; night-win{night};
static{room} (a character moved into/out of the room currently watched on video);
phone-call-start{night} / phone-call-end{night,muted};
cue{name,...}: footstep{who,room}, laugh{who,room} (maestro moves), kitchen-noise (lark each opportunity in kitchen),
door-presence{who,room,side} (light held with someone at that door), office-entry{who}, cove-stage{stage}, run (ratchet sprint),
powerdown, jingle-start{bpm,notes}, jingle-note{index,midi,beats}, eyes{visible} (toggles at 2 Hz max = 1 Hz blink), dark.

## Snapshot
night,state,progress(0..1),hour(0..6),clock('12 AM'..'6 AM'),secondsPerHour,power,powerDisplay,usage(1-5, 0 in power-out),doors,lights(effective),
monitorUp,cameraRoom,cameraVideo,characters{who:{room,ai,effectiveAi,inOffice,(ratchet: stage,running,bangs)}},multiplier,
powerOut{phase approach|jingle|eyes|dark|scare, eyesVisible, note}|null, phone{playing}, killer.

## Rules encoded (constants in data.mjs; "approx" = community values from memory)
- Night 12AM->6AM = 6 hours; classic 89.1 s/h (534.6 s), short 30 s/h. ALL game timers and power are in "classic seconds"; a shorter
  hour scales them by 89.1/sph so the short night keeps the same density (3 min of pressure compressed), not sparser.
- Movement opportunity: every interval (bellwether 4.97, lark 4.98, ratchet 5.01, maestro 3.02 s) roll `floor(rng*21)` (0..20); moves if `ai>0 && roll<=ai` (AI 0 never moves; deliberate deviation so level 0 means off).
- Destinations picked by rng from route graph (ROUTES); rooms occupied by another character are skipped (showstage excepted).
- bellwether (west) / lark (east) / maestro (east): at their door room (`hall-west-corner` / `hall-east-corner`) a successful roll is a door check:
  door closed -> retreat (dining / restrooms / hall-east); open -> enter office, jumpscare as soon as the monitor is down or after a 10 s cap (comfort; original waits indefinitely for monitor drop).
- maestro skips opportunities while the monitor is up on his current room. His path is deterministic: showstage-dining-restrooms-kitchen-hall-east-hall-east-corner.
- ratchet: cove stages 0-3 advance on successful rolls only when the cove camera is not watched; looking at cove (rising edge) freezes him for 0.83-16.67 s (rng). At stage 3 a success starts a 5 s run to the west door (approx; no camera-dependent shortening). Door closed: `door-knock`, power loss 1% then +5 each time (1,6,11...), returns to cove stage 1-2. Open: jumpscare.
- Power: 100%; usage = 1 + closed doors + held lights + monitor; seconds per 1% at usage 1..5 = 9.6/4.8/2.8/1.9/1.0. Passive extra drain, seconds per 1%: N2 6, N3 5, N4 4, N5 3, N6 3 (approx); N1 and custom none.
- Power out (power <= 0): phases approach (3-6 s rng) -> jingle (original 16-note music box tune, data only, ~20 s) -> eyes (3 s, blinking) -> dark (5-20 s rng) -> maestro jumpscare. Reaching 6AM first wins.
- AI table (maestro,bellwether,lark,ratchet): N1 0,0,0,0 (bellwether 1 at 2AM, lark 1 at 4AM); N2 0,3,1,1; N3 1,0->1@1AM->2@3AM,5,2; N4 2,2,4,6; N5 3,5,7,5; N6 4,10,12,6. Approximates FNAF1; Night 4 maestro fixed at 2.
- Phone call seconds N1-5: 110,75,45,50,35 (approx). Progress: `createProgress/recordWin/availableNights/validProgress` (plain JSON; caller persists).

## Known gaps
No camera-dependent ratchet run shortening, no Freddy-style door lockout rules beyond the above, no Golden-type extras (not in scope), no audio (cues only), power-out interaction is automatic (no player action). Numbers marked approx should be tuned in playtest.
