// Bench diagnostic only. Keep the electrode cable disconnected from the board.
// The ADC's internal input-short mux measures electronics noise, not physiology.
#include <SPI.h>
#include "Protocentral_ADS1292R.h"

Protocentral_ADS1292R ads(7, 6, 5, 4); // CS, DRDY, START, RESET
uint32_t sampleNumber = 0;
uint32_t lastSample = 0;

void haltDiagnostic() {
  ads.stop();
  while (true) delay(1000);
}

void requireRegister(uint8_t reg, uint8_t expected) {
  const uint8_t actual = ads.readRegister(reg);
  Serial.print(F("REGISTER,0x"));
  Serial.print(reg, HEX);
  Serial.print(F(",0x"));
  Serial.println(actual, HEX);
  if (actual != expected) {
    Serial.print(F("ERROR,REGISTER_MISMATCH,EXPECTED_0x"));
    Serial.println(expected, HEX);
    haltDiagnostic();
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println(F("BENCH_NOISE_ONLY,ELECTRODES_MUST_BE_DISCONNECTED"));

  ADS1292R_Config cfg;
  cfg.dataRate = ADS1292R_DataRate::SPS_125;
  cfg.reference = ADS1292R_Reference::V2_42;
  cfg.ch1Gain = ADS1292R_Gain::X6;
  cfg.ch2Gain = ADS1292R_Gain::X6;
  cfg.ch1Mux = ADS1292R_Mux::Shorted;
  cfg.ch2Mux = ADS1292R_Mux::Shorted;
  cfg.testSignal = ADS1292R_TestSignal::Off;
  cfg.respiration = false;
  cfg.respExternalClock = false;
  cfg.leadOff = false;
  cfg.leadOffSense = 0;
  cfg.rld = false;
  cfg.rldSources = 0;
  cfg.rldLeadOff = false;
  cfg.clockOutput = false;

  if (!ads.begin(cfg)) {
    Serial.print(F("ERROR,BEGIN,"));
    Serial.println(static_cast<int>(ads.lastError()));
    Serial.print(F("DEVICE_ID,0x"));
    Serial.println(ads.readID(), HEX);
    haltDiagnostic();
  }

  // Stop acquisition while reporting/read-verifying configuration. begin()
  // entered continuous-read mode; the library safely handles register reads.
  ads.stop();
  Serial.print(F("DEVICE_ID,0x"));
  Serial.println(ads.readID(), HEX);
  requireRegister(ADS1292R_REG_CONFIG1, 0x00); // continuous, 125 SPS
  requireRegister(ADS1292R_REG_CONFIG2, 0xA0); // 2.42 V ref on; test/LOFF off
  requireRegister(ADS1292R_REG_CH1SET, 0x01);  // powered, gain 6, input short
  requireRegister(ADS1292R_REG_CH2SET, 0x01);
  requireRegister(ADS1292R_REG_RLD_SENS, 0x00);
  requireRegister(ADS1292R_REG_LOFF_SENS, 0x00);
  requireRegister(ADS1292R_REG_RESP1, 0x02);   // fixed bit only, excitation off
  requireRegister(ADS1292R_REG_RESP2, 0x03);   // fixed/internal ref, calibration off

  Serial.println(F("CONFIG,SPS_125,GAIN_6,VREF_NOMINAL_V_2.42,MUX_SHORTED_BOTH"));
  Serial.println(F("CONFIG,RESPIRATION_OFF,LEADOFF_OFF,RLD_OFF,TEST_SIGNAL_OFF"));
  Serial.println(F("CONVERSION,INPUT_UV_PER_COUNT,0.04808108"));
  Serial.println(F("CONVERSION,INPUT_UV_EQUALS_COUNTS_TIMES_2420000_DIV_6_DIV_8388608"));
  Serial.println(F("NOTE,DISCARD_FIRST_125_SAMPLES_FOR_SETTLING"));
  Serial.println(F("source,sequence,micros,ch1_counts,ch2_counts"));
  lastSample = millis();
  ads.start();
}

void loop() {
  ADS1292R_Sample s;
  if (ads.available() && ads.read(s)) {
    const uint32_t sampleMicros = micros(); // host-read time, not an ADC timestamp
    lastSample = millis();
    Serial.print(F("SHORTED_INPUT,"));
    Serial.print(sampleNumber++);
    Serial.print(',');
    Serial.print(sampleMicros);
    Serial.print(',');
    Serial.print(s.resp); // CH1; name in library does not imply respiration here
    Serial.print(',');
    Serial.println(s.ecg); // CH2; name does not imply an ECG measurement here
  }
  if (millis() - lastSample > 3000) {
    Serial.println(F("ERROR,NO_SAMPLES,CHECK_DRDY_START_CLOCK_WIRING"));
    lastSample = millis();
  }
}
