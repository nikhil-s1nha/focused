# Experimental electrical-reaction processing

## Standalone acquisition output (sensor side only)

`acquire_signal.py` now connects the bench CSV protocol to the processing API.
It does not contact, edit, or run the game. The current firmware still samples
the **internal generator**, not electrodes. External/body acquisition is not
enabled by this adapter. Keep electrodes disconnected for these commands.

From the project root on the Mac, after normal SSH access is available:

```sh
# One-time copy of the read-only transport script; wait for this to finish.
scp firmware/stream_serial.py root@PI_IP:/root/adaptive-horror/firmware/

# Exactly one serial reader. This does not flash firmware or write ADC registers.
# Opening a serial port may reset an Uno; startup causes fresh calibration.
set -o pipefail
ssh -o ConnectTimeout=5 -o ServerAliveInterval=3 -o ServerAliveCountMax=2 \
  root@PI_IP \
  'python3 /root/adaptive-horror/firmware/stream_serial.py --seconds 45' \
  | backend/.venv/bin/python -m backend.acquire_signal \
      --source internal_test --channel 2 --raw-log /tmp/bench-raw-new.jsonl
```

The raw-log filename must be new: the reader refuses to overwrite a recording.
Omit `--seconds 45` for an interactive continuous run; stop with Ctrl-C.
No credentials are embedded in code or documentation. If using an existing SSH
control socket, add its normal `-S`/`ControlPath` options. Run the filtering on
the Mac's existing virtual environment; the Pi transport needs only its Python
standard library. Do not run another serial reader or uploader concurrently.

Replay a saved **serial CSV** for offline checks:

```sh
backend/.venv/bin/python -m backend.acquire_signal \
  --source internal_test --input /absolute/path/to/capture.csv
```

Replay messages carry `replay=true`; they must never drive a live experience.
Do not feed the raw JSONL recording back as CSV. Pipe through `tee capture.csv`
before the adapter if preserving the exact serial bytes is needed.

Profiles live in `acquisition_profiles.json`. They deliberately distinguish
gain 1 internal test from gain 6 shorted input and use the signed ADC scale
`nominal_reference * 1e6 / gain / 2**23`. These are **expected settings from
previous firmware/tests**, not fresh register verification by this adapter.
The 2.42 V reference is nominal, not a multimeter measurement. If firmware or
ADC configuration changes, reverify its settings before selecting/updating a
profile; matching CSV labels alone cannot prove the analog configuration.
If available ID/register/configuration/conversion headers contradict the
selected profile, the adapter latches invalid and rejects all subsequent data.
Review the configuration and restart the process; later records cannot silently
clear that fault. Out-of-order records are rejected rather than re-timestamped.

The adapter uses one channel at a time, preserves both channels' raw counts,
unwraps the Uno's 32-bit host-read clock, and anchors it once to Unix time.
Application sequence detects missing transmitted records; it does not count
missed ADC conversions. Timing gaps are checked separately. Gaps, reset,
duplicates, bad records, and disconnects discard baseline and restart settling.
It never interpolates missing samples. Silence longer than two seconds emits
an invalid signal; EOF also emits invalid output so the last score is not held.
The first 125 consecutive timing intervals establish a median observed read
rate. Until then output is invalid (`read_rate_unverified`). A rate more than
10% away from the profile latches `sample_rate_mismatch` and requires review
and process restart. The window and tolerance are in the acquisition profiles;
they are engineering checks, not precision measurement of the ADC clock.
At the expected rate this adds about one second, within the five-second filter
startup period. Timing/sequence gaps clear the rate window. A passed cadence
check still cannot rule out missed conversions before the Uno reads the chip.

### Partner output contract

Stdout is newline-delimited JSON, approximately 10 signal messages per second.
There are also `type=session` metadata and `type=status` diagnostics. Consume
only `type=signal`, and require **all** of the following before using a score:

- `source` is the explicitly agreed source. `internal_test` and
  `shorted_input` are bench signals, never human EEG.
- `replay` is false.
- `calibrated` is true.
- `signal_quality > 0` and `quality_reasons` is empty.
- `timestamp` is fresh (suggested maximum age 2 seconds), with a receiver-side
  timeout if messages stop. Timestamp basis is Uno host-read time, not precise
  ADC acquisition time. Computers need reasonably aligned clocks.

Use `intensity` as an experimental 0–1 baseline-relative electrical-change
score. `reaction_event` stays false for bench sources; only `test_event` may
exercise downstream numerics. Quality is a numerical gate, not a probability
of genuine EEG. Invalid/calibrating intensity zero is not evidence of calm.
On invalid/stale output the consumer should freeze/reset its own control,
rather than treating zero as a physiological reading. The partner owns that
behavior and all scene mappings.

`filtered_uv`, `rms_uv`, `reaction_score`, `baseline_progress`, `channel`,
`sequence`, and `missing_transmitted_records` support debugging. Raw JSONL
contains both raw count channels, receive/device times, and conversion profile.
`observed_read_rate_hz` is null until the timing window is established, then
reports the median rate of successfully read/transmitted records.
No source is silently promoted to `hardware`, and this command has no body mode.

Verification: 26 automated tests cover DSP plus adapter wraparound, timestamp
anchoring, gain/source selection, malformed/out-of-range input, sequence loss,
duplicates, clock resets, metadata contradictions, wrong-rate masking, read
timing gaps, and invalidation. The first live
adapter attempt on October 17 received **zero samples** because Pi network
reachability dropped; it correctly emitted stale/closed invalid output.
This is not a passed live filtering/calibration test. Prior ADC bench results
in `firmware/results/` remain valid within their documented scope.

This module filters an already-acquired differential voltage stream and detects
unusually large changes relative to a quiet baseline. It does **not** classify
fear, emotion, arousal, or prove that a signal is brain activity. Forehead
electrodes also detect eye and muscle activity. A quality flag is a numerical
gate, not a probability that the signal is genuine EEG.

## Setup and tests

Run from the project root with Python 3.10 or newer:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install --only-binary=:all: -r backend/requirements.txt
backend/.venv/bin/python -m unittest backend.test_eeg_processing -v
```

The local verification environment uses NumPy 2.5.4 and SciPy 1.18.1. It is
isolated in the ignored `backend/.venv`; no system or Pi packages are modified.

## Public API

```python
from backend.eeg_processing import EEGProcessor, ProcessingConfig

# Example metadata only: verify reference and gain from the actual firmware.
reference_volts = 2.42
gain = 1
processor = EEGProcessor(ProcessingConfig(
    sample_rate=125,
    adc_full_scale_uv=reference_volts / gain * 1_000_000,
    notch_hz=None,  # Set to 60 only if measured mains noise warrants it.
))

# Acquisition adapter supplies voltage samples, not raw ADC counts.
# Explicit times are sample/acquisition timestamps anchored to Unix seconds.
for update in processor.process(samples_uv, acquisition_times, source="internal_test"):
    message = update.to_dict()
    # Send message through the existing relay. Do not change the source label.
```

`process(samples_uv, timestamps=None, *, source='hardware')` accepts any chunk
size and returns `SignalUpdate` values near 10 Hz. `.to_dict()` provides:

- `type='signal'`, `source`, `timestamp`, `intensity` in 0–1,
  `signal_quality` in 0–1, and a list of `quality_reasons`;
- `filtered_uv`, `rms_uv`, `reaction_score` (baseline-relative score),
  `reaction_event`, `test_event`, `calibrated`, and `baseline_progress`.

The acquisition layer must retain ADC counts, reference voltage, gain, source
configuration, and sample sequence numbers. For signed 24-bit ADS data,
`microvolts = counts * (Vref / gain) * 1e6 / (2**23 - 1)` is the positive-full-scale
scaling convention; verify reference, signed decoding, polarity, and gain from
read-back registers and the test signal before using it. This module performs
no ADC register writes or count conversion. The chip's noise floor is not its
least-significant-bit size.

Without explicit timestamps, the processor generates **relative sample time**
from the declared rate, starting at zero. This supports offline/synthetic tests
but cannot discover dropped serial records or provide Unix timestamps. For live
relay output, the acquisition adapter should anchor the device sample counter
to an epoch and detect missing sequence numbers. Do not assign one arrival time
to every sample in a serial packet: that falsely looks like a discontinuity.

Supported source labels are `internal_test`, `shorted_input`, `synthetic`, and
`hardware`. Only `hardware` can emit `reaction_event=True`. Other sources emit
`test_event` instead, and their numerical scores can exercise the demo. The
caller must use `hardware` only for an actual external-electrode acquisition
mode after the separate hardware/body-connection review. A source change resets
calibration and filter state. `reset()` explicitly resets everything.

## Pipeline and heuristics

All tunables live in the frozen `ProcessingConfig` dataclass. Defaults:

1. 125 samples/second; a 1 Hz second-order high-pass followed by a 30 Hz
   fourth-order low-pass. Optional second-order mains notch, Q=30.
2. Causal SOS processing, preserving filter state across chunks. Startup and
   sample gaps and flatline recovery mask decisions for five seconds. A timestamp gap greater than
   1.5 sampling intervals, or non-increasing time, resets filter state.
3. Raw clipping (98% of supplied full scale), nonfinite data, and a one-second
   raw window spanning at most 0.01 µV invalidate output. Missing ADC full-scale
   metadata also invalidates output. These checks cannot detect every bad lead,
   eye blink, jaw contraction, or electrode-motion artifact.
4. A 200 ms RMS envelope, updated 10 times/second. Collect 30 seconds of clean
   baseline after settling; fit its median and `1.4826 * MAD`, floored at
   0.5 µV. Baseline remains fixed until reset/recalibration.
5. Trigger after two updates above score 4; rearm below score 2; require two
   seconds between triggers. `intensity = min(1, reaction_score / 4)` by default.

All thresholds are **engineering starting points, not validated physiological
cutoffs**. Invalid output sets `signal_quality=0` and suppresses events. Game
logic must gate on quality and calibration; a masked `intensity=0` is **not**
evidence that the player is calm. Calibration counts valid output frames, so
artifacts make its wall-clock duration longer. High/low-pass and notch filters
cannot recover clipping or remove interference already aliased into the passband.
No ICA, emotion model, or claim of complete artifact removal is included.

At 125 SPS, Nyquist is 62.5 Hz, but the ADS1292R's third-order sinc filter also
attenuates the upper passband. The sinc model gives about 32.7 Hz at −3 dB.
250 SPS may improve 1–30 Hz fidelity once acquisition/serial throughput is
verified; changing the declared rate alone does not change the chip rate.

## Verification boundary

Tests cover filter response to drift/10 Hz/60 Hz, irregular chunk invariance,
single-event and refractory behavior, gaps, clipping, flatline, nonfinite
samples, baseline scale floor, source tagging, and invalid parameters. They are
synthetic numerical tests. They do not validate fear detection or real EEG.

Internal square-wave capture verifies a chip/transport path, not electrode
pickup, EEG quality, or electrical safety. Keep electrodes disconnected during
bench testing. This module does not make a mains/USB/Ethernet-connected system
safe to attach to a person; body-connected power/isolation and electrode setup
must be resolved separately before acquisition on a person.

## Primary and official sources

- [TI ADS1292R specifications, test sources, gain and sample rates](https://www.ti.com/product/ADS1292R)
- [TI third-order sinc decimation filter and settling](https://www.ti.com/document-viewer/ADS1292R/datasheet#digital-decimation-filter-sbas4591444/SBAS4591444)
- [SciPy causal SOS filter and persistent delay state](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.sosfilt.html)
- [SciPy forward/backward filtering, intended for finite sequences](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.sosfiltfilt.html)
- [SciPy notch filter and Q definition](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.iirnotch.html)
- [Maddirala & Veluvolu: single-channel eye-blink artifact research](https://pmc.ncbi.nlm.nih.gov/articles/PMC8155082/)
- [Whitham et al.: muscle contamination above 20 Hz, original experiment](https://researchnow.flinders.edu.au/en/publications/scalp-electrical-recording-during-paralysis-quantitative-evidence/)
