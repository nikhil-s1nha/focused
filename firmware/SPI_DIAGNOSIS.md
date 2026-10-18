# Uno / ProtoCentral communication diagnosis — 2026-10-17

## Current conclusion

The intended mapping matches the official Uno/v3 wiring. Reported continuity,
5.13 V input supply, regulated 3.3 V, and 5 V logic selection remain accepted;
do not repeat those checks without new evidence. The isolated Uno input test
passed. USB/Uno serial transport works. Successful sensor communication has
**not** been restored, and the exact failed physical component is not identified.

An explicitly authorized, separate bench sketch bypassed ID/readback rejection
with the electrode cable disconnected. It obtained bytes, but configuration
readbacks and status structure failed. The production driver's ID guard was
not changed. The normal application has been restored with upload verification.
Filtering or electrode placement cannot turn these corrupted transfers into EEG.

## Latest bounded bypass comparison

All captures below requested internal inputs only, with electrodes disconnected.
Requested configuration is not established when readback fails. Counts are raw
integers, not calibrated microvolts or physiological measurements.

| Read mode / requested input | SPI | Raw records | Valid status structure | Register mismatches |
| --- | --- | --- | --- | --- |
| RDATA / internal short | 125 kHz | 72 | 34 | 6 of 10 |
| RDATA / internal short | 1 MHz | 998 | 0 | 7 of 10 |
| Direct RDATAC / internal short | 125 kHz | 77 | 0 | 7 of 10 |
| Direct RDATAC / internal short | 1 MHz | 15 | 0 | 7 of 10 |
| Direct RDATAC / internal 1 Hz test | 125 kHz | 16 | 0 | 7 of 10 |

Direct RDATAC removed the per-frame opcode and its discarded received byte.
It did not restore communication; changing the read pattern alone was insufficient.
The ADC's actual read mode remains unverified, so this does not conclusively
exclude a mode mismatch. The three zero-valued register matches do not prove
successful writes: a stuck-zero response can also match an expected zero.
In each direct-RDATAC phase, observed DRDY edges stopped
early during an eight-second window; this does not prove the ADC itself stopped.
No stable known test waveform was verified. Intermittent correct-looking bytes
or status headers do not establish a valid register map or channel samples.

Evidence: `results/id-bypass-capture-20261017.txt`,
`results/id-bypass-continuous-20261017.txt`, and
`results/id-bypass-continuous-restore-20261017.log`.
The standalone sources are `IdBypassBench/IdBypassBench.ino` and
`IdBypassContinuous/IdBypassContinuous.ino`. Both are diagnostic exceptions only;
neither is a body-acquisition mode. The wall-powered Pi/Ethernet arrangement has
no verified body isolation. Electrode acquisition remains disabled.

### Latest disconnected bench capture and raw-count viewer

`results/bench-live-20261017-before-object.txt` preserves a bounded direct-RDATAC run:
20 frames at 125 kHz with internal short requested, 17 at 1 MHz with internal
short requested, and 150 at 125 kHz with the internal test source requested.
All 187 frames failed status structure; each phase had seven register mismatches
and zero correct ID reads. These are received bus bytes decoded as signed
integers, not verified ADC measurements. No electrode signal is established.

Signal Scope at `http://127.0.0.1:8767/?view=bench` now displays both decoded
channel fields, separates phases, labels raw counts and stale/completed capture,
and never substitutes generated samples. The capture is now completed, not live.
Original firmware restoration succeeded with upload verification; status and
restore evidence are `results/bench-live-20261017-status.json` and
`results/bench-live-20261017-restore.log`. No serial reader remains attached.
An initial runner attempt failed due to a missing reader path and restored the
original application; the corrected retry produced the capture above.

The standalone port-8768 viewer was stopped at the user's request; use Signal
Scope. It exposes the same fixed-file parser through `/api/bench-state` and
the original capture download through `/api/bench-raw`.
Ten parser tests passed, covering raw signed conversion, metadata, frame gaps,
timestamp wrap, bounded buffers, partial/malformed rows and completed captures.

### Nonhuman object-input and extended-frame experiment

The user confirmed electrodes touch only a teddy bear's surface, not a person
or the toy's electronics. `FrameFormatObjectBench` requests three four-second
phases at 125 kHz in RDATA mode: internal short, internal 1 Hz test, then CH1
short/control and CH2 external object input. All excitation is requested off;
failed readback still leaves the actual configuration unverified.

`results/object-format-20261017.txt` preserves 497 records per phase (1,491
total), zero valid status words, seven register mismatches per phase, and zero
correct ID reads. Original firmware was restored with verification afterward.
Twelve extended probes retained the opcode response plus eighteen payload bytes.
No fixed bit offset recovered more than two valid status words among the twelve
probes. No repeated pair of complete nine-byte blocks was observed. These
results do not identify a working alternate format or establish an object signal.
See `results/extended-probe-findings-20261017.md` and the accompanying JSON/script.

The earlier 187-frame capture was archived as
`results/bench-live-20261017-before-object.txt`. `results/bench-live-20261017.txt`
is the current live-view feed and may now contain a later nonhuman capture.
The offline analysis defaults use the immutable archived files.

### Two-minute object monitor and unified Signal Scope

`results/object-monitor-20261017.txt` preserves the later 120-second
`ObjectSurfaceMonitor` run. It received 23 rows in a 0.175696-second burst,
then observed no further frames for the rest of the window. All 23 status
structures failed; seven register readbacks mismatched and no ID read was
correct. The completion marker is present. This is not a continuous working
stream and does not establish a signal from the object. The absence of observed
DRDY edges does not prove the ADC stopped converting.

`results/object-monitor-20261017-status.json` records upload, capture and
original-firmware restoration exit codes of zero. No process held the serial
port after completion. The frozen capture SHA-256 is
`7a028b8f77939e143411d06996cc3787f82f4f46448a7acd7dc927d6e6cdf908`.
See `results/object-monitor-findings-20261017.md` for the timing comparison.

Signal Scope now uses one workspace and a **Change source** selector instead
of separate Raw Diagnostics / Waveform and Markers tabs. Selecting diagnostic
data is read-only and preserves existing recordings and markers. The raw
capture uses counts, retains failed-check labels, and shows a completed saved
capture rather than claiming it is live. Use
`http://127.0.0.1:8767/?source=raw_diagnostic`; the old `?view=bench` URL remains
compatible. No separate port-8768 service is needed.

## Earlier bench evidence (historical)

Electrode cable remained disconnected. The standalone SPI diagnostic uses
mode 1, MSB first, CS low across `20 00 00`, 50 microsecond command gaps, START
low, SDATAC and STOP. It never writes configuration registers or starts
acquisition. Raw diagnostic reads are not EEG or valid configuration metadata.

| SPI clock | First sweep: 16 ID reads |
| --- | --- |
| 125 kHz | sixteen `0x31` |
| 250 kHz | sixteen `0x31` |
| 500 kHz | sixteen `0x31` |
| 1 MHz | alternating `0x31` / `0x00` |

No read returned `0x73`. A second run reproduced these results. Both a short
50-microsecond reset-pin pulse and a software RESET followed by SDATAC/STOP
returned this untrusted register sequence (addresses 00–0B):

`31 00 00 00 00 00 00 00 00 00 00 04`

These are inconsistent with the documented reset map, including CONFIG1=02,
CONFIG2=80 and LOFF=10. This is broader than an isolated ID mismatch. The
readbacks cannot distinguish corrupted commands from corrupted return data.

The original application was restored and all 32256 application-region bytes
verified by avrdude. Its subsequent startup returned `ERROR,BEGIN,3` and
`DEVICE_ID,0x0` (rather than the earlier 0x31). This further confirms that
communication remains unresolved; it is not evidence that the ADC was repaired.
The capture is `results/after-spi-diagnostic-restore-20261017.txt`.

DRDY was high while conversions were stopped, which is not a failed DRDY test.
The nominal-bandgap estimate of Uno Vcc was 5209 mV; this is **not calibrated**
and does not measure the sensor VDD, its regulated rail or translator supplies.

Evidence files:

- `results/spi-link-diagnostic-20261017.txt`
- `results/spi-reset-diagnostic-20261017.txt`
- `results/flash-backups/uno-before-spi-diagnostic.hex` — checksum-validated
  original 32768-byte flash read, including bootloader.
- `results/flash-backups/uno-original-app.hex` — application-region restore,
  excluding the bootloader.

## Ranked explanations, not proven causes

### Later continuity and slow-GPIO checks

The user subsequently measured approximately 0.1 ohm on MISO and ground, near
zero on SCK-to-D13, MOSI-to-D11 and CS-to-D7, and 5.13 V from sensor VDD to GND.
These support low-resistance paths at the probed contacts and presence of input
power. They do not verify edge waveforms, all header contacts, the internal
3.3-V rail, or each remaining control wire. Raw reports are recorded in
`results/manual-continuity-20261017.json`; earlier cross-signal megaohm readings
were not measurements of the intended jumper pairs.

After reconnecting, normal firmware returned ID `0x71` with zero samples.
An independent GPIO-mode-1 diagnostic then disabled AVR hardware SPI and read
the ID at programmed half-periods of 500, 100 and 50 microseconds, taking an
early and late sample of each returned bit. GPIO overhead means these are not
calibrated clock frequencies. It made no configuration writes and never
started acquisition.

| Programmed half-period | Correct early IDs / 16 | Correct late IDs / 16 |
| --- | --- | --- |
| 500 microseconds | 0 | 0 |
| 100 microseconds | 0 | 3 |
| 50 microseconds | 0 | 0 |

The three late-only correct IDs support a marginal waveform/timing hypothesis;
they do not identify which line or component is responsible. Other register
reads remained unreliable. This does not establish working communication and
is not a basis for accepting a wrong ID or enabling electrode acquisition.
See `results/slow-spi-diagnostic-20261017.txt` and
`results/slow-spi-summary-20261017.json`. The original application is restored
after this diagnostic rather than leaving the temporary sketch installed.

The next controlled physical experiment is replacing only the MISO jumper
with a short known-good jumper, with USB power removed first. If that does not
help, measure the regulated rail/translator supplies or capture signal edges
with an experienced hardware helper. A pass on DC continuity does not rule out
connector or high-frequency signal problems.

1. Signal/contact/translator path: the higher-speed variation makes signal
   integrity worth checking. No particular wire is identified by these bytes.
2. Sensor supply or common-ground problem: an LED and nominal Uno voltage do
   not validate voltage at the ADC or translator.
3. Clock-selection/reset/command-delivery problem: software reset variants did
   not resolve it, but pin-level delivery has not been measured.
4. Different or damaged ADC: premature to conclude, especially given the
   earlier successful 0x73/internal-test recordings.

Simply lowering SPI speed was insufficient. Mac USB 2 versus USB 3 is not an
explanation for the ADC ID byte: the Uno performs SPI independently and its
serial diagnostic messages arrive correctly.

## Next discriminating physical checks

Keep the electrode cable disconnected. After restoring normal bench firmware,
cold-cycle USB power once; opening serial resets the Uno but does not cycle the
sensor power rail. Avoid repeatedly changing all nine connections blindly.

With USB disconnected, use a working meter to check end-to-end continuity and
unwanted shorts, especially MISO-to-D12 and common ground. An experienced mentor
can measure sensor VDD, regulated 3.3 V and both TXB0108 supply sides while
powered. The 5 V LOGIC_SEL selection is appropriate for a 5 V Uno; it does not
mean the bare ADC is powered at 5 V.

If still failing, capture CS, SCK, MOSI and MISO with a logic analyzer at the
sensor header. Expect `20 00 00`, CS held low across 24 clocks, mode 1, with
`01110011` on the final eight returned bits. Comparing ADC DOUT (translator A2)
with host MISO (B2) distinguishes sensor output from translator/cable/host
interpretation. Fine-pitch probing should be done by someone equipped for it.

## Primary sources

- [TI ADS1292R datasheet, SPI and register map](https://www.ti.com/lit/ds/symlink/ads1292r.pdf)
- [ProtoCentral v3 wiring guide](https://protocentral.com/product/ads1292r-ecg-respiration-breakout-kit/docs/getting-started-v3/)
- [Pinned v3 schematic](https://github.com/Protocentral/ADS1292rShield_Breakout/blob/78d4c71237888394fc233803c64684b348a3c30d/hardware/breakout/pc_ads1292r_brk_v3.sch)
- [Pinned official driver](https://github.com/Protocentral/protocentral-ads1292r-arduino/blob/9be1a97587509abda02e7da94e911794e8d37850/src/Protocentral_ADS1292R.cpp)
- [Arduino Uno R3 pinout](https://content.arduino.cc/assets/Pinout-UNOrev3_latest.pdf)
- [TI TXB0108 loading/layout requirements](https://www.ti.com/lit/ds/symlink/txb0108.pdf)
- [TI support: failed ADS1292R ID reads and waveform checks](https://e2e.ti.com/support/data-converters-group/data-converters/f/data-converters-forum/536288/issue-with-interfacing-to-ads1292r-id-read)

No source reviewed identifies `0x31` as a unique diagnosis of one faulty wire.
