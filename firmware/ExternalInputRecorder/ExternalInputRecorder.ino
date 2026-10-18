// STAGED ONLY: do not upload to the current body-connected / mains-powered rig.
// External acquisition is deliberately DISABLED in this source and build.
// An enabled, separately reviewed build still requires ARM,<32 hex characters>.
// Raw external biopotential input is not proof of EEG, arousal, fear or isolation.
#include <Arduino.h>
#include <SPI.h>
#include "Protocentral_ADS1292R.h"

const bool ENABLE_EXTERNAL_ACQUISITION = false; // KEEP DISABLED; no enabling command.
const uint8_t CS_PIN = 7, DRDY_PIN = 6, START_PIN = 5, RESET_PIN = 4;
const uint32_t FRAME_SPI_HZ = 1000000UL; // Same as the pinned driver's default.
const uint32_t STALE_MS = 1000UL, MAX_CAPTURE_MS = 120000UL;
const uint32_t MAX_SAMPLE_INTERVAL_US = 12000UL; // 1.5 nominal periods.
Protocentral_ADS1292R ads(CS_PIN, DRDY_PIN, START_PIN, RESET_PIN);

// Entire register map, excluding only live lead-off and GPIO input bits.
const uint8_t EXPECTED[] = {
  0x73, 0x00, 0xA0, 0x10, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x02, 0x03, 0x0C
};
const uint8_t VERIFY_MASK[] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
  0xFF, 0xFF, 0xE0, 0xFF, 0xFF, 0xFC
};

enum RecorderState : uint8_t { Disabled, ReadyForArm, Armed, Stopped, Fault };
RecorderState recorderState = Disabled;
char commandBuffer[37]; // "ARM," + 32 hexadecimal characters + NUL.
uint8_t commandLength = 0;
bool drdySeenHigh = false;
uint32_t sequence = 0, armedAtMs = 0, lastFrameMs = 0, lastFrameMicros = 0;

void hexByte(uint8_t value) {
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

void hexStatus(uint32_t value) {
  hexByte(static_cast<uint8_t>(value >> 16));
  hexByte(static_cast<uint8_t>(value >> 8));
  hexByte(static_cast<uint8_t>(value));
}

void parkHardware() {
  // Physical control pins, not best-effort SPI commands on a possibly bad link.
  digitalWrite(START_PIN, LOW);
  pinMode(START_PIN, OUTPUT);
  digitalWrite(RESET_PIN, LOW);
  pinMode(RESET_PIN, OUTPUT);
  digitalWrite(CS_PIN, HIGH);
  pinMode(CS_PIN, OUTPUT);
}

void latchFault(const __FlashStringHelper* reason) {
  parkHardware();
  recorderState = Fault;
  Serial.print(F("ERROR,"));
  Serial.println(reason);
  Serial.println(F("CAPTURE,FAULT_LATCHED,START_LOW,RESET_LOW,RESET_REQUIRED"));
}

bool verifyTwice() {
  const uint8_t id = ads.readID();
  Serial.print(F("DEVICE_ID,0x"));
  hexByte(id);
  Serial.println();
  if (id != ADS1292R_DEVICE_ID) {
    latchFault(F("DEVICE_ID_MISMATCH"));
    return false;
  }
  for (uint8_t pass = 1; pass <= 2; ++pass) {
    Serial.print(F("VERIFY_PASS,"));
    Serial.println(pass);
    for (uint8_t address = 0; address < sizeof(EXPECTED); ++address) {
      const uint8_t value = ads.readRegister(address);
      Serial.print(F("REGISTER,0x"));
      hexByte(address);
      Serial.print(F(",0x"));
      hexByte(value);
      Serial.println();
      if ((value & VERIFY_MASK[address]) !=
          (EXPECTED[address] & VERIFY_MASK[address])) {
        parkHardware();
        Serial.print(F("ERROR_DETAIL,REGISTER,0x")); hexByte(address);
        Serial.print(F(",EXPECTED,0x")); hexByte(EXPECTED[address]);
        Serial.print(F(",MASK,0x")); hexByte(VERIFY_MASK[address]);
        Serial.println();
        latchFault(F("REGISTER_READBACK_MISMATCH"));
        return false;
      }
    }
    delay(5);
  }
  Serial.println(F("VERIFY_OK,ID_AND_CONFIG_TWO_PASSES"));
  return true;
}

void printAcquisitionMetadata() {
  Serial.println(F("CHANNEL_ROLE,1,INTERNAL_SHORT_CONTROL"));
  Serial.println(F("CHANNEL_ROLE,2,EXTERNAL_DIFFERENTIAL_UNVALIDATED"));
  Serial.println(F("CONFIG,SPS_125,GAIN_6,VREF_NOMINAL_V_2.42,CH1_SHORTED,CH2_EXTERNAL"));
  Serial.println(F("CONFIG,RESPIRATION_OFF,LEADOFF_OFF,RLD_OFF,TEST_SIGNAL_OFF"));
  Serial.println(F("CONVERSION,INPUT_UV_PER_COUNT,0.04808108"));
  Serial.println(F("TIMESTAMP_BASIS,UNO_HOST_READ_MICROS_NOT_ADC_CLOCK"));
  Serial.println(F("FRAME_FORMAT,EXTERNAL_INPUT,sequence,uno_read_micros,status_hex,ch1_counts,ch2_counts"));
}

bool validArmCommand() {
  if (commandLength != 36 || strncmp(commandBuffer, "ARM,", 4) != 0) return false;
  for (uint8_t i = 4; i < 36; ++i) {
    const char c = commandBuffer[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
          (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

void armRecorder() {
  // The host must generate a new random session ID; the Uno has no unique clock.
  Serial.print(F("SESSION,"));
  Serial.println(commandBuffer + 4);
  // Bind the session to fresh checks; old READY output cannot authorize a new run.
  if (!verifyTwice()) return;
  printAcquisitionMetadata();
  Serial.flush(); // Finish metadata before starting conversions.
  sequence = 0;
  lastFrameMicros = 0;
  drdySeenHigh = false;
  armedAtMs = lastFrameMs = millis();
  ads.start(); // autoStart was false; this is the only conversion-start point.
  recorderState = Armed;
  Serial.println(F("ARMED,EXTERNAL_INPUT"));
}

void stopRecorder(const __FlashStringHelper* reason) {
  parkHardware();
  recorderState = Stopped;
  Serial.print(F("CAPTURE,STOPPED,"));
  Serial.println(reason);
  Serial.println(F("STATE,START_LOW,RESET_LOW,RESET_REQUIRED"));
}

void processControl() {
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r') continue;
    if (c == '\n') {
      commandBuffer[commandLength] = '\0';
      if (commandLength == 0) continue;
      if (strcmp(commandBuffer, "STOP") == 0) {
        stopRecorder(F("HOST_STOP"));
      } else if (recorderState == ReadyForArm && validArmCommand()) {
        armRecorder();
      } else {
        latchFault(F("INVALID_CONTROL_OR_RECORDER_STATE"));
      }
      commandLength = 0;
      return;
    }
    if (c < 32 || c > 126 || commandLength >= sizeof(commandBuffer) - 1) {
      latchFault(F("INVALID_OR_OVERSIZED_CONTROL"));
      commandLength = 0;
      return;
    }
    commandBuffer[commandLength++] = c;
  }
}

int32_t signed24(const uint8_t* data) {
  uint32_t value = (static_cast<uint32_t>(data[0]) << 16) |
                   (static_cast<uint32_t>(data[1]) << 8) | data[2];
  if (value & 0x800000UL) value |= 0xFF000000UL;
  return static_cast<int32_t>(value);
}

bool readAndEmitFrame() {
  uint8_t data[9];
  const uint32_t readMicros = micros();
  SPI.beginTransaction(SPISettings(FRAME_SPI_HZ, MSBFIRST, SPI_MODE1));
  digitalWrite(CS_PIN, LOW);
  delayMicroseconds(50);
  // autoStart=false left RDATAC off; RDATA explicitly requests this frame.
  SPI.transfer(ADS1292R_CMD_RDATA);
  delayMicroseconds(50);
  for (uint8_t i = 0; i < 9; ++i) data[i] = SPI.transfer(0);
  delayMicroseconds(50);
  digitalWrite(CS_PIN, HIGH);
  SPI.endTransaction();
  delayMicroseconds(50);
  const uint32_t status = (static_cast<uint32_t>(data[0]) << 16) |
                          (static_cast<uint32_t>(data[1]) << 8) | data[2];
  if ((status & 0xF01FFFUL) != 0xC00000UL) {
    parkHardware();
    Serial.print(F("ERROR_DETAIL,FRAME_STATUS,0x")); hexStatus(status);
    Serial.println();
    latchFault(F("INVALID_FRAME_STATUS"));
    return false;
  }
  if (sequence != 0 && static_cast<uint32_t>(readMicros - lastFrameMicros) >
                           MAX_SAMPLE_INTERVAL_US) {
    latchFault(F("READ_TIMING_GAP"));
    return false;
  }
  lastFrameMicros = readMicros;
  lastFrameMs = millis();
  Serial.print(F("EXTERNAL_INPUT,"));
  Serial.print(sequence++);
  Serial.print(','); Serial.print(readMicros);
  Serial.print(','); hexStatus(status);
  Serial.print(','); Serial.print(signed24(data + 3));
  Serial.print(','); Serial.println(signed24(data + 6));
  return true;
}

void setup() {
  parkHardware();
  Serial.begin(115200);
  delay(1500);
  Serial.println(F("EXTERNAL_INPUT_RECORDER,VERSION,1"));
  if (!ENABLE_EXTERNAL_ACQUISITION) {
    Serial.println(F("BLOCKED,EXTERNAL_ACQUISITION_DISABLED"));
    Serial.println(F("STAGED_ONLY,NO_SPI_BEGIN,NO_ADC_INITIALIZATION,NO_CAPTURE"));
    return;
  }

  ADS1292R_Config cfg;
  cfg.autoStart = false;
  cfg.dataRate = ADS1292R_DataRate::SPS_125;
  cfg.reference = ADS1292R_Reference::V2_42;
  cfg.testSignal = ADS1292R_TestSignal::Off;
  cfg.ch1Gain = ADS1292R_Gain::X6;
  cfg.ch2Gain = ADS1292R_Gain::X6;
  cfg.ch1Mux = ADS1292R_Mux::Shorted;
  cfg.ch2Mux = ADS1292R_Mux::Normal;
  cfg.respiration = false;
  cfg.respExternalClock = false;
  cfg.leadOff = false;
  cfg.leadOffSense = 0;
  cfg.leadOffAC = false;
  cfg.rld = false;
  cfg.rldSources = 0;
  cfg.rldLeadOff = false;
  cfg.clockOutput = false;
  // parkHardware() held RESET low long enough to power down. Allow full wake-up
  // before the driver's subsequent short reset pulse and strict ID read.
  digitalWrite(RESET_PIN, HIGH);
  delay(1000);
  // Pinned library checks ID 0x73 BEFORE applying this configuration and checks
  // writable-register readbacks. It never starts conversions with autoStart=false.
  if (!ads.begin(cfg)) {
    Serial.print(F("ERROR_DETAIL,LIBRARY_BEGIN_STATUS,"));
    Serial.println(static_cast<uint8_t>(ads.lastError()));
    latchFault(F("BEGIN_FAILED"));
    return;
  }
  delay(200);
  if (!verifyTwice()) return;
  recorderState = ReadyForArm;
  Serial.println(F("READY_FOR_ARM,ARM_REQUIRES_HOST_SESSION_32_HEX"));
}

void loop() {
  if (recorderState == Disabled || recorderState == Stopped || recorderState == Fault) {
    delay(50);
    return;
  }
  processControl();
  if (recorderState != Armed) return;
  const uint32_t now = millis();
  if (now - armedAtMs >= MAX_CAPTURE_MS) {
    stopRecorder(F("SESSION_TIME_LIMIT"));
    return;
  }
  if (now - lastFrameMs > STALE_MS) {
    latchFault(F("DRDY_STALE"));
    return;
  }
  const bool high = digitalRead(DRDY_PIN) == HIGH;
  if (high) drdySeenHigh = true;
  if (!high && drdySeenHigh) {
    drdySeenHigh = false;
    readAndEmitFrame();
  }
}
