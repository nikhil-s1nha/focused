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

## Board-side jack mapping and pending body-use path

The existing board-side jack mapping is now recorded from the manufacturer's **v3 Eagle schematic**, JP3 (`AUDIO-JACK`, `SMD2`):

| TRS contact | Official v3 board path | Meaning |
|---|---|---|
| Tip / JP3 LEFT | R20 (0 Ω) → ADS1292R IN2N | Channel 2 negative input |
| Ring / JP3 RIGHT | R22 (0 Ω) → ADS1292R IN2P | Channel 2 positive input |
| Sleeve | R24 (100 kΩ) → N$35 → R23 (0 Ω) → RLDOUT, with feedback network | Driven bias path; **not a ground lead** |

This is the published board design, not a measurement of the actual assembled PCB. `sources/legacy-jack-mapping.json` records the relevant manufacturer net/pin references and source-file SHA-256. The source link is below. We have **not** verified which colored snap lead reaches tip/ring/sleeve, assigned anatomical positions, or validated an EEG montage. Three electrodes do not provide three EEG channels.

**Optional host replacement:** a battery-only laptop may replace the Pi at A2 using the same Uno USB cable. **Choose exactly one USB host; never connect both at once.** The user plans this change but has not confirmed physically moving the connection. Leave the charger, docks, external displays and powered peripherals unplugged for that proposed battery acquisition arrangement. The actual power/peripheral path still needs review; this note does not establish medical isolation or approve body use.

**Leave electrodes disconnected during USB/mains bench tests.** Before a person wears them, review power isolation, all conductive peripheral connections, electrode identification and the acquisition configuration. A battery-powered Pi connected to a powered display or other USB peripherals does not establish isolation. A wireless uplink can keep mains-connected host equipment out of the acquisition island, but is not yet implemented.

This ADS1292R breakout is marketed for ECG/respiration. Forehead EEG signal quality is unvalidated; respiration excitation must not simply be enabled for an improvised forehead configuration. Use device ID and internal test-signal checks before considering human acquisition. No robot arm or heart-rate sensor is included in the current MVP.

## Validation and limitations

KiCad **10.0.6** loaded the file, exported native netlist, SVG and PDF, and reported **0 ERC violations**. `verify_netlist.py` checks the exported XML for all **16 exact two-node connections** (9 jumpers, 3 cable contacts, 4 USB conductors), 3 deliberate no-connects and 4 modules. All checks pass.

Symbols use passive pins because they describe connector endpoints rather than internal electronics. Consequently ERC alone does not validate supply isolation, protection circuitry, internal USB-to-Uno power routing, firmware, actual breadboard placement, electrode mapping, or EEG suitability. The exported netlist check detects wrong or accidentally shorted external schematic connections; it cannot inspect physical wiring.

Regenerate with `python3 generate_schematic.py`, export with `kicad-cli sch export netlist --format kicadxml -o exports/adaptive-horror.xml adaptive-horror.kicad_sch`, and run `python3 verify_netlist.py`. Re-export PDF/SVG and rerun ERC after schematic changes. Do not run the generator over unsaved manual edits.

## Revision B and primary references

Revision A source/export snapshots are preserved in `revisions/rev-A/`. Revision B adds the source-backed board-side jack mapping and optional laptop replacement note; the nine Uno wires and USB netlist are unchanged.


- [ProtoCentral legacy guide](https://protocentral.com/product/ads1292r-ecg-respiration-breakout-kit/docs/getting-started-v3/)
- [ProtoCentral official hardware repository](https://github.com/Protocentral/ADS1292rShield_Breakout)
- [Legacy Eagle schematic source](https://github.com/Protocentral/ADS1292rShield_Breakout/blob/78d4c71237888394fc233803c64684b348a3c30d/hardware/breakout/pc_ads1292r_brk_v3.sch)
- [Legacy breakout schematic](https://github.com/Protocentral/ADS1292rShield_Breakout/blob/78d4c71237888394fc233803c64684b348a3c30d/hardware/breakout/pc_ads1292r_brk_v3.pdf)
- [Official Arduino library](https://github.com/Protocentral/protocentral-ads1292r-arduino)

The local KiCad 10.0.6 disk image was mounted read-only to run its editor and CLI; the application was not copied over an existing install. Opening the project later requires KiCad installed or the image mounted again.
