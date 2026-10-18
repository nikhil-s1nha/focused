"""Object recorder controller tests: all remote operations are mocked."""
import base64
from contextlib import redirect_stdout
import csv
import io
import json
import shlex
from pathlib import Path
import tempfile
import threading
import time
import unittest

from backend.bench_recorder import BenchRecorder, REMOTE_BASE, SSH_CONTROL, SSH_HOST, _ssh
from backend.bypass_viewer import BenchLog, OBJECT_HEADER
from unittest.mock import patch


CAPTURE = (OBJECT_HEADER + "\nBYPASS_PHASE,SPI_HZ,125000,READ_MODE,RDATA,MUX,CH1_SHORT_CH2_EXTERNAL_OBJECT\n"
           "UNTRUSTED_BYPASS,0,8000,C00000000001FFFFFF\n")


def response(text="", stage="capturing_untrusted_bench_bytes", restore=None, reset=False):
    return json.dumps({"data": base64.b64encode(text.encode()).decode(), "reset": reset,
                       "status_text": json.dumps({"stage": stage, "restore_exit": restore})})


class BenchRecorderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.feed = self.base / "feed.txt"
        self.feed.write_text("old feed to preserve\n")
        self.log = BenchLog(self.feed, max_samples=1)

    def tearDown(self):
        self.temp.cleanup()

    def recorder(self, transport, **kwargs):
        return BenchRecorder(self.log, results_dir=self.base / "results", transport=transport,
                             poll_interval=0.001, enabled=True, **kwargs)

    def wait(self, controller):
        controller._thread.join(timeout=3)
        self.assertFalse(controller._thread.is_alive())

    def test_opt_in_and_explicit_nonhuman_confirmation_precede_any_action(self):
        calls = []
        controller = BenchRecorder(self.log, results_dir=self.base / "results", transport=calls.append)
        with self.assertRaises(RuntimeError):
            controller.start(True)
        controller.enabled = True
        for invalid in (False, None, 1, "true"):
            with self.assertRaises(ValueError):
                controller.start(invalid)
        self.assertEqual(calls, [])
        self.assertEqual(self.feed.read_text(), "old feed to preserve\n")

    def test_complete_archives_previous_feed_and_all_samples_despite_viewer_retention(self):
        calls, responses = [], iter([response(CAPTURE), response("UNTRUSTED_BYPASS,1,16000,C00000000002FFFFFE\nBYPASS_COMPLETE\n", "complete", 0)])
        def transport(command):
            calls.append(command)
            return "" if command.startswith("nohup ") else next(responses)
        controller = self.recorder(transport)
        controller.start(True)
        self.wait(controller)
        state = controller.state()
        self.assertFalse(state["active"])
        self.assertTrue(state["restoration_confirmed"])
        self.assertFalse(state["body_acquisition_enabled"])
        directory = self.base / "results" / state["run_id"]
        self.assertEqual((directory / "previous-feed.txt").read_text(), "old feed to preserve\n")
        self.assertEqual((directory / "raw.txt").read_bytes(), self.feed.read_bytes())
        self.assertEqual(len(self.log.state()["phases"][0]["samples"]), 1)
        exported = controller.export_json()
        self.assertEqual(len(exported["samples"]), 2)
        self.assertEqual(exported["samples"][0]["ch2_counts"], -1)
        self.assertTrue((directory / "export.json").exists())
        self.assertTrue((directory / "export.csv").exists())
        self.assertIn(REMOTE_BASE + "/run_object_continuous.py", calls[0])
        self.assertIn("--nonhuman-surface-only --run-name object-ui-", calls[0])

    def test_monitor_only_does_not_archive_and_removes_temporary_diagnostics(self):
        controller = self.recorder(lambda command: "" if command.startswith("nohup ") else response(CAPTURE, "complete", 0))
        controller.start(True, record_to_disk=False)
        self.wait(controller)
        self.assertFalse((self.base / "results").exists())
        self.assertIsNone(controller._directory)
        self.assertIsNone(controller._temporary_directory)
        self.assertFalse(controller.state()["record_to_disk"])
        self.assertFalse(controller.state()["recording_saved"])
        self.assertEqual(controller.export_json()["samples"], [])
        # Live feed is transport diagnostics, not a user recording archive.
        self.assertIn("UNTRUSTED_BYPASS", self.feed.read_text())

    def test_monitor_only_does_not_remove_an_older_saved_capture(self):
        responses = lambda command: "" if command.startswith("nohup ") else response(CAPTURE, "complete", 0)
        controller = self.recorder(responses)
        saved_id = controller.start(True)["run_id"]
        self.wait(controller)
        saved = self.base / "results" / saved_id / "export.json"
        contents = saved.read_bytes()
        controller.start(True, record_to_disk=False)
        self.wait(controller)
        self.assertEqual(saved.read_bytes(), contents)
        self.assertEqual(len(list((self.base / "results").iterdir())), 1)

    def test_restores_latest_safe_archive_without_any_remote_or_feed_action(self):
        controller = self.recorder(lambda command: "" if command.startswith("nohup ") else response(CAPTURE, "complete", 0))
        run_id = controller.start(True)["run_id"]
        self.wait(controller)
        saved = controller.export_json()
        feed_before = self.feed.read_bytes()
        remote_calls = []
        restarted = self.recorder(remote_calls.append)
        self.assertTrue(restarted.restore_latest_finished())
        self.assertEqual(restarted.state()["run_id"], run_id)
        self.assertFalse(restarted.state()["active"])
        self.assertIsNone(restarted._thread)
        self.assertEqual(restarted.export_json()["samples"], saved["samples"])
        self.assertEqual(self.feed.read_bytes(), feed_before)
        self.assertEqual(remote_calls, [])

    def test_restore_ignores_active_and_failed_archives(self):
        controller = self.recorder(lambda command: "" if command.startswith("nohup ") else response(CAPTURE, "complete", 0))
        controller.start(True)
        self.wait(controller)
        directory = controller._directory
        metadata = json.loads((directory / "metadata.json").read_text())
        restarted = self.recorder(lambda command: self.fail("Unexpected remote call"))
        metadata["active"] = True
        (directory / "metadata.json").write_text(json.dumps(metadata))
        self.assertFalse(restarted.restore_latest_finished())
        metadata.update(active=False, restoration_confirmed=False)
        (directory / "metadata.json").write_text(json.dumps(metadata))
        self.assertFalse(restarted.restore_latest_finished())

    def test_restart_keeps_saved_marker_aligned_only_for_identical_feed(self):
        run_id = "object-ui-20261018T010000Z-fixture"
        directory = self.base / "results" / run_id
        directory.mkdir(parents=True)
        (directory / "raw.txt").write_text(CAPTURE)
        self.feed.write_text(CAPTURE)
        metadata = {"run_id": run_id, "active": False, "stage": "stopped_original_restored",
                    "restoration_confirmed": True, "started_at": 1, "finished_at": 2,
                    "capture_session_baseline": 17}
        marker = {"id": "marker", "label": "Blink", "capture_session": 18,
                  "nearest_phase_id": "18:1", "phase_id": "18:1"}
        (directory / "metadata.json").write_text(json.dumps(metadata))
        (directory / "markers.json").write_text(json.dumps([marker]))
        before = {path.name: path.read_bytes() for path in directory.iterdir()}

        fresh_log = BenchLog(self.feed)
        self.assertEqual(fresh_log.state()["session"], 1)
        restarted = BenchRecorder(fresh_log, results_dir=self.base / "results",
                                  transport=lambda command: self.fail("No remote operations permitted"))
        self.assertTrue(restarted.restore_latest_finished())
        phase_id = fresh_log.state()["phases"][0]["id"]
        self.assertEqual(phase_id, restarted.state()["markers"][0]["nearest_phase_id"])
        self.assertEqual(phase_id, "18:1")
        self.assertFalse(restarted.state()["active"])
        self.assertEqual(before, {path.name: path.read_bytes() for path in directory.iterdir()})

        # A different current feed must not inherit this archive's session IDs.
        self.feed.write_text(CAPTURE + "different diagnostic line\n")
        different_log = BenchLog(self.feed)
        different = BenchRecorder(different_log, results_dir=self.base / "results")
        self.assertTrue(different.restore_latest_finished())
        self.assertEqual(different_log.state()["session"], 1)
        self.assertNotEqual(different_log.state()["phases"][0]["id"], marker["nearest_phase_id"])

    def test_concurrent_start_rejected_and_stop_waits_for_restore(self):
        release, polled, calls = threading.Event(), threading.Event(), []
        def transport(command):
            calls.append(command)
            if command.startswith("nohup ") or " && touch " in command:
                return ""
            polled.set()
            release.wait(1)
            return response(CAPTURE, "stopped_original_restored", 0)
        controller = self.recorder(transport)
        controller.start(True)
        self.assertTrue(polled.wait(1))
        with self.assertRaises(RuntimeError):
            controller.start(True)
        self.assertTrue(controller.stop()["active"])
        release.set()
        self.wait(controller)
        self.assertEqual(controller.state()["stage"], "stopped_original_restored")
        self.assertNotIn("error", controller.state())

    def test_stop_request_is_fixed_generated_run_path(self):
        calls, controller = [], None
        def transport(command):
            calls.append(command)
            if command.startswith("nohup "):
                controller.stop()
                return ""
            if " && touch " in command:
                return ""
            return response(CAPTURE, "stopped_original_restored", 0)
        controller = self.recorder(transport)
        controller.start(True)
        self.wait(controller)
        stop_commands = [x for x in calls if " && touch " in x]
        self.assertEqual(len(stop_commands), 1)
        self.assertIn(REMOTE_BASE + "/" + controller.state()["run_id"] + "/stop.request", stop_commands[0])

    def test_markers_have_observed_frame_alignment_and_delete_is_durable(self):
        next_poll, release = threading.Event(), threading.Event()
        polls = [0]
        def transport(command):
            if command.startswith("nohup "):
                return ""
            polls[0] += 1
            if polls[0] == 1:
                return response(CAPTURE)
            next_poll.set()
            release.wait(1)
            return response("BYPASS_COMPLETE\n", "complete", 0)
        controller = self.recorder(transport)
        controller.start(True)
        self.assertTrue(next_poll.wait(1))
        marker = controller.mark("object tapped")
        self.assertEqual(marker["nearest_sequence"], 0)
        self.assertEqual(marker["nearest_read_micros"], 8000)
        self.assertEqual(marker["nearest_phase_id"], self.log.state()["phases"][0]["id"])
        self.assertEqual(marker["capture_session"], self.log.state()["session"])
        self.assertEqual(marker["alignment"], "nearest_observed_frame_not_exact")
        self.assertGreaterEqual(marker["frame_age_seconds"], 0)
        rows = list(csv.DictReader(io.StringIO(controller.export_csv())))
        self.assertEqual(rows[-1]["kind"], "marker")
        self.assertEqual(rows[-1]["label"], "object tapped")
        for invalid in ("", " "*2, "x"*121, None):
            with self.assertRaises(ValueError):
                controller.mark(invalid)
        controller.delete_marker(marker["id"])
        self.assertEqual(controller.state()["markers"], [])
        self.assertEqual(json.loads((controller._directory / "markers.json").read_text()), [])
        with self.assertRaises(ValueError):
            controller.delete_marker("not-real")
        release.set()
        self.wait(controller)
        with self.assertRaises(ValueError):
            controller.mark("after recording ended")

    def test_launcher_failure_is_immediate_and_log_contents_are_never_exposed(self):
        polls = [0]
        def transport(command):
            if command.startswith("nohup ") or " && touch " in command:
                return ""
            polls[0] += 1
            return json.dumps({"launcher_failed": True, "status_text": None, "data": "", "reset": False})
        controller = self.recorder(transport)
        controller.start(True)
        self.wait(controller)
        self.assertEqual(polls[0], 1)
        self.assertFalse(controller.state()["active"])
        self.assertIn("before establishing status", controller.state()["error"])
        remote_run = self.base / "object-ui-fixture"
        remote_run.mkdir()
        launch = Path(str(remote_run)+".launch.log")
        launch.write_text("private traceback and checksum details")
        command = controller._poll_command(str(remote_run), 0)
        output = io.StringIO()
        with redirect_stdout(output):
            exec(compile(shlex.split(command)[2], "<fixed-poll>", "exec"), {})
        payload = json.loads(output.getvalue())
        self.assertTrue(payload["launcher_failed"])
        self.assertTrue((remote_run / "lease.touch").exists())
        self.assertNotIn("private traceback", output.getvalue())
        (remote_run / "status.json").write_text(json.dumps({"stage": "capturing_untrusted_bench_bytes"}))
        output = io.StringIO()
        with redirect_stdout(output):
            exec(compile(shlex.split(command)[2], "<fixed-poll>", "exec"), {})
        self.assertFalse(json.loads(output.getvalue())["launcher_failed"])

    def test_transient_ssh_failure_retries_but_persistent_failure_finishes_unconfirmed(self):
        attempts = [0]
        def transient(command):
            if command.startswith("nohup "):
                return ""
            attempts[0] += 1
            if attempts[0] == 1:
                raise RuntimeError("temporary")
            return response(CAPTURE, "complete", 0)
        controller = self.recorder(transient)
        controller.start(True)
        self.wait(controller)
        self.assertEqual(attempts[0], 2)
        self.assertEqual(controller.state()["stage"], "complete")
        def failure(command):
            if command.startswith("nohup "):
                return ""
            raise RuntimeError("private remote detail")
        controller = self.recorder(failure, max_ssh_failures=2)
        controller.start(True)
        self.wait(controller)
        self.assertFalse(controller.state()["active"])
        self.assertFalse(controller.state()["restoration_confirmed"])
        self.assertIn("unconfirmed", controller.state()["error"])
        self.assertNotIn("private remote detail", json.dumps(controller.state()))

    def test_restore_failure_is_prominent_and_deadline_is_bounded(self):
        controller = self.recorder(lambda command: "" if command.startswith("nohup ") else response(CAPTURE, "restore_failed", 1))
        controller.start(True)
        self.wait(controller)
        self.assertEqual(controller.state()["stage"], "restore_failed")
        self.assertIn("RESTORE FAILED", controller.state()["message"])
        controller = self.recorder(lambda command: "" if command.startswith("nohup ") else response(), deadline_seconds=0.005)
        controller.start(True)
        self.wait(controller)
        self.assertFalse(controller.state()["active"])
        self.assertIn("deadline", controller.state()["error"])

    def test_continuous_default_has_no_deadline_and_failure_requests_stop_once(self):
        calls = []
        def transport(command):
            calls.append(command)
            if command.startswith("nohup ") or " && touch " in command:
                return ""
            raise RuntimeError("offline")
        controller = self.recorder(transport, max_ssh_failures=2)
        self.assertIsNone(controller.deadline_seconds)
        self.assertTrue(controller.state()["continuous"])
        self.assertIsNone(controller.state()["duration_limit_seconds"])
        controller.start(True)
        self.wait(controller)
        self.assertEqual(sum(" && touch " in command for command in calls), 1)
        self.assertTrue(controller.state()["stop_request_sent"])
        self.assertFalse(controller.state()["restoration_confirmed"])

    def test_restart_headers_keep_sample_and_marker_sessions_unambiguous(self):
        # Establish a preexisting viewer session, which the new run must offset.
        self.feed.write_text(CAPTURE)
        self.log.read_new()
        baseline = self.log.state()["session"]
        second_poll, release = threading.Event(), threading.Event()
        polls = [0]
        def transport(command):
            if command.startswith("nohup "):
                return ""
            polls[0] += 1
            if polls[0] == 1:
                return response(CAPTURE + "\nHOST_EVENT,RESTART,1\n" + CAPTURE)
            second_poll.set()
            release.wait(1)
            return response("BYPASS_COMPLETE\n", "stopped_original_restored", 0)
        controller = self.recorder(transport)
        controller.start(True)
        self.assertTrue(second_poll.wait(1))
        marker = controller.mark("after restart")
        exported = controller.export_json()
        self.assertEqual(exported["capture_session_baseline"], baseline)
        self.assertEqual([s["capture_segment"] for s in exported["samples"]], [1, 2])
        self.assertEqual([s["phase_number"] for s in exported["samples"]], [1, 2])
        self.assertEqual([s["capture_session"] for s in exported["samples"]], [baseline+1, baseline+2])
        self.assertEqual(exported["samples"][-1]["phase_id"], marker["nearest_phase_id"])
        self.assertEqual(marker["capture_segment"], 2)
        self.assertEqual(marker["capture_session"], baseline+2)
        rows = list(csv.DictReader(io.StringIO(controller.export_csv())))
        self.assertEqual(rows[1]["capture_segment"], "2")
        release.set()
        self.wait(controller)

    def test_default_transport_uses_only_fixed_host_control_and_batch_mode(self):
        with patch("backend.bench_recorder.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "ok"
            self.assertEqual(_ssh("fixed command"), "ok")
        argv = run.call_args.args[0]
        self.assertIn(SSH_HOST, argv)
        self.assertIn(SSH_CONTROL, argv)
        self.assertIn("BatchMode=yes", argv)
        self.assertEqual(argv[-1], "fixed command")

    def queued_restart(self, *, restore_exit=0, cancel=False):
        first_poll, release, second_launch = threading.Event(), threading.Event(), threading.Event()
        launch_count = [0]
        terminal_returned = [False]
        def transport(command):
            if command.startswith("nohup "):
                launch_count[0] += 1
                if launch_count[0] == 2:
                    self.assertTrue(terminal_returned[0])
                    self.assertEqual(restore_exit, 0)
                    second_launch.set()
                return ""
            if " && touch " in command:
                return ""
            if launch_count[0] == 1:
                first_poll.set()
                release.wait(1)
                terminal_returned[0] = True
                stage = "stopped_original_restored" if restore_exit == 0 else "restore_failed"
                return response(CAPTURE, stage, restore_exit)
            return response(CAPTURE, "complete", 0)
        controller = self.recorder(transport)
        first_run = controller.start(True)["run_id"]
        self.assertTrue(first_poll.wait(1))
        controller.stop()
        queued = controller.start(True)
        self.assertTrue(queued["active"])
        self.assertTrue(queued["start_queued"])
        self.assertEqual(queued["run_id"], first_run)
        self.assertTrue(controller.start(True)["start_queued"])
        self.assertEqual(launch_count[0], 1)
        if cancel:
            self.assertFalse(controller.stop()["start_queued"])
        release.set()
        if restore_exit == 0 and not cancel:
            self.assertTrue(second_launch.wait(1))
        self.wait(controller)
        return controller, launch_count[0], first_run

    def test_stop_then_start_queues_exactly_one_new_run_after_restoration(self):
        controller, launches, first_run = self.queued_restart()
        self.assertEqual(launches, 2)
        self.assertNotEqual(controller.state()["run_id"], first_run)
        self.assertFalse(controller.state()["start_queued"])
        self.assertEqual(controller.state()["stage"], "complete")
        self.assertEqual(len(list((self.base/"results").iterdir())), 2)
        self.assertTrue((self.base/"results"/first_run/"export.json").exists())

    def test_queued_run_never_launches_after_failed_restoration(self):
        controller, launches, first_run = self.queued_restart(restore_exit=1)
        self.assertEqual(launches, 1)
        self.assertEqual(controller.state()["run_id"], first_run)
        self.assertFalse(controller.state()["start_queued"])
        self.assertEqual(controller.state()["stage"], "restore_failed")

    def test_stop_again_cancels_queued_start(self):
        controller, launches, first_run = self.queued_restart(cancel=True)
        self.assertEqual(launches, 1)
        self.assertEqual(controller.state()["run_id"], first_run)
        self.assertFalse(controller.state()["start_queued"])
        self.assertEqual(controller.state()["stage"], "stopped_original_restored")


if __name__ == "__main__":
    unittest.main()
