"""Controller/sender integration with fake transport; no HTTP or hardware calls."""
import copy
import json
import threading
import unittest
import uuid

from backend.live_detector import PRESET, REARM_THRESHOLD, THRESHOLD
from backend.live_link import LiveModeService
from backend.partner_sender import AUTOMATIC_CAPABILITY, PartnerSender
from backend.test_partner_sender import FakeLink


class FakeController:
    def __init__(self, bench_log, recorder, *, on_event):
        self.on_event = on_event
        self.current = {"active": False, "generation": 0, "session_id": None,
                        "preset": PRESET, "value": 1,
                        "detector": {"threshold": THRESHOLD, "rearm_threshold": REARM_THRESHOLD}}
        self.stops = 0

    def state(self): return copy.deepcopy(self.current)

    def start(self, *, nonhuman_surface_only, record_to_disk, control_value):
        if nonhuman_surface_only is not True:
            raise ValueError("Expected nonhuman source confirmation")
        self.current.update(active=True, generation=self.current["generation"] + 1,
                            session_id=str(uuid.uuid4()), value=control_value,
                            record_to_disk=record_to_disk)
        return self.state()

    def stop(self):
        self.stops += 1
        self.current.update(active=False, generation=self.current["generation"] + 1)
        return self.state()

    def configure(self, *, control_value): self.current["value"] = control_value


class LiveModeServiceTests(unittest.TestCase):
    def setUp(self):
        self.remote = FakeLink()
        self.remote.automatic_capability = copy.deepcopy(AUTOMATIC_CAPABILITY)
        self.sender = PartnerSender(request=self.remote.request, clock=self.remote.clock)
        self.sender.configure("http://192.168.1.20:48081", self.remote.secret)
        self.sender.check()
        self.local_calls = []
        self.service = LiveModeService(None, None, request=self.request,
                                       controller_factory=FakeController)

    def request(self, path, payload=None):
        self.local_calls.append((path, copy.deepcopy(payload)))
        if path == "/state": return self.sender.state()
        if path == "/automatic/start": return self.sender.automatic_start(payload)
        if path == "/automatic/stop": return self.sender.automatic_stop()
        if path == "/threshold": return self.sender.threshold(payload)
        raise AssertionError("Unexpected local route: " + path)

    def event(self, **changes):
        state = self.service.controller.state()
        event = {"id": str(uuid.uuid4()), "created_at_ms": int(self.remote.now * 1000),
                 "generation": state["generation"], "session_id": state["session_id"],
                 "preset": PRESET, "threshold": THRESHOLD, "rearm_threshold": REARM_THRESHOLD,
                 "score": THRESHOLD + .1, "event": "reaction", "control_value": state["value"],
                 "quality": "unverified", "valid_measurement": False, "reaction_validated": False}
        event.update(changes)
        return event

    def start(self, value=1):
        return self.service.start(nonhuman_surface_only=True, record_to_disk=False, value=value)

    def test_canonical_controller_packet_becomes_accepted_v2_event(self):
        state = self.start(.7)
        self.assertTrue(state["forwarding"]["allowed"])
        event = self.event()
        result = self.service.controller.on_event(event)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(len(self.remote.posts), 1)
        packet = self.remote.posts[0]
        self.assertEqual(packet["id"], event["id"])
        self.assertEqual(packet["schema"], "signal-scope.event.v2")
        self.assertEqual(packet["value"], .7)
        self.assertEqual(packet["event"], "reaction")
        self.assertEqual(packet["source"], "threshold_detector")
        self.assertIsNone(packet["emotion"])
        self.assertFalse(packet["detector"]["valid_measurement"])
        self.assertEqual(self.service.state()["latest_event"]["status"], "accepted")

    def test_remote_owner_stop_never_stops_another_run(self):
        owner = str(uuid.uuid4())
        self.service.start(nonhuman_surface_only=True, owner_id=owner)
        self.assertEqual(self.service.state()['owner_id'], owner)
        cancelled=self.service.stop(owner_id=str(uuid.uuid4()))
        self.assertTrue(cancelled['owner_cancelled'])
        self.assertTrue(self.service.state()['active'])
        self.service.stop(owner_id=owner)
        self.assertFalse(self.service.state()['active'])
        with self.assertRaises(ValueError):
            self.service.start(nonhuman_surface_only=True, owner_id=owner)

    def test_invalid_owner_does_not_start_and_local_stop_remains_available(self):
        with self.assertRaises(ValueError):
            self.service.start(nonhuman_surface_only=True, owner_id='not-a-uuid')
        self.assertFalse(self.service.state()['active'])
        self.service.start(nonhuman_surface_only=True, owner_id=str(uuid.uuid4()))
        self.service.stop()
        self.assertFalse(self.service.state()['active'])

    def test_owner_stop_before_delayed_start_cancels_that_command(self):
        owner = str(uuid.uuid4())
        result=self.service.stop(owner_id=owner)
        self.assertTrue(result['owner_cancelled'])
        self.assertEqual(result['cancelled_owner_id'],owner)
        with self.assertRaises(ValueError):
            self.service.start(nonhuman_surface_only=True, owner_id=owner)
        self.assertFalse(self.service.state()['active'])

    def test_missing_capability_blocks_and_recovery_does_not_replay(self):
        self.remote.automatic_capability = None
        self.sender.check()
        self.assertFalse(self.start()["forwarding"]["allowed"])
        self.service.on_event(self.event())
        self.assertEqual(self.remote.posts, [])
        self.remote.automatic_capability = copy.deepcopy(AUTOMATIC_CAPABILITY)
        self.sender.check()
        self.service.refresh()
        self.assertTrue(self.service.state()["forwarding"]["allowed"])
        self.assertEqual(self.remote.posts, [])
        self.service.on_event(self.event())
        self.assertEqual(len(self.remote.posts), 1)

    def test_stale_generation_session_and_inactive_events_drop_locally(self):
        self.start()
        current = self.event()
        for changes in ({"generation": current["generation"] - 1}, {"session_id": str(uuid.uuid4())}):
            self.assertEqual(self.service.on_event(self.event(**changes))["status"], "not_sent")
        self.service.controller.current["active"] = False
        self.assertEqual(self.service.on_event(current)["status"], "not_sent")
        self.assertFalse(any(path == "/threshold" for path, _ in self.local_calls))
        self.assertEqual(self.remote.posts, [])

    def test_old_timestamp_rejected_by_real_sender(self):
        self.start()
        result = self.service.on_event(self.event(created_at_ms=int((self.remote.now - 3) * 1000)))
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "stale_event")
        self.assertEqual(self.remote.posts, [])

    def test_stop_then_restart_does_not_replay_old_events_or_sessions(self):
        self.start()
        old = self.event()
        old_sender_session = self.service.session
        self.service.stop()
        self.assertFalse(self.sender.state()["automatic"]["active"])
        self.assertFalse(self.service.state()["active"])
        self.service.on_event(old)
        self.service.refresh()
        self.assertEqual(self.remote.posts, [])
        self.start()
        self.assertNotEqual(self.service.session, old_sender_session)
        self.service.on_event(old)
        self.assertEqual(self.remote.posts, [])
        self.service.on_event(self.event())
        self.assertEqual(len(self.remote.posts), 1)

    def test_failed_delivery_is_never_retried(self):
        self.start()
        self.remote.delivery_fails = True
        failed = self.service.on_event(self.event())
        self.assertEqual(failed["status"], "failed")
        self.remote.delivery_fails = False
        for _ in range(3): self.service.refresh()
        self.assertEqual(len(self.remote.posts), 1)
        self.remote.now += 5
        self.sender.check()
        self.service.on_event(self.event())
        self.assertEqual(len(self.remote.posts), 2)

    def test_public_state_excludes_sender_session_and_token(self):
        self.start()
        sender_session = self.service.session
        self.service.on_event(self.event())
        public = json.dumps(self.service.state())
        self.assertNotIn(sender_session, public)
        self.assertNotIn(self.remote.secret, public)
        self.assertNotIn('"session":', public)
        # The nonsecret controller session is distinct from sender authorization.
        self.assertNotEqual(sender_session, self.service.state()["session_id"])

    def test_missing_sender_update_does_not_send(self):
        original = self.service.request
        self.service.request = lambda path, payload=None: {"configured": True} if path == "/state" else original(path, payload)
        self.assertFalse(self.start()["forwarding"]["allowed"])
        self.service.on_event(self.event())
        self.assertEqual(self.remote.posts, [])
        self.assertIn("update", self.service.state()["forwarding"]["reason"])

    def test_stop_during_delayed_start_cancels_sender_session(self):
        entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
        original = self.service.request
        def delayed(path, payload=None):
            if path == "/automatic/start":
                entered.set()
                if not release.wait(2): raise TimeoutError("test release timed out")
            return original(path, payload)
        self.service.request = delayed
        errors = []
        def start():
            try: self.start()
            except Exception as exc: errors.append(exc)
        thread = threading.Thread(target=start)
        thread.start()
        self.assertTrue(entered.wait(1))
        stopper = threading.Thread(target=lambda: (self.service.stop(), stopped.set()))
        stopper.start()
        self.assertFalse(stopped.wait(.02))
        release.set()
        thread.join(2)
        stopper.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertTrue(stopped.is_set())
        self.assertEqual(errors, [])
        self.assertFalse(self.service.state()["active"])
        self.assertFalse(self.service.state()["forwarding"]["allowed"])
        self.assertFalse(self.sender.state()["automatic"]["active"])
        self.assertEqual(self.remote.posts, [])

    def test_suspended_session_requires_explicit_stop_and_start(self):
        self.start()
        old = self.event()
        self.sender.automatic_stop(suspend=True)
        self.service.refresh()
        self.assertFalse(self.service.state()["forwarding"]["allowed"])
        self.assertTrue(self.service.restart_required)
        for _ in range(3): self.service.refresh()
        self.service.on_event(old)
        self.assertFalse(self.sender.state()["automatic"]["active"])
        self.assertEqual(self.remote.posts, [])
        self.service.stop()
        self.start()
        self.assertTrue(self.service.state()["forwarding"]["allowed"])
        self.service.on_event(old)
        self.assertEqual(self.remote.posts, [])
        self.service.on_event(self.event())
        self.assertEqual(len(self.remote.posts), 1)


if __name__ == "__main__": unittest.main()
