# Independent recording analysis worker

`watch_completed_recordings.py` watches **finished archive files only**. It does
not connect to the Uno or Pi, open serial/SSH, change firmware, control recording,
touch Signal Scope, or change the paused app automation.

## Sensor replacement boundary

The worker reads `backend/results/sensor-cohorts/active.json` before discovery and
again before every queued job. The current replacement sensor starts at:

```
object-ui-20261018T002800Z-053a830ab45f4c4fb8f909f68b8f09ed
```

It excludes earlier run IDs **before reading their archive files**. Missing,
malformed or unsafe policy fields cause it to wait without analyzing anything.
The policy's `source_path` must match the input directory. A policy/boundary change
stops dispatching the previous cohort's remaining queue and uses the new cohort's
separate output directory on the next poll.

**Every new recording is independent.** Each eligible run invokes:

```sh
backend/.venv/bin/python -m backend.reaction_analysis.independent_capture \
  --recordings backend/results/bench-recordings \
  --first-run object-ui-20261018T002800Z-053a830ab45f4c4fb8f909f68b8f09ed \
  --run-id EXACT_COMPLETED_RUN_ID \
  --output backend/results/replacement-sensor-20261018T002800Z
```

`--run-id` is generated from one discovered directory, never a collection. The
independent analyzer performs its calculations within that capture only; the
watcher does not invoke the previous pooled reaction or binary-threshold CLIs.
It does not reuse earlier sensor thresholds or train across new recordings.
The analyzer's per-run reports and cohort index are separate: an index listing
several recordings is not a pooled model. `latest.json` refers to the newest
completed run's report, not combined performance.

After the user selected an intermediate threshold on the first replacement run,
`detector-config.json` in the active cohort directory records that fixed demo
setting. When present, the worker also passes it through `--detector-config`.
The analyzer evaluates this setting separately on each capture, without changing
it or incorporating old-sensor data. Its calibration recording is explicitly
post-hoc tuning; later recordings provide separate checks of the frozen setting.

Earlier mixed reports in `backend/results/reaction-analysis/` and
`backend/results/reaction-binary-review/` are preserved, but are **superseded for
replacement-sensor conclusions**. Their numbers and thresholds must not be
carried into new-sensor reports. Raw archives and frozen historical snapshots are
not modified or deleted by this worker.

## Start and stop

The previous worker was stopped during this revision. **This implementation has
not restarted it.** After review, run from the project root:

```sh
backend/.venv/bin/python tools/watch_completed_recordings.py \
  --policy backend/results/sensor-cohorts/active.json \
  --recordings backend/results/bench-recordings \
  --worker-output backend/results/sensor-cohort-worker \
  --output-root backend/results
```

Add `--once` to check completed archives once and exit. A continuous worker polls
every two seconds by default. It stores its lock, status, per-run checkpoints and
analysis log in `sensor-cohort-worker/`, and passes the cohort-named report output
directory to the analyzer. Ctrl-C or creating
`backend/results/sensor-cohort-worker/watcher.stop` stops it. An existing stop
file is honored; it is never removed automatically.

## What qualifies and what is retained

- Metadata must explicitly have `active: false` and a finite `finished_at`.
- Status must be `stopped_original_restored` or
  `capture_failed_original_restored`; active/restoring/unknown stages are skipped.
- Raw data must be nonempty, and marker/status/metadata files must be readable
  and stable during discovery.
- A capture with no recognized labels still receives its own insufficient-data
  report. It is not silently merged with a better-labelled recording.
- Marker/status/metadata contents and raw-file size/mtime/ctime identify changed
  versions for dispatch. The analyzer freezes and hashes the actual raw bytes.
- Successful versions are checkpointed per run. Editing one completed archive
  schedules only that run. One failed job does not prevent other independent
  runs from being analyzed; failed runs retry with delays capped at 60 seconds.

The worker does not make failed status bytes valid EEG, verify body isolation,
or classify fear. Those limitations stay in the independent analysis reports.

## Verification

```sh
backend/.venv/bin/python -m unittest tools.test_watch_completed_recordings -v
```

Tests use temporary archives and mocked analyzer processes. They prove exclusion
of old and active captures, fail-closed policy handling, exact single-run command
dispatch, separate retry/checkpoint behavior, inclusion of empty marker logs, and
stopping a queue when the sensor boundary changes. They do not start the real
worker or contact live hardware.
