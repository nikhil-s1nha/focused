import csv
from http.client import HTTPConnection
import io
import json
from pathlib import Path
import queue
import tempfile
import threading
import unittest
from unittest.mock import patch

from http.server import ThreadingHTTPServer

from backend.viewer_server import ViewerEngine, make_handler


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeSerial:
    def __init__(self, port):
        self.port = port
        self.closed = False
        self.lines = []

    def read_lines(self):
        result, self.lines = self.lines, []
        return result

    def close(self):
        self.closed = True


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.engine = ViewerEngine(clock=self.clock, monotonic=self.clock)

    def tearDown(self):
        self.engine.close()

    def advance(self, seconds):
        self.clock.advance(seconds)
        self.engine.tick()

    def test_default_is_obvious_demo_and_full_rate_two_channel(self):
        state = self.engine.state()
        self.assertEqual(state["source"], "synthetic")
        self.assertIn("no sensor", state["source_label"])
        self.assertFalse(state["body_acquisition_enabled"])
        self.advance(1)
        event = self.engine.publish()
        self.assertEqual(len(event["samples"]), 125)
        self.assertEqual(len(event["samples"][0]["raw_uv"]), 2)
        self.assertEqual(len(event["samples"][0]["filtered_uv"]), 2)
        self.assertTrue(all(s["source"] == "synthetic" for s in event["samples"]))
        self.assertAlmostEqual(event["samples"][1]["timestamp"]-
                               event["samples"][0]["timestamp"], .008)
        json.dumps(event, allow_nan=False)

    def test_recording_is_explicit_and_bounded_with_exports(self):
        self.advance(.2)
        self.engine.mark("Old source marker")
        self.assertEqual(self.engine.recording_state()["samples"], 0)
        self.engine.max_recording_samples = 10
        self.engine.set_recording(True)
        self.engine.mark("Test encounter")
        self.advance(.2)
        state = self.engine.recording_state()
        self.assertEqual(state["samples"], 10)
        self.assertFalse(state["active"])
        self.assertTrue(state["truncated"])
        exported = self.engine.export_json()
        self.assertIn("conversion_profiles", exported)
        rows = list(csv.DictReader(io.StringIO(self.engine.export_csv())))
        self.assertEqual(sum(row["kind"] == "sample" for row in rows), 10)
        self.assertTrue(any(row["marker"] == "Test encounter" for row in rows))

    def test_source_change_clears_pending_and_increments_generation(self):
        self.advance(.2)
        generation = self.engine.generation
        self.engine.switch_source("synthetic")
        event = self.engine.publish()
        self.assertEqual(event["samples"], [])
        self.assertGreater(event["generation"], generation)
        self.assertFalse(event["summary"]["calibrated"])
        self.assertTrue(all(m["generation"] == event["generation"] for m in event["markers"]))

    def test_serial_requires_explicit_port_and_failure_never_becomes_demo(self):
        with self.assertRaises(ValueError):
            self.engine.switch_source("internal_test")
        with patch("backend.viewer_server.SerialReader", side_effect=OSError("missing")):
            with self.assertRaises(ValueError):
                self.engine.switch_source("internal_test", "/dev/missing")
        state = self.engine.state()
        self.assertEqual(state["source"], "internal_test")
        self.assertEqual(state["mode"], "serial")
        self.assertEqual(state["status"], "error")
        self.advance(.2)
        self.assertEqual(self.engine.publish()["samples"], [])

    def test_serial_frames_preserve_bench_label_conversion_and_full_rate(self):
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("shorted_input", "/dev/example")
        for i in range(126):
            self.clock.advance(.008)
            self.engine.feed_serial(f"SHORTED_INPUT,{i},{i*8000},100,-200", self.clock())
        event = self.engine.publish()
        self.assertEqual(event["source"], "shorted_input")
        self.assertEqual(len(event["samples"]), 126)
        sample = event["samples"][-1]
        self.assertEqual(sample["raw_counts"], [100, -200])
        self.assertAlmostEqual(sample["raw_uv"][0], 100*2420000/6/(2**23))
        self.assertFalse(any(s.get("reaction_event") for s in event["summary"]["channels"]))

    def test_serial_recording_keeps_count_clock_conversion_and_channel_summary_provenance(self):
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("shorted_input", "/dev/example")
        self.engine.feed_serial("SHORTED_INPUT,0,8000,100,-200", self.clock())
        self.engine.set_recording(True)
        self.clock.advance(.008)
        self.engine.feed_serial("SHORTED_INPUT,1,16000,101,-201", self.clock())
        sample = self.engine.record_samples[-1]
        self.assertEqual(sample["device_read_micros"], 16000)
        self.assertEqual(sample["received_at"], self.clock())
        self.assertEqual(sample["raw_counts"], [101, -201])
        self.assertEqual(sample["generation"], self.engine.generation)
        self.assertAlmostEqual(sample["uv_per_count_nominal"], 2420000/6/(2**23))
        self.assertEqual(sample["conversion_profile"]["gain"], 6)
        self.assertEqual(sample["timestamp_basis"], "unwrapped_uno_host_read_clock")
        self.assertIn("not EEG", sample["source_label"])
        self.assertEqual(len(sample["latest_summaries"]), 2)
        self.assertTrue(all("timestamp" in summary for summary in sample["latest_summaries"]))
        rows = list(csv.DictReader(io.StringIO(self.engine.export_csv())))
        row = next(row for row in rows if row["kind"] == "sample")
        self.assertEqual(row["ch1_raw_counts"], "101")
        self.assertEqual(row["ch2_raw_counts"], "-201")
        self.assertEqual(row["device_read_micros"], "16000")
        self.assertEqual(float(row["received_at"]), self.clock())
        self.assertEqual(json.loads(row["conversion_profile_json"])["gain"], 6)
        json.dumps(self.engine.export_json(), allow_nan=False)

    def test_immediate_clipping_cannot_inherit_good_earlier_summary_on_either_channel(self):
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("internal_test", "/dev/example")
        self.engine.feed_serial("INTERNAL_TEST,0,8000,100,200", self.clock())
        self.engine.set_recording(True)
        # Controlled 10 Hz summary fixture, followed by full-rate raw frames
        # between summary ticks. The earlier good labels must remain timestamped.
        previous_time = self.engine.pending[-1]["timestamp"]
        for channel, summary in enumerate(self.engine.summaries):
            summary.update(timestamp=previous_time - channel*.001, signal_quality=1.0,
                           calibrated=True, quality_reasons=[])
        previous_summaries = [dict(s) for s in self.engine.summaries]
        for sequence, (channel, counts) in enumerate(((1, [100, 8388607]),
                                                     (0, [-8388608, 200])), 1):
            with self.subTest(channel=channel):
                self.clock.advance(.008)
                self.engine.feed_serial(
                    f"INTERNAL_TEST,{sequence},{8000*(sequence+1)},{counts[0]},{counts[1]}",
                    self.clock())
                sample = self.engine.record_samples[-1]
                self.assertEqual(sample["raw_quality_reasons"][channel], ["clipping"])
                self.assertEqual(sample["raw_quality_reasons"][1-channel], [])
                self.assertEqual(sample["signal_quality"], 0.0)
                self.assertEqual(sample["channel_signal_quality"][channel], 0.0)
                self.assertEqual(sample["channel_signal_quality"][1-channel], 1.0)
                self.assertEqual(sample["latest_summaries"], previous_summaries)
                self.assertTrue(all(s["timestamp"] < sample["timestamp"]
                                    for s in sample["latest_summaries"]))
                self.assertIn("immediate_raw_flags", sample["quality_scope"])
        sample_rows = [row for row in csv.DictReader(io.StringIO(self.engine.export_csv()))
                       if row["kind"] == "sample"]
        self.assertEqual(json.loads(sample_rows[0]["ch2_raw_flags"]), ["clipping"])
        self.assertEqual(float(sample_rows[0]["ch2_summary_quality"]), 1.0)
        self.assertLess(float(sample_rows[0]["ch2_summary_timestamp"]),
                        float(sample_rows[0]["timestamp"]))

    def test_nonfinite_raw_is_flagged_and_export_remains_strict_json(self):
        self.engine.set_recording(True)
        self.engine._append_sample(self.clock(), [float("nan"), float("inf")], 0)
        sample = self.engine.record_samples[-1]
        self.assertEqual(sample["raw_uv"], [None, None])
        self.assertEqual(sample["filtered_uv"], [None, None])
        self.assertEqual(sample["raw_quality_reasons"], [["nonfinite"], ["nonfinite"]])
        self.assertEqual(sample["signal_quality"], 0)
        self.assertTrue(all(s["timestamp"] is None for s in sample["latest_summaries"]))
        json.dumps(self.engine.export_json(), allow_nan=False)

    def test_csv_keeps_legacy_columns_and_does_not_invent_missing_provenance(self):
        legacy = {"timestamp": 1000, "source": "synthetic", "sequence": 1,
                  "raw_uv": [1.0, 2.0], "filtered_uv": [3.0, 4.0],
                  "signal_quality": .75, "calibrated": True}
        self.engine.record_samples.append(legacy)
        reader = csv.DictReader(io.StringIO(self.engine.export_csv()))
        self.assertEqual(reader.fieldnames[:11], ["timestamp", "source", "kind", "sequence",
                         "ch1_raw_uv", "ch1_filtered_uv", "ch2_raw_uv", "ch2_filtered_uv",
                         "signal_quality", "calibrated", "marker"])
        row = next(reader)
        self.assertEqual(row["signal_quality"], "0.75")
        self.assertEqual(row["calibrated"], "True")
        for name in ("ch1_raw_counts", "device_read_micros", "received_at", "generation",
                     "uv_per_count_nominal", "conversion_profile_json", "ch1_summary_timestamp"):
            self.assertEqual(row[name], "")
        self.assertEqual(self.engine.record_samples, [legacy])

    def test_record_start_rejects_unavailable_source_without_erasing_saved_data(self):
        self.engine.set_recording(True)
        self.advance(.1)
        self.engine.mark("Keep this recording annotation")
        self.engine.set_recording(False)
        samples, markers = list(self.engine.record_samples), list(self.engine.record_markers)
        for status in ("error", "connecting", "disconnected"):
            with self.subTest(status=status):
                self.engine.status = status
                with self.assertRaisesRegex(ValueError, "running source"):
                    self.engine.set_recording(True)
                self.assertEqual(self.engine.record_samples, samples)
                self.assertEqual(self.engine.record_markers, markers)
                self.assertFalse(self.engine.recording)
                self.engine.set_recording(False)  # Stop is always allowed.

    def test_stale_invalidates_and_recovery_starts_new_trace(self):
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("internal_test", "/dev/example")
        self.engine.feed_serial("INTERNAL_TEST,0,8000,100,200", self.clock())
        generation = self.engine.generation
        self.advance(2.1)
        state = self.engine.state()
        self.assertEqual(state["status"], "disconnected")
        self.assertEqual(state["summary"]["signal_quality"], 0)
        self.assertGreater(state["generation"], generation)
        self.assertEqual(self.engine.publish()["samples"], [])

    def test_metadata_mismatch_closes_reader_and_stops_samples(self):
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("shorted_input", "/dev/example")
        reader = self.engine.reader
        self.engine.feed_serial("CONFIG,SPS_500,GAIN_12,VREF_NOMINAL_V_2.42,MUX_SHORTED_BOTH", self.clock())
        self.assertTrue(reader.closed)
        self.assertIsNone(self.engine.reader)
        self.assertEqual(self.engine.status, "error")
        self.assertEqual(self.engine.summary()["signal_quality"], 0)

    def test_failed_initialization_preserves_exact_device_diagnostic(self):
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("internal_test", "/dev/example")
        for line in ("BENCH_TEST_ONLY,ELECTRODES_MUST_BE_DISCONNECTED",
                     "ERROR,BEGIN,3", "DEVICE_ID,0x31"):
            self.engine.feed_serial(line, self.clock())
        state = self.engine.state()
        self.assertEqual(state["status"], "error")
        self.assertIn("DEVICE_ID,0x31", state["message"])
        self.assertIn("expected DEVICE_ID,0x73", state["message"])
        self.assertIn("ERROR,BEGIN,3", state["message"])
        self.assertTrue(any(d["line"] == "ERROR,BEGIN,3" for d in state["diagnostics"]))
        self.assertEqual(self.engine.publish()["samples"], [])
        self.assertIsNone(self.engine.reader)

    def test_subscribers_are_bounded_and_start_with_state(self):
        listener = self.engine.subscribe()
        self.assertEqual(listener.get_nowait()["type"], "state")
        for _ in range(50):
            self.engine.publish()
        self.assertEqual(listener.qsize(), listener.maxsize)
        self.engine.unsubscribe(listener)
        self.assertFalse(self.engine.listeners)

    def test_pulse_is_explicitly_synthetic_and_calibration_breaks_trace(self):
        marker = self.engine.demo_pulse()
        self.assertIn("DEMO", marker["label"])
        previous = self.engine.generation
        self.engine.calibrate()
        self.assertGreater(self.engine.generation, previous)
        self.assertTrue(all(m["generation"] == self.engine.generation for m in self.engine.pending_markers))
        with patch("backend.viewer_server.SerialReader", FakeSerial):
            self.engine.switch_source("internal_test", "/dev/example")
        with self.assertRaises(ValueError):
            self.engine.demo_pulse()

    def test_delete_marker_removes_pending_history_and_export_keeps_samples(self):
        self.engine.set_recording(True)
        self.advance(.2)
        marker = self.engine.mark("Delete this encounter")
        samples_before = len(self.engine.record_samples)
        first, second = self.engine.subscribe(), self.engine.subscribe()
        first.get_nowait(); second.get_nowait()
        result = self.engine.delete_markers(marker_id=marker["id"])
        self.assertNotIn(marker, self.engine.pending_markers)
        self.assertNotIn(marker, self.engine.marker_history)
        self.assertNotIn(marker, self.engine.record_markers)
        self.assertNotIn("Delete this encounter", self.engine.export_csv())
        self.assertEqual(len(self.engine.record_samples), samples_before)
        for client in (first, second):
            self.assertEqual(client.get_nowait(), result)
        self.assertTrue(all(m["id"] != marker["id"] for m in self.engine.publish()["marker_history"]))

    def test_marker_ids_history_and_clear_all_are_authoritative(self):
        one = self.engine.mark("Blink")
        two = self.engine.mark("Blink")
        self.assertNotEqual(one["id"], two["id"])
        self.engine.set_recording(True)
        self.advance(.2)
        recorded = self.engine.mark("Old recording annotation")
        self.engine.set_recording(False)
        self.engine.switch_source("synthetic")
        self.assertNotIn(recorded, self.engine.marker_history)
        self.assertIn(recorded, self.engine.record_markers)
        self.engine.mark("Current unrecorded annotation")
        result = self.engine.delete_markers(all_markers=True)
        self.assertEqual(result["marker_history"], [])
        self.assertEqual(self.engine.record_markers, [])
        self.assertTrue(self.engine.record_samples)
        self.assertEqual(self.engine.subscribe().get_nowait()["marker_history"], [])
        with self.assertRaises(ValueError):
            self.engine.delete_markers()
        with self.assertRaises(ValueError):
            self.engine.delete_markers(marker_id="x", all_markers=True)

    def test_marker_history_is_bounded_for_reload(self):
        for i in range(510):
            self.engine.mark(str(i))
        history = self.engine.state()["marker_history"]
        self.assertEqual(len(history), 500)
        self.assertEqual(history[0]["label"], "10")
        self.assertEqual(self.engine.publish()["marker_history"], history)

    def test_export_restore_preserves_recording_without_serial_reconnect(self):
        self.engine.set_recording(True)
        self.advance(.2)
        self.engine.mark("Recorded demo mark")
        self.engine.set_recording(False)
        with patch("backend.viewer_server.SerialReader", side_effect=OSError("offline")):
            with self.assertRaises(ValueError):
                self.engine.switch_source("internal_test", "/dev/example")
        transient = self.engine.mark("Unrecorded visible mark")
        data = self.engine.export_json()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "saved.json")
            path.write_text(json.dumps(data))
            restored = ViewerEngine(clock=self.clock, monotonic=self.clock)
            with patch("backend.viewer_server.SerialReader", side_effect=AssertionError("must not open")):
                restored.restore_recording(path)
            self.assertIsNone(restored.reader)
            self.assertFalse(restored.recording)
            self.assertEqual(restored.status, "error")
            self.assertEqual(restored.record_samples, self.engine.record_samples)
            self.assertEqual(restored.record_markers, self.engine.record_markers)
            self.assertEqual(restored.marker_history[0]["id"], transient["id"])
            self.assertNotIn(transient, restored.record_markers)
            restored.delete_markers(marker_id=transient["id"])
            self.assertEqual(list(restored.marker_history), [])
            self.assertEqual(restored.record_markers, self.engine.record_markers)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.engine = ViewerEngine()
        self.directory = tempfile.TemporaryDirectory()
        Path(self.directory.name, "index.html").write_text("<title>Viewer test</title>")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.engine, self.directory.name))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.engine.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def request(self, method, path, payload=None, headers=None):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=2)
        body = None if payload is None else json.dumps(payload)
        conn.request(method, path, body=body,
                     headers=headers or {"Content-Type": "application/json"})
        response = conn.getresponse()
        status, data = response.status, response.read()
        conn.close()
        return status, data

    def test_state_control_and_static_end_to_end(self):
        status, body = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["source"], "synthetic")
        status, body = self.request("POST", "/api/recording", {"recording": True})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["active"])
        status, _ = self.request("POST", "/api/marker", {"label": "Door"})
        self.assertEqual(status, 200)
        status, body = self.request("GET", "/api/export.csv")
        self.assertIn(b"Door", body)
        status, body = self.request("GET", "/")
        self.assertIn(b"Viewer test", body)

    def test_rejects_unavailable_source_bad_input_and_cross_origin(self):
        self.assertEqual(self.request("POST", "/api/source", {"source": "hardware"})[0], 400)
        self.assertEqual(self.request("POST", "/api/recording", {"recording": "true"})[0], 400)
        self.assertEqual(self.request("POST", "/api/marker", {"label": ""})[0], 400)
        self.assertEqual(self.request("POST", "/api/calibrate", {},
            {"Content-Type": "application/json", "Origin": "https://example.com"})[0], 403)

    def test_http_marker_delete_is_persistent_and_export_annotations_removed(self):
        self.request("POST", "/api/recording", {"recording": True})
        status, body = self.request("POST", "/api/marker", {"label": "Delete via HTTP"})
        result = json.loads(body)
        self.assertEqual(status, 200)
        identifier = result["marker"]["id"]
        status, body = self.request("POST", "/api/markers/delete", {"id": identifier})
        self.assertEqual(status, 200)
        self.assertTrue(all(m["id"] != identifier for m in json.loads(body)["marker_history"]))
        _, body = self.request("GET", "/api/state")
        self.assertNotIn("Delete via HTTP", body.decode())
        _, body = self.request("GET", "/api/export.csv")
        self.assertNotIn("Delete via HTTP", body.decode())
        self.assertEqual(self.request("POST", "/api/markers/delete", {"all": True})[0], 200)

    def test_sse_emits_initial_state_and_full_batch(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=2)
        conn.request("GET", "/api/events")
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        line = response.fp.readline().decode()
        initial = json.loads(line.removeprefix("data: "))
        self.assertEqual(initial["type"], "state")
        response.fp.readline()
        self.engine.publish()
        event = json.loads(response.fp.readline().decode().removeprefix("data: "))
        self.assertEqual(event["type"], "samples")
        self.assertEqual(event["source"], "synthetic")
        response.close()
        conn.close()


if __name__ == "__main__":
    unittest.main()
