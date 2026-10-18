// OFFLINE-PREPARED HOST TEST ONLY. Sensor and all electrodes MUST be disconnected.
// Uno wiring: USB plus ONE short D11/MOSI -> D12/MISO jumper, nothing else.
// Waits for explicit serial 'R' before enabling SPI. Never issues ADC commands.
// SPI necessarily drives D11/MOSI, D13/SCK and D10/SS; leave D10/D13 unconnected.
#include <Arduino.h>
#include <SPI.h>

const uint32_t CLOCK_HZ = 125000UL;
const uint16_t REPEATS = 512;
const uint8_t PATTERNS[] = {0x00, 0xFF, 0xAA, 0x55, 0x73, 0x31, 0x80, 0x01};
const uint8_t PATTERN_COUNT = sizeof(PATTERNS) / sizeof(PATTERNS[0]);
const uint8_t MAX_ERROR_DETAILS = 16;
bool hasRun = false;

struct ErrorDetail {
  uint16_t index;
  uint8_t sent;
  uint8_t received;
};

void printHex(uint8_t value) {
  Serial.print(F("0x"));
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

uint8_t countBits(uint8_t value) {
  uint8_t count = 0;
  while (value) {
    count += value & 1;
    value >>= 1;
  }
  return count;
}

void releaseSpiPins() {
  SPI.end();
  const uint8_t pins[] = {MOSI, MISO, SCK, SS};
  for (uint8_t i = 0; i < sizeof(pins); ++i) {
    pinMode(pins[i], INPUT);
    digitalWrite(pins[i], LOW);  // Disable pull-ups; no output drive remains.
  }
}

void runLoopback() {
  uint16_t matches[PATTERN_COUNT] = {0};
  uint16_t errors[PATTERN_COUNT] = {0};
  uint16_t bitErrors[PATTERN_COUNT] = {0};
  ErrorDetail details[MAX_ERROR_DETAILS];
  uint8_t detailCount = 0;
  uint16_t total = 0, totalErrors = 0;
  uint32_t totalBitErrors = 0;

  Serial.println(F("LOOPBACK_BEGIN,HOST_ONLY,NO_SENSOR_NO_ELECTRODES"));
  Serial.println(F("WIRING,ONLY_D11_TO_D12,D10_D13_UNCONNECTED"));
  Serial.print(F("SETTINGS,SPI_MODE,1,MSB_FIRST,1,REQUESTED_SPI_HZ,"));
  Serial.print(CLOCK_HZ);
  Serial.print(F(",F_CPU,")); Serial.println(F_CPU);

  // Only SPI pins are configured. No sensor-control GPIO is driven.
  pinMode(MISO, INPUT);
  digitalWrite(MISO, LOW);
  SPI.begin();
  SPI.beginTransaction(SPISettings(CLOCK_HZ, MSBFIRST, SPI_MODE1));
  Serial.print(F("SPI_REGISTERS,SPCR,")); printHex(SPCR);
  Serial.print(F(",SPSR,")); printHex(SPSR);
  Serial.print(F(",DDRB,")); printHex(DDRB);
  Serial.println();

  const uint32_t started = micros();
  // No serial output between transfers: test the actual SPI peripheral path.
  for (uint16_t repeat = 0; repeat < REPEATS; ++repeat) {
    for (uint8_t pattern = 0; pattern < PATTERN_COUNT; ++pattern) {
      const uint8_t sent = PATTERNS[pattern];
      const uint8_t received = SPI.transfer(sent);
      const uint8_t differing = countBits(sent ^ received);
      if (sent == received) {
        ++matches[pattern];
      } else {
        ++errors[pattern];
        ++totalErrors;
        if (detailCount < MAX_ERROR_DETAILS) {
          details[detailCount++] = {total, sent, received};
        }
      }
      bitErrors[pattern] += differing;
      totalBitErrors += differing;
      ++total;
    }
  }
  const uint32_t elapsed = micros() - started;
  SPI.endTransaction();
  releaseSpiPins();

  for (uint8_t i = 0; i < PATTERN_COUNT; ++i) {
    Serial.print(F("LOOPBACK_PATTERN,TX,")); printHex(PATTERNS[i]);
    Serial.print(F(",TESTED,")); Serial.print(REPEATS);
    Serial.print(F(",MATCHES,")); Serial.print(matches[i]);
    Serial.print(F(",BYTE_ERRORS,")); Serial.print(errors[i]);
    Serial.print(F(",BIT_ERRORS,")); Serial.println(bitErrors[i]);
  }
  for (uint8_t i = 0; i < detailCount; ++i) {
    Serial.print(F("LOOPBACK_ERROR,INDEX,")); Serial.print(details[i].index);
    Serial.print(F(",TX,")); printHex(details[i].sent);
    Serial.print(F(",RX,")); printHex(details[i].received);
    Serial.println();
  }
  Serial.print(F("LOOPBACK_SUMMARY,BYTES,")); Serial.print(total);
  Serial.print(F(",BYTE_ERRORS,")); Serial.print(totalErrors);
  Serial.print(F(",BIT_ERRORS,")); Serial.print(totalBitErrors);
  Serial.print(F(",ELAPSED_US,")); Serial.println(elapsed);
  Serial.print(F("LOOPBACK_RESULT,"));
  Serial.println(totalErrors ? F("FAIL_HOST_SPI_OR_LOOPBACK_PATH") : F("PASS_HOST_SPI_LOCAL_LOOPBACK_ONLY"));
  Serial.println(F("LOOPBACK_COMPLETE,SPI_DISABLED,D10_D11_D12_D13_INPUT_PULLUPS_OFF,NO_SENSOR_VALIDATION"));
}

void setup() {
  Serial.begin(115200);
  delay(1800);
  Serial.println(F("HARDWARE_SPI_LOOPBACK_ONLY,NO_SENSOR_NO_ELECTRODES,NOT_ADC_DATA"));
  Serial.println(F("REQUIRED,DISCONNECT_ALL_SENSOR_WIRES,USB_PLUS_ONE_SHORT_D11_TO_D12_JUMPER_ONLY"));
  Serial.println(F("WAITING,R_TO_RUN_ONCE_AFTER_PHYSICAL_WIRING_CONFIRMATION"));
}

void loop() {
  while (Serial.available()) {
    const char command = Serial.read();
    if (!hasRun && command == 'R') {
      hasRun = true;
      runLoopback();
    }
  }
  delay(10);
}
