# Signal Scope

A local sensor workspace for the adaptive-horror project, independent of the
game and the paused troubleshooting automation. Use the original viewer at
**http://127.0.0.1:8767/**; there is no separate object-test viewer to launch.

## Start

From the project root, with Python 3.10 or newer:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install --only-binary=:all: -r backend/requirements.txt
backend/.venv/bin/python -m backend.viewer_server
```

Open **http://127.0.0.1:8767/**. On the configured Mac, the root
`start-signal-viewer.command` also starts the viewer.

## Current object test: Start → Mark → Stop

The confirmed setup uses electrodes on **teddy-bear fabric only**, with no
person, animal, or toy electronics connected. Its plots are **untrusted raw ADC
counts, not EEG or fear measurements**. Human-input recording remains disabled.

The operator must explicitly enable Pi-controlled object recording at server
startup:

```sh
backend/.venv/bin/python -m backend.viewer_server --enable-object-bench
```

Use **Change source → Diagnostic capture · raw counts**, or open
`http://127.0.0.1:8767/?source=raw_diagnostic`. **Start recording** runs only the
fixed audited Pi runner, which uploads the object diagnostic. **Mark reaction**
and custom labels create operator annotations with approximate nearest-frame
timing; missing/stale frames leave markers unaligned. **Stop** sends serial `S`
and restores the original bench firmware. Wait for restoration confirmation.

**Start after stopping** queues one next recording after successful restoration;
repeated Start clicks do not create parallel runs. **Cancel queued start**
cancels it. A restoration failure prevents the queued recording from starting.

Capture continues **until Stop**, with no duration or row cap. Missing frames
can trigger at most **three automatic Uno resets**, after five seconds of
silence and at least ten seconds since the previous reset. The compact source,
reception and status labels show Receiving, No frames, Restarting and saved
traces. Automatic recovery does not turn invalid frames into valid signals.

The connected server renews a **30-second remote lease**. Closing the browser
alone does not stop recording; losing that lease makes the remote runner stop
and restore. Uploads/restoration can take additional time. The chart keeps the
latest **1,500 samples per phase**, while each run preserves every received byte
under `backend/results/bench-recordings/<run_id>/`. CSV/JSON exports include the
full archived samples, markers and distinct restart segments; raw export retains
the original bytes.

The fixed runner is `firmware/id-bypass-diagnostic/run_object_continuous.py` on
the Pi, reached only through the configured SSH control socket. Without the CLI
flag, viewing diagnostic files remains read-only and cannot start hardware.
Stop and confirm restoration before a coordinated server restart; do not open
another serial reader alongside this recorder.

## Other sources

The default waveform is explicitly synthetic. **Connect sensor** can attach a
local USB port with matching internal-test or shorted-input firmware; keep its
electrode cable disconnected. That direct-USB path does not upload firmware or
send serial commands. Only the explicitly enabled object recorder above uploads
its fixed diagnostic and restoration firmware.

The upper chart is full-rate causal 1–30 Hz filtered voltage; the lower chart
is raw input-referred voltage. Both support either ADC channel, 5/10/30-second
windows, auto/fixed amplitude scale, and display-only pause. Mark events with
the buttons or B/J/S keys, start/stop recording, and export CSV. Space pauses
outside form controls. Demo mode has a deliberately synthetic spike button.

See `backend/VIEWER.md` for the API contract, source-specific recording limits,
conversion profiles, tests and hardware verification boundaries.
