// Bench diagnostic only. Disconnect the electrode cable from the board.
// Uses the sensor's internal test signal; no physiological measurements.
#include <SPI.h>
#include "Protocentral_ADS1292R.h"

Protocentral_ADS1292R ads(7, 6, 5, 4); // CS, DRDY, START, RESET
uint32_t sampleNumber = 0;
uint32_t lastSample = 0;

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println(F("BENCH_TEST_ONLY,ELECTRODES_MUST_BE_DISCONNECTED"));
  ADS1292R_Config cfg;
  cfg.dataRate = ADS1292R_DataRate::SPS_125;
  cfg.respiration = false;
  cfg.leadOff = false;
  cfg.rld = false;
  cfg.ch1Gain = ADS1292R_Gain::X1;
  cfg.ch2Gain = ADS1292R_Gain::X1;
  cfg.ch1Mux = ADS1292R_Mux::TestSignal;
  cfg.ch2Mux = ADS1292R_Mux::TestSignal;
  cfg.testSignal = ADS1292R_TestSignal::Square1Hz;
  if (!ads.begin(cfg)) {
    Serial.print(F("ERROR,BEGIN,"));
    Serial.println(static_cast<int>(ads.lastError()));
    Serial.print(F("DEVICE_ID,0x"));
    Serial.println(ads.readID(), HEX);
    while (true) delay(1000);
  }
  Serial.print(F("DEVICE_ID,0x"));
  Serial.println(ads.readID(), HEX);
  Serial.println(F("source,sequence,micros,ch1_counts,ch2_counts"));
  lastSample = millis();
}

void loop() {
  ADS1292R_Sample s;
  if (ads.available() && ads.read(s)) {
    lastSample = millis();
    Serial.print(F("INTERNAL_TEST,"));
    Serial.print(sampleNumber++);
    Serial.print(',');
    Serial.print(micros());
    Serial.print(',');
    Serial.print(s.resp);
    Serial.print(',');
    Serial.println(s.ecg);
  }
  if (millis() - lastSample > 3000) {
    Serial.println(F("ERROR,NO_SAMPLES,CHECK_DRDY_START_CLOCK_WIRING"));
    lastSample = millis();
  }
}
