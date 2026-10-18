# Signal Scope operator guide

The local viewer is available in the in-app browser at
**http://127.0.0.1:8767/** while its server is running. On this Mac, double-click
`start-signal-viewer.command` in the project root to start it again, or use the
terminal command below. The scheduled troubleshooting task remains paused;
the manually launched viewer is independent of it.

## Current object-test workflow

Use the original **http://127.0.0.1:8767/** workspace. The current hardware
test is explicitly limited to electrodes on the confirmed teddy-bear fabric,
with no person, animal, or toy electronics connected. It produces **untrusted
raw ADC counts, not EEG, emotional measurements, or calibrated microvolts**.

The operator enables this separate Pi-controlled path when launching the server:

```sh
backend/.venv/bin/python -m backend.viewer_server --enable-object-bench
```

Without that flag, diagnostic files can still be viewed, but object recording
controls cannot start hardware. The fixed connection uses the existing SSH
control socket `/tmp/molten-pi-ssh/control`, `root@PI_IP`, and the audited
`/root/adaptive-horror/firmware/id-bypass-diagnostic/run_object_continuous.py`.
Do not launch another viewer or serial reader alongside the original server.
If the server needs restarting, first Stop the recording and wait for confirmed
original-firmware restoration.

1. **Change source → Diagnostic capture · raw counts** (or open
   `http://127.0.0.1:8767/?source=raw_diagnostic`). **Start recording** uploads
   the fixed object diagnostic and begins capture. It requests CH1 internal-short
   control and CH2 external object input, both gain1, with excitation disabled;
   failed ID/configuration/status checks remain explicit and untrusted.
2. Use **Mark reaction** or a custom label while recording. These are operator
   annotations; the system does not detect fear. A marker links to the nearest
   observed frame with approximate timing, or remains unaligned when no fresh
   matching frame exists. Delete removes that annotation, not raw samples.
3. **Stop** sends serial `S`, parks acquisition, and restores the verified original
   bench firmware. Wait for **Recording stopped · original firmware restored**.
   **Start after stopping** queues exactly one next recording; it starts only
   after successful restoration. **Cancel queued start** cancels that request.
   Restoration failure prevents a queued restart and remains visibly reported.
4. Export **CSV**, **JSON**, or the original **raw capture**. Each run archives
   all received bytes, status and markers under
   `backend/results/bench-recordings/<run_id>/`. A new run preserves the previous
   live feed. The chart retains the latest **1,500 samples per phase**; exports
   parse the full archived log, including separate restart segments.

Capture runs **until Stop**, with no recording-duration or row cap. If no frames
arrive for five seconds, the runner may reset the Uno, allowing at least ten
seconds since the previous reset; it permits **three automatic resets total**.
After those attempts, it keeps the existing recording open and reports missing
frames until Stop. Restarts preserve received bytes and begin identifiable new
capture segments. They do not certify the data or repair invalid status words.

The server renews a **30-second remote lease**. Closing the browser alone does
not stop capture while the server remains connected. Losing the server/SSH lease
causes the remote runner to stop and restore; uploads/restoration can take
additional time. A lost connection never counts as confirmed restoration.
Compact source, reception and status labels distinguish Receiving, No frames,
Restarting, saved traces and restoration errors without a separate banner.

## Processed/demo waveform controls

- The upper trace is filtered voltage; the lower trace is raw voltage.
  Both use microvolts on the vertical axis and seconds ago on the horizontal.
- Select ADC channel 2 or channel 1. These are ADC channels, not two independent
  scalp measurement sites on the stock three-lead cable.
- Change the window to 5, 10, or 30 seconds; choose Auto or a fixed vertical scale.
  Auto centers the raw display on its visible DC offset and labels that center.
  Its vertical labels retain the actual voltage values.
- Pause freezes a copy of the visible history. Acquisition and optional recording
  continue. Resume returns to the newest samples.
- Blink, Jaw clench, Scare / stimulus, or a custom label inserts a time marker;
  it does not change physical sensor data. Keyboard shortcuts B, J, and S work
  outside form fields; Space pauses/resumes.
- Start recording, add markers, stop, then Export CSV. The download includes
  both channels and timestamped marker rows. Starting another recording asks
  before replacing an existing in-memory recording. Recording cannot start
  while the source is disconnected, waiting, or in an error state; a rejected
  start preserves the saved recording.
- In demo mode only, Simulate spike creates a clearly synthetic burst.
- Connect sensor lists available USB ports and the supported bench firmware
  sources. It requires confirming the electrode cable is disconnected.
  Reset baseline restarts settling/calibration.

## Current physical verification

Human external-electrode recording is **not enabled** in this viewer. The
explicit object-only path above is a separate untrusted diagnostic exception.
A separate `firmware/ExternalInputRecorder/ExternalInputRecorder.ino` has been staged and
compiled, not uploaded. Its default build disables acquisition. It requires
separately reviewed hardware/power arrangements and verified ID/configuration
before any external-input mode can be enabled. The current firmware and viewer
sources must not be relabelled as personal EEG.

An earlier Pi-hosted bounded diagnostic compared per-frame RDATA with direct
RDATAC while electrodes were unplugged. The direct-RDATAC comparison produced
108 raw records, zero valid status prefixes, and seven register mismatches in
each phase. Normal firmware was restored with upload verification. Details and
raw captures are in `firmware/SPI_DIAGNOSIS.md` and `firmware/results/`.

Earlier on October 17 the directly connected Uno was detected as
`/dev/cu.usbmodem101`. A five-second capture identified the internal-test sketch,
but returned `ERROR,BEGIN,3` and `DEVICE_ID,0x31`, with **zero sample frames**.
The previously verified ID was `0x73`. These failed immutable-ID reads make
communication untrusted; choosing another conversion profile does not fix it.
The read-only inspection is saved in `results/viewer-usb-inspection.csv`.
These historical failures do not establish real human EEG. Current object-test
plotting preserves received raw bytes even when validation fails.
Demo acquisition, controls, recording and browser CSV export were exercised
end to end. `results/viewer-validation.json` records that boundary.

Run from the project root using the existing isolated Python environment:

```sh
backend/.venv/bin/python -m backend.viewer_server
```

Open **http://127.0.0.1:8767/**. The server serves `signal-viewer/` and starts in
**DEMO — generated synthetic waveform, no sensor attached**. Both traces are
generated in microvolts at 125 samples/second. The filtered display is a causal
1–30 Hz filter; 10 Hz summaries use the existing experimental processor. The
demo includes low-frequency drift, a 60 Hz component, and a periodic generated
burst. A button can add a deliberate synthetic burst. None is a live EEG signal.

The default binding is localhost. Do not expose this development server to a
public network. It is separate from the VR game and does not relay data to it.

## Attach a bench source explicitly

Keep the electrode cable physically disconnected. Attach the Uno by USB to the
computer running this server; a Pi only reachable by SSH is not automatically a
local USB source. This direct-USB path does not contact the Pi; the separately
enabled object recorder above does. Stop other serial
readers first. Choose an available USB serial port and the exact firmware mode:

- **internal_test:** `SensorBenchTest`, internal ADC test source, gain 1;
- **shorted_input:** `SensorNoiseTest`, internally shorted ADC inputs, gain 6.

Both modes are **bench tests, not EEG**. Conversion uses the existing nominal
2.42 V reference profiles; this is not a measured voltage calibration. Opening
an Uno serial port can cause its normal USB reset. This direct-USB path never
uploads firmware or sends serial commands. The explicit object recorder can
upload only its fixed diagnostic/restoration firmware; no path enables
body-connected acquisition. An
exclusive-open request prevents subsequent readers while the port is attached;
it cannot remove another reader that was already running.

Attachment failure remains visibly in the selected serial/error state. It never
silently replaces missing sensor data with demo data. Disconnect, stale input,
configuration mismatch, rate mismatch, sequence gaps and reset are invalid
states. A configuration/rate mismatch requires explicit reattachment after
checking the selected firmware/profile.

Raw and filtered waveforms are full-rate display traces; contaminated/raw
samples may remain visible during invalid periods for diagnosis. Treat the
quality flags and discontinuity generation as authoritative. Numerical quality
passing is not proof of genuine EEG, and electrical spikes do not establish fear.

## Browser API

JSON POST bodies use `Content-Type: application/json`. Controls are same-origin.

| Endpoint | Request/response |
|---|---|
| `GET /api/state` | Current source, explicit label, status, generation, units, conversion profile, two-channel summaries and recording state. |
| `GET /api/ports` | `{"ports":["/dev/cu.usbmodem..."]}`; never auto-attaches. |
| `GET /api/events` | Standard SSE `onmessage`; initial `type: "state"`, then `type: "samples"` batches near 20 Hz. `/events` is an alias. |
| `POST /api/source` | `{"source":"synthetic"}` or `{"source":"shorted_input","port":"/dev/cu.usbmodem..."}`. |
| `POST /api/calibrate` | `{}` resets scoring/filter state and restarts five-second settling plus 30-second clean baseline. |
| `POST /api/demo-pulse` | `{}` creates a synthetic 0.6-second burst and a marker; rejected in serial mode. |
| `POST /api/marker` | `{"label":"Door opened"}`; up to 120 characters. |
| `POST /api/markers/delete` | `{"id":"stable-marker-id"}` deletes one event; `{"all":true}` clears all log and recording annotations. Waveform samples are retained. |
| `POST /api/recording` | `{"recording":true}` starts a **new** in-memory recording; false stops it. |
| `GET /api/export.csv` | Download current recording, with source on each sample/marker row. |
| `GET /api/export.json` | Download recording including both raw count channels for serial, conversion profiles and metadata. |

Sample event shape:

```json
{
  "type": "samples",
  "source": "synthetic",
  "source_label": "DEMO — generated synthetic waveform, no sensor attached",
  "generation": 0,
  "sample_rate": 125,
  "units": "microvolts",
  "samples": [
    {"timestamp": 1792267200.008, "raw_uv": [12.1, 8.7],
     "filtered_uv": [9.2, 6.4], "sequence": 1,
     "source": "synthetic", "generation": 0}
  ],
  "summary": {
    "channel": 2,
    "signal_quality": 0,
    "calibrated": false,
    "baseline_progress": 0,
    "channels": [{"signal_quality": 0}, {"signal_quality": 0}]
  },
  "status": "running",
  "message": "DEMO — generated synthetic waveform, no sensor attached",
  "markers": [],
  "recording": {"active": false, "samples": 0, "markers": 0, "truncated": false}
}
```

Arrays are CH1 then CH2; CH2 is the default summary. Each summary includes
quality reasons, calibration progress, RMS, experimental reaction score,
`reaction_event` and `test_event`. Bench/demo sources never emit human reaction
events. Clear plotted trace history when `generation` changes. Pause affects
display only; capture, source validation and recording continue.

## Processed waveform recording and limits

New samples preserve raw counts, Uno read-time microseconds, host arrival,
source/generation, nominal conversion, and observed read rate. Immediate raw
clipping/nonfinite flags are per channel. The slower per-channel scoring
summaries retain their own timestamps; their quality is not a verdict on every
individual sample or proof of physiological origin. The legacy quality field
is additionally gated by both channels' immediate numeric flags.

CSV retains its original first eleven columns and appends the extra raw,
timing, conversion, quality, and marker-provenance columns. JSON includes the
same provenance. Older restored samples with missing fields remain unknown;
the exporter does not invent their device timing or conversion metadata.

Recording is opt-in and remains in memory. Export before restarting the server.
The limit is **75,000 two-channel samples**, approximately ten minutes at 125 Hz.
Reaching it stops recording and sets `truncated: true`. It does not stop capture.
Starting a new recording replaces the previous one. At most 10,000 recording
markers and 100 pending markers are retained. Slow SSE clients get recent data
from a bounded queue; recording is independent of browser display speed.

JSON export preserves sample sources and generations across explicit source
changes. Profiles declare nominal conversion values. No recording from these
bench modes should be presented as a human EEG dataset.

Each event has a stable `id`. The current generation's last 500 events are
returned in `marker_history` with `markers_revision` in state and SSE batches,
so reloads and multiple tabs share the same log. A chip's × deletes it from
the plot/log, pending delivery and recording annotations. **Clear log** asks for
confirmation and removes all event annotations, including older-source recording
annotations; neither operation deletes waveform samples or edits an already
downloaded file. Deletion also updates paused plots. Event history is kept in
server memory unless exported.

For a coordinated restart, first save `/api/export.json`, then restore that
explicit local file at startup:

```sh
backend/.venv/bin/python -m backend.viewer_server --restore-recording backend/results/saved-viewer.json
```

Restore preserves recorded samples and annotations plus current log history,
assigning IDs to legacy markers that lack them. Recording resumes **off**, and
no serial source is automatically opened. A restored serial source remains
disconnected/error until explicitly reattached. Restore is CLI-only; the server
does not expose an arbitrary-file import endpoint. A marker migrated from an
older UI's visible clock can carry `timestamp_precision: "display_second"` and
explicit provenance; it remains unrecorded unless it was in the original export.

## Tests

```sh
backend/.venv/bin/python -m unittest backend.test_viewer_server -v
backend/.venv/bin/python -m unittest backend.test_eeg_processing backend.test_acquisition backend.test_viewer_server -v
```

Viewer tests cover full-rate two-channel output, explicit attachment and no
silent fallback, bench conversion/source labels, stale/discontinuity masking,
metadata mismatch, marker/recording/export limits, bounded subscribers,
calibration/pulse controls, real local HTTP endpoints and SSE delivery. Serial
tests use a fake reader; physical hardware is not asserted to be available.

## Raw diagnostics inside Signal Scope

Use **Change source → Diagnostic capture · raw counts** in the existing viewer,
or open `http://127.0.0.1:8767/?source=raw_diagnostic` (`?view=bench` remains compatible).
Selecting this source alone is a read-only view of the fixed local
capture file `firmware/results/bench-live-20261017.txt`; selecting it does not
attach serial hardware, switch the processing source, clear markers, or replace
the waveform recording. Use the same **Change source** control to select the
synthetic waveform or either existing Uno bench source. Only one graph workspace
is shown for the selected source; there are no separate navigation tabs.

`GET /api/bench-state` returns the bounded diagnostic phases and provenance from
`BenchLog`; `GET /api/bench-raw` downloads the original capture text. Neither
endpoint accepts a file path or writes acquisition commands. The charts display
untrusted signed counts against actual Uno read timestamps, break lines at gaps,
and label completed/incomplete captures. There is no voltage conversion, filter,
calibration or reaction score for this view. The capture header distinguishes
an electrode-disconnected test from an explicitly nonhuman object-surface test;
neither is a human EEG acquisition mode.

The object recorder adds explicit opt-in control endpoints in this same server:

| Endpoint | Behavior |
|---|---|
| `GET /api/bench-recording` | Controller stage, restoration state, queued start and markers. |
| `POST /api/bench-recording/start` | `{"nonhuman_surface_only":true}`; starts or queues one object recording. |
| `POST /api/bench-recording/stop` | Stops current capture and cancels any queued start. |
| `POST /api/bench-recording/marker` | `{"label":"Object touched"}`; active recording only. |
| `POST /api/bench-recording/marker/delete` | `{"id":"marker-id"}`; deletes an annotation. |
| `GET /api/bench-recording/export.csv` | Full archived raw-count samples and marker rows. |
| `GET /api/bench-recording/export.json` | Same data plus provenance, status and capture segments. |

These routes cannot select arbitrary hosts, files, firmware or human-input
modes. Existing processed waveform exports and markers keep their own provenance.
Object-controller and recovery tests use mocks/local files only:

```sh
backend/.venv/bin/python -m unittest backend.test_bench_recorder firmware.test_object_continuous -v
```
