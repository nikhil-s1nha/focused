# Host hardware-SPI loopback — prepared offline only

This is a temporary **Uno-only** diagnostic. It exercises `SPI.transfer` and the AVR SPI peripheral at **mode 1, MSB first, 125 kHz**, beyond the earlier GPIO-only input test. It acquires no ADC or physiological data and never communicates with the ProtoCentral board.

## Required physical setup before any later run

1. Remove USB power. **Disconnect every sensor-board wire from the Uno**, including power and ground, and disconnect all electrode cables. No person or sensor may be connected during this test.
2. Remove previous test jumpers. Connect **one short jumper from Uno D11/MOSI to Uno D12/MISO**.
3. Leave every other header pin unconnected. The Uno should have only USB and that one jumper.

SPI necessarily drives **D11/MOSI** and **D13/SCK**. The standard Arduino AVR `SPI.begin()` also makes **D10/SS high/output** so the peripheral remains master. D10 and D13 must remain unconnected; only D11 connects to D12. No ADC-control pins, including D4–D7, are configured or driven by this sketch. USB serial still operates normally. All four SPI pins return to inputs with pull-ups off at completion.

The program cannot sense whether the sensor is physically disconnected. The operator must confirm that setup first. It prints instructions at 115200 baud and waits for an uppercase **`R`** over serial before enabling SPI. Each reset permits one run; it does not repeat continuously.

## Offline compile

```sh
tools/arduino/bin/arduino-cli compile --fqbn arduino:avr:uno \
  --config-file tools/arduino/arduino-cli.yaml \
  --output-dir tools/arduino/build/hardware-spi-loopback \
  firmware/HardwareSpiLoopback
```

Compilation does not upload, open serial, or change connected hardware. This artifact was prepared for possible later use; no upload or run is part of its preparation.

## Output and interpretation

The test sends `00 FF AA 55 73 31 80 01` in that order, repeated 512 times: **4,096 transferred bytes / 32,768 bit comparisons**. Received bytes must equal sent bytes exactly. There is no serial printing during the transfer loop. Output includes actual AVR SPI register settings, match/error totals for each pattern, up to 16 mismatch examples, elapsed microseconds and a final summary.

- Expected pass: `LOOPBACK_SUMMARY,BYTES,4096,BYTE_ERRORS,0,BIT_ERRORS,0,...` followed by `PASS_HOST_SPI_LOCAL_LOOPBACK_ONLY`.
- A pass establishes that this Uno SPI peripheral and short local jumper can receive the known local output at this setting. It does **not** validate ADC command delivery, the sensor's level translator, external wiring, MISO drive quality, identity, configuration, or any recorded sensor values.
- A failure identifies a host-SPI/loopback-path problem, but alone does not name a damaged MCU; wrong pins, contact, jumper, or peripheral setup remain possible causes.

After any later run, remove USB power and the D11–D12 loopback before restoring the normal sensor connections and verified bench firmware. Never reconnect the sensor while the diagnostic jumper is installed.

Local implementation reference: installed Arduino AVR core `libraries/SPI/src/SPI.cpp` configures SS, SCK and MOSI in `SPI.begin()`; `SPI.transfer` clocks one byte through SPDR. This sketch uses that installed implementation without extra libraries.
