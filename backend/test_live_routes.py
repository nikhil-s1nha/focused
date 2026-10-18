"""Software-only HTTP contract tests. All acquisition services are fakes."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import tempfile
import threading
import unittest

from backend.viewer_server import make_handler


class FakeRecorder:
    def __init__(self):
        self.calls = []
        self.result = {"active": False, "run_id": "retained-recording", "markers": []}

    def state(self):
        return dict(self.result)

    def start(self, **kwargs):
        self.calls.append(("start", kwargs))
        return self.state()

    def stop(self):
        self.calls.append(("stop", {}))
        return self.state()


class FakeLive:
    def __init__(self):
        self.calls = []
        self.active = False

    def state(self):
        return {"active": self.active, "enabled": True,
                "acquisition": {"state": "receiving" if self.active else "off"}}

    def start(self, **kwargs):
        self.calls.append(("start", kwargs))
        self.active = True
        return self.state()

    def stop(self, **kwargs):
        self.calls.append(("stop", kwargs))
        self.active = False
        return self.state()

    def configure(self, **kwargs):
        self.calls.append(("configure", kwargs))
        return self.state()


class LiveRouteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.recorder = FakeRecorder()
        self.live = FakeLive()
        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            make_handler(object(), self.directory.name, bench_log=object(),
                         bench_recorder=self.recorder, live_mode=self.live))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def request(self, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        request_headers = dict(headers or {})
        encoded = None if body is None else json.dumps(body)
        if body is not None:
            request_headers.setdefault("Content-Type", "application/json")
        try:
            connection.request("GET" if body is None else "POST", path,
                               body=encoded, headers=request_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_get_state_only_reads_injected_service(self):
        status, result = self.request("/api/live-detection")
        self.assertEqual(status, 200)
        self.assertEqual(result, self.live.state())
        self.assertEqual(self.live.calls, [])
        self.assertEqual(self.recorder.calls, [])

    def test_remote_owner_is_forwarded_only_when_explicit(self):
        owner='4adfa94c-2f74-4c6d-9b27-785644dcbd7f'
        self.request('/api/live-detection/start', {'nonhuman_surface_only':True,'owner_id':owner})
        self.assertEqual(self.live.calls[-1][1]['owner_id'], owner)
        self.request('/api/live-detection/stop', {'owner_id':owner})
        self.assertEqual(self.live.calls[-1], ('stop',{'owner_id':owner}))

    def test_start_stop_settings_forward_exact_values(self):
        status, result = self.request("/api/live-detection/start", {
            "nonhuman_surface_only": True, "record_to_disk": True, "value": .65})
        self.assertEqual(status, 200)
        self.assertTrue(result["active"])
        self.assertEqual(self.live.calls[-1], ("start", {
            "nonhuman_surface_only": True, "record_to_disk": True, "value": .65}))
        status, _ = self.request("/api/live-detection/settings", {"value": .3})
        self.assertEqual(status, 200)
        self.assertEqual(self.live.calls[-1], ("configure", {"value": .3}))
        status, result = self.request("/api/live-detection/stop", {})
        self.assertEqual(status, 200)
        self.assertFalse(result["active"])
        self.assertEqual(self.live.calls[-1], ("stop", {}))
        self.assertEqual(self.recorder.calls, [])

    def test_start_defaults_to_live_without_disk_saving(self):
        status, _ = self.request("/api/live-detection/start", {"nonhuman_surface_only": True})
        self.assertEqual(status, 200)
        self.assertEqual(self.live.calls[-1], ("start", {
            "nonhuman_surface_only": True, "record_to_disk": False, "value": 1}))

    def test_foreign_host_cannot_control_even_with_matching_origin(self):
        for suffix in ("start", "stop", "settings"):
            with self.subTest(endpoint=suffix):
                status, _ = self.request("/api/live-detection/" + suffix, {}, {
                    "Host": "foreign.example", "Origin": "http://foreign.example"})
                self.assertEqual(status, 403)
        self.assertEqual(self.live.calls, [])

    def test_foreign_origin_cannot_control_local_host(self):
        for suffix in ("start", "stop", "settings"):
            with self.subTest(endpoint=suffix):
                status, _ = self.request("/api/live-detection/" + suffix, {}, {
                    "Origin": "http://foreign.example"})
                self.assertEqual(status, 403)
        self.assertEqual(self.live.calls, [])

    def test_same_origin_control_is_allowed(self):
        status, _ = self.request("/api/live-detection/start", {
            "nonhuman_surface_only": True}, {
            "Origin": "http://127.0.0.1:" + str(self.server.server_port)})
        self.assertEqual(status, 200)
        self.assertEqual(self.live.calls[0][0], "start")

    def test_legacy_stop_stops_live_but_returns_recorder_shape(self):
        self.live.active = True
        status, result = self.request("/api/bench-recording/stop", {})
        self.assertEqual(status, 200)
        self.assertEqual(result, self.recorder.state())
        self.assertEqual(result["run_id"], "retained-recording")
        self.assertEqual(self.live.calls, [("stop", {})])
        self.assertEqual(self.recorder.calls, [])

    def test_legacy_stop_uses_recorder_if_live_is_inactive(self):
        status, result = self.request("/api/bench-recording/stop", {})
        self.assertEqual(status, 200)
        self.assertEqual(result, self.recorder.state())
        self.assertEqual(self.recorder.calls, [("stop", {})])
        self.assertEqual(self.live.calls, [])

    def test_separate_legacy_recording_cannot_conflict_with_live_mode(self):
        self.live.active = True
        status, result = self.request("/api/bench-recording/start", {"nonhuman_surface_only": True})
        self.assertEqual(status, 400)
        self.assertIn("Stop live detection", result["error"])
        self.assertEqual(self.recorder.calls, [])


if __name__ == "__main__":
    unittest.main()
