import unittest

from .acquire_signal import BenchAcquisition, UINT32
from .eeg_processing import ProcessingConfig


def frame(seq, micros, ch1=100, ch2=-200, source="INTERNAL_TEST"):
    return f"{source},{seq},{micros},{ch1},{ch2}"


class AcquisitionTests(unittest.TestCase):
    def test_only_bench_profiles(self):
        with self.assertRaises(ValueError):
            BenchAcquisition("hardware")

    def test_gain_and_selected_channel(self):
        a = BenchAcquisition("internal_test")
        b = BenchAcquisition("shorted_input", channel=1)
        self.assertAlmostEqual(a.scale / b.scale, 6)
        a.feed(frame(0, 8000), 1000)
        self.assertEqual(a.last_raw["ch1_counts"], 100)
        self.assertEqual(a.last_raw["ch2_counts"], -200)
        self.assertEqual(a.last_raw["channel"], 2)

    def test_device_clock_not_packet_arrival(self):
        a = BenchAcquisition("internal_test")
        a.feed(frame(0, 8000), 1000)
        a.feed(frame(1, 16000), 1005)  # Delayed host delivery must not change sample spacing.
        self.assertAlmostEqual(a.timestamp, 1000.008)

    def test_both_counter_wraps(self):
        a = BenchAcquisition("internal_test")
        a.feed(frame(UINT32 - 1, UINT32 - 4000), 1000)
        messages = a.feed(frame(0, 4000), 1000.01)
        self.assertAlmostEqual(a.timestamp, 1000.008)
        self.assertFalse(any(m["type"] == "status" for m in messages))

    def test_missing_and_duplicate_transport_records(self):
        a = BenchAcquisition("internal_test")
        a.feed(frame(0, 8000), 1000)
        messages = a.feed(frame(2, 24000), 1000.016)
        self.assertEqual(a.missing, 1)
        self.assertIn("sequence_gap", [m.get("reason") for m in messages])
        messages = a.feed(frame(2, 24000), 1000.02)
        self.assertEqual(a.samples, 2)
        self.assertEqual(a.duplicates, 1)
        self.assertEqual(messages[-1]["signal_quality"], 0)
        self.assertIsNone(a.last_raw)

    def test_header_and_reset_discard_calibration(self):
        a = BenchAcquisition("internal_test")
        a.feed(frame(99, 1000000), 1000)
        messages = a.feed(frame(0, 8000), 1001)
        self.assertIn("device_counter_reset_or_out_of_order", [m.get("reason") for m in messages])
        self.assertFalse(a.processor.calibrated)
        self.assertEqual(a.samples, 1)  # Regressing record is rejected, not re-anchored.
        self.assertIsNone(a.last_raw)
        messages = a.feed("BENCH_TEST_ONLY,ELECTRODES_MUST_BE_DISCONNECTED", 1002)
        self.assertEqual(messages[-1]["quality_reasons"], ["device_startup"])

    def test_profile_mismatch_and_invalid_counts(self):
        a = BenchAcquisition("internal_test")
        messages = a.feed(frame(0, 8000, source="SHORTED_INPUT"), 1000)
        self.assertEqual(messages[-1]["quality_reasons"], ["source_profile_mismatch"])
        self.assertEqual(a.feed(frame(1, 16000), 1001), [])
        a = BenchAcquisition("internal_test")
        messages = a.feed(frame(0, 8000, ch1=2**23), 1000)
        self.assertEqual(messages[-1]["quality_reasons"], ["malformed_serial_record"])
        self.assertEqual(a.samples, 0)

    def test_metadata_matches_or_latches_invalid(self):
        for header in ("CONFIG,SPS_500,GAIN_12,VREF_NOMINAL_V_2.42,MUX_SHORTED_BOTH",
                       "REGISTER,0x04,0x15", "DEVICE_ID,0x72",
                       "CONVERSION,INPUT_UV_PER_COUNT,0.28848648"):
            a = BenchAcquisition("shorted_input")
            messages = a.feed(header, 1000)
            self.assertEqual(messages[-1]["signal_quality"], 0)
            self.assertEqual(a.feed(frame(0, 8000, source="SHORTED_INPUT"), 1001), [])
            self.assertEqual(a.samples, 0)
        a = BenchAcquisition("shorted_input")
        for header in ("DEVICE_ID,0x73", "REGISTER,0x04,0x01",
                       "CONFIG,SPS_125,GAIN_6,VREF_NOMINAL_V_2.42,MUX_SHORTED_BOTH",
                       "CONFIG,RESPIRATION_OFF,LEADOFF_OFF,RLD_OFF,TEST_SIGNAL_OFF",
                       "CONVERSION,INPUT_UV_PER_COUNT,0.04808108"):
            self.assertEqual(a.feed(header, 1000), [])
        self.assertIsNone(a.metadata_fault)

    def test_read_timing_gap_even_without_sequence_gap(self):
        a = BenchAcquisition("internal_test")
        a.feed(frame(0, 8000), 1000)
        messages = a.feed(frame(1, 32000), 1000.024)
        self.assertEqual(a.missing, 0)
        self.assertIn("read_timing_gap", [m.get("reason") for m in messages])

    def test_observed_rate_verified_before_accepting_scores(self):
        a = BenchAcquisition("internal_test")
        messages = []
        for i in range(126):
            messages += a.feed(frame(i, i * 8000), 1000 + i * .008)
        self.assertAlmostEqual(a.observed_read_rate, 125)
        early = [m for m in messages if m["type"] == "signal" and m["sequence"] < 125]
        self.assertTrue(early)
        self.assertTrue(all(m["signal_quality"] == 0 for m in early))

    def test_faster_stream_cannot_silently_use_125_hz_filter(self):
        a = BenchAcquisition("internal_test")
        messages = []
        for i in range(126):
            messages += a.feed(frame(i, i * 4000), 1000 + i * .004)
        fault = [m for m in messages if m.get("reason") == "sample_rate_mismatch"]
        self.assertEqual(len(fault), 1)
        self.assertAlmostEqual(fault[0]["observed_read_rate_hz"], 250)
        self.assertEqual(a.metadata_fault, "sample_rate_mismatch")
        self.assertEqual(a.feed(frame(126, 126 * 4000), 1001), [])
        self.assertTrue(all(not m.get("reaction_event") for m in messages))

    def test_stale_invalidation_and_bench_events(self):
        a = BenchAcquisition("internal_test", config=ProcessingConfig(
            startup_seconds=0, baseline_seconds=.2, flatline_seconds=.1))
        messages = []
        for i in range(250):
            messages += a.feed(frame(i, i * 8000, ch2=100 if i % 2 else -100), 1000)
        self.assertTrue(a.processor.calibrated)
        self.assertTrue(any(m.get("calibrated") for m in messages))
        self.assertTrue(all(not m.get("reaction_event") for m in messages))
        invalid = a.invalidate("serial_stale", 1003)[-1]
        self.assertFalse(invalid["calibrated"])
        self.assertEqual(invalid["signal_quality"], 0)
        self.assertFalse(a.processor.calibrated)


if __name__ == "__main__":
    unittest.main()
