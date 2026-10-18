"""Software-only sender tests: no serial, capture process, or live HTTP requests."""
import copy
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

from backend.partner_sender import AUTOMATIC_CAPABILITY, CONTROL_CAPABILITY, PartnerSender, handler_for
import uuid


class FakeLink:
    def __init__(self):
        self.now = 1000.0
        self.scope = {"run_id": "run-a", "markers": []}
        self.scope_fails = False
        self.delivery_fails = False
        self.calls = []
        self.posts = []
        self.automatic_capability = None
        self.secret = "private-test-token-24-characters"

    def clock(self):
        return self.now

    def request(self, url, payload=None, token=None):
        self.calls.append((url, copy.deepcopy(payload), token))
        if url.endswith("/api/bench-recording"):
            if self.scope_fails:
                raise OSError("offline " + self.secret)
            return copy.deepcopy(self.scope)
        if url.endswith("/signal-link/health"):
            return {"ok": True, "received": len(self.posts), "subscribers": 1,
                    "last_received_at_ms": int(self.now * 1000), "token": self.secret,
                    "capabilities": {"automatic_threshold_events": self.automatic_capability}}
        if url.endswith("/signal-link/event"):
            self.posts.append(copy.deepcopy(payload))
            if self.delivery_fails:
                raise OSError("failed with " + self.secret)
            return {"accepted": True, "id": payload["id"], "subscribers": 1}
        raise AssertionError("Unexpected fake route: " + url)

    def marker(self, ident, label="Blink", age=0):
        marker = {"id": ident, "label": label, "timestamp": self.now - age}
        self.scope["markers"].append(marker)
        return marker


class PartnerSenderTests(unittest.TestCase):
    def setUp(self):
        self.link = FakeLink()
        self.sender = PartnerSender(request=self.link.request, clock=self.link.clock)
        self.sender.configure("http://192.168.1.20:48081", self.link.secret)

    def test_no_token_mode_can_send_and_follow(self):
        self.sender.configure("http://192.168.1.20:48081", "")
        self.assertTrue(self.sender.state()["configured"])
        self.assertEqual(self.sender.state()["authentication"], "none")
        self.sender.emit("blink", "Blink")
        self.sender.follow(True)
        self.link.marker("new")
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 2)
        posts=[call for call in self.link.calls if call[1] is not None]
        self.assertTrue(all(call[2] == "" for call in posts))

    def test_start_skips_existing_markers_and_sends_next_marker_once(self):
        self.link.marker("old")
        self.sender.follow(True)
        self.sender.tick()
        self.assertEqual(self.link.posts, [])
        self.link.marker("new", "Startle / flinch")
        self.sender.tick()
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 1)
        event = self.link.posts[0]
        self.assertEqual(event["event"], "startle_flinch")
        self.assertEqual(event["source"], "manual_marker")
        self.assertEqual(event["measurement"], "operator_annotation")
        self.assertIsNone(event["emotion"])
        self.assertEqual(self.sender.state()["sent"], 1)

    def test_stale_and_future_markers_are_skipped_without_replay(self):
        self.sender.follow(True)
        self.link.marker("stale", age=3.01)
        self.link.marker("future", age=-1)
        self.sender.tick()
        self.link.now += 1
        self.sender.tick()
        self.assertEqual(self.link.posts, [])

    def test_stop_prevents_polling_and_marker_delivery(self):
        self.sender.follow(True)
        self.sender.tick()  # Initialize the health timer too.
        self.sender.follow(False)
        self.link.marker("after-stop")
        call_count = len(self.link.calls)
        self.sender.tick()
        self.assertEqual(len(self.link.calls), call_count)
        self.assertEqual(self.link.posts, [])
        self.assertFalse(self.sender.state()["following"])

    def test_restart_baselines_markers_created_while_stopped(self):
        self.sender.follow(True)
        self.sender.follow(False)
        self.link.marker("during-stop")
        self.sender.follow(True)
        self.sender.tick()
        self.link.marker("after-restart")
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 1)

    def test_read_outage_skips_backlog_then_accepts_fresh_marker(self):
        self.sender.follow(True)
        self.link.scope_fails = True
        self.sender.tick()
        self.assertTrue(self.sender.state()["scope_error"])
        # Even a fresh marker from the outage must not replay on recovery.
        self.link.marker("during-outage")
        self.link.scope_fails = False
        self.sender.tick()
        self.assertEqual(self.link.posts, [])
        self.assertEqual(self.sender.state()["scope_error"], "")
        self.link.marker("after-recovery", "Jaw clench")
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 1)
        self.assertEqual(self.link.posts[0]["event"], "jaw_clench")

    def test_failed_delivery_is_not_retried(self):
        self.sender.follow(True)
        self.link.delivery_fails = True
        self.link.marker("will-fail")
        self.sender.tick()
        self.assertEqual(self.sender.state()["dropped"], 1)
        self.link.delivery_fails = False
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 1)
        self.assertEqual(self.sender.state()["sent"], 0)
        self.link.marker("next")
        self.sender.tick()
        self.assertEqual(self.sender.state()["sent"], 1)

    def test_manual_test_uses_control_value_and_manual_provenance(self):
        result = self.sender.emit("blink", "Blink", 0.7)
        self.assertEqual(result["status"], "accepted")
        event = self.link.posts[0]
        self.assertEqual(event["source"], "manual_test")
        self.assertEqual(event["value"], 0.7)
        self.assertEqual(event["created_at_ms"], 1000000)
        self.assertIsNone(event["emotion"])

    def test_custom_marker_maps_to_generic_reaction(self):
        self.sender.follow(True)
        self.link.marker("custom", "Door creaked")
        self.sender.tick()
        self.assertEqual(self.link.posts[0]["event"], "reaction")
        self.assertEqual(self.link.posts[0]["label"], "Door creaked")

    def test_same_marker_id_in_new_run_gets_new_event_id(self):
        self.sender.follow(True)
        self.link.marker("same")
        self.sender.tick()
        self.link.scope = {"run_id": "run-b", "markers": []}
        self.link.marker("same")
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 2)
        self.assertNotEqual(self.link.posts[0]["id"], self.link.posts[1]["id"])

    def test_public_state_and_errors_never_expose_token(self):
        self.sender.check()
        self.link.delivery_fails = True
        result = self.sender.emit("blink", "Blink")
        self.sender.follow(True)
        self.link.scope_fails = True
        self.sender.tick()
        public = json.dumps({"state": self.sender.state(), "result": result})
        self.assertNotIn(self.link.secret, public)
        self.assertNotIn('"token":', public)
        self.assertTrue(self.sender.state()["configured"])

    def test_invalid_targets_are_rejected_without_mutating_configuration(self):
        invalid = [
            "http://8.8.8.8:48081", "http://0.0.0.0:48081",
            "http://224.0.0.1:48081", "ftp://192.168.1.20:48081",
            "http://user:password@192.168.1.20:48081",
            "http://192.168.1.20:48081/path", "http://192.168.1.20:48081?q=1",
            "http://192.168.1.20:48081#fragment", "http://192.168.1.20:0",
            "http://192.168.1.20:65536", "http://example.com:48081",
        ]
        for target in invalid:
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.sender.configure(target, self.link.secret)
        self.assertEqual(self.sender.state()["target"], "http://192.168.1.20:48081")

    def test_bad_events_and_values_rejected_before_request(self):
        for event, value in [("fear", 1), ("blink", -0.1), ("blink", 1.1),
                             ("blink", True), ("blink", float("nan")),
                             ("blink", float("inf")), ("blink", "0.7")]:
            with self.subTest(event=event, value=value), self.assertRaises(ValueError):
                self.sender.emit(event, "test", value)
        self.assertEqual(self.link.posts, [])

    def test_cannot_start_forwarding_without_scope_baseline(self):
        self.link.scope_fails = True
        with self.assertRaises(ValueError):
            self.sender.follow(True)
        self.assertFalse(self.sender.state()["following"])

    def test_configuration_stops_previous_forwarding(self):
        self.sender.follow(True)
        self.sender.configure("http://192.168.1.21:48081", self.link.secret)
        self.assertFalse(self.sender.state()["following"])
        self.link.marker("new-target-not-started")
        self.sender.tick()
        self.assertEqual(self.link.posts, [])

    def test_malformed_scope_response_rejects_start_and_recovers_after_tick(self):
        for invalid in [None, [], "bad", 3, {"markers": None}, {"markers": {}}]:
            with self.subTest(response=invalid):
                self.sender.follow(False)
                self.link.scope = invalid
                with self.assertRaises(ValueError):
                    self.sender.follow(True)
                self.assertFalse(self.sender.state()["following"])
                self.link.scope = {"run_id": "run-a", "markers": []}
                self.sender.follow(True)
                self.link.scope = invalid
                self.sender.tick()
                self.assertTrue(self.sender.state()["scope_error"])
                self.link.scope = {"run_id": "run-a", "markers": []}
                self.sender.tick()
                self.assertEqual(self.sender.state()["scope_error"], "")

    def test_malformed_receiver_responses_are_failed_delivery_not_exceptions(self):
        for invalid in [None, [], "bad", 3, {}, {"accepted": True, "id": "wrong"}]:
            with self.subTest(response=invalid):
                self.sender.request = lambda *args, response=invalid: response
                row = self.sender.emit("blink", "Blink")
                self.assertEqual(row["status"], "failed")
                self.assertTrue(self.sender.state()["error"])

    def test_malformed_health_response_is_unavailable(self):
        for invalid in [None, [], "bad", 3, {}, {"ok": False}]:
            with self.subTest(response=invalid):
                self.sender.request = lambda *args, response=invalid: response
                self.sender.check()
                self.assertIsNone(self.sender.state()["remote"])
                self.assertTrue(self.sender.state()["error"])

    def test_fractional_clock_produces_integer_milliseconds(self):
        self.link.now = 1000.123456
        self.sender.emit("blink", "Blink")
        self.sender.follow(True)
        self.link.marker("fractional", age=0.020001)
        self.sender.tick()
        self.assertEqual(len(self.link.posts), 2)
        for event in self.link.posts:
            self.assertIs(type(event["created_at_ms"]), int)
            self.assertIs(type(event["sent_at_ms"]), int)
            self.assertEqual(event["sent_at_ms"], 1000123)
        self.assertEqual(self.link.posts[1]["created_at_ms"], 1000103)

    def test_partner_health_names_are_normalized(self):
        self.sender.request = lambda *args: {
            "enabled": True, "clients": 2, "accepted": 7,
            "last_event": {"received_at_ms": 1000123}}
        self.sender.check()
        self.assertEqual(self.sender.state()["remote"], {
            "ok": True, "received": 7, "subscribers": 2,
            "last_received_at_ms": 1000123, "automatic_threshold_events": False, "acquisition_control": False})

    def test_remote_control_private_config_requires_both_fresh_capabilities(self):
        self.sender.request = lambda *args: {'ok':True,'capabilities':{
            'automatic_threshold_events':copy.deepcopy(AUTOMATIC_CAPABILITY),
            'acquisition_control':copy.deepcopy(CONTROL_CAPABILITY)}}
        self.sender.check()
        config=self.sender.remote_control_config()
        self.assertEqual(config['capabilities']['acquisition_control'], CONTROL_CAPABILITY)
        self.assertEqual(config['token'], self.link.secret)
        self.assertNotIn(self.link.secret,json.dumps(self.sender.state()))
        self.link.now += 11
        self.assertEqual(self.sender.remote_control_config()['capabilities'], {})

    def test_remote_control_config_change_disables_remote_mode(self):
        class Control:
            def __init__(self):self.enabled=True
            def enable(self,value):self.enabled=value
            def state(self):return {'enabled':self.enabled}
        self.sender.remote_control=Control()
        self.sender.configure('http://192.168.1.20:48081')
        self.assertFalse(self.sender.state()['remote_control']['enabled'])

    def test_allow_host_is_exact_not_public_range(self):
        sender = PartnerSender(request=self.link.request, clock=self.link.clock,
                               allowed_hosts=("20.20.20.179",))
        sender.configure("http://20.20.20.179:48080", self.link.secret)
        self.assertEqual(sender.state()["target"], "http://20.20.20.179:48080")
        for target in ["http://20.20.20.178:48080", "http://8.8.8.8:48080"]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                sender.configure(target, self.link.secret)
        with self.assertRaises(ValueError):
            self.sender.configure("http://20.20.20.179:48080", self.link.secret)

    def test_partner_202_without_id_is_accepted_but_mismatched_id_is_not(self):
        self.sender.request = lambda *args: {"_http_status": 202, "clients": 1}
        row = self.sender.emit("blink", "Blink")
        self.assertEqual(row["status"], "accepted")
        self.assertEqual(row["subscribers"], 1)
        self.sender.request = lambda *args: {"_http_status": 202, "id": "wrong"}
        self.assertEqual(self.sender.emit("blink", "Blink")["status"], "failed")
        self.assertEqual(self.sender.state()["sent"], 1)

    def test_partner_200_duplicate_is_accepted(self):
        self.sender.request = lambda *args: {"_http_status": 200, "duplicate": True}
        row = self.sender.emit("blink", "Blink")
        self.assertEqual(row["status"], "accepted")
        self.assertTrue(row["duplicate"])
        self.assertEqual(self.sender.state()["sent"], 1)

    def test_label_control_characters_removed_and_empty_label_falls_back(self):
        self.sender.emit("reaction", "Door\n\t\x00\x7f creaked")
        self.sender.emit("blink", "\n\x00")
        self.assertEqual(self.link.posts[0]["label"], "Door creaked")
        self.assertEqual(self.link.posts[1]["label"], "blink")


class AutomaticThresholdTests(unittest.TestCase):
    def setUp(self):
        self.link=FakeLink()
        self.link.automatic_capability=copy.deepcopy(AUTOMATIC_CAPABILITY)
        self.sender=PartnerSender(request=self.link.request,clock=self.link.clock)
        self.sender.configure('http://192.168.1.20:48081',self.link.secret)
        self.settings=dict(preset='more-sensitive-v1',threshold=.28153449356783367,
            rearm_threshold=.22522759485426695,value=1.0,cooldown_ms=5000)
        self.start=self.sender.automatic_start(self.settings)

    def event(self,**updates):
        payload=dict(session=self.start['session'],generation=self.start['generation'],
            id=str(uuid.uuid4()),created_at_ms=int(self.link.now*1000),
            detector=dict(preset=self.settings['preset'],threshold=self.settings['threshold'],
                rearm_threshold=self.settings['rearm_threshold'],score=.35,quality='unverified',
                valid_measurement=False,reaction_validated=False))
        payload.update(updates)
        return payload

    def test_v2_metadata_value_and_integer_timestamps(self):
        self.assertEqual(self.sender.threshold(self.event())['status'],'accepted')
        packet=self.link.posts[0]
        self.assertEqual(packet['schema'],'signal-scope.event.v2')
        self.assertEqual(packet['source'],'threshold_detector')
        self.assertEqual(packet['measurement'],'threshold_crossing')
        self.assertEqual(packet['event'],'reaction')
        self.assertIsNone(packet['emotion'])
        self.assertEqual(packet['value'],1.0)
        self.assertIs(type(packet['created_at_ms']),int)
        self.assertIs(type(packet['sent_at_ms']),int)
        self.assertFalse(packet['detector']['valid_measurement'])
        self.assertNotIn('session',packet)
        self.assertNotIn('generation',packet)

    def test_old_receiver_and_inexact_capability_never_enable_automatic(self):
        for capability in [None,True,{},dict(AUTOMATIC_CAPABILITY,quality='verified'),
                           dict(AUTOMATIC_CAPABILITY,detector_version=True)]:
            with self.subTest(capability=capability):
                self.sender.automatic_stop()
                self.link.automatic_capability=capability
                with self.assertRaises(ValueError):self.sender.automatic_start(self.settings)
                self.assertFalse(self.sender.state()['automatic']['active'])
        self.assertEqual(self.link.posts,[])

    def test_wrong_session_generation_stop_and_suspend_drop_without_network(self):
        payload=self.event()
        for bad in [dict(payload,session='wrong'),dict(payload,generation=0),dict(payload,generation=True)]:
            self.assertEqual(self.sender.threshold(bad)['reason'],'stale_session')
        old_generation=self.start['generation']
        self.sender.automatic_stop()
        self.assertGreater(self.sender.state()['automatic']['generation'],old_generation)
        self.assertEqual(self.sender.threshold(payload)['reason'],'inactive')
        self.start=self.sender.automatic_start(self.settings)
        self.assertEqual(self.sender.threshold(payload)['reason'],'stale_session')
        payload=self.event()
        self.sender.automatic_stop(suspend=True)
        self.assertEqual(self.sender.state()['automatic']['reason'],'Suspended')
        self.assertEqual(self.sender.threshold(payload)['reason'],'inactive')
        self.assertEqual(self.link.posts,[])

    def test_stale_and_future_events_never_send(self):
        for timestamp in [int(self.link.now*1000)-2001,int(self.link.now*1000)+1]:
            self.assertEqual(self.sender.threshold(self.event(created_at_ms=timestamp))['reason'],'stale_event')
        self.assertEqual(self.link.posts,[])

    def test_bad_timestamps_provenance_and_config_rejected(self):
        for timestamp in [True,1000000.0,-1,float('nan'),None]:
            with self.subTest(timestamp=timestamp),self.assertRaises(ValueError):
                self.sender.threshold(self.event(created_at_ms=timestamp))
        for updates in [dict(quality='verified'),dict(valid_measurement=True),dict(reaction_validated=True),
                        dict(score=float('nan')),dict(score=.1),dict(threshold=.3),dict(preset='other'),
                        dict(extra='raw'),dict(rearm_threshold=True)]:
            event=self.event();event['detector'].update(updates)
            with self.subTest(updates=updates),self.assertRaises(ValueError):self.sender.threshold(event)
        self.assertEqual(self.link.posts,[])

    def test_duplicate_cooldown_and_failed_events_are_not_replayed(self):
        first=self.event();self.sender.threshold(first)
        self.assertEqual(self.sender.threshold(first)['reason'],'duplicate')
        second=self.event()
        self.assertEqual(self.sender.threshold(second)['reason'],'cooldown')
        self.link.now+=5;self.sender.check()
        second['created_at_ms']=int(self.link.now*1000)
        self.assertEqual(self.sender.threshold(second)['reason'],'duplicate')
        self.link.delivery_fails=True
        third=self.event();self.assertEqual(self.sender.threshold(third)['status'],'failed')
        self.link.delivery_fails=False;self.link.now+=5;self.sender.check()
        third['created_at_ms']=int(self.link.now*1000)
        self.assertEqual(self.sender.threshold(third)['reason'],'duplicate')
        self.assertEqual(len(self.link.posts),2)
        self.assertEqual(self.sender.threshold(self.event())['status'],'accepted')

    def test_expired_health_suspends_and_requires_explicit_restart(self):
        self.link.now+=11
        self.assertEqual(self.sender.threshold(self.event())['reason'],'receiver_unavailable')
        self.sender.check()
        self.assertFalse(self.sender.state()['automatic']['active'])
        self.assertEqual(self.sender.threshold(self.event())['reason'],'inactive')
        self.assertEqual(self.link.posts,[])

    def test_health_loss_invalidates_session_without_token_leak(self):
        self.link.automatic_capability=None;self.sender.check()
        self.assertFalse(self.sender.state()['automatic']['active'])
        public=json.dumps(self.sender.state())
        self.assertNotIn(self.link.secret,public)
        self.assertNotIn(self.start['session'],public)
        self.assertNotIn('capabilities',public)

    def test_omitted_token_preserves_existing_and_explicit_empty_clears(self):
        self.sender.configure('http://192.168.1.20:48081')
        self.sender.emit('blink','Blink')
        self.assertEqual(self.link.calls[-1][2],self.link.secret)
        self.assertFalse(self.sender.state()['automatic']['active'])
        self.sender.configure('http://192.168.1.20:48081',None)
        self.sender.emit('blink','Blink')
        self.assertEqual(self.link.calls[-1][2],self.link.secret)
        self.sender.configure('http://192.168.1.20:48081','')
        self.sender.emit('blink','Blink')
        self.assertEqual(self.link.calls[-1][2],'')

    def test_missing_capability_emotion_field_is_not_an_exact_match(self):
        capability=dict(AUTOMATIC_CAPABILITY);del capability['emotion']
        self.sender.automatic_stop();self.link.automatic_capability=capability
        with self.assertRaises(ValueError):self.sender.automatic_start(self.settings)
        self.assertFalse(self.sender.state()['automatic']['active'])

    def test_automatic_requires_auth_even_if_receiver_advertises_capability(self):
        self.sender.configure('http://192.168.1.20:48081','')
        with self.assertRaises(ValueError):self.sender.automatic_start(self.settings)
        self.assertFalse(self.sender.state()['automatic']['active'])
        self.sender.emit('blink','Blink')
        self.assertEqual(len(self.link.posts),1)

    def test_stop_during_inflight_is_immediate_and_prevents_next_delivery(self):
        entered=threading.Event();release=threading.Event();original=self.sender.request
        def slow_request(url,payload=None,token=None):
            if payload is not None:entered.set();release.wait(2)
            return original(url,payload,token)
        self.sender.request=slow_request
        event=self.event()
        worker=threading.Thread(target=lambda:self.sender.threshold(event))
        worker.start();self.assertTrue(entered.wait(1))
        try:
            self.assertTrue(self.sender.state()['automatic']['inflight'])
            self.sender.automatic_stop()
            self.assertFalse(self.sender.state()['automatic']['active'])
            self.assertEqual(self.sender.threshold(self.event())['reason'],'inactive')
        finally:release.set();worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(self.link.posts),1)  # already committed request cannot be recalled

    def test_stop_during_start_health_check_cancels_start(self):
        entered=threading.Event();release=threading.Event();original=self.sender.request;errors=[]
        self.sender.automatic_stop()
        def slow_health(url,payload=None,token=None):
            if url.endswith('/health'):entered.set();release.wait(2)
            return original(url,payload,token)
        def start():
            try:self.sender.automatic_start(self.settings)
            except ValueError as error:errors.append(str(error))
        self.sender.request=slow_health
        worker=threading.Thread(target=start);worker.start();self.assertTrue(entered.wait(1))
        self.sender.automatic_stop();release.set();worker.join(2)
        self.assertFalse(self.sender.state()['automatic']['active'])
        self.assertTrue(errors)
        self.assertEqual(self.link.posts,[])

    def test_invalid_config_and_malicious_remote_fields_are_sanitized(self):
        for updates in [dict(threshold=float('inf')),dict(rearm_threshold=.4),dict(value=True),
                        dict(value=1.1),dict(cooldown_ms=0),dict(cooldown_ms=True),dict(preset='')]:
            with self.subTest(updates=updates),self.assertRaises(ValueError):
                self.sender.automatic_start(dict(self.settings,**updates))
        self.sender.request=lambda *args:{'ok':True,'received':self.link.secret,'subscribers':{'token':self.link.secret},
            'last_received_at_ms':self.link.secret,'capabilities':{'automatic_threshold_events':self.link.secret}}
        self.sender.check()
        self.assertNotIn(self.link.secret,json.dumps(self.sender.state()))


class PartnerSenderHTTPTests(unittest.TestCase):
    """Real HTTP only on an ephemeral loopback port; upstream is entirely fake."""
    def setUp(self):
        self.link = FakeLink()
        self.sender = PartnerSender(request=self.link.request, clock=self.link.clock)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.sender, 0))
        self.port = self.server.server_address[1]
        self.server.RequestHandlerClass = handler_for(self.sender, self.port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def http(self, method, path, data=None, origin="http://127.0.0.1:8767", host=None):
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if origin is not None:
            headers["Origin"] = origin
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), json.loads(raw) if raw else None
        finally:
            connection.close()

    def configure(self):
        return self.http("POST", "/configure", {
            "target": "http://192.168.1.20:48081", "token": self.link.secret})

    def test_configure_test_and_get_state_exclude_credentials(self):
        status, headers, data = self.configure()
        self.assertEqual(status, 200)
        self.assertTrue(data["configured"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:8767")
        self.assertNotIn(self.link.secret, json.dumps(data))
        status, _, data = self.http("POST", "/test", {"event": "blink", "value": 0.5})
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "accepted")
        self.assertEqual(self.link.posts[0]["value"], 0.5)
        self.assertEqual(self.link.posts[0]["source"], "manual_test")
        status, headers, data = self.http("GET", "/state")
        self.assertEqual(status, 200)
        self.assertEqual(data["sent"], 1)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn(self.link.secret, json.dumps(data))
        self.assertNotIn("token", data)

    def test_reject_foreign_origin_without_delivery_or_configuration(self):
        for method, path, payload in [
            ("GET", "/state", None),
            ("POST", "/configure", {"target": "http://192.168.1.20:48081", "token": self.link.secret}),
            ("POST", "/test", {"event": "blink"}),
            ("OPTIONS", "/test", None),
        ]:
            with self.subTest(method=method, path=path):
                status, headers, _ = self.http(method, path, payload, origin="https://evil.example")
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertFalse(self.sender.state()["configured"])
        self.assertEqual(self.link.posts, [])

    def test_reject_foreign_host(self):
        self.configure()
        for host in [f"evil.example:{self.port}", f"192.168.1.20:{self.port}", "127.0.0.1:1"]:
            with self.subTest(host=host):
                status, _, _ = self.http("POST", "/test", {"event": "blink"}, host=host)
                self.assertEqual(status, 403)
        self.assertEqual(self.link.posts, [])

    def test_local_preflight_and_originless_cli_are_allowed(self):
        status, headers, _ = self.http("OPTIONS", "/test")
        self.assertEqual(status, 204)
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])
        status, _, data = self.http("GET", "/state", origin=None)
        self.assertEqual(status, 200)
        self.assertFalse(data["configured"])

    def test_invalid_json_shape_and_invalid_test_are_rejected(self):
        status, _, _ = self.http("POST", "/configure", ["bad"])
        self.assertEqual(status, 400)
        self.configure()
        status, _, _ = self.http("POST", "/test", {"event": "fear", "value": 1})
        self.assertEqual(status, 400)
        self.assertEqual(self.link.posts, [])

    def test_automatic_http_routes_and_state_do_not_leak_local_session(self):
        self.configure();self.link.automatic_capability=dict(AUTOMATIC_CAPABILITY)
        settings=dict(preset='more-sensitive-v1',threshold=.28153449356783367,
            rearm_threshold=.22522759485426695,value=1,cooldown_ms=5000)
        status,_,started=self.http('POST','/automatic/start',settings)
        self.assertEqual(status,200)
        payload=dict(id=str(uuid.uuid4()),session=started['session'],generation=started['generation'],
            created_at_ms=int(self.link.now*1000),detector=dict(preset=settings['preset'],threshold=settings['threshold'],
                rearm_threshold=settings['rearm_threshold'],score=.35,quality='unverified',valid_measurement=False,reaction_validated=False))
        status,_,row=self.http('POST','/threshold',payload)
        self.assertEqual(status,200);self.assertEqual(row['status'],'accepted')
        status,_,state=self.http('GET','/state')
        self.assertTrue(state['automatic']['active'])
        self.assertNotIn(started['session'],json.dumps(state))
        self.assertNotIn(self.link.secret,json.dumps(state))
        status,_,state=self.http('POST','/automatic/suspend',{})
        self.assertFalse(state['automatic']['active'])
        self.assertEqual(state['automatic']['reason'],'Suspended')
        status,_,row=self.http('POST','/threshold',payload)
        self.assertEqual(row['reason'],'inactive')
        status,_,state=self.http('POST','/automatic/stop',{})
        self.assertEqual(status,200);self.assertEqual(state['automatic']['reason'],'Stopped')
        self.assertEqual(len(self.link.posts),1)

    def test_http_configure_omitted_token_preserves_secret(self):
        self.configure()
        self.http('POST','/configure',{'target':'http://192.168.1.20:48081'})
        self.http('POST','/test',{'event':'blink'})
        self.assertEqual(self.link.calls[-1][2],self.link.secret)

    def test_remote_control_route_validates_bool_and_local_origin(self):
        class Control:
            def __init__(self):self.enabled=False
            def state(self):return {'enabled':self.enabled}
            def enable(self,value):
                if type(value) is not bool:raise ValueError('Boolean required')
                self.enabled=value
        self.sender.remote_control=Control()
        status,_,state=self.http('POST','/remote-control',{'enabled':True})
        self.assertEqual(status,200)
        self.assertTrue(state['remote_control']['enabled'])
        self.assertEqual(self.http('POST','/remote-control',{'enabled':'yes'})[0],400)
        self.assertEqual(self.http('POST','/remote-control',{'enabled':False},origin='https://example.com')[0],403)
        self.assertTrue(self.sender.remote_control.enabled)


if __name__ == "__main__":
    unittest.main()
