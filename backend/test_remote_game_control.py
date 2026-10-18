"""Offline game-control tests. No live services, credentials, firmware or serial."""
import copy
import json
import io
import threading
import unittest
import uuid

from backend.remote_game_control import (CONTROL_CAPABILITY, START_PAYLOAD, RemoteGameControl,
                                         capability_supported, sse_messages, validate_command)


class FakeServices:
    def __init__(self):
        self.now = 1000.0
        self.mono = 50.0
        self.config = {"target": "http://192.168.1.20:48080", "token": "test-only-remote-control-secret",
                       "capabilities": {"acquisition_control": copy.deepcopy(CONTROL_CAPABILITY)}}
        self.local = {"active": False, "stopping": False, "session_id": None, "run_id": None,
                      "owner_id": None, "acquisition": {"receiving": False}, "forwarding": {"allowed": False}}
        self.local_calls, self.acks = [], []
        self.local_fail = None
        self.ack_fail = False
        self.start_ready = False
        self.start_then_timeout = False
        self.delay_start = None
        self.stop_keeps_stopping = False

    def local_request(self, path, payload=None):
        self.local_calls.append((path, copy.deepcopy(payload)))
        if self.local_fail == path:
            raise OSError("Never expose " + self.config["token"])
        if path == "/api/live-detection":
            return copy.deepcopy(self.local)
        if path == "/api/live-detection/start":
            if self.delay_start:
                entered, release = self.delay_start
                entered.set()
                if not release.wait(2):
                    raise TimeoutError("Test was not released")
            if self.local["active"]:
                raise ValueError("Local active")
            self.local.update(active=True, stopping=False, session_id=str(uuid.uuid4()), run_id="test-run-" + str(uuid.uuid4()),
                              owner_id=payload["owner_id"], acquisition={"receiving": self.start_ready},
                              forwarding={"allowed": self.start_ready})
            if self.start_then_timeout:
                raise TimeoutError("reply lost " + self.config["token"])
            return copy.deepcopy(self.local)
        if path == "/api/live-detection/stop":
            if self.local.get("owner_id") != payload.get("owner_id"):
                raise ValueError("Owner mismatch")
            self.local.update(active=False, stopping=self.stop_keeps_stopping)
            return copy.deepcopy(self.local)
        raise AssertionError("Unexpected local route")

    def remote_request(self, url, payload, token):
        self.acks.append((url, copy.deepcopy(payload), token))
        if self.ack_fail:
            raise OSError("Do not expose " + token)
        return {"ok": True}

    def manager(self):
        manager = RemoteGameControl(lambda: copy.deepcopy(self.config), self.local_request, self.remote_request,
                                    clock=lambda: self.now, monotonic=lambda: self.mono, background=False)
        manager.enable(True)
        manager._connection_ready(manager._config())
        return manager

    def command(self, action="start", round_id=None, **changes):
        packet = {"schema": "signal-scope.control.v1", "id": str(uuid.uuid4()), "action": action,
                  "round_id": round_id or str(uuid.uuid4()), "created_at_ms": int(self.now * 1000)}
        packet.update(changes)
        return packet

    def statuses(self):
        return [ack[1]["status"] for ack in self.acks]


class CommandContractTests(unittest.TestCase):
    def setUp(self): self.fake = FakeServices()

    def test_exact_capability_and_command(self):
        self.assertTrue(capability_supported(CONTROL_CAPABILITY))
        for key in CONTROL_CAPABILITY:
            cap = dict(CONTROL_CAPABILITY); del cap[key]
            self.assertFalse(capability_supported(cap))
        self.assertFalse(capability_supported(dict(CONTROL_CAPABILITY, actions=["stop", "start"])))
        packet = self.fake.command()
        self.assertEqual(validate_command(packet, 1000000), packet)

    def test_rejects_malformed_or_stale_commands(self):
        packet = self.fake.command()
        for change in [{"schema": "other"}, {"action": "body_start"}, {"extra": True}, {"id": "not-uuid"},
                       {"round_id": str(uuid.uuid1())}, {"created_at_ms": True}, {"created_at_ms": 1000000.0},
                       {"created_at_ms": -1}, {"created_at_ms": 996999}, {"created_at_ms": 1000001}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_command(dict(packet, **change), 1000000)
        self.assertEqual(validate_command(dict(packet, created_at_ms=997000), 1000000)["created_at_ms"], 997000)

    def test_bounded_sse_comments_messages_and_incomplete_tail(self):
        packet = self.fake.command()
        lines = [b": heartbeat\n", b"\n", ("data: " + json.dumps(packet) + "\n").encode(), b"\n",
                 b"data: {\"incomplete\":true}\n"]
        self.assertEqual(list(sse_messages(lines)), [packet])
        self.assertEqual(list(sse_messages(["data: {\n", 'data: "x":1}\n', "\n"])), [{"x": 1}])
        with self.assertRaises(ValueError): list(sse_messages(["data:" + "x" * 4096]))
        with self.assertRaises(ValueError): list(sse_messages(["data:" + "x" * 3000, "data:" + "x" * 3000]))
        with self.assertRaises(ValueError): list(sse_messages(["data: nope\n", "\n"]))


class RemoteGameControlTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeServices()
        self.manager = self.fake.manager()

    def start(self, ready=False):
        self.fake.start_ready = ready
        command = self.fake.command()
        self.assertTrue(self.manager.accept(command)["accepted"])
        self.manager.tick()
        return command

    def stops(self):
        return [p for route, p in self.fake.local_calls if route.endswith("/stop")]

    def test_start_payload_is_fixed_nonhuman_no_disk_and_owned(self):
        command = self.start()
        start = next(payload for route, payload in self.fake.local_calls if route.endswith("/start"))
        self.assertEqual(start, dict(START_PAYLOAD, owner_id=command["id"]))
        self.assertTrue(self.manager.state()["owned"])
        self.assertEqual(self.fake.statuses(), ["starting"])
        self.assertEqual(self.manager.state()["last_command"]["id"], command["id"])

    def test_running_waits_for_receiving_and_forwarding(self):
        self.start()
        self.fake.local["acquisition"]["receiving"] = True
        self.manager.tick()
        self.assertNotIn("running", self.fake.statuses())
        self.fake.local["forwarding"]["allowed"] = True
        self.manager.tick(); self.manager.tick()
        self.assertEqual(self.fake.statuses().count("running"), 1)
        self.assertEqual(self.manager.state()["status"], "running")

    def test_duplicate_and_closed_round_never_restart(self):
        command = self.start(True)
        self.assertEqual(self.manager.accept(command)["reason"], "duplicate")
        stop = self.fake.command("stop", command["round_id"])
        self.manager.accept(stop); self.manager.tick()
        self.assertFalse(self.manager.state()["owned"])
        self.assertEqual(self.stops(), [{"owner_id": command["id"]}])
        self.assertEqual(self.manager.accept(self.fake.command(round_id=command["round_id"]))["reason"], "round_already_closed")
        self.manager.tick()
        self.assertEqual(len([r for r, _ in self.fake.local_calls if r.endswith("/start")]), 1)

    def test_stop_before_pending_start_cancels_without_local_start(self):
        start = self.fake.command(); self.manager.accept(start)
        self.manager.accept(self.fake.command("stop", start["round_id"]))
        self.manager.tick()
        self.assertEqual(self.fake.local_calls, [])
        self.assertEqual(self.fake.statuses(), ["stopped"])

    def test_stop_during_inflight_start_stops_once_start_returns(self):
        entered, release = threading.Event(), threading.Event()
        self.fake.delay_start = entered, release
        command = self.fake.command(); self.manager.accept(command)
        thread = threading.Thread(target=self.manager.tick); thread.start()
        self.assertTrue(entered.wait(1))
        self.assertTrue(self.manager.accept(self.fake.command("stop", command["round_id"]))["accepted"])
        self.manager.tick()  # concurrent worker is a no-op, not another local request
        release.set(); thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertFalse(self.fake.local["active"])
        self.assertFalse(self.manager.state()["owned"])
        self.assertEqual(len(self.stops()), 1)
        self.assertNotIn("running", self.fake.statuses())
        self.assertEqual(self.fake.statuses()[-1], "stopped")

    def test_disconnect_during_start_cleans_up_then_reconnect_does_not_start(self):
        entered, release = threading.Event(), threading.Event()
        self.fake.delay_start = entered, release
        command = self.fake.command(); self.manager.accept(command)
        thread = threading.Thread(target=self.manager.tick); thread.start(); self.assertTrue(entered.wait(1))
        self.manager.disconnect(); release.set(); thread.join(2)
        self.assertFalse(self.fake.local["active"])
        self.manager._connection_ready(self.manager._config())
        self.manager.tick()
        self.assertEqual(len([r for r, _ in self.fake.local_calls if r.endswith("/start")]), 1)
        self.assertEqual(self.manager.accept(command)["reason"], "duplicate")
        self.assertEqual(self.manager.accept(self.fake.command(round_id=command["round_id"]))["reason"], "round_already_closed")

    def test_start_timeout_recovers_owner_and_stops_that_run(self):
        self.fake.start_then_timeout = True
        command = self.start()
        self.assertFalse(self.fake.local["active"])
        self.assertFalse(self.manager.state()["owned"])
        self.assertEqual(self.stops(), [{"owner_id": command["id"]}])
        self.assertIn("failed", self.fake.statuses())
        self.assertNotIn(self.fake.config["token"], json.dumps(self.manager.state()))

    def test_unrelated_local_mode_is_never_started_over_or_stopped(self):
        self.fake.local.update(active=True, session_id="manual", run_id="manual-run", owner_id=None)
        command = self.start()
        self.assertFalse(self.manager.state()["owned"])
        self.assertEqual(self.fake.statuses(), ["failed"])
        self.manager.accept(self.fake.command("stop", command["round_id"]))
        self.manager.tick()
        self.assertTrue(self.fake.local["active"])
        self.assertEqual(self.stops(), [])

    def test_replaced_owner_never_stopped_even_same_session_identity(self):
        command = self.start(True)
        self.fake.local["owner_id"] = str(uuid.uuid4())
        self.manager.accept(self.fake.command("stop", command["round_id"]))
        self.manager.tick()
        self.assertEqual(self.stops(), [])
        self.assertTrue(self.fake.local["active"])
        self.assertEqual(self.fake.statuses()[-1], "rejected")

    def test_cross_round_stop_does_not_cancel_owned_run(self):
        self.start(True)
        self.assertEqual(self.manager.accept(self.fake.command("stop"))["reason"], "different_round")
        self.manager.tick()
        self.assertEqual(self.stops(), [])
        self.assertTrue(self.fake.local["active"])

    def test_stop_before_unseen_round_closes_it(self):
        stop = self.fake.command("stop")
        self.manager.accept(stop); self.manager.tick()
        self.assertEqual(self.manager.accept(self.fake.command(round_id=stop["round_id"]))["reason"], "round_already_closed")
        self.assertEqual(self.fake.local_calls, [])

    def test_no_command_backlog_and_malformed_input_never_reaches_local_api(self):
        pending = self.fake.command(); self.manager.accept(pending)
        for _ in range(3):
            self.assertEqual(self.manager.accept(self.fake.command())["reason"], "acquisition_busy")
        self.assertEqual(self.manager.accept(self.fake.command(created_at_ms=0))["reason"], "invalid_or_stale_command")
        self.manager.tick()
        self.assertEqual(len([r for r, _ in self.fake.local_calls if r.endswith("/start")]), 1)

    def test_disabling_stops_owned_only_and_cancels_future_commands(self):
        self.start(True); self.manager.enable(False); self.manager.tick()
        self.assertFalse(self.fake.local["active"])
        self.assertFalse(self.manager.state()["enabled"])
        self.assertEqual(self.manager.accept(self.fake.command())["reason"], "control_disconnected")

    def test_heartbeat_timeout_and_capability_loss_stop_owned_run(self):
        self.start(True); self.fake.mono += 12.01; self.manager.tick()
        self.assertFalse(self.fake.local["active"])
        self.assertFalse(self.manager.state()["connected"])
        self.manager._connection_ready(self.manager._config())
        self.start(True)
        self.fake.config["capabilities"] = {}; self.manager.tick()
        self.assertFalse(self.fake.local["active"])
        self.assertFalse(self.manager.state()["capable"])

    def test_startup_timeout_fails_and_cleans_up(self):
        self.start()
        self.fake.mono += 46
        # Heartbeats continue, but the local acquisition never becomes ready.
        self.manager.last_heartbeat = self.fake.mono
        self.manager.tick(); self.manager.tick()
        self.assertFalse(self.fake.local["active"])
        self.assertIn("failed", self.fake.statuses())
        self.assertNotIn("running", self.fake.statuses())

    def test_stopped_ack_waits_for_acquisition_cleanup(self):
        command = self.start(True); self.fake.stop_keeps_stopping = True
        self.manager.accept(self.fake.command("stop", command["round_id"]))
        self.manager.tick(); self.manager.tick()
        self.assertTrue(self.manager.state()["owned"])
        self.assertNotIn("stopped", self.fake.statuses())
        self.fake.local["stopping"] = False; self.manager.tick()
        self.assertFalse(self.manager.state()["owned"])
        self.assertEqual(self.fake.statuses().count("stopping"), 1)
        self.assertEqual(self.fake.statuses()[-1], "stopped")

    def test_ack_failures_do_not_replay_or_block_local_cleanup(self):
        self.fake.ack_fail = True
        command = self.start(True)
        self.manager.accept(self.fake.command("stop", command["round_id"]))
        self.manager.tick()
        sent = len(self.fake.acks)
        self.manager.tick(); self.manager.tick()
        self.assertEqual(len(self.fake.acks), sent)
        self.assertFalse(self.fake.local["active"])
        self.assertNotIn(self.fake.config["token"], json.dumps(self.manager.state()))

    def test_stop_failures_are_bounded_and_visible(self):
        command = self.start(True)
        self.fake.local_fail = "/api/live-detection/stop"
        self.manager.accept(self.fake.command("stop", command["round_id"]))
        for _ in range(10): self.manager.tick()
        self.assertLessEqual(len(self.stops()), 3)
        self.assertTrue(self.manager.state()["owned"])
        self.assertEqual(self.manager.state()["reason"], "stop_not_confirmed")
        self.assertEqual(self.fake.statuses().count("failed"), 1)

    def test_late_start_is_cleaned_up_after_initial_unknown_state(self):
        original = self.fake.local_request
        command = self.fake.command()
        def timeout_start(path, payload=None):
            if path.endswith('/start'):
                self.fake.local_calls.append((path, copy.deepcopy(payload)))
                raise TimeoutError('pending server operation')
            return original(path, payload)
        self.manager.local_request = timeout_start
        self.manager.accept(command); self.manager.tick()
        self.assertTrue(self.manager.state()['cleanup_pending'])
        self.assertFalse(self.manager.state()['owned'])
        self.assertNotIn('stopped', self.fake.statuses())
        self.fake.local.update(active=True, session_id='late-session', run_id='late-run', owner_id=command['id'])
        self.fake.mono += .5; self.manager.tick()
        self.assertFalse(self.fake.local['active'])
        self.assertFalse(self.manager.state()['cleanup_pending'])
        self.assertEqual(self.fake.statuses()[-1], 'stopped')

    def test_explicit_viewer_owner_tombstone_resolves_uncertain_start(self):
        original = self.fake.local_request
        command = self.fake.command()
        cancelled = set()
        def local(path, payload=None):
            if path.endswith('/start'):
                raise TimeoutError('delayed start did not reach viewer yet')
            if path.endswith('/stop'):
                cancelled.add(payload['owner_id'])
                return dict(self.fake.local, owner_cancelled=True, cancelled_owner_id=payload['owner_id'])
            return original(path, payload)
        self.manager.local_request = local
        self.manager.accept(command); self.manager.tick()
        self.assertIn(command['id'], cancelled)
        self.assertFalse(self.manager.state()['cleanup_pending'])
        self.assertEqual(self.fake.statuses(), ['starting', 'failed', 'stopped'])
        self.assertEqual(self.fake.acks[-1][1]['reason'], 'owner_cancelled')

    def test_unknown_start_window_expires_without_false_stopped_ack(self):
        self.fake.local_fail = '/api/live-detection/start'
        self.start()
        self.assertTrue(self.manager.state()['cleanup_pending'])
        self.fake.mono += 12.1
        self.manager.last_heartbeat = self.fake.mono
        self.manager.tick()
        self.assertFalse(self.manager.state()['cleanup_pending'])
        self.assertEqual(self.manager.state()['reason'], 'start_outcome_unknown_use_local_stop')
        self.assertNotIn('stopped', self.fake.statuses())
        self.assertEqual(self.fake.statuses()[-1], 'failed')

    def test_stop_failure_recovery_keeps_checking_after_three_failed_attempts(self):
        command = self.start(True)
        self.fake.local_fail = '/api/live-detection/stop'
        self.manager.accept(self.fake.command('stop', command['round_id']))
        for delta in [0, .5, 1, 2]:
            self.fake.mono += delta
            self.manager.last_heartbeat = self.fake.mono
            self.manager.tick()
        self.assertEqual(len(self.stops()), 4)
        self.assertTrue(self.manager.state()['owned'])
        # The last lost reply did in fact stop the server. A later GET must still confirm it.
        self.fake.local_fail = None
        self.fake.local.update(active=False, stopping=False)
        self.fake.mono += 4; self.manager.last_heartbeat = self.fake.mono
        self.manager.tick()
        self.assertFalse(self.manager.state()['owned'])
        self.assertEqual(self.fake.statuses()[-1], 'stopped')

    def test_running_downgrades_then_recovers_or_stops_on_readiness_loss(self):
        self.start(True)
        self.fake.local['acquisition']['receiving'] = False
        self.manager.tick()
        self.assertEqual(self.manager.state()['status'], 'degraded')
        self.fake.local['acquisition']['receiving'] = True
        self.manager.tick()
        self.assertEqual(self.manager.state()['status'], 'running')
        self.fake.local['forwarding']['allowed'] = False
        self.manager.tick()
        self.fake.mono += 15.1; self.manager.last_heartbeat = self.fake.mono
        self.manager.tick()
        self.assertFalse(self.fake.local['active'])
        self.assertFalse(self.manager.state()['owned'])
        self.assertIn('readiness_lost', [ack[1].get('reason') for ack in self.fake.acks])

    def test_remote_ack_cannot_delay_local_stop(self):
        command = self.start(True)
        original = self.fake.remote_request
        observed = []
        def remote(url, payload, token):
            if payload['status'] in ('stopping', 'stopped'):
                observed.append(self.fake.local['active'])
            return original(url, payload, token)
        self.manager.remote_request = remote
        self.manager.accept(self.fake.command('stop', command['round_id'])); self.manager.tick()
        self.assertEqual(observed, [False, False])

    def test_latest_stop_command_remains_visible_after_cleanup(self):
        start = self.start(True)
        stop = self.fake.command('stop', start['round_id'])
        self.manager.accept(stop); self.manager.tick()
        self.assertEqual(self.manager.state()['last_command']['id'], stop['id'])

    def test_blocking_stream_close_does_not_delay_owned_acquisition_stop(self):
        self.start(True)
        close_entered, release_close, disconnected = threading.Event(), threading.Event(), threading.Event()
        class BlockedStream:
            def close(self):
                close_entered.set()
                release_close.wait(2)
        self.manager.stream = BlockedStream()
        def disconnect():
            self.manager.disconnect()
            disconnected.set()
        caller = threading.Thread(target=disconnect)
        caller.start()
        try:
            self.assertTrue(close_entered.wait(1))
            self.assertTrue(disconnected.wait(.2), 'disconnect waited for stream close')
            self.manager.tick()
            self.assertFalse(self.fake.local['active'])
            self.assertFalse(self.manager.state()['owned'])
            self.assertFalse(release_close.is_set())
        finally:
            release_close.set(); caller.join(1)
        self.assertFalse(caller.is_alive())

    def test_stream_uses_authenticated_fixed_route_and_eof_never_restarts(self):
        command = self.fake.command()
        factory_calls = []
        manager = self.manager
        class Stream(io.BytesIO):
            def __exit__(self, *args):
                manager.closed.set()
                return super().__exit__(*args)
        def factory(url, token):
            factory_calls.append((url, token))
            return Stream((': heartbeat\n\ndata: ' + json.dumps(command) + '\n\n').encode())
        manager.stream_factory = factory
        manager.run()
        self.assertEqual(factory_calls, [(self.fake.config['target'] + '/signal-link/control/events', self.fake.config['token'])])
        self.assertFalse(manager.state()['connected'])
        self.assertEqual(self.fake.local_calls, [])
        self.assertIsNone(manager.desired)
        self.assertIn(command['round_id'], manager.closed_rounds)

    def test_construction_and_disabled_state_perform_no_io(self):
        def never(*args):
            self.fail('Disabled controller unexpectedly performed I/O')
        manager = RemoteGameControl(never, never, never, stream_factory=never, background=False)
        self.assertFalse(manager.state()['enabled'])
        self.assertFalse(manager.state()['connected'])

    def test_public_state_and_ack_have_no_credentials(self):
        self.start(True)
        self.assertNotIn(self.fake.config["token"], json.dumps(self.manager.state()))
        for url, ack, token in self.fake.acks:
            self.assertEqual(url, self.fake.config["target"] + "/signal-link/control/ack")
            self.assertEqual(token, self.fake.config["token"])
            self.assertNotIn(token, json.dumps(ack))
            self.assertIs(type(ack["received_at_ms"]), int)


if __name__ == "__main__": unittest.main()
