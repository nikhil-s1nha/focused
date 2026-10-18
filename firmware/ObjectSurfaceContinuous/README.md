# Continuous nonhuman object diagnostic — offline prepared

Separate derivative of `ObjectSurfaceMonitor`. The bounded original is unchanged. This sketch is prepared/compiled only; its author did not upload, open serial, or operate hardware.

Use only with the previously confirmed **nonhuman object/fabric surface**, with no person, animal, or object electronics connected. It requests CH1 internal-short control / CH2 external input, both gain 1, nominal 125 SPS / 2.42 V reference. Respiration, RLD, lead-off and test excitation are requested off. Failed ID/register checks remain failures: all received rows stay **UNTRUSTED_BYPASS**, raw counts only, never calibrated or EEG.

## Continuous capture and explicit Stop

- There is **no duration limit or row cap**. Capture starts once per boot after the same setup/readback procedure as the bounded monitor.
- Send exactly uppercase ASCII **`S`** over the same 115200-baud serial connection to stop. No newline is required. Other characters are ignored.
- Stop is polled at every capture-loop iteration, including while no new DRDY edge is observed. Startup/reset/settling waits are also stop-aware, and an early Stop is latched.
- An in-progress short SPI operation or serial line finishes before the next poll; no hard real-time latency is claimed. UART interrupts remain enabled while waiting for DRDY.
- Once Stop is processed, START is lowered, the DRDY pin-change interrupt is disabled, and a STOP command is attempted. The summary is printed, RESET is lowered, then `OBJECT_STOP_ACK,REASON,USER_SERIAL_S,CAPTURE_STARTED,0|1` and the ordinary `BYPASS_COMPLETE,...` footer are emitted. A Stop before acquisition gives zero frames and `CAPTURE_STARTED,0`.
- The sketch then stays parked with START/RESET low and CS high. Serial commands cannot resume capture. There are no automatic resets, retries, forced samples, or acquisition restarts in this sketch.

A physical reset, power cycle, or the Uno's normal USB-DTR reset **does** run setup again. The host must keep one exclusive serial reader open, send Stop through that reader, wait for the acknowledgement/completion, and avoid automatic reconnect/reset loops. The operator remains responsible for restoring the normal verified firmware afterward.

Existing raw formats are retained: `BYPASS_PHASE`, `UNTRUSTED_BYPASS`, the first-four-frame `RAW_TRANSACTION`, and `BYPASS_SUMMARY`. New metadata declares `OBJECT_SURFACE_CONTINUOUS,UNTIL_SERIAL_S,NO_DURATION_LIMIT,NO_ROW_CAP,NONHUMAN_ONLY`. If DRDY stalls, no fallback rows are generated; the loop remains responsive to `S`.

Sequence, edge counters and summary durations use unsigned 32-bit values and eventually wrap. Uno `micros()` wraps about every 71.6 minutes; timestamps remain host-read timestamps, not independently verified ADC conversion times. Serial printing and extended probes can miss conversions. The host must preserve these limitations and bound its own in-memory graph buffer without imposing a hidden firmware capture limit.

## Compile only

```sh
tools/arduino/bin/arduino-cli compile --fqbn arduino:avr:uno \
  --config-file tools/arduino/arduino-cli.yaml \
  --output-dir tools/arduino/build/object-surface-continuous \
  firmware/ObjectSurfaceContinuous
```

No upload command is included. Hardware wiring and protocol reference remain in `FrameFormatObjectBench/README.md`; this derivative does not change them or enable human acquisition.
