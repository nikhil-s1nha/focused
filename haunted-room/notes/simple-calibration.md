# Adaptive calibration (public/simple/calibration.mjs)

Pure logic, no THREE/DOM. Deterministic with injected monotonic seconds and rng.
Tests: `node --test test/simple-calibration.test.mjs`.

## API

```js
import { AdaptiveProfile, responseMetric, CONFIG, BEAT_GROUPS } from './calibration.mjs';
const prof = new AdaptiveProfile({ rng, config: { /* any CONFIG key */ } });
prof.start(); prof.reset(); prof.end();      // phase: idle | calibrating | adapting | ended
prof.sample(t, { intensity, quality, fresh });
prof.scareLunge(t, side);                    // when the lunge STARTS
const d = prof.update(dt, t, { tension });   // tension (live Director) is optional
prof.profile();                              // derived summary or null before calibration ends
prof.export();                               // derived-only JSON for the session summary
```

Directives `d`: `{ phase, trigger: null | {kind:'calibration', side:null, skipTelegraph:false},
suppressOthers, effectiveTension 0..1, gapScale 0.6..1.6, intensityScale 0.7..1.3, minGap,
beatWeights {light,fake,visual,sound,real: 0.5..2}, notes[] }`. `suppressOthers` and `minGap`
are additions to the requested shape.

## Per-frame wiring

1. Each frame: `prof.sample(now, { intensity: snap.value or raw intensity, quality, fresh })`.
   `fresh` = the caller's freshness test (e.g. Director not in WAIT). Stale or low-quality samples are ignored.
2. On the ScareDirector `lunge` event: `prof.scareLunge(now, event.side)`.
3. `const d = prof.update(dt, now, { tension: directorSnap.tension })`.
4. If `d.trigger`: `scares.trigger(null, null, { skipTelegraph: d.trigger.skipTelegraph })`.
5. While `d.suppressOthers` (calibration): do not let the ScareDirector run its own gaps or ambient beats
   (e.g. do not call `start()` timers for scares, or set a huge gap) other than the scripted trigger.
6. Adapting: feed `scares.update(dt, { tension: d.effectiveTension, ... })`;
   `scares.setIntensity(clamp01(base * d.intensityScale))`; multiply the app's own gap by `d.gapScale`
   and never let two real scares start closer than `d.minGap` seconds; choose beats using `d.beatWeights`
   as multipliers on each beat group's probability. ScareDirector has no beat-weight or gap-scale hook,
   so the app has to apply those.
7. At the end: `prof.end()` and put `prof.export()` in the summary.

## How it works

- Calibration: first scripted scare at `firstScareAt` (8 s) after the first sample/update, then every
  `calibrationGap` (11 s); exactly `calibrationScares` (3) triggers. Next request waits until the prior
  window closes. If no lunge is reported within `lungeTimeout`, that scare counts as discarded.
- Window per scare: baseline = `[lunge-3, lunge)`, response = `[lunge+0.3, lunge+3.0]`. A window needs
  enough usable samples and a usable fraction, else the response is discarded and noted.
- Profile: baseline {mean, sd}, reactivity = median z, habituation = slope of z over scares
  (negative = shrinking), quality, confidence. No valid scares: neutral profile, note
  "Calibration unusable; adapting with neutral defaults."
- Controller: after each real scare, EMA of z vs a target (blend of `targetResponse` and the person's median
  by `personalWeight * confidence`). Weak: drive up (more fake/visual beats, shorter gaps, higher intensity,
  higher profile tension). Strong: drive down (more sound/light, longer gaps, lower intensity). Habituation adds
  visual/fake weight. `effectiveTension = tensionWeight*live + (1-tensionWeight)*profileTension`.
- Safety: `intensityScale` capped at 1.3, all outputs clamped, `minGap` 3.5 s average scare-rate cap.

## The placeholder metric

`responseMetric({ pre, post, direction, floor })` is marked `PLACEHOLDER: replace with the validated spike
metric`. It is max |post - mean(pre)| / max(sd(pre), floor). To swap, keep the signature (number arrays in, finite
number >= 0 out) and change only that function; the controller target (`targetResponse`, z units) will need
retuning for the new scale. `config.direction` ('any'|'up'|'down') is passed through.

## Honesty limits

- The input is an experimental response proxy, not validated fear or emotion detection. This module reports only
  "response of the signal to the stimulus". Do not label it fear, anxiety or arousal in UI text.
- Three scares is a tiny sample; z values and habituation slopes are noisy. Confidence reflects data quality and
  count, not validity.
- The baseline window includes the telegraph (silence/lights) unless `preGuard` is raised. Movement/blink
  artifacts can look like a response.
- No raw samples are exported; only a ~14 s rolling window lives in memory.
- Thresholds are untuned guesses and have not been checked against real hardware data.
