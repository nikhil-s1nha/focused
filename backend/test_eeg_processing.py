"""Synthetic numerical checks; these do not validate physiological meaning."""
import unittest
from dataclasses import replace

import numpy as np
from scipy.signal import sosfilt

from backend.eeg_processing import EEGProcessor, ProcessingConfig


class ProcessingTests(unittest.TestCase):
    def setUp(self):
        self.c = ProcessingConfig(startup_seconds=2, baseline_seconds=3,
                                  adc_full_scale_uv=1000)

    def wave(self, seconds, amplitude=2, frequency=10):
        t = np.arange(round(seconds * self.c.sample_rate)) / self.c.sample_rate
        return t, amplitude * np.sin(2 * np.pi * frequency * t)

    def test_chunk_boundaries_preserve_all_output_and_events(self):
        t, x = self.wave(15)
        x[(t > 9) & (t < 10)] *= 8
        whole = EEGProcessor(self.c).process(x, t)
        chunked_processor = EEGProcessor(self.c)
        chunked = []
        start = 0
        for size in [1, 9, 27, 3, 130, 2, 11] * 20:
            stop = min(len(x), start + size)
            chunked += chunked_processor.process(x[start:stop], t[start:stop])
            start = stop
            if start == len(x):
                break
        chunked += chunked_processor.process(x[start:], t[start:])
        self.assertEqual(whole, chunked)
        self.assertEqual(len(whole), 150)

    def test_frequency_response_drift_and_mains_rejected(self):
        p = EEGProcessor(replace(self.c, notch_hz=60))
        t = np.arange(125 * 30) / 125
        gains = {}
        for hz in (0.1, 10, 60):
            y = sosfilt(p.sos, np.sin(2 * np.pi * hz * t))[125 * 10:]
            gains[hz] = np.sqrt(np.mean(y * y)) / np.sqrt(0.5)
        self.assertGreater(gains[10], 0.9)
        self.assertLess(gains[0.1], 0.02)
        self.assertLess(gains[60], 0.01)

    def test_combined_signal_retains_ten_hz(self):
        p = EEGProcessor(replace(self.c, notch_hz=60))
        t = np.arange(125 * 30) / 125
        target = np.sin(2 * np.pi * 10 * t)
        mixed = target + 20 * np.sin(2 * np.pi * 0.1 * t) + 4 * np.sin(2 * np.pi * 60 * t)
        clean = sosfilt(p.sos, target)[125 * 10:]
        filtered = sosfilt(p.sos, mixed)[125 * 10:]
        self.assertLess(np.sqrt(np.mean((filtered-clean)**2)), 0.2)

    def test_one_burst_has_one_event(self):
        t, x = self.wave(15)
        x[(t >= 8) & (t < 9)] *= 10
        out = EEGProcessor(self.c).process(x, t)
        events = [u for u in out if u.reaction_event]
        self.assertEqual(len(events), 1)
        self.assertGreater(events[0].timestamp, 8)
        self.assertLess(events[0].timestamp, 8.6)

    def test_refractory_and_rearm(self):
        t, x = self.wave(18)
        for start, end in [(8, 8.4), (9, 9.4), (13, 13.5)]:
            x[(t >= start) & (t < end)] *= 10
        out = EEGProcessor(self.c).process(x, t)
        events = [u.timestamp for u in out if u.reaction_event]
        self.assertEqual(len(events), 2)
        self.assertTrue(all(b-a >= self.c.refractory_seconds for a,b in zip(events,events[1:])))

    def test_gap_masks_recovery_and_never_triggers(self):
        t, x = self.wave(12)
        t[t >= 7] += 1
        out = EEGProcessor(self.c).process(x, t)
        recovery = [u for u in out if 8 <= u.timestamp < 10]
        self.assertTrue(recovery)
        self.assertTrue(all("sample_gap" in u.quality_reasons for u in recovery))
        self.assertFalse(any(u.reaction_event for u in out))

    def test_flatline_does_not_calibrate_or_trigger(self):
        out = EEGProcessor(self.c).process(np.zeros(125 * 12))
        self.assertFalse(out[-1].calibrated)
        self.assertIn("flatline", out[-1].quality_reasons)
        self.assertFalse(any(u.reaction_event for u in out))

    def test_clipping_and_nonfinite_are_gated(self):
        t, x = self.wave(14)
        x[(t >= 8) & (t < 8.3)] = 1000
        x[(t >= 11) & (t < 11.3)] = np.nan
        out = EEGProcessor(self.c).process(x, t)
        self.assertTrue(any("clipping" in u.quality_reasons for u in out))
        self.assertTrue(any("nonfinite" in u.quality_reasons for u in out))
        self.assertFalse(any(u.reaction_event for u in out))
        self.assertTrue(all(np.isfinite(u.intensity) for u in out))

    def test_flatline_reconnection_masks_transient(self):
        t, x = self.wave(16)
        x[(t >= 8) & (t < 11)] = 0
        x[t >= 11] += 150
        out = EEGProcessor(self.c).process(x, t)
        self.assertTrue(any("flatline_recovery" in u.quality_reasons for u in out))
        self.assertFalse(any(u.reaction_event for u in out))

    def test_unknown_adc_range_suppresses_events(self):
        t, x = self.wave(15)
        out = EEGProcessor(replace(self.c, adc_full_scale_uv=None)).process(x)
        self.assertTrue(all("adc_range_unknown" in u.quality_reasons for u in out))
        self.assertFalse(any(u.reaction_event for u in out))

    def test_zero_mad_floor_gives_finite_score(self):
        c = replace(self.c, highpass_order=1, lowpass_order=1)
        t, x = self.wave(20)
        p = EEGProcessor(c)
        out = p.process(x)
        self.assertTrue(p.calibrated)
        self.assertGreaterEqual(p._baseline_scale, c.mad_floor_uv)
        self.assertTrue(all(np.isfinite(u.reaction_score) for u in out))

    def test_bench_sources_never_emit_human_event(self):
        t, x = self.wave(15)
        x[(t >= 8) & (t < 9)] *= 10
        for source in ("synthetic", "internal_test", "shorted_input"):
            out = EEGProcessor(self.c).process(x, source=source)
            self.assertFalse(any(u.reaction_event for u in out))
            self.assertTrue(any(u.test_event for u in out))

    def test_source_change_restarts_calibration(self):
        _, x = self.wave(8)
        p = EEGProcessor(self.c)
        p.process(x, source="synthetic")
        self.assertTrue(p.calibrated)
        out = p.process(x[:125], source="hardware")
        self.assertFalse(p.calibrated)
        self.assertFalse(any(u.reaction_event for u in out))

    def test_parameter_and_timestamp_validation(self):
        for kwargs in ({"lowpass_hz": 63}, {"notch_hz": 62.5},
                       {"mad_floor_uv": 0}, {"sample_rate": 0},
                       {"release_z": 5}, {"trigger_updates": 0}):
            with self.assertRaises(ValueError):
                ProcessingConfig(**kwargs)
        p = EEGProcessor(self.c)
        with self.assertRaises(ValueError):
            p.process([1, 2], [0])
        with self.assertRaises(ValueError):
            p.process([1], [float("nan")])
        with self.assertRaises(ValueError):
            p.process([1], source="fear")


if __name__ == "__main__":
    unittest.main()
