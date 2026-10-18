// Electronic bench ONLY. Electrode cable remains disconnected.
// REQUIRED: detach sensor MISO from Uno D12; jumper ONLY Uno D8 to Uno D12.
// D8 is driven during this test. Never connect it to sensor MISO or a power rail.
// Other sensor wiring remains unchanged. No ADC commands or samples.
#include <Arduino.h>
#include <SPI.h>

const uint8_t DRIVE_PIN=8, INPUT_PIN=12;

uint16_t sampleHeld(bool high) {
  digitalWrite(DRIVE_PIN, high ? HIGH : LOW);
  delay(50);
  uint16_t highs=0, rawHighs=0;
  for (uint16_t i=0;i<1000;++i) {
    rawHighs += (PINB & _BV(4)) != 0;
    highs += digitalRead(INPUT_PIN);
    delayMicroseconds(100);
  }
  Serial.print(F("INPUT_SELFTEST,DRIVE_")); Serial.print(high ? F("HIGH") : F("LOW"));
  Serial.print(F(",DIGITAL_HIGH_COUNT,")); Serial.print(highs);
  Serial.print(F(",RAW_HIGH_COUNT,")); Serial.print(rawHighs);
  Serial.println(F(",TOTAL,1000"));
  return (highs==(high?1000:0) && rawHighs==(high?1000:0)) ? 0 : 1;
}

uint16_t patternTest(uint16_t settleUs) {
  const uint16_t patterns[]={0x0000,0xFFFF,0xAAAA,0x5555,0x8001,0x7FFE,0xA55A,0x5AA5};
  uint16_t errors=0, tested=0;
  // Strong known Uno output bypasses the sensor, translator and SPI commands.
  for (uint8_t repeat=0;repeat<8;++repeat) {
    for (uint8_t p=0;p<8;++p) {
      for (int8_t bit=15;bit>=0;--bit) {
        const bool expected=(patterns[p]>>bit)&1;
        if (expected) PORTB |= _BV(0); else PORTB &= ~_BV(0); // D8=PB0
        delayMicroseconds(settleUs);
        const bool actual=(PINB & _BV(4)) != 0;             // D12=PB4
        errors += actual != expected;
        ++tested;
      }
    }
  }
  Serial.print(F("INPUT_PATTERN,SETTLE_US,")); Serial.print(settleUs);
  Serial.print(F(",ERRORS,")); Serial.print(errors);
  Serial.print(F(",BITS,")); Serial.println(tested);
  return errors;
}

void setup() {
  Serial.begin(115200);
  SPCR &= ~_BV(SPE);
  // Deselect sensor and keep START low throughout; leave power/reset released.
  digitalWrite(7,HIGH); pinMode(7,OUTPUT);
  digitalWrite(5,LOW); pinMode(5,OUTPUT);
  digitalWrite(4,HIGH); pinMode(4,OUTPUT);
  digitalWrite(13,LOW); pinMode(13,OUTPUT);
  digitalWrite(11,LOW); pinMode(11,OUTPUT);
  digitalWrite(INPUT_PIN,LOW); pinMode(INPUT_PIN,INPUT);
  digitalWrite(DRIVE_PIN,LOW); pinMode(DRIVE_PIN,OUTPUT);
  delay(1800);
  Serial.println(F("UNO_INPUT_SELFTEST_ONLY,ELECTRODES_DISCONNECTED,NO_ADC_COMMANDS"));
  Serial.println(F("REQUIRED,SENSOR_MISO_DETACHED_FROM_D12,JUMPER_UNO_D8_TO_UNO_D12_ONLY"));
  uint16_t failures=0;
  for (uint8_t i=0;i<4;++i) { failures+=sampleHeld(false); failures+=sampleHeld(true); }
  failures+=patternTest(100);
  failures+=patternTest(2);
  digitalWrite(DRIVE_PIN,LOW);
  pinMode(DRIVE_PIN,INPUT);
  Serial.print(F("INPUT_SELFTEST_RESULT,"));
  Serial.println(failures ? F("FAIL_KNOWN_INPUT_NOT_RELIABLY_READ") : F("PASS_STATIC_AND_PATTERNS"));
  Serial.println(F("SELFTEST_COMPLETE,D8_INPUT,D12_INPUT,RESTORE_WIRING_AND_BENCH_FIRMWARE_BEFORE_SAMPLING"));
}

void loop() { delay(1000); }
