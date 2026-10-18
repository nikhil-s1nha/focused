// Electronic bench ONLY: electrode cable must be disconnected.
// Direct GPIO implements documented SPI mode 1 independently of hardware SPI.
// No WREG, START, respiration, lead-off, RLD, or physiological acquisition.
#include <Arduino.h>
#include <SPI.h>

const uint8_t CS_PIN = 7;
const uint8_t START_PIN = 5;
const uint8_t RESET_PIN = 4;
const uint8_t SCK_PIN = 13;
const uint8_t MOSI_PIN = 11;
#ifndef DIAGNOSTIC_MISO_PIN
#define DIAGNOSTIC_MISO_PIN 12
#endif
const uint8_t MISO_PIN = DIAGNOSTIC_MISO_PIN;
const uint16_t HALF_US[] = {500, 100, 50};

struct ReadPair { uint8_t early; uint8_t late; };

void hexByte(uint8_t value) {
  Serial.print(F("0x"));
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

ReadPair exchange(uint8_t output, uint16_t halfUs) {
  ReadPair input = {0, 0};
  for (int8_t bit = 7; bit >= 0; --bit) {
    digitalWrite(MOSI_PIN, (output >> bit) & 1);
    digitalWrite(SCK_PIN, HIGH);  // ADC updates DOUT on rising edge.
    delayMicroseconds(1);
    input.early = (input.early << 1) | digitalRead(MISO_PIN);
    delayMicroseconds(halfUs - 1);
    input.late = (input.late << 1) | digitalRead(MISO_PIN);
    digitalWrite(SCK_PIN, LOW);   // ADC samples DIN on falling edge.
    delayMicroseconds(halfUs);
  }
  return input;
}

void command(uint8_t value, uint16_t halfUs) {
  digitalWrite(CS_PIN, LOW);
  delayMicroseconds(100);
  exchange(value, halfUs);
  delayMicroseconds(100);
  digitalWrite(CS_PIN, HIGH);
  delayMicroseconds(100);
}

ReadPair readRegister(uint8_t reg, uint16_t halfUs) {
  digitalWrite(CS_PIN, LOW);
  delayMicroseconds(100);
  exchange(0x20 | reg, halfUs);
  delayMicroseconds(100);
  exchange(0x00, halfUs);
  delayMicroseconds(100);
  ReadPair value = exchange(0x00, halfUs);
  delayMicroseconds(100);
  digitalWrite(CS_PIN, HIGH);
  delayMicroseconds(100);
  return value;
}

void resetStopped(uint16_t halfUs) {
  digitalWrite(START_PIN, LOW);
  digitalWrite(CS_PIN, HIGH);
  digitalWrite(RESET_PIN, LOW);
  delayMicroseconds(50);
  digitalWrite(RESET_PIN, HIGH);
  delay(1500);
  command(0x11, halfUs);  // SDATAC
  command(0x0A, halfUs);  // STOP; never START.
}

void setup() {
  Serial.begin(115200);
  // Explicitly keep the AVR SPI engine disabled for independent GPIO timing.
  SPCR &= ~_BV(SPE);
  digitalWrite(CS_PIN, HIGH);
  digitalWrite(START_PIN, LOW);
  digitalWrite(RESET_PIN, HIGH);
  digitalWrite(SCK_PIN, LOW);
  digitalWrite(MOSI_PIN, LOW);
  digitalWrite(MISO_PIN, LOW);  // INPUT without internal pull-up.
  pinMode(CS_PIN, OUTPUT);
  pinMode(START_PIN, OUTPUT);
  pinMode(RESET_PIN, OUTPUT);
  pinMode(SCK_PIN, OUTPUT);
  pinMode(MOSI_PIN, OUTPUT);
  pinMode(MISO_PIN, INPUT);
  delay(1800);
  Serial.println(F("SLOW_DIAG_ONLY,ELECTRODES_DISCONNECTED,NO_SAMPLES_NO_CONFIG_WRITES"));
  Serial.print(F("DIAGNOSTIC_MISO_PIN,")); Serial.println(MISO_PIN);
  Serial.println(F("TIMING,MODE1,EARLY_AFTER_RISE,LATE_BEFORE_FALL,GPIO_OVERHEAD_NOT_CALIBRATED"));
  for (uint8_t speed = 0; speed < 3; ++speed) {
    const uint16_t halfUs = HALF_US[speed];
    resetStopped(halfUs);
    uint8_t goodEarly = 0, goodLate = 0;
    for (uint8_t attempt = 0; attempt < 16; ++attempt) {
      ReadPair id = readRegister(0x00, halfUs);
      Serial.print(F("GPIO_ID,HALF_US,")); Serial.print(halfUs);
      Serial.print(F(",ATTEMPT,")); Serial.print(attempt);
      Serial.print(F(",EARLY,")); hexByte(id.early);
      Serial.print(F(",LATE,")); hexByte(id.late);
      Serial.println();
      goodEarly += id.early == 0x73;
      goodLate += id.late == 0x73;
    }
    Serial.print(F("GPIO_ID_RESULT,HALF_US,")); Serial.print(halfUs);
    Serial.print(F(",EARLY_VALID,")); Serial.print(goodEarly);
    Serial.print(F(",LATE_VALID,")); Serial.print(goodLate);
    Serial.println(F(",TOTAL,16"));
    for (uint8_t reg = 0; reg <= 0x0B; ++reg) {
      ReadPair value = readRegister(reg, halfUs);
      Serial.print(F("UNTRUSTED_GPIO_REG,HALF_US,")); Serial.print(halfUs);
      Serial.print(F(",ADDRESS,")); hexByte(reg);
      Serial.print(F(",EARLY,")); hexByte(value.early);
      Serial.print(F(",LATE,")); hexByte(value.late);
      Serial.println();
    }
  }
  digitalWrite(START_PIN, LOW);
  digitalWrite(CS_PIN, HIGH);
  digitalWrite(SCK_PIN, LOW);
  digitalWrite(MOSI_PIN, LOW);
  Serial.println(F("SLOW_DIAG_COMPLETE,START_LOW,RESET_HIGH,NO_ACQUISITION"));
}

void loop() { delay(1000); }
