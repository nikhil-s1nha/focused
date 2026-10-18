# External input recorder — staged and disabled

**Not uploaded. Do not use this build to start the present head-connected,
wall-powered arrangement.** `ENABLE_EXTERNAL_ACQUISITION` remains `false`.
The default build parks START and RESET low, prints `BLOCKED`, and never calls
`SPI.begin()`, the ADC library's `begin()`, or acquisition functions. Even a
separately reviewed enabled build cannot start automatically: it requires fresh
ID/configuration verification and an explicit host ARM command.

The present communication failures and the body-connected electrical arrangement
are independent unresolved blockers. Software arming is not a substitute for
electrical isolation or a review of the external input/bias circuit. This file
does not establish anatomical electrode placement, cable-color identity, input
common mode, EEG quality, or fear measurement. With RLD disabled the jack sleeve
is **not automatically a ground/reference electrode**; do not reinterpret it.

## Proposed acquisition identity

- Uno R3: CS D7, DRDY D6, START D5, RESET D4, hardware SPI D11/D12/D13.
- Pinned ProtoCentral driver 2.0.0, commit
  `9be1a97587509abda02e7da94e911794e8d37850`.
- 125 SPS; nominal reference 2.42 V; both gains 6.
- CH1: internal short, electronic control channel. CH2: normal differential
  external biopotential input, **unvalidated source**.
- Test generator, respiration, lead-off, RLD, RLD source selection, and clock
  output all disabled. No host register-write interface exists.
- Strict driver ID check precedes configuration. Every relevant register is
  additionally read twice, at startup and again immediately before arming.

Expected register map `00` through `0B`:

```text
73 00 A0 10 01 00 00 00 00 02 03 0C
```

All verification masks are `FF`, except `08` uses `E0` to ignore live lead-off
flags and `0B` uses `FC` to ignore live GPIO input levels. Any mismatch latches a
fault and drives START/RESET low. No ID bypass exists in this recorder.

## Staged serial protocol

Default disabled output:

```text
EXTERNAL_INPUT_RECORDER,VERSION,1
BLOCKED,EXTERNAL_ACQUISITION_DISABLED
STAGED_ONLY,NO_SPI_BEGIN,NO_ADC_INITIALIZATION,NO_CAPTURE
```

The following describes the **inactive reviewed-build path**, not steps to
enable it now. Startup verifies ID and the full map twice before it can emit:

```text
READY_FOR_ARM,ARM_REQUIRES_HOST_SESSION_32_HEX
```

An enabled path would accept exactly `ARM,<32 hexadecimal characters>` followed
by newline. The host must generate a fresh random session token; the Uno has no
reliable globally unique clock. A token is provenance, not authorization or
evidence of hardware safety. The firmware binds the token to fresh verification:

```text
SESSION,<host-generated-token>
DEVICE_ID,0x73
VERIFY_PASS,1
REGISTER,0x00,0x73
...every register 00 through 0B, then VERIFY_PASS,2 and the same map...
VERIFY_OK,ID_AND_CONFIG_TWO_PASSES
CHANNEL_ROLE,1,INTERNAL_SHORT_CONTROL
CHANNEL_ROLE,2,EXTERNAL_DIFFERENTIAL_UNVALIDATED
CONFIG,SPS_125,GAIN_6,VREF_NOMINAL_V_2.42,CH1_SHORTED,CH2_EXTERNAL
CONFIG,RESPIRATION_OFF,LEADOFF_OFF,RLD_OFF,TEST_SIGNAL_OFF
CONVERSION,INPUT_UV_PER_COUNT,0.04808108
TIMESTAMP_BASIS,UNO_HOST_READ_MICROS_NOT_ADC_CLOCK
FRAME_FORMAT,EXTERNAL_INPUT,sequence,uno_read_micros,status_hex,ch1_counts,ch2_counts
ARMED,EXTERNAL_INPUT
```

Raw rows have six fields: source, sequence, Uno read-time microseconds, six-digit
hex status word, signed CH1 counts, signed CH2 counts. No microvolt values are
emitted in sample rows. The conversion metadata is nominal, not a measurement of
the actual reference. A receiver must require a **fresh SESSION, complete matching
two-pass handshake, roles/configuration, and ARMED**, not merely trust a row prefix.
Never rename internal-test, shorted-input, bypass, or replay rows to this source.

RDATA requests a nine-byte frame in stopped-continuous-read mode. Both fixed
status requirements are checked before emission: `1100` prefix and 13 low zero
bits. A failure latches the recorder off, as do stale DRDY and a read-time gap
greater than 12 ms. Good status bits alone do not verify all sample bits or neural
origin. `STOP` followed by newline latches a stopped state. Fault, stop, and the
two-minute session limit all require reset before a new session.

The firmware requires seeing DRDY high before accepting its next low level;
stuck-low input cannot fabricate a stream. Polling cannot count every missed ADC
conversion; transmitted sequence numbers count accepted frames, not a hardware
sample index. Uno `micros()` wraps after approximately 71.6 minutes; a two-minute
session may still cross a wrap depending on when it is armed. Receivers must
unwrap unsigned 32-bit times and label host read time accordingly.

## Offline build only

From the project root, with the existing installed AVR core and pinned library:

```sh
tools/arduino/bin/arduino-cli compile --fqbn arduino:avr:uno \
  --config-file tools/arduino/arduino-cli.yaml \
  --library /tmp/hypnos-ads1292-library \
  --output-dir tools/arduino/build/external-staged \
  firmware/ExternalInputRecorder
```

This is a compile command only. No upload or enabling command is provided.
Default-disabled compilation checks C++ declarations and types, but it is not a
runtime test of the inactive acquisition path.

Sources: [TI ADS1292R datasheet](https://www.ti.com/lit/gpn/ADS1292R),
[pinned official driver](https://github.com/Protocentral/protocentral-ads1292r-arduino/tree/9be1a97587509abda02e7da94e911794e8d37850/src).
