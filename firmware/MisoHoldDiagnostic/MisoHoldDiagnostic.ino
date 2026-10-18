// Electronic bench only; electrode cable MUST remain disconnected.
// Holds a documented ID-register bit on DOUT, without WREG or START.
// h/l select expected HIGH/LOW, x releases CS and stops this diagnostic.
// Neither an observed logic level nor these bytes are physiological samples.
#include <Arduino.h>
#include <SPI.h>

const uint8_t CS_PIN=7, RESET_PIN=4, START_PIN=5;
const uint8_t SCK_PIN=13, MOSI_PIN=11, MISO_PIN=12;
bool holding=false, expectedHigh=false;
uint32_t lastReport=0;

uint8_t exchange(uint8_t output) {
  uint8_t value=0;
  for (int8_t bit=7; bit>=0; --bit) {
    digitalWrite(MOSI_PIN, (output>>bit)&1);
    digitalWrite(SCK_PIN,HIGH);
    delayMicroseconds(100);
    value=(value<<1)|digitalRead(MISO_PIN);
    digitalWrite(SCK_PIN,LOW);
    delayMicroseconds(100);
  }
  return value;
}

void command(uint8_t value) {
  digitalWrite(CS_PIN,LOW); delayMicroseconds(100);
  exchange(value); delayMicroseconds(100);
  digitalWrite(CS_PIN,HIGH); delayMicroseconds(100);
}

void releaseBus() {
  digitalWrite(CS_PIN,HIGH);
  digitalWrite(SCK_PIN,LOW);
  digitalWrite(MOSI_PIN,LOW);
  digitalWrite(START_PIN,LOW);
  holding=false;
}

void holdIdBit(bool high) {
  releaseBus(); delayMicroseconds(100);
  command(0x11);  // SDATAC; no register writes or acquisition.
  digitalWrite(CS_PIN,LOW); delayMicroseconds(100);
  exchange(0x20); delayMicroseconds(100); // ID RREG
  exchange(0x00); delayMicroseconds(100); // one register
  digitalWrite(MOSI_PIN,LOW);
  digitalWrite(SCK_PIN,HIGH);             // ID bit 7: expected 0
  delayMicroseconds(100);
  if (high) {
    digitalWrite(SCK_PIN,LOW); delayMicroseconds(100);
    digitalWrite(SCK_PIN,HIGH);           // ID bit 6: expected 1 for 0x73
    delayMicroseconds(100);
  }
  expectedHigh=high;
  holding=true;
  Serial.print(F("HOLD,EXPECTED_"));
  Serial.println(high ? F("HIGH_ID_BIT6") : F("LOW_ID_BIT7"));
  Serial.println(F("EXPECTED_IS_CONDITIONAL_ON_VALID_COMMAND_DELIVERY_NOT_PROOF_OF_MISO_ONLY_FAULT"));
  Serial.print(F("AVR_STATE,SPCR,")); Serial.print(SPCR,HEX);
  Serial.print(F(",DDRB,")); Serial.print(DDRB,HEX);
  Serial.print(F(",PORTB,")); Serial.print(PORTB,HEX);
  Serial.print(F(",MISO_DIGITAL_PIN,")); Serial.print(MISO_PIN);
  Serial.print(F(",MISO_PORT_BITMASK,")); Serial.println(digitalPinToBitMask(MISO_PIN),HEX);
  lastReport=0;
}

void setup() {
  Serial.begin(115200);
  SPCR &= ~_BV(SPE);
  digitalWrite(CS_PIN,HIGH); digitalWrite(START_PIN,LOW);
  digitalWrite(RESET_PIN,HIGH); digitalWrite(SCK_PIN,LOW);
  digitalWrite(MOSI_PIN,LOW); digitalWrite(MISO_PIN,LOW);
  pinMode(CS_PIN,OUTPUT); pinMode(START_PIN,OUTPUT);
  pinMode(RESET_PIN,OUTPUT); pinMode(SCK_PIN,OUTPUT);
  pinMode(MOSI_PIN,OUTPUT); pinMode(MISO_PIN,INPUT);
  delay(1800);
  digitalWrite(RESET_PIN,LOW); delayMicroseconds(50);
  digitalWrite(RESET_PIN,HIGH); delay(1500);
  command(0x11); command(0x0A);
  Serial.println(F("BENCH_HOLD_ONLY,ELECTRODES_DISCONNECTED,NO_WREG_NO_START_NO_SAMPLES"));
  Serial.println(F("COMMANDS,l=ID_BIT7_EXPECTED_LOW,h=ID_BIT6_EXPECTED_HIGH,x=RELEASE"));
  holdIdBit(false);
}

void loop() {
  while (Serial.available()) {
    char value=Serial.read();
    if (value=='h') holdIdBit(true);
    else if (value=='l') holdIdBit(false);
    else if (value=='x') { releaseBus(); Serial.println(F("RELEASED,NO_ACQUISITION")); }
  }
  if (holding && millis()-lastReport>=1000) {
    lastReport=millis();
    uint16_t highCount=0, rawHighCount=0, clockHighCount=0;
    for (uint16_t i=0;i<200;++i) {
      const uint8_t rawPort = PINB;
      rawHighCount += (rawPort & _BV(4)) != 0;
      clockHighCount += (rawPort & _BV(5)) != 0;
      highCount += digitalRead(MISO_PIN);
      delayMicroseconds(100);
    }
    Serial.print(F("MISO_HOLD,EXPECTED_")); Serial.print(expectedHigh ? F("HIGH") : F("LOW"));
    Serial.print(F(",INPUT_HIGH_COUNT,")); Serial.print(highCount);
    Serial.print(F(",RAW_PINB4_HIGH_COUNT,")); Serial.print(rawHighCount);
    Serial.print(F(",CLOCK_PINB5_HIGH_COUNT,")); Serial.print(clockHighCount);
    Serial.println(F(",TOTAL,200"));
  }
}
