# Internal shorted-input bench noise diagnostic

**Electrode cable unplugged from the ProtoCentral board throughout this test.**
This is a separate diagnostic sketch, not a body-connected acquisition program.
It is prepared for the existing Uno R3 / ADS1292R wiring and the official
ProtoCentral library 2.0.0, source commit
`9be1a97587509abda02e7da94e911794e8d37850`. Creating this file does not upload it.

## Purpose and configuration

The square-wave sketch tests acquisition and transport using a generated signal.
`SensorNoiseTest/SensorNoiseTest.ino` instead selects the ADS1292R's **internal
input-short multiplexer on both channels**, with both PGAs powered at gain 6,
125 samples/second per channel, and the nominal 2.42 V internal reference.
The test generator, respiration modulation/demodulation, lead-off excitation and
comparators, right-leg drive, and external clock output are disabled. No physical
shorting wire or electrode is required. `CH1`/`CH2` are electronic channels here;
the library field names `resp`/`ecg` do not indicate measured physiology.

The Uno remains connected to the Pi by USB. Existing sensor connections stay:

| Sensor | Uno R3 |
|---|---|
| VDD / GND | 5V / GND |
| SCK / MISO / MOSI | D13 / D12 / D11 |
| CS / DRDY / START / RESET | D7 / D6 / D5 / D4 |

## Run and restore

1. Ensure no other process is using the Uno serial port. Keep electrodes unplugged.
2. Compile for `arduino:avr:uno`, using the same pinned ProtoCentral library and
   toolchain as the already-working square-wave diagnostic. Upload this sketch
   only after the main operator has released the serial port.
3. Read serial at **115200 baud**, allowing the Uno to reset and print its header.
   Capture at least 30 seconds, preferably 60 seconds, of raw serial output.
4. Check `DEVICE_ID,0x73`, no `ERROR` lines, and these read-back values:

   | Register | Expected |
   |---|---|
   | CONFIG1 / CONFIG2 | `0x00` / `0xA0` |
   | CH1SET / CH2SET | `0x01` / `0x01` |
   | RLD_SENS / LOFF_SENS | `0x00` / `0x00` |
   | RESP1 / RESP2 | `0x02` / `0x03` |

   The sketch stops if a checked configuration register does not match.
5. Analyze only five-column rows whose first field is `SHORTED_INPUT`:

   ```text
   source,sequence,micros,ch1_counts,ch2_counts
   SHORTED_INPUT,0,1234567,-10,14
   ```

   Ignore all other metadata/header lines and discard the first **125 sample
   rows** for settling. The example values are illustrative, not measured data.
6. Close the serial reader, restore `SensorBenchTest/SensorBenchTest.ino`, and
   verify its `INTERNAL_TEST` source and expected square waveform again.

## Convert counts and estimate noise

ADC samples are sign-extended 24-bit two's-complement values. With the **configured
nominal** reference and gain, input-referred conversion is:

```text
uV_per_count = (2.42 * 1_000_000) / (6 * 2^23)
             = 0.0480810801188 uV/count
input_uV    = signed_counts * uV_per_count
```

This matches the official library's `countsToMicrovolts()` implementation:
`(2 * VREF * 1e6) / (gain * 2^24)`. The actual reference has tolerance; this is
not a precision calibration. Do not reuse this scale after changing gain or
reference. A small count size is resolution, not a claim about achievable noise.

For each channel, calculate the following from the retained unfiltered samples:

- Mean counts and mean microvolts: offset, not random-noise RMS.
- **RMS noise = sqrt(mean((x - mean(x))^2))**, then multiply by the scale.
- Peak-to-peak = `(max(x) - min(x)) * scale`, reporting capture duration because
  peak-to-peak depends on observation time and outliers.
- Number of rail values (`-8388608` or `8388607`), repeated/flat data runs, and
  timing gaps. A constant zero stream is not evidence of excellent noise until
  the square-wave test and configuration checks demonstrate a responding ADC.

Do not report RMS of the uncentered samples as noise: that mixes offset and
fluctuation. Preserve raw capture even if subsequently analyzing a filtered band;
report filter and bandwidth alongside any filtered RMS. There is **no measured
noise-floor result yet** until this sketch is actually run and analyzed.

`micros` marks when the Uno read a frame, not the physical ADC conversion instant.
Consecutive timestamps should be near 8000 us; calculate unsigned 32-bit deltas
to handle the approximately 71.6-minute wrap. The application sequence counts
successfully read frames, not hardware ADC conversions, so consecutive sequence
numbers alone cannot prove no samples were lost. Check elapsed time and sample
count as well. Polling on D6 does not enable the library's interrupt loss counter.

## What a result means

A stable, small, plausible shorted-input noise floor supports the performance of
the internal shorted-input/PGA/ADC path **in this powered setup**, alongside the
existing data link. Power/reference/digital coupling may still appear. It does
not measure the complete external electrode-input path: the internal mux bypasses
the electrodes, leads, skin interface, and much of the breakout's input network.
Do not call it an electrode noise floor or subtract it numerically from arbitrary
future forehead recordings.

This test cannot establish EEG sensitivity on the body, electrode contact,
electrical isolation, neural origin, fear, arousal, or emotion classification.
Noisy results warrant checking supply/reference, board layout, wiring and SPI
integrity; clean results do not remove the need for external-input validation.

At 125 SPS, the Nyquist frequency is 62.5 Hz. The converter's digital filtering
and effective bandwidth matter when comparing measured noise with a datasheet
table; use matching gain, rate, reference/supply, bandwidth, and RMS versus
peak-to-peak definitions. Do not compare this result directly to a headline
noise specification taken under different conditions.

## Sources

- [TI ADS1292R datasheet](https://www.ti.com/lit/gpn/ADS1292R): channel input mux,
  input-short noise measurement, PGA gain, reference, data format, noise tables,
  and filter/data-rate characteristics.
- [Pinned official ProtoCentral driver](https://github.com/Protocentral/protocentral-ads1292r-arduino/tree/9be1a97587509abda02e7da94e911794e8d37850/src):
  `ADS1292R_Mux::Shorted`, configuration enums, register handling, sign extension,
  and `countsToMicrovolts()`.
- [Official ProtoCentral guide](https://protocentral.com/product/ads1292r-ecg-respiration-breakout-kit/docs/getting-started-v3/):
  older breakout host wiring. This diagnostic uses the already-verified bench wiring.
