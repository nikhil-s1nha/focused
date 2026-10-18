# Replacement-sensor capture analysis

This offline tool analyzes each completed recording separately. It does not open serial ports, modify firmware, control recording, or change Signal Scope. Earlier sensor recordings and their fitted values are excluded by the required cohort boundary.

## Run one finished capture

From the repository root:

```sh
backend/.venv/bin/python -m backend.reaction_analysis.independent_capture \
  --recordings backend/results/bench-recordings \
  --first-run object-ui-20261018T002800Z-053a830ab45f4c4fb8f909f68b8f09ed \
  --run-id object-ui-20261018T002800Z-053a830ab45f4c4fb8f909f68b8f09ed \
  --detector-config backend/results/replacement-sensor-20261018T002800Z/detector-config.json \
  --output backend/results/replacement-sensor-20261018T002800Z
```

Omit `--run-id` to process all completed captures at or after the boundary, each independently. Omit `--detector-config` to perform only independent within-recording analysis. The optional configuration is read unchanged; it is never selected, overwritten, or refitted by this command. A configuration from another cohort is rejected.

Exit code **0** means processing completed, including reports of insufficient data. Exit code **2** means an input or processing error. The command prints a JSON receipt listing the processed report paths. Active captures and captures without a successful original-firmware restoration terminal state are skipped. Marker-free finished captures receive an insufficiency report.

## Outputs and timing

- `snapshots/<run>/<hash>/`: frozen raw data, markers, status, metadata, and source hashes.
- `runs/<run>/independent-<hash>.json`: immutable analysis result tied to source, implementation, method, and optional configuration hashes.
- `implementation/<hash>/`: the Python implementation used for reproduction.
- `index.json` and `latest.json`: atomically written pointers/results; `latest.json` remains the newest run even if an older run is reprocessed.

The marker estimate is its matching frame's device time plus the logged local parse age. This is not a physically synchronized timestamp. Each marker independently permits a match within **±0.5 seconds**. All action, background, and shifted-control neighborhoods use the same full one-second coverage checks, including rejection of gaps above 24 ms and missing boundary support. Device-clock resets are separated by capture segment.

The primary descriptive comparison finds raw abrupt events without action labels, uses one-to-one matches, and compares them with coverage-valid circular shifts of the marker schedule. Dense raw peaks can produce many chance matches.

The threshold comparison calibrates only on the first acquisition-order half of that same recording, with a one-second gap around the split, and checks the later half. Blink, jaw clench, and startle are pooled as manually marked **reactions**, not emotions. Background includes unmarked windows unless explicitly marked as no action. It therefore remains a background-trigger proxy rather than a confirmed physiological false-positive rate.

## Frozen seven-hit demo setting

The user selected an intermediate cutoff after seeing the first replacement recording. The immutable `detector-config.json` uses channel scales `[13484552.799999999, 14631714.439999996]` and cutoff `1.0139512788744232` on the largest normalized absolute raw step, with a strict `>` rule.

On its selection recording, that setting hits **7/9 later marked windows** and **20/24 later background windows**. Across the whole selection recording it hits **12/17 marked windows** and **40/53 background windows**. These are **posthoc demo-tuning results**, not held-out validation or 90% reliability. The later subset ceased to be a validation set once it was used to choose this cutoff.

For each later capture, `frozen_detector_evaluation` applies these exact scales and cutoff separately, without pooling or changing them. The same report also retains the independent within-recording calibration comparison. The source run is explicitly labelled `posthoc_selection_recording_not_validation`; later runs are labelled `new_recording_frozen_config_check`.

`RawSpikeDetector` in `raw_spike_detector.py` can consume already-acquired nine-byte frames with this configuration. Its per-frame `threshold_event`/`spike` is a raw threshold crossing, not an independently validated reaction. Consecutive true frames can be one burst. Reported grouped bursts per minute use retrospective strongest-first 250 ms suppression and are not the live boolean rate. All outputs retain `quality="unverified"`, `valid_measurement=false`, and `reaction_validated=false`; no output is a fear probability or verified EEG interpretation.

## Tests

```sh
backend/.venv/bin/python -m unittest backend.reaction_analysis.test_independent_capture -v
```

The focused tests cover cohort isolation, active/marker-free captures, clock-reset chronology, immutable frozen configuration evaluation, and newest-report selection. Related window coverage and raw detector tests remain in `test_binary.py`.
