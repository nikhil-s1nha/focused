// Electronic bench diagnostic ONLY. Electrode cable must be disconnected.
// No START command, no sample acquisition, no respiration/lead-off configuration.
// Tests documented SPI mode 1 at lower clocks; raw reads are not EEG samples.
#include <SPI.h>

const uint8_t CS_PIN = 7;
const uint8_t DRDY_PIN = 6;
const uint8_t START_PIN = 5;
const uint8_t RESET_PIN = 4;
const uint32_t CLOCKS[] = {125000UL, 250000UL, 500000UL, 1000000UL};

void printHex(uint8_t value) {
  Serial.print(F("0x"));
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

void command(uint8_t value, uint32_t hz) {
  SPI.beginTransaction(SPISettings(hz, MSBFIRST, SPI_MODE1));
  digitalWrite(CS_PIN, LOW);
  delayMicroseconds(50);
  SPI.transfer(value);
  delayMicroseconds(50);
  digitalWrite(CS_PIN, HIGH);
  SPI.endTransaction();
  delayMicroseconds(50);
}

uint8_t readRegister(uint8_t address, uint32_t hz) {
  SPI.beginTransaction(SPISettings(hz, MSBFIRST, SPI_MODE1));
  digitalWrite(CS_PIN, LOW);
  delayMicroseconds(50);
  SPI.transfer(0x20 | address);  // RREG
  delayMicroseconds(50);
  SPI.transfer(0x00);            // One register
  delayMicroseconds(50);
  const uint8_t value = SPI.transfer(0x00);
  delayMicroseconds(50);
  digitalWrite(CS_PIN, HIGH);
  SPI.endTransaction();
  delayMicroseconds(50);
  return value;
}

void resetStopped(uint32_t hz) {
  digitalWrite(START_PIN, LOW);
  digitalWrite(CS_PIN, HIGH);
  digitalWrite(RESET_PIN, LOW);
  delay(10);
  digitalWrite(RESET_PIN, HIGH);
  delay(500);
  command(0x11, hz);  // SDATAC: leave power-on continuous-read mode
  command(0x0A, hz);  // STOP
  delay(20);
}

long nominalUnoVccMv() {
  // Uno ATmega328P only. Uses nominal 1.1V bandgap: approximate, not calibrated.
  const uint8_t oldAdmux = ADMUX;
  ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);
  delay(3);
  ADCSRA |= _BV(ADSC);
  while (bit_is_set(ADCSRA, ADSC)) {}
  const uint16_t measured = ADC;
  ADMUX = oldAdmux;
  return measured ? 1125300L / measured : 0;
}

void setup() {
  Serial.begin(115200);
  digitalWrite(CS_PIN, HIGH);
  digitalWrite(START_PIN, LOW);
  digitalWrite(RESET_PIN, LOW);
  pinMode(CS_PIN, OUTPUT);
  pinMode(START_PIN, OUTPUT);
  pinMode(RESET_PIN, OUTPUT);
  pinMode(DRDY_PIN, INPUT);
  SPI.begin();
  delay(1800);
  Serial.println(F("DIAG_ONLY,ELECTRODES_DISCONNECTED,NO_PHYSIOLOGICAL_SAMPLES"));
  Serial.println(F("DIAG,UNO_R3,CS7,DRDY6,START5,RESET4,MISO12,MOSI11,SCK13"));
  Serial.print(F("DIAG,UNO_VCC_NOMINAL_ESTIMATE_MV,"));
  Serial.println(nominalUnoVccMv());
  Serial.println(F("DIAG,VCC_ESTIMATE_IS_NOT_SENSOR_VDD_OR_CALIBRATED_MULTIMETER"));
  bool anyValid = false;
  for (uint8_t index = 0; index < sizeof(CLOCKS) / sizeof(CLOCKS[0]); ++index) {
    const uint32_t hz = CLOCKS[index];
    resetStopped(hz);
    Serial.print(F("ID_SWEEP,"));
    Serial.print(hz);
    Serial.print(F(",MODE1"));
    uint8_t valid = 0;
    for (uint8_t attempt = 0; attempt < 16; ++attempt) {
      const uint8_t id = readRegister(0x00, hz);
      Serial.print(',');
      printHex(id);
      if (id == 0x73) ++valid;
      delay(5);
    }
    Serial.println();
    Serial.print(F("ID_RESULT,"));
    Serial.print(hz);
    Serial.print(F(",VALID_0x73,"));
    Serial.print(valid);
    Serial.println(F(",TOTAL,16"));
    if (valid == 16) {
      anyValid = true;
      for (uint8_t address = 0; address <= 0x0B; ++address) {
        Serial.print(F("READBACK,"));
        Serial.print(hz);
        Serial.print(',');
        printHex(address);
        Serial.print(',');
        printHex(readRegister(address, hz));
        Serial.println();
      }
    }
    Serial.print(F("DRDY_IDLE_LEVEL,"));
    Serial.print(hz);
    Serial.print(',');
    Serial.println(digitalRead(DRDY_PIN));
  }
  Serial.print(F("DIAG_RESULT,"));
  Serial.println(anyValid ? F("CONSISTENT_VALID_ID_AT_ONE_OR_MORE_CLOCKS") :
                            F("NO_CONSISTENT_VALID_ID"));
  // Read-only additional diagnostics. Invalid-ID bytes remain untrusted;
  // no register values are written or accepted as acquisition metadata.
  for (uint8_t strategy = 0; strategy < 2; ++strategy) {
    digitalWrite(RESET_PIN, HIGH);
    delay(1000);
    if (strategy == 0) {
      digitalWrite(RESET_PIN, LOW);
      delayMicroseconds(50);  // Reset pulse, shorter than power-down threshold.
      digitalWrite(RESET_PIN, HIGH);
    } else {
      command(0x06, 125000UL);  // RESET opcode, no external input enabling.
    }
    delay(1000);
    command(0x11, 125000UL);
    command(0x0A, 125000UL);
    Serial.print(F("UNTRUSTED_RESET_READBACK,"));
    Serial.print(strategy == 0 ? F("PIN_50US") : F("OPCODE_06"));
    for (uint8_t address = 0; address <= 0x0B; ++address) {
      Serial.print(',');
      printHex(readRegister(address, 125000UL));
    }
    Serial.println();
  }
  digitalWrite(START_PIN, LOW);
  digitalWrite(RESET_PIN, LOW);
  Serial.println(F("DIAG_COMPLETE,RESET_HELD_LOW,RESTORE_BENCH_FIRMWARE_BEFORE_SAMPLING"));
}

void loop() {
  // Stop here. This sketch intentionally never starts conversion streaming.
  delay(1000);
}
