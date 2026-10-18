"""Software-only live controller tests; no transport, serial, or device calls."""
import copy
import threading
import unittest
import uuid

from backend.live_detector import ACTIVE_STAGE, EXPECTED_MUX, THRESHOLD, LiveDetectorController


class Clock:
    def __init__(self): self.value = 100.0
    def __call__(self): return self.value
    def advance(self, amount): self.value += amount


class Feed:
    def __init__(self):
        self.current = {"session": 0, "completed": False, "input_context": "nonhuman_object_surface",
                        "sample_age_seconds": None, "phases": []}
    def state(self): return copy.deepcopy(self.current)
    def phase(self, session=1):
        self.current.update(session=session, sample_age_seconds=0, completed=False,
                            phases=[{"id": f"{session}:1", "mux_requested": EXPECTED_MUX,
                                     "read_mode": "RDATA", "samples": [], "frame_count": 0}])
    def sample(self, sequence, micros, counts=0):
        phase = self.current["phases"][-1]
        phase["samples"].append({"sequence": sequence, "read_micros": micros,
                                 "status_hex": "000000", "counts": [counts, 0]})
        phase["frame_count"] += 1
        self.current["sample_age_seconds"] = 0


class Recorder:
    def __init__(self, feed):
        self.feed = feed
        self.current = {"active": False, "stage": "idle", "run_id": None}
        self.enabled = True
        self.starts, self.stops = [], 0
    def state(self): return copy.deepcopy(self.current)
    def start(self, nonhuman_surface_only, *, record_to_disk):
        if nonhuman_surface_only is not True: raise ValueError("Need nonhuman confirmation")
        self.starts.append(record_to_disk)
        self.current = {"active": True, "stage": "starting", "run_id": f"run{len(self.starts)}",
                        "capture_session_baseline": self.feed.current["session"]}
        return self.state()
    def stop(self):
        self.stops += 1
        self.current["stage"] = "stop_requested"
        return self.state()


class LiveDetectorTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.feed, self.events = Clock(), Feed(), []
        self.recorder = Recorder(self.feed)
        self.controller = LiveDetectorController(self.feed, self.recorder, on_event=self.events.append,
                                                clock=self.clock, wall_clock=self.clock, background=False)
        self.sequence, self.micros = 0, 8000

    def start(self):
        self.controller.start(True)
        # Starting state polls must not prevent the first fresh baseline from arming.
        self.controller.process_once()
        self.recorder.current["stage"] = ACTIVE_STAGE
        self.feed.phase(len(self.recorder.starts))
        self.add(0)

    def add(self, counts, *, dt=.008):
        self.clock.advance(dt)
        self.micros += round(dt * 1e6)
        self.feed.sample(self.sequence, self.micros, counts)
        self.sequence += 1
        self.controller.process_once()

    def low(self, duration, count=0):
        for _ in range(round(duration / .008) + 1): self.add(count)

    def test_preset_initial_baseline_and_single_burst(self):
        self.start()
        self.assertEqual(self.events, [])
        self.assertTrue(self.controller.state()["detector"]["armed"])
        self.add(4000000)
        self.assertEqual(len(self.events), 1)
        for i in range(100): self.add(0 if i % 2 else 4000000)
        self.assertEqual(len(self.events), 1)
        packet = self.events[0]
        self.assertEqual(packet["threshold"], THRESHOLD)
        self.assertEqual(packet["control_value"], 1)
        self.assertEqual(packet["event"], "reaction")
        self.assertFalse(packet["valid_measurement"])
        self.assertEqual(packet["quality"], "unverified")
        self.assertEqual(packet["id"], str(uuid.UUID(packet["id"])))
        self.assertEqual(self.recorder.starts, [False])

    def test_rearm_requires_quiet_interval_and_cooldown(self):
        self.start(); self.add(4000000)
        self.low(.3)
        self.add(4000000)  # A new burst before cooldown is discarded, not delayed.
        self.assertEqual(len(self.events), 1)
        for i in range(650): self.add(0 if i % 2 else 4000000)
        self.assertEqual(len(self.events), 1)
        self.low(.3)
        self.add(4000000)
        self.assertEqual(len(self.events), 2)

    def test_stale_frames_recovery_and_reset_never_replay_backlog(self):
        self.start()
        self.feed.current["sample_age_seconds"] = 1.1
        self.controller.process_once()
        self.add(4000000)
        self.add(0)
        self.assertEqual(self.events, [])
        self.low(.3); self.add(4000000)
        self.assertEqual(len(self.events), 1)
        self.clock.advance(6)
        self.feed.phase(2)
        self.sequence, self.micros = 0, 0
        self.add(4000000); self.add(0)
        self.assertEqual(len(self.events), 1)
        self.low(.3); self.add(4000000)
        self.assertEqual(len(self.events), 2)

    def test_gap_and_sequence_discontinuity_have_no_cross_gap_trigger(self):
        self.start()
        self.add(4000000, dt=.1)
        self.assertEqual(self.events, [])
        self.low(.3)
        self.sequence += 2
        self.add(4000000)
        self.assertEqual(self.events, [])
        self.low(.3); self.add(4000000)
        self.assertEqual(len(self.events), 1)

    def test_old_session_wrong_phase_or_stopping_cannot_trigger(self):
        self.start()
        self.feed.current["phases"][-1]["mux_requested"] = "OTHER"
        self.add(4000000)
        self.assertEqual(self.events, [])
        self.feed.current["phases"][-1]["mux_requested"] = EXPECTED_MUX
        self.recorder.current["stage"] = "reconnecting"
        self.add(0)
        self.assertEqual(self.events, [])
        self.assertFalse(self.controller.state()["acquisition"]["receiving"])

    def test_stop_generation_and_external_run_ownership(self):
        self.start()
        generation = self.controller.state()["generation"]
        self.controller.stop()
        self.add(4000000)
        self.assertEqual(self.events, [])
        self.assertEqual(self.recorder.stops, 1)
        self.assertFalse(self.controller.state()["active"])
        with self.assertRaises(RuntimeError): self.controller.start(True)
        self.recorder.current["active"] = False
        self.assertEqual(self.controller.state()["acquisition"]["state"], "off")
        self.assertFalse(self.controller.state()["stopping"])
        self.assertTrue(self.controller.state()["enabled"])
        self.start()
        self.feed.sample(self.sequence, self.micros + 8000, 4000000)
        self.controller.process_once(generation=generation)
        self.assertEqual(self.events, [])
        self.recorder.current["run_id"] = "other-owner"
        self.controller.stop()
        self.assertEqual(self.recorder.stops, 1)

    def test_callback_failure_is_dropped_without_replay(self):
        calls = []
        def fail(packet):
            calls.append(packet)
            raise RuntimeError("failed")
        self.controller.on_event = fail
        self.start(); self.add(4000000)
        for _ in range(20): self.controller.process_once()
        self.assertEqual(len(calls), 1)
        self.assertIn("without replay", self.controller.state()["error"])

    def test_stop_and_callback_are_serialized(self):
        entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
        def callback(packet):
            entered.set(); release.wait(2); self.events.append(packet)
        self.controller.on_event = callback
        self.start()
        thread = threading.Thread(target=self.add, args=(4000000,))
        thread.start()
        self.assertTrue(entered.wait(1))
        stopper = threading.Thread(target=lambda: (self.controller.stop(), stopped.set()))
        stopper.start()
        self.assertFalse(stopped.wait(.02))
        release.set(); thread.join(1); stopper.join(1)
        self.assertTrue(stopped.is_set())
        self.add(0)
        self.assertEqual(len(self.events), 1)

    def test_invalid_controls_and_recording_opt_in(self):
        for value in (float("nan"), float("inf"), -1, 2, True, "1"):
            with self.assertRaises(ValueError): self.controller.configure(control_value=value)
        with self.assertRaises(ValueError): self.controller.start(True, record_to_disk="false")
        self.controller.start(True, record_to_disk=True, control_value=.6)
        self.assertEqual(self.recorder.starts, [True])
        self.assertEqual(self.controller.state()["value"], .6)


if __name__ == "__main__": unittest.main()
