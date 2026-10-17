# Session handoff — vr-scene-expansion branch (2026-10-17)

Read CLAUDE.md first for project rules and the signal contract. This file is
the live status of the expansion work, written for the next Claude session.

## Where things stand

Branch `vr-scene-expansion` (partner keeps `main`). All work is modular, each
module has its own node --test suite. 76/76 tests green at last commit.

Modules in haunted-room/public/ (all plain ESM, Three.js 0.186.1 via local
importmap, no CDN, Quest 3S budgets):

| Module | Status | What it is |
|---|---|---|
| director.mjs | done | BUILD/PEAK/RELIEF/WAIT + encounter scheduler with adaptive memory (escalates encounter types that raised tension), pause/resume, duration, getSession() |
| signal-client.mjs | done | one seam for manual/synthetic/live input, 10 Hz, scenarios (cycle/low/high/dropout/artifacts), reconnect+stats. EEG partner's feed plugs in here unchanged |
| audio-engine.mjs | done | synthesized spatial drone + per-encounter cues, opt-in, capped |
| music-box.mjs | done | original lullaby that slows/drops notes/halts with tension (FNaF-genre, original IP) |
| animatronic.mjs | done | "the Attendant": staged awakening, advances only during opacity dips, 1.2 m safety radius, trigger('advance'/'scare') |
| environment.mjs | done | full Victorian room + 6-segment corridor that extends with tension, 3 interactables (clock/radio/corridor-door), accepts { materials } injection |
| ghost.mjs | done | PEAK apparition (port of bridge-horror-house Ghost.js, MIT), corridor-only stalk, never past z 0.5 |
| volumetrics.mjs | done | stereo-safe volumetric light cone (threex.volumetricspotlight, MIT) |
| monitor.mjs | done | CRT security monitor: render-target corridor feed, static rises with tension, RT skipped in XR by default |
| textures.mjs | agent in flight | createMaterialLibrary → 8 procedural materials (bridge-horror-house Textures.js techniques) |
| atmosphere.mjs | agent in flight | observatory/cold/ember grading presets, ~2 s glide, desktop vignette overlay hidden in XR |
| app.mjs | REWRITTEN, unverified | composes everything + full UI wiring, WASD, E-interact crosshair, keyboard shortcuts, presets, summary panel. Imports textures.mjs and atmosphere.mjs, so the page 404s until those two land |

Also: index.html/style.css rebuilt (room-first studio console, all control IDs
wired by app.mjs), test-xr/ Playwright+IWER harness (in flight),
scripts/quest-usb.sh (`npm run quest` sets up adb reverse for the headset).

## Immediate next steps (in order)

1. Confirm textures.mjs + atmosphere.mjs exist and `npm test` is fully green.
2. Serve (`npm start`), open http://127.0.0.1:8080, fix any runtime wiring
   errors in app.mjs (it was written against the module specs; verify against
   delivered APIs; check browser console).
3. Walk the demo: Begin → slider low → PEAK (corridor extends, Attendant wakes,
   ghost in corridor, monitor static) → slider high → RELIEF → `npm run mock`
   live mode → stop feed → WAIT → 120 s ending → summary panel.
4. `npm run test:xr` (Playwright+IWER emulated-Quest suite; `npm run
   test:xr:install` first time).
5. Commit; push needs the repo owner's GitHub auth.

## User preferences (also in Claude memory on the original machine)

- Prefer adapting license-verified (MIT/Apache/BSD/CC0) existing repos over
  building from scratch; credit in file headers. No GPL/unlicensed code; no
  actual FNaF assets/melody (copyright) — original genre-inspired work only.
- Multiple background agents for parallel work is the preferred style.
- Milestone 1 = everything desktop-testable driven by slider/synthetic/live;
  Milestone 2 = physical Quest 3S via `npm run quest` (adb reverse route),
  acceptance checklist in haunted-room/README.md.
