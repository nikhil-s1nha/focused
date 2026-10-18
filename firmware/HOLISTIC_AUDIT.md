# Independent hardware, firmware and signal audit

2026-10-17. Electronic bench only; electrode cable disconnected. Three
independent audits covered board/wiring, executable/history, and interface
timing/input behavior. No current test establishes human EEG acquisition.

## Findings that remain passed

| Check | Evidence | Boundary |
| --- | --- | --- |
| ELEGOO Uno R3 compatibility | Vendor specifies ATmega328P; official Uno pin definitions apply | Branding does not require different SPI pins |
| Intended wiring plan | Matches official legacy ProtoCentral v3 schematic and visible photos | Hidden/header/MCU contacts are not all independently established |
| Incoming sensor power | User measured 5.13 V at VDD | Does not establish noise/transient performance |
| Regulated supply | User measured 3.3 V at selector's 3.3 V pad | Correct DC voltage at that pad |
| Translator host supply | User confirmed about 5 V at LOGIC_SEL center | Correct nominal selection for Uno |
| Idle controls at sensor header | RESET and CS about 5 V; START about 0 V | Static header readings, not translated chip-side waveforms |
| Reported jumper continuity | MISO/ground about 0.1 ohm; SCK/MOSI/CS near zero | Preserve results; no reason to repeat all measurements |
| Uno upload and USB serial | Flash writes verify; readable diagnostic output | Not proof of ADC communication |
| Original executable | Clean compile matches all 4618 executable bytes in saved original flash | Firmware change is not supported as cause |
| Prior internal bench acquisition | Shorted-input log: ID73, register readbacks, 3474 samples after 125 discarded, 125.13 Hz | Bench acquisition, not body-connected EEG |

The archived viewer recording of 3369 samples is explicitly synthetic. Its
waveform should not be confused with the earlier physical bench results.

## Correct standard connection

| ProtoCentral v3 label | Uno R3 |
| --- | --- |
| VDD | 5V |
| GND | GND |
| PWDN/RESET | D4 |
| START | D5 |
| DRDY | D6 |
| CS | D7 |
| MOSI | D11 |
| MISO | D12 |
| SCK | D13 |
| CLK, GPIO1, GPIO2 | Unconnected |

The board's CLK pin is not the SPI SCK pin. The sensor photo shows the header
in reverse physical order relative to schematic numbering; the printed labels
remain the correct reference. No definite swap was found in the photos.

## What fails now

Normal initialization returns invalid IDs31,00 or71 rather than73, with zero
sample frames. It stops before applying the requested bench configuration.
Replacing the MISO jumper did not resolve this. Slowing hardware SPI alone
also did not resolve it. Manual GPIO reads yielded only 3 valid late-sampled
IDs out of 48 attempts; no consistently valid register map was established.

In a stopped register-bit hold test, sensor-header MISO measured steady 5 V on
the user's DC meter, but UnoD12 usually sampled high only about 35–55 times
per 200 observations. It also became 200/200 for an interval, so the same input
can read high consistently under some conditions. Repeating the command
returned to inconsistent behavior. A DC meter cannot exclude fast glitches;
these sample counts must not be interpreted as a calibrated waveform duty cycle.

The runtime audit confirms SPCR=00 (hardware SPI disabled), DDRB=28
(PB4/D12 input), PORTB=20 (PB4 pull-up off), and pin12 maps to bitmask10.
Reading raw PINB bit4 also shows the instability; PB5/the held clock reads
high 200/200. No Arduino digitalRead mapping/latch bug was found. Sequential
raw and API reads can differ because they observe the input at different times.
Evidence: results/miso-hold-20261017-222422.txt.

## Why it used to work

The saved physical bench log supports genuine earlier communication, and the
normal executable is unchanged. We have not proven what changed. Physical
handling, contact behavior and power/ground noise could change despite correct
DC readings. The Mac or Pi does not generate sensor SPI directly; the Uno
executes the same code. Moving hosts does not by itself identify the cause.

The remaining candidates are an intermittent contact/Uno receiving path,
unstable translated signal, or incorrect command delivery. The evidence does
not justify naming one damaged part yet. General clock-edge delay is unlikely
to be the entire explanation because instability persists while SCK is held.

One secondary software issue was found: serial readers do not always force a
fresh Uno reset, so a startup header can be missed. The manual hold controller
now deliberately pulses DTR. This cannot explain the unstable raw MCU input.

## Next controlled experiment, no voltage rechecks

The compiled UnoInputSelfTest isolates the receiving input from the sensor.
With USB removed and electrodes disconnected, detach sensor MISO from UnoD12,
leave its loose end insulated/clear, then place one spare jumper ONLY between
UnoD8 and UnoD12. All other connections remain unchanged. Reconnect USB; the
diagnostic is uploaded only after this wiring is confirmed.

It drives known low/high levels from D8, checks D12 using both raw and Arduino
reads, and sends 1024-bit known patterns at two settling intervals. It sends no
ADC commands and keeps the sensor deselected. This temporary loopback is not
the final sensor wiring. Do not connect the driven test wire to sensor MISO or
to a power rail.

- If it passes, the Uno input can receive a known source. Investigate the
  connected sensor/translator path or compare sensor MISO on an alternate GPIO.
- If it fails, inspect the local jumper/header/Uno input before blaming the ADC.
- A scope or logic analyzer remains the method to distinguish short glitches,
  level-translation trouble and command delivery at the actual pins.

Restore both the original wiring and original bench firmware before sensor
sampling. Move Uno USB to the Orange Pi only after stable identification and
the internal test stream are re-established. No Pi GPIO wiring is needed.

## Primary references

### Isolated input self-test result

The user confirmed the loopback arrangement and the compiled diagnostic was
uploaded and flash-verified. All four low and four high phases passed, totaling
8000 held-level samples checked by both Arduino and raw input reads. Both
1024-bit pattern tests passed with zero errors (100-us and 2-us settling).
The final result was PASS_STATIC_AND_PATTERNS. Raw evidence:
`results/uno-input-selftest-20261017.txt`.

This establishes that D12 can read a strong known Uno signal, including changing
patterns. It does not exclude faults or abnormal loading that appear only with
the sensor's level-translated output. The next comparison routes sensor MISO
to D8 under the separately compiled GPIO-mode-1 diagnostic. The loopback must
first be removed and original firmware restored, so D8 is not driven when the
sensor is attached. This is temporary test wiring, not standard hardware SPI.

- [ELEGOO Uno R3 product](https://us.elegoo.com/products/elegoo-uno-r3-board)
- [Official Uno AVR pin definitions](https://github.com/arduino/ArduinoCore-avr/blob/master/variants/standard/pins_arduino.h)
- [Official Arduino digital input implementation](https://github.com/arduino/ArduinoCore-avr/blob/master/cores/arduino/wiring_digital.c)
- [Pinned ProtoCentral v3 schematic](https://github.com/Protocentral/ADS1292rShield_Breakout/blob/78d4c71237888394fc233803c64684b348a3c30d/hardware/breakout/pc_ads1292r_brk_v3.sch)
- [Pinned ProtoCentral driver](https://github.com/Protocentral/protocentral-ads1292r-arduino/blob/9be1a97587509abda02e7da94e911794e8d37850/src/Protocentral_ADS1292R.cpp)
- [TI ADS1292R datasheet](https://www.ti.com/lit/ds/symlink/ads1292r.pdf)
- [TI TXB0108 datasheet](https://www.ti.com/lit/ds/symlink/txb0108.pdf)
