# FNAF-style modes 2 and 3 (original characters, pure logic)

Files: `public/fnaf/modes/fnaf2.mjs` (`Fnaf2Mode`, `C2`, `CHARS2`, `CAMS2`), `public/fnaf/modes/fnaf3.mjs` (`Fnaf3Mode`, `C3`, `ROOMS3`, `CAMS3`, `PHANTOMS`).
No THREE/DOM. Default export is the class too.

## Shared interface
`new Mode({night, rng=Math.random, now, secondsPerHour=45, ai})`; `start()`; `update(dt, input)`; `consumeEvents()` (drains); `snapshot()`; `setAiLevelMultiplier(x)`; `setAiLevel(who, n)`.
- Sim runs on a fixed 0.1 s step (dt is accumulated), so results are independent of frame rate. rng is only drawn inside steps.
- `night` 1-6 (FNAF2) / 1-5 (FNAF3) use built-in tables; any other night (use 7) is a custom night: all levels 0 except those in `ai` (`{who: level 0..20}`). `ai` also overrides tables.
- Effective level = round(base * multiplier), capped 20. Movement roll: `floor(rng*20)+1 <= level`.
- AI cadence constants (move intervals, unwind, fault/phantom rolls) scale by `secondsPerHour/45`; player-reaction timers (grace, reboot, seal) do not.
- Night: 12AM-6AM, `hour` events 1..6 (`label`), then `night-win` once. Jumpscare is terminal and emitted once (`running=false`, `dead=true`).
- Events: `{type:'move',who,from,to,reason?}`, `{type:'jumpscare',who,reason}`, `{type:'hour',hour,label}`, `{type:'night-win',night}`, `{type:'static',intensity}`, `{type:'cue',id,...}`, `{type:'phone-call-start'|'phone-call-end',id}`; FNAF3 also `{type:'phantom',action:'appear'|'dismiss'|'expire',id,location}`. Because the FNAF1 core did not exist when written, shapes were inferred from the brief; adapt in the app if they differ.
- Snapshot common: `mode,night,running,dead,won,scare,hour,elapsed,progress,secondsPerHour,camera,cam,cameraView,multiplier`.

## FNAF2 (`mode:'fnaf2'`)
Input (state each frame): `{mask, camera, cam, flashlight, windMusicBox, ventLight:'left'|'right'|null}`.
- Mask and camera are exclusive (mask wins). Flashlight and vent light only work with mask and camera both down. Winding counts only while camera up on `cam==='prize'` and `windMusicBox` held.
- Cameras: stage, party, main, hall, parts, ventL-far, ventR-far, prize.
- Characters (original): hall: bramble, pip, cinder (withered), quill (withered); left vent: nimbus, tallow (w); right vent: sprocket, wick (w); puppet-role: jackalope (music box).
- Movement opportunity every 5 s (x k); advance if roll succeeds. At hall end / vent mouth: hall - flashlight held 2.5 s (x2 withered) sends it back one room (`reason:'repelled'`), else enters office after 5 s dwell. Vent - matching-side vent light 1.5 s repels, unlit 5 s enters office.
- In office: grace 3.5 + rng*1.5 s (x0.75 withered); mask off when it expires = jumpscare (`reason:'mask-off'`). Mask continuously on 2.5 s = it leaves to start (`reason:'left'`).
- Flashlight battery 100, drains 0.9/s while on (~111 s); dies at 0 (`cue flashlight-dead`).
- Music box (`musicbox` id): value 1..0, wind +0.18/s, unwinds `(0.006+0.0012*lvl)/k` per s (only if jackalope level>0). Cues `{id:'musicbox', state:'low'|'empty'|'wound'}`. Empty starts 8 s escape countdown (`escapeIn`); winding above 0.15 cancels; otherwise jumpscare `who:'jackalope', reason:'musicbox'` (mask does not help).
- Snapshot extras: `mask, flashlight{on,battery}, ventLight, musicbox{id,value,state,winding,escapeIn}, characters{id:{room,level,inOffice,withered,kind,grace}}, office[], hall[]`.
- Night tables are in `CHARS2[*].levels` (nights 1-6).

## FNAF3 (`mode:'fnaf3'`)
Stalker: `scrapjack`. Input: `{camera, cam, lure:roomId|null, seal:'A'|'B'|'C'|null, reboot:'audio'|'camera'|'vent'|null, dismiss:phantomId|null}`.
`lure`, `seal`, `reboot`, `dismiss` are edge-triggered: they act when the value changes to a non-null one (send null between presses).
- Rooms graph `ROOMS3`: cellar, hall1, kitchen, hall2, arcade, storage, lobby; vents `ventX-far` -> `ventX-near` -> office (X in A,B,C). Cameras: all non-vent rooms.
- AI levels `who`: `stalker`, `phantoms`, `faults` (tables in file, nights 1-5). Stalker moves every 6 s (x k) on a successful roll; 70% toward lobby else random neighbour; from lobby picks a random vent; far->near automatically. In a near vent for 4.5 s = jumpscare (`reason:'vent'`).
- Seals: 8 s per section, 15 s cooldown. Stalker in a sealed section is trapped (`trapped` cue); when seal ends he returns to lobby and is frozen 10 s. Resealing during cooldown emits `seal-unavailable`.
- Lure: needs audio OK; draws stalker one step per opportunity toward the room regardless of roll; lasts 10 s, cooldown 8 s after it ends (`lure-failed`, `lure-cooldown` cues). He lingers while lure active.
- Systems audio/camera/vent: random fault every 12 s roll (max 2 active). Reboot takes audio 5 s, camera 7 s, vent 8 s; only one reboot at a time (`reboot-blocked`). Camera fault blanks `cameraView`; audio fault blocks lure. Vent fault: `ventDrain`/`blur` rises 1/30 s, jumpscare (`reason:'ventilation'`) at 1; recovers 0.1/s when OK.
- Phantoms: cinderling, lanternhead, mothlady, hollow-jester, marrowbird. Roll every 14-24 s (x k), max 2 active, 40% in office. Dismiss: office = camera down; camera room = camera up on that cam and camera system OK. Deadline 6 s office / 8 s camera. Camera expiry: temporary system fault (auto-clears 20 s). Office expiry: strike + temp fault; 3rd strike jumpscare (`reason:'phantom'`).
- Snapshot extras: `stalker{id,room,level,trapped,trapSection,nearT,paused}, systems, reboot, ventDrain, blur, seals, lure, lureCooldown, phantoms[], strikes`.

## Honest gaps
Constants are modelled on the structure of the originals, not frame-exact. No visuals/audio wiring. No phone-call line content. FNAF2 has no balloon-role or hall light-flicker. Both modes' Director hooks are only the level multiplier and per-actor levels.
