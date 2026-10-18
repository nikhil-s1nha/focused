# Uno and ADS1292R bench diagnostic

Verified October 17, 2026 on the user's Uno R3 and ProtoCentral legacy breakout,
using SSH to the Pi. The electrode cable stays disconnected from the board.
This firmware only samples the internal test generator. It does not sample EEG.

## Result

- ADS1292R device ID: `0x73`.
- Repeat capture: 1,251 samples over a 10-second reader window.
- Median sample rate: 125.13 Hz; no sequence gaps.
- Internal test peak-to-peak: CH1 7,039 counts; CH2 7,032 counts.
- Compile: 4,618 bytes flash and 233 bytes SRAM on Uno.
- `results/internal-test.txt` contains the clean repeat result.

These checks verify device communication, conversion, and USB serial transport.
They do not verify the electrode cable, contact, body safety, EEG signal quality,
calibration, or an emotion/intensity algorithm.

## Wiring

| Sensor | Uno R3 |
|---|---|
| VDD | 5V |
| GND | GND |
| SCK | D13 |
| MISO | D12 |
| MOSI | D11 |
| CS | D7 |
| DRDY | D6 |
| START | D5 |
| RESET | D4 |

No Pi GPIO wires. CLK/GPIO1/GPIO2 on the sensor remain unconnected.
This board's host logic selector was measured in its 5 V position, matching Uno.

## Electrode jack: board-side mapping only

Traced from the manufacturer's legacy v3 Eagle schematic, commit
`78d4c71237888394fc233803c64684b348a3c30d`:

| 3.5 mm contact | Board path |
|---|---|
| Tip (JP3 LEFT) | R20, 0 ohms, to ADS1292R IN2N |
| Ring (JP3 RIGHT) | R22, 0 ohms, to ADS1292R IN2P |
| Sleeve | R24, 100 kilohms, into RLD feedback/output network; R23, 0 ohms, to RLDOUT |

The sleeve is **not plain circuit ground**. RLD means right-leg drive; it is a
common-mode/bias circuit, not a third independent EEG channel. This source trace
does not establish which snap-lead color reaches each plug contact. The actual
cable still needs identification before an anatomical placement is selected.
No firmware has been changed to enable external input, RLD or excitation.
Do not use the generic respiration-enabled example for a forehead experiment.

Primary source:
[ProtoCentral v3 schematic](https://github.com/Protocentral/ADS1292rShield_Breakout/blob/78d4c71237888394fc233803c64684b348a3c30d/hardware/breakout/pc_ads1292r_brk_v3.sch).
`results/board-input-map.json` retains source hash and the relevant net records.

## Tools and exact library

- Official Arduino CLI 1.5.1, downloaded from Arduino's GitHub release and checked
  against the release's SHA-256 list.
- Arduino AVR core 1.8.8.
- [ProtoCentral ADS1292R library](https://github.com/Protocentral/protocentral-ads1292r-arduino),
  version 2.0.0, commit `9be1a97587509abda02e7da94e911794e8d37850`.
- Firmware sets both channels to internal square-wave input, gain 1, 125 SPS.
  Respiration modulation, lead-off excitation, and right-leg drive are disabled.

## Pi paths and commands

Working directory: `/root/adaptive-horror`.
CLI: `/root/adaptive-horror/tools/arduino-cli`.
Library: `/root/adaptive-horror/libraries/ProtoCentral_ADS1292R`.
Firmware: `/root/adaptive-horror/firmware/SensorBenchTest`.
Original Uno flash backup: `/root/adaptive-horror/backups/uno-before-bench.hex`.
Serial device observed: `/dev/ttyACM0` (Uno also has a stable by-id symlink).

```sh
cd /root/adaptive-horror
tools/arduino-cli compile --fqbn arduino:avr:uno \
  --libraries libraries --output-dir firmware/build \
  --config-file arduino-cli.yaml firmware/SensorBenchTest
tools/arduino-cli upload --fqbn arduino:avr:uno --port /dev/ttyACM0 \
  --input-dir firmware/build --config-file arduino-cli.yaml firmware/SensorBenchTest
python3 firmware/read_bench_test.py --seconds 10
```

Opening or uploading to an Uno may reset it. Run only one serial reader at a
time. The Python reader uses the standard library and filters startup noise;
it does not require pyserial. A result with `stream_received: true` proves a
stream arrived, not that every possible hardware fault is excluded.

Do not attach electrodes to a person in the current mains-connected bench setup.
Review electrical isolation and intended sensor configuration before human use.
