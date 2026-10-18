# Signal Scope smoothness proposal — STAGED, NOT DEPLOYED

The user explicitly requested that this work stay off localhost until they say to
apply it after recording. No active source files, server, browser tab, capture,
serial connection, firmware, or hardware have been modified by this staging work.

## Why the graph jumps

- The current raw view paints only after `/api/bench-state` and recorder polling:
  250 ms plus request time, at most about four paints per second.
- Pi-to-Mac delivery is separately batched at 500 ms plus SSH time. Browser
  repaint rate is not the sensor sample rate.
- The current view resets both canvas bitmaps every paint and rescales the entire
  retained time span whenever a new batch arrives.
- One read-only observation during staging returned 1,500 retained samples in a
  240,682-byte response in 7.1 ms. The capture was active with a recent frame.
  This suggests display cadence/batching, rather than measured local JSON API
  latency, is the immediate smoothness bottleneck. Invalid status/readback
  diagnostics remain independent acquisition problems.

## Proposed changes

1. Draw raw traces with `requestAnimationFrame`, independently of API polling.
   This targets display refresh cadence, commonly 60 Hz, without claiming a new
   acquisition rate or guaranteed browser FPS.
2. Use a fixed 10-second rolling time axis and a bounded 4,096-sample ring. An
   explicit 0.75-second presentation buffer absorbs normal delivery batches.
   Each trace displays its actual lag behind the latest received sample.
3. Preserve original values, timestamps, invalid-status flags, and phase/session
   boundaries. No filtering, synthesized readings, sample interpolation,
   physiological classification, or ADC-rate changes are added.
4. Stop movement at the latest received sample when data stalls. Show any actual
   missing intervals as gaps. On Stop, drain the display to the final real point
   and freeze it. On restart/new phase, reset the view to the new source segment.
5. Keep marker submission/click timing and server alignment unchanged. A marker
   appears on the delayed graph only when its matched real frame is displayed.
6. Resize canvases only when dimensions change, retain real min/max spikes when
   reducing a dense trace to pixel columns, and skip hidden processed charts.
   Axis range hysteresis affects display scale only, never measurements.

The 0.75-second buffer is a latency tradeoff for smoother drawing. The live status
continues to report received-frame age; the trace label reports the additional
display lag. This does not fix acquisition stalls or make invalid bytes valid EEG.

## Files that would be deployed

- `signal-viewer/bench-trace.js` (new display-only helper)
- `signal-viewer/bench-panel.js` (wire RAF renderer into the existing raw view)
- `signal-viewer/app.js` (skip the hidden processed renderer)

`base/` contains original snapshots; `proposed/` contains the candidate and tests.
`smoothness.patch` is the complete reviewable patch. `manifest.json` records
original and proposed SHA-256 hashes. The existing marker buttons, controls,
exports, diagnostics, sampling, and backend are preserved.

## Verification already completed in staging

Run:

```sh
node --test staging/signal-scope-smoothness-20261018/proposed/signal-viewer/*.test.mjs
```

10 tests pass, including existing queued Start/Stop, marker shortcuts/deletion,
source selection/calibration guards, plus bounded history, duplicate snapshots,
phase resets, real gaps, preserved peaks, repeated timestamps, stale/frozen
display, hidden views, and RAF paints between polls. An inert-DOM test produces
60 trace paints from 30 animation frames without fetching another batch. Tests
do not send any request to the real local recorder or operate hardware.

A 600-frame dual-trace workload with 4,096 input samples reported JavaScript
preparation p50 0.188 ms and p95 0.286 ms on this machine. This uses a mock canvas:
browser rasterization, visual QA, actual FPS and active-page behavior remain to be
checked after the user authorizes deployment. No claim of guaranteed 60 FPS.

## Apply only after the user explicitly says to apply

From `/path/to/focused`:

```sh
python3 staging/signal-scope-smoothness-20261018/apply-staged.py --apply-after-user-approval
```

The helper refuses if recording or a queued start is active, if the recorder
cannot be checked, or if active/staged files changed since this proposal. It backs
up current files and replaces only the three frontend files. The existing
auto-refresh will then load them. It does not start/stop the recorder or restart
the server. **The apply command has not been executed.**
