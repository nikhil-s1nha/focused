# Pooled raw-change detector: Reaction versus background

This is a separate exploratory analysis. It preserves the earlier multiclass recipe, results, and Signal Scope. It never touches live hardware or enables body acquisition.

## Run on completed captures

```sh
backend/.venv/bin/python -m backend.reaction_analysis.binary_threshold \
  --recordings backend/results/bench-recordings \
  --output backend/results/reaction-binary-review
```

Exit 0 means successful analysis. Exit 2 means a read/input/validation failure. At least two completed recordings are needed. Active recordings are excluded. The output is an atomic `latest.json`, an immutable `binary-analysis-<hash>.json`, frozen source snapshots, and hashed implementation snapshots. Watchers may invoke this after a recording finishes.

The latest recording is held out as a whole; all channel scales and thresholds come only from earlier recordings. The latest existing recording had already been inspected before this binary question, so the result is an **exploratory held-out comparison**, not untouched prospective validation. Retrospective leave-one-recording-out comparisons are also saved, without selecting the threshold on a held-out run.

## Fixed score and timing

Blink, Jaw clench, and Startle / flinch markers become the single manual class **Reaction**. The score is the largest absolute sample-to-sample change, across either channel, inside the one-second interval centered on the estimated click. Each channel is divided by its training-only 99th-percentile absolute change (minimum scale 1 raw count). Large sign-bit excursions remain in the data; they are not silently removed or repaired.

Each marker independently has ±0.5-second timing allowance. There is no fixed global shift and no label-driven offset optimization. Estimated click time is the logged frame timestamp plus parse age, not synchronized physical onset.

A positive or background window must have at least 100 frames, recorded samples around both boundaries, edge samples within 25 ms, consecutive sequences, and no timestamp gap over 24 ms anywhere across the interval, including gaps straddling either boundary. No interpolation bridges missing data. Shifted controls call this exact same function and reject a complete shift if any required window fails coverage, preserving the same event denominator.

Explicit `No action` or `Background` markers are accepted as negative trials and reported separately from unmarked pseudo-negatives. Unmarked controls are nonoverlapping one-second windows whose centers are at least 1.5 seconds from recognized action markers. These are **unmarked pseudo-negatives, not confirmed no-action trials**. Consequently biological precision is not estimated; action prevalence is artificial and the background labels are unverified.

## Current held-out result

Earlier three recordings calibrated the thresholds; the fourth completed recording (`001042`) supplied 29 action and 77 background windows.

| Training-only threshold choice | Held-out marked windows detected | Held-out unmarked windows triggered | Grouped background bursts/minute |
|---|---:|---:|---:|
| Approximate 5% background trigger target | 0/29 (0%) | 0/77 (0%) | 0 |
| Approximate 10% target | 0/29 (0%) | 0/77 (0%) | 0 |
| Approximate 20% target | 20/29 (69.0%) | 47/77 (61.0%) | 49.5 |
| Best training balanced accuracy | 28/29 (96.6%) | 67/77 (87.0%) | 121.8 |
| At least 90% training sensitivity | 29/29 (100%) | 74/77 (96.1%) | 134.3 |
| Any nonzero change | 29/29 (100%) | 77/77 (100%) | 192.5 |

The best-training-balanced threshold's held-out balanced accuracy is about **54.8%**. Catching over 90% of marked windows is possible here by triggering on most background windows; it does not demonstrate 90% reliability. Quantile targets are approximate, e.g. the 5% training target actually flags 5/98 windows (5.10%).

Grouped bursts/minute is a **retrospective proxy**: threshold crossings inside background windows undergo strongest-first 250 ms suppression and are divided by 76.377196 seconds of actual observed step support. This differs from the per-frame boolean API below. Several true booleans can be one burst. Neither metric establishes physical reactions.

## Reusable offline detector contract

```python
from pathlib import Path
from backend.reaction_analysis.raw_spike_detector import (
    RawSpikeDetector, config_from_report,
)

config = config_from_report(
    Path('backend/results/reaction-binary-review/latest.json'),
    'best_training_balanced_accuracy',  # Explicit choice; not a reliability claim.
)
detector = RawSpikeDetector(config)
result = detector.update(
    raw_hex='000000000100000000',
    sequence=10,
    read_micros=80000,
    segment=1,
)
```

The function only consumes a frame already available to the caller. It has no serial, network, UI, or hardware operations. Output includes:

```json
{
  "raw_counts": {"ch1": 256, "ch2": 0},
  "spike": null,
  "threshold_event": null,
  "step_score": null,
  "quality": "unverified",
  "valid_measurement": false,
  "reaction_validated": false,
  "meaning": "raw_abrupt_change_only; not verified action, physiology, or emotion"
}
```

`spike` aliases `threshold_event`. Null means no usable consecutive step (first sample, reset, discontinuity, or excessive gap). False means an available raw step did not exceed the selected threshold; true means it did. No probabilities or emotion labels are generated. Status-word format and timing checks remain in `quality_flags`; matching one status word cannot establish configuration or physiological validity.

## Validation

```sh
backend/.venv/bin/python -m unittest backend.reaction_analysis.test_binary -v
```

Nine tests cover equal positive/control windows, independent ±0.5-second offsets, interior and boundary-straddling gaps, training-only scale/threshold selection, reset handling, null-versus-false semantics, shifted-control coverage, and explicit No action labels. Independent audit reproduced the numeric threshold results. The original multiclass recipe remains unchanged.

For a useful next run, freeze the chosen detector configuration before recording and include explicitly marked No action trials in a shuffled schedule. Repeating only actions cannot measure false alarms. All current source protocol/configuration failures remain recorded as unverified.
