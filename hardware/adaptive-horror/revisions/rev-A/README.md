# Adaptive horror — bench wiring reference

This native KiCad schematic records the hardware currently on the table: a legacy ProtoCentral ADS1292R breakout, Arduino Uno R3, and Orange Pi 5 Pro. It is a module-level wiring reference, not a new custom PCB or a reproduction of either board's internals.

Open `adaptive-horror.kicad_sch` in KiCad 9 or later, or use `exports/adaptive-horror.pdf`. The editable functional symbols are embedded and also included in `AdaptiveHorror.kicad_sym`. No external symbol-library download is required.

## Confirmed bench connections

Disconnect all power while wiring. There are **nine jumpers** from the sensor to the Uno; no sensor wires go to the Pi GPIO header.

| ProtoCentral silkscreen | Uno R3 |
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

Leave CLK, GPIO1 and GPIO2 unconnected. Use the **USB-B port on the Uno → USB-A host port on the Pi** for data and bench power. Do not simultaneously add barrel-jack/VIN power in this reference configuration. Firmware must use the control pins above; Uno D10 should stay configured as an output so hardware SPI stays in master mode.

The user reported approximately zero ohms from the LOGIC_SEL center contact to +5V and approximately 1.32 MΩ from center to +3.3V. This establishes the existing 5V logic selection for the Uno path; the resistor has not been moved. Direct connection to a 3.3V Pi GPIO is excluded.

## Electrodes and unimplemented body-use path

The left-hand cable block shows only **tip/ring/sleeve contact continuity** into the board's existing 3.5mm jack. It does not assign electrode colors, anatomical positions, RA/LA/RL identity, or an EEG montage. Those remain unverified for the actual cable. The three electrodes are not three EEG channels.

**Leave electrodes disconnected during USB/mains bench tests.** Before a person wears the electrodes, the acquisition system needs a reviewed isolation arrangement, such as a battery acquisition island with a wireless uplink and no conductive connection to mains-powered USB/HDMI equipment. That arrangement is not implemented by this schematic. A battery-powered Pi connected to a powered display or other USB peripherals does not establish isolation.

This ADS1292R breakout is marketed for ECG/respiration. Forehead EEG signal quality is unvalidated; respiration excitation must not simply be enabled for an improvised forehead configuration. Use device ID and internal test-signal checks before considering human acquisition. No robot arm or heart-rate sensor is included in the current MVP.

## Validation and limitations

KiCad **10.0.6** loaded the file, exported native netlist, SVG and PDF, and reported **0 ERC violations**. `verify_netlist.py` checks the exported XML for all **16 exact two-node connections** (9 jumpers, 3 cable contacts, 4 USB conductors), 3 deliberate no-connects and 4 modules. All checks pass.

Symbols use passive pins because they describe connector endpoints rather than internal electronics. Consequently ERC alone does not validate supply isolation, protection circuitry, internal USB-to-Uno power routing, firmware, actual breadboard placement, electrode mapping, or EEG suitability. The exported netlist check detects wrong or accidentally shorted external schematic connections; it cannot inspect physical wiring.

Regenerate with `python3 generate_schematic.py`, export with `kicad-cli sch export netlist --format kicadxml -o exports/adaptive-horror.xml adaptive-horror.kicad_sch`, and run `python3 verify_netlist.py`. Re-export PDF/SVG and rerun ERC after schematic changes. Do not run the generator over unsaved manual edits.

## Primary references

- [ProtoCentral legacy guide](https://protocentral.com/product/ads1292r-ecg-respiration-breakout-kit/docs/getting-started-v3/)
- [ProtoCentral official hardware repository](https://github.com/Protocentral/ADS1292rShield_Breakout)
- [Legacy breakout schematic](https://github.com/Protocentral/ADS1292rShield_Breakout/blob/master/hardware/breakout/pc_ads1292r_brk_v3.pdf)
- [Official Arduino library](https://github.com/Protocentral/protocentral-ads1292r-arduino)

The local KiCad 10.0.6 disk image was mounted read-only to run its editor and CLI; the application was not copied over an existing install. Opening the project later requires KiCad installed or the image mounted again.
