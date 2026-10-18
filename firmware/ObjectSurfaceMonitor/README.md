# Bounded nonhuman object surface monitor

Offline prepared only; not uploaded by its author. This is a separate derivative
of `FrameFormatObjectBench`; that original three-phase sketch is unchanged.

Run only on the confirmed nonhuman fabric/object surface, with no person, animal,
or toy electronics connected. It requests **only CH1 internal short / CH2 normal
external input, both gain1**, nominal125SPS/2.42V reference, lead-off/RLD/
respiration/test generator off. Failed ID or configuration readbacks remain
diagnostic failures; bypass data never become trusted, calibrated, or EEG.

The single requested phase lasts at most120seconds /15000 rows. The first line,
`BYPASS_PHASE`, `UNTRUSTED_BYPASS`, and first-four-frame `RAW_TRANSACTION`
formats match `FrameFormatObjectBench`. An additional `OBJECT_SURFACE_MONITOR`
metadata line declares the duration and frame limits. The first four transaction
probes retain opcode RX plus18 payload bytes; ordinary rows always contain the
first nine payload bytes. Serial/probe overhead can miss conversions. Row
sequence is not a hardware sample counter; timestamps are Uno read times.

Completion parks START and RESET low. There is no automatic restart, host command
to extend the limit, or production acquisition enablement. The parent operator
must restore the normal firmware after the bounded capture. See the original
frame-format bench README for the exact Uno wiring, protocol rationale and TI
source links.

Offline compile only:

```sh
tools/arduino/bin/arduino-cli compile --fqbn arduino:avr:uno \
  --config-file tools/arduino/arduino-cli.yaml \
  --output-dir tools/arduino/build/object-surface-monitor \
  firmware/ObjectSurfaceMonitor
```
