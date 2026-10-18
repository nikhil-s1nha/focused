# Nonhuman object frame-format bench diagnostic

**Offline prepared only; not uploaded by its author.** Use only with electrodes
on nonhuman fabric/object surfaces, with no person, animal, or toy electronics
connected. This diagnostic bypasses ID/configuration guards deliberately; it is
not the production recorder, EEG acquisition, or proof of reliable measurements.
`ExternalInputRecorder` remains unchanged and disabled.

Fixed wiring: Uno R3 D7→CS, D6→DRDY, D5→START, D4→RESET, D13→SCK,
D12←MISO, D11→MOSI; sensor VDD→Uno5V and GND→GND. Uno connects over USB;
there are no Pi GPIO connections.

Three requested configurations run for at most four seconds / 500 frame rows
each, using 125 kHz MODE1/MSB-first SPI and RDATA. Configuration/ID failures are
printed and deliberately do not stop this object-only diagnostic:

1. Both channels internal-short, gain6.
2. Both channels internal1Hz test, gain1.
3. CH1 internal-short control; CH2 normal external object input; both gain1.

All phases request125SPS, nominal2.42V reference, lead-off/RLD/respiration off,
RLD source mask0. These are requests, not verified settings when readback fails.
The first line is exactly:

```text
FRAME_FORMAT_OBJECT_BENCH_ONLY,NONHUMAN_SURFACE_ONLY,NOT_EEG
```

`BYPASS_PHASE` identifies each phase. Every `UNTRUSTED_BYPASS` row contains the
sequence (restarts each phase), Uno read-time microseconds, and nine payload
bytes as18hex characters. First four frames of each phase also emit:

```text
RAW_TRANSACTION,<same sequence>,<same micros>,<38 hex characters>
```

Those19bytes are the byte received while transmitting RDATA (`12`), followed
by18payload bytes, under one continuous CS-low transaction. The ordinary row
retains the first nine payload bytes. Keeping the opcode response and extra
payload allows offline checks of alignment and the documented multiple-readback
behavior; it does not manufacture or certify a second sample. Later frames use
the normal nine-byte payload. No-DRDY fallback clocks only a bus probe and labels
it `FORCED_CLOCK_PROBE_NOT_SAMPLE`.

Extended reads and extra serial printing add timing overhead and may miss
conversions. Sequence counts rows, not an ADC sample index; timestamps mark Uno
read initiation. Status checks are diagnostics only, not a guarantee that channel
words are correct. No calibrated units are emitted. Each phase is bounded even
if DRDY stops. Completion drives START and RESET low; no host start command or
unbounded capture exists. The parent operator must restore normal firmware.

Offline compile (no upload):

```sh
tools/arduino/bin/arduino-cli compile --fqbn arduino:avr:uno \
  --config-file tools/arduino/arduino-cli.yaml \
  --output-dir tools/arduino/build/frame-format-object \
  firmware/FrameFormatObjectBench
```

Sources: [TI datasheet pp28–29,35–39](https://www.ti.com/lit/ds/sbas502b/sbas502b.pdf#page=28)
defines MODE1 timing, the72-bit status/CH1/CH2 frame, commands and multiple
readback. [Official driver](https://github.com/Protocentral/protocentral-ads1292r-arduino/blob/9be1a97587509abda02e7da94e911794e8d37850/src/Protocentral_ADS1292R.cpp)
uses the same nine-byte layout. This standalone sketch adds no libraries beyond
the installed Arduino AVR core/SPI.
