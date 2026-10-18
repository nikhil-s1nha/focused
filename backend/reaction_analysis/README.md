# Offline raw reaction matching

Run from the project root:

```sh
backend/.venv/bin/python -m backend.reaction_analysis \
  --recordings backend/results/bench-recordings \
  --output backend/results/reaction-analysis
```

The CLI freezes completed recording archives, analyzes raw counts and manual labels, and atomically writes `latest.json`. It never opens serial/SSH, changes hardware, starts recording, or edits Signal Scope. Exit code 0 means analysis completed (including insufficient-data reports); 2 means input/read/validation failure. A recording with `metadata.active=true` or a nonterminal status is excluded.

A watcher may invoke this command when a finished archive changes. Each source version gets a SHA-256-addressed snapshot. Previously frozen bytes and reports are preserved. The output directory also receives a compact README and an immutable `analysis-<hash>.json`. Sources are raw `raw.txt`, `markers.json`, `status.json`, and `metadata.json`, not rounded graph pixels or decimated display points.

## Locked recipe

`recipe.json` records version `raw-reaction-v1` and its lock timestamp. Do not tune it after inspecting a held-out recording. Changes require a new version and a new forward recording.

Each marker is tied to exactly one segment/sequence/microsecond anchor. Estimated click time adds the stored local parse age. This is **not synchronized physical onset**. User-reported click uncertainty is ±0.5 seconds independently for each marker. A fixed two-second symmetric feature envelope accommodates that tolerance around a nominal half-second response context, without optimizing time shifts using labels.

The eight features are log(1 + standard deviation), log(1 + mean absolute first difference), negative fraction, and zero fraction, for each raw channel. Windows with missing edges, fewer than 200 rows, sequence discontinuities, or timestamp gaps over 24 ms are excluded. No filtering, resampling, microvolt calibration, sign-bit masking, or bus-format repair occurs.

Nearest-centroid matching uses **only training recordings** for scaling and class centroids. The complete latest recording is held out. Leave-one-recording-out results are also provided as retrospective exploration; those folds can train on recordings chronologically later than the test recording and are not forward claims. No frame-level random split is used. Candidate labels are manual action labels, never fear/emotions. The reported best constant-label baseline is explicitly an oracle descriptive benchmark; a separately reported training-majority baseline selects its label without accessing test labels.

## Background and controls

Recognized action labels are `Blink`, `Jaw clench`, and `Startle / flinch`. Explicit `No action` or `Background` markers map to Background. Unmarked pseudo-background windows use identical features and gap checks, have centers at least two seconds from any recognized marker, and are spaced at least two seconds apart. They are **not verified rest**. Their count is capped at the number of action markers and selected across the available interval, without considering features or classification performance.

The model is evaluated both with and without background. The reaction-only comparison also evaluates 100 deterministic circular shifts of the complete held-out marker schedule. Every shifted schedule must retain the same event count and pass identical gap checks. Those shifts account for the same timing-window opportunity; they are a descriptive coincidence benchmark, not a p-value, because temporal stationarity is unverified.

Separate, label-independent raw event detection identifies absolute first differences strictly above each channel/segment's 99th percentile. Strongest-first suppression uses 250 ms within channel and 100 ms across channels. One-to-one possible matches permit an independently varying ±0.5-second offset. Circular-shift controls use the same peak list and tolerance. More peaks near markers do not establish action-specific patterns.

## Measurement verdict

Every output retains source integrity flags. The current bench provenance and failed status/configuration readback mean `measurement_verdict: unreliable`, even when an experimental candidate label matches. No class probabilities, clinical confidence, physiological confirmation, or emotion classification are emitted. All-constant features return `Unknown` rather than an arbitrary tie label.

The first three recordings were already explored before this recipe was fixed. The fourth was underway at recipe lock, and its waveform/outcomes were not used to choose features; it is described only as a forward outcome check. A genuine prospective experiment requires an unchanged recipe fixed before a new recording begins and a predefined action schedule.

## Most useful next recording

Use the same existing **nonhuman object** setup and hold the setup constant. Record 24 shuffled trials: six of each of the three labelled actions plus six explicitly marked No action trials. Space trials six seconds apart, with five quiet seconds at each end (roughly 2.5 minutes). Mark onset once per trial; do not add multiple marker clicks for a single action. The ±0.5-second allowance remains unchanged. Repeat in a separate recording for an independent repeatability check. Physiological interpretation additionally requires reliable acquisition and an appropriate verified biological setup; this CLI does not enable one.

## Tests

```sh
backend/.venv/bin/python -m unittest backend.reaction_analysis.test_analysis -v
```

Tests cover exact marker linkage, independently varying half-second offsets, gap rejection, whole-recording separation, training-only normalization, unknown output for constant features, single-use peak matching, active-recording exclusion, and immutable source snapshots.
