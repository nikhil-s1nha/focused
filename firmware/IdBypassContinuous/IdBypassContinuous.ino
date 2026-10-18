// ELECTRONIC BENCH ONLY. Electrode cable MUST be physically disconnected.
// Explicit diagnostic exception: invalid ID/readback NEVER becomes trusted data.
// Attempts internal-short/test configuration; no external-input/RLD/resp/lead-off use.
// Every raw row is UNTRUSTED_BYPASS, no microvolt conversion, bounded capture.
#include <Arduino.h>
#include <SPI.h>
#include <avr/interrupt.h>

const uint8_t CS_PIN=7, DRDY_PIN=6, START_PIN=5, RESET_PIN=4;
const uint32_t CLOCKS[]={125000UL,1000000UL,125000UL};
const uint8_t ADDRESSES[]={1,2,3,4,5,6,7,9,10,11};
const uint8_t VALUES[]   ={0x00,0xA0,0x10,0x01,0x01,0x00,0x00,0x02,0x03,0x0C};
volatile uint32_t falls=0;
volatile bool drdyWasHigh=true;

ISR(PCINT2_vect) {
  const bool high=(PIND & _BV(6))!=0;
  if (drdyWasHigh && !high) ++falls;
  drdyWasHigh=high;
}

void hexByte(uint8_t value) {
  if (value<16) Serial.print('0');
  Serial.print(value,HEX);
}

void beginBus(uint32_t clockHz) {
  SPI.beginTransaction(SPISettings(clockHz,MSBFIRST,SPI_MODE1));
  digitalWrite(CS_PIN,LOW); delayMicroseconds(50);
}

void endBus() {
  delayMicroseconds(50); digitalWrite(CS_PIN,HIGH);
  SPI.endTransaction(); delayMicroseconds(50);
}

void command(uint8_t value,uint32_t clockHz) {
  beginBus(clockHz); SPI.transfer(value); endBus();
}

uint8_t readRegister(uint8_t address,uint32_t clockHz) {
  beginBus(clockHz);
  SPI.transfer(0x20|address); delayMicroseconds(50);
  SPI.transfer(0); delayMicroseconds(50);
  const uint8_t value=SPI.transfer(0);
  endBus(); return value;
}

void writeRegister(uint8_t address,uint8_t value,uint32_t clockHz) {
  beginBus(clockHz);
  SPI.transfer(0x40|address); delayMicroseconds(50);
  SPI.transfer(0); delayMicroseconds(50);
  SPI.transfer(value); endBus();
}

void readRaw(uint8_t* data,uint32_t clockHz) {
  beginBus(clockHz);
  // RDATAC: exactly nine clocks-bytes; do not discard a command RX byte.
  for (uint8_t i=0;i<9;++i) data[i]=SPI.transfer(0);
  endBus();
}

uint32_t edgeCount() {
  noInterrupts(); const uint32_t value=falls; interrupts(); return value;
}

void resetStopped(uint32_t clockHz) {
  digitalWrite(START_PIN,LOW); digitalWrite(CS_PIN,HIGH);
  digitalWrite(RESET_PIN,LOW); delayMicroseconds(50);
  digitalWrite(RESET_PIN,HIGH); delay(1000);
  command(0x11,clockHz); command(0x0A,clockHz);
}

void capture(uint32_t clockHz,bool testSignal) {
  resetStopped(clockHz);
  uint8_t expected[sizeof(VALUES)];
  for (uint8_t i=0;i<sizeof(VALUES);++i) expected[i]=VALUES[i];
  if (testSignal) { expected[1]=0xA3; expected[3]=0x15; expected[4]=0x15; }
  Serial.print(F("BYPASS_PHASE,SPI_HZ,")); Serial.print(clockHz);
  Serial.print(F(",READ_MODE,RDATAC,MUX,")); Serial.println(testSignal?F("INTERNAL_TEST_1HZ"):F("INTERNAL_SHORT"));
  Serial.print(F("UNTRUSTED_ID_READS,"));
  uint8_t goodIds=0;
  for (uint8_t i=0;i<8;++i) {
    const uint8_t id=readRegister(0,clockHz);
    if (i) Serial.print(','); hexByte(id); goodIds+=id==0x73;
  }
  Serial.println();
  Serial.print(F("ID_GUARD_BYPASSED_FOR_BENCH_ONLY,VALID_73,")); Serial.println(goodIds);
  for (uint8_t i=0;i<sizeof(ADDRESSES);++i) writeRegister(ADDRESSES[i],expected[i],clockHz);
  delay(200); // Requested reference settling, not proof writes succeeded.
  uint8_t mismatches=0;
  for (uint8_t i=0;i<sizeof(ADDRESSES);++i) {
    const uint8_t a=readRegister(ADDRESSES[i],clockHz);
    const uint8_t b=readRegister(ADDRESSES[i],clockHz);
    // GPIO low bits report live pin levels; verify direction bits only.
    const uint8_t mask=ADDRESSES[i]==0x0B ? 0x0C : 0xFF;
    const bool match=(a&mask)==(expected[i]&mask) && (b&mask)==(expected[i]&mask);
    mismatches+=!match;
    Serial.print(F("UNTRUSTED_REG,ADDRESS,")); hexByte(ADDRESSES[i]);
    Serial.print(F(",REQUESTED,")); hexByte(expected[i]);
    Serial.print(F(",READ_A,")); hexByte(a);
    Serial.print(F(",READ_B,")); hexByte(b);
    Serial.print(F(",VERIFY_MASK,")); hexByte(mask);
    Serial.print(F(",MATCH,")); Serial.println(match?1:0);
  }
  Serial.print(F("CONFIG_READBACK_MISMATCHES,")); Serial.println(mismatches);
  Serial.println(testSignal ? F("REQUESTED_ONLY,125_SPS,GAIN1,REF2_42,INTERNAL_TEST_1HZ,EXTERNAL_EXCITATION_OFF") : F("REQUESTED_ONLY,125_SPS,GAIN6,REF2_42,INTERNAL_SHORT_BOTH,EXCITATION_OFF"));
  Serial.println(F("WARNING,IF_READBACK_WRONG_MUX_GAIN_REF_RATE_NOT_VERIFIED;ALL_ROWS_UNTRUSTED"));
  command(0x10,clockHz); // Explicit RDATAC; also matches power-on read mode.
  noInterrupts();
  falls=0; drdyWasHigh=(PIND&_BV(6))!=0;
  PCIFR=_BV(PCIF2); PCMSK2|=_BV(6); PCICR|=_BV(PCIE2);
  interrupts();
  uint32_t served=0,frames=0,cPrefix=0,reservedZero=0,bothStatus=0;
  uint32_t firstMicros=0,lastMicros=0;
  const uint32_t started=millis();
  digitalWrite(START_PIN,HIGH);
  while (millis()-started<8000UL && frames<1000UL) {
    const uint32_t observed=edgeCount();
    if (observed==served) continue;
    served=observed;
    uint8_t data[9]; const uint32_t now=micros(); readRaw(data,clockHz);
    const uint32_t status=((uint32_t)data[0]<<16)|((uint32_t)data[1]<<8)|data[2];
    const bool prefix=(status&0xF00000UL)==0xC00000UL;
    const bool zero=(status&0x1FFFUL)==0;
    cPrefix+=prefix; reservedZero+=zero; bothStatus+=prefix&&zero;
    if (!frames) firstMicros=now; lastMicros=now;
    Serial.print(F("UNTRUSTED_BYPASS,")); Serial.print(frames++);
    Serial.print(','); Serial.print(now); Serial.print(',');
    for (uint8_t i=0;i<9;++i) hexByte(data[i]);
    Serial.println();
  }
  digitalWrite(START_PIN,LOW);
  const uint32_t elapsed=millis()-started;
  const uint32_t observed=edgeCount();
  PCMSK2&=~_BV(6); PCICR&=~_BV(PCIE2);
  if (!frames) {
    // Still in requested RDATAC mode. Without DRDY this is a bus probe only.
    uint8_t probe[9]; readRaw(probe,clockHz);
    Serial.print(F("FORCED_CLOCK_PROBE_NOT_SAMPLE,"));
    for (uint8_t i=0;i<9;++i) hexByte(probe[i]);
    Serial.println();
  }
  command(0x11,clockHz); command(0x0A,clockHz);
  Serial.print(F("BYPASS_SUMMARY,SPI_HZ,")); Serial.print(clockHz);
  Serial.print(F(",ELAPSED_MS,")); Serial.print(elapsed);
  Serial.print(F(",OBSERVED_DRDY_FALLS,")); Serial.print(observed);
  Serial.print(F(",RAW_FRAMES,")); Serial.print(frames);
  Serial.print(F(",C_PREFIX,")); Serial.print(cPrefix);
  Serial.print(F(",RESERVED_ZERO,")); Serial.print(reservedZero);
  Serial.print(F(",BOTH_STATUS_CHECKS,")); Serial.print(bothStatus);
  Serial.print(F(",FIRST_US,")); Serial.print(firstMicros);
  Serial.print(F(",LAST_US,")); Serial.println(lastMicros);
}

void setup() {
  Serial.begin(115200);
  digitalWrite(CS_PIN,HIGH); pinMode(CS_PIN,OUTPUT);
  digitalWrite(START_PIN,LOW); pinMode(START_PIN,OUTPUT);
  digitalWrite(RESET_PIN,HIGH); pinMode(RESET_PIN,OUTPUT);
  pinMode(DRDY_PIN,INPUT); digitalWrite(DRDY_PIN,LOW);
  SPI.begin(); delay(1800);
  Serial.println(F("ID_BYPASS_CONTINUOUS_BENCH_ONLY,ELECTRODE_CABLE_MUST_BE_UNPLUGGED,NOT_EEG"));
  Serial.println(F("FORMAT,UNTRUSTED_BYPASS,SEQUENCE,UNO_READ_MICROS,NINE_RAW_BYTES_HEX"));
  for (uint8_t i=0;i<3;++i) capture(CLOCKS[i],i==2);
  digitalWrite(START_PIN,LOW); command(0x0A,125000UL);
  digitalWrite(RESET_PIN,LOW);
  Serial.println(F("BYPASS_COMPLETE,RESET_LOW,NO_ACQUISITION,RESTORE_NORMAL_FIRMWARE"));
}

void loop() { delay(1000); }
