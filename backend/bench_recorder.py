"""Opt-in controller for the fixed, leased NONHUMAN object diagnostic runner.

No serial access or human-input path. SSH invokes only the audited fixed runner,
reads its own generated run directory, or writes that run's stop.request file.
"""
from __future__ import annotations

import base64
import copy
import csv
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from backend.bypass_viewer import OBJECT_HEADER, signed24


SSH_CONTROL = os.environ.get("SIGNAL_SCOPE_SSH_CONTROL", "/tmp/signal-scope-ssh/control")
SSH_HOST = os.environ.get("SIGNAL_SCOPE_SSH_HOST", "root@orangepi.local")
REMOTE_BASE = os.environ.get("SIGNAL_SCOPE_REMOTE_BASE", "/root/adaptive-horror/firmware/id-bypass-diagnostic")
TERMINAL_STAGES = {"complete", "stopped_original_restored", "capture_failed_original_restored", "restore_failed"}
DEFAULT_RESULTS = Path(__file__).resolve().parent / "results/bench-recordings"


class _LaunchFailure(RuntimeError):
    """Remote launcher reported output before it could establish run status."""


def _ssh(command):
    result = subprocess.run(
        ["ssh", "-S", SSH_CONTROL, "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
         "-o", "ServerAliveInterval=2", "-o", "ServerAliveCountMax=2",
         SSH_HOST, command], capture_output=True, text=True, timeout=10)
    if result.returncode:
        # Do not return shell output/credentials to browser clients.
        raise RuntimeError("Fixed Pi SSH command failed")
    return result.stdout


class BenchRecorder:
    def __init__(self, bench_log, *, log_path=None, results_dir=None, enabled=False,
                 transport=None, poll_interval=0.5, deadline_seconds=None,
                 max_ssh_failures=8):
        self.bench_log = bench_log
        self.log_path = Path(log_path) if log_path is not None else bench_log.path
        if self.log_path.resolve() != bench_log.path.resolve():
            raise ValueError("Recorder and BenchLog must share the same feed file")
        self.results_dir = Path(results_dir) if results_dir is not None else DEFAULT_RESULTS
        self.enabled = enabled is True
        self._transport = transport or _ssh
        self.poll_interval = poll_interval
        self.deadline_seconds = deadline_seconds
        self.max_ssh_failures = max_ssh_failures
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._thread = None
        self._directory = None
        self._temporary_directory = None
        self._record_to_disk = True
        self._queued_record_to_disk = True
        self._started_monotonic = None
        self._capture_session_baseline = 0
        self._stop_requested = False
        self._start_queued = False
        self._markers = []
        self._state = {"active": False, "stage": "idle", "message": "No object recording started",
                       "run_id": None, "started_at": None, "finished_at": None}

    def _public(self):
        return {**copy.deepcopy(self._state), "markers": copy.deepcopy(self._markers),
                "enabled": self.enabled, "source": "untrusted_bench_bytes",
                "input_context": "nonhuman_object_surface", "not_eeg": True,
                "body_acquisition_enabled": False, "human_acquisition_enabled": False,
                "units": "raw signed 24-bit counts", "continuous": True,
                "duration_limit_seconds": None, "remote_lease_timeout_seconds": 30,
                "start_queued": self._start_queued, "next_run_requested": self._start_queued,
                "record_to_disk": self._record_to_disk,
                "recording_saved": self._record_to_disk and self._directory is not None,
                "storage_mode": "archive" if self._record_to_disk else "temporary_diagnostics"}

    def state(self):
        with self._lock:
            return self._public()

    def restore_latest_finished(self):
        """Restore a completed local archive for export, never acquisition.

        A viewer restart must not silently replace the last saved recording with
        empty in-memory state. Only this recorder's results directory is read;
        active, failed, or restoration-unconfirmed runs cannot be resumed here.
        """
        with self._lock:
            if self._state["active"]:
                raise RuntimeError("Cannot restore an archive while acquisition is active")
            candidates = []
            if not self.results_dir.exists():
                return False
            root = self.results_dir.resolve()
            for directory in self.results_dir.glob("object-ui-*"):
                try:
                    if not directory.is_dir() or directory.resolve().parent != root:
                        continue
                    metadata = json.loads((directory / "metadata.json").read_text())
                    if (metadata.get("active") is not False or metadata.get("restoration_confirmed") is not True
                            or metadata.get("stage") not in {"complete", "stopped_original_restored"}
                            or metadata.get("run_id") != directory.name
                            or metadata.get("record_to_disk", True) is not True
                            or not (directory / "raw.txt").is_file()):
                        continue
                    markers = json.loads((directory / "markers.json").read_text())
                    if not isinstance(markers, list) or any(not isinstance(m, dict) or "id" not in m for m in markers):
                        continue
                    started = float(metadata.get("started_at", 0))
                    candidates.append((started, directory.name, directory, metadata, markers))
                except (OSError, ValueError, TypeError):
                    continue
            if not candidates:
                return False
            _, _, directory, metadata, markers = max(candidates, key=lambda item: item[:2])
            self._cleanup_temporary()
            self._directory, self._record_to_disk = directory, True
            keys = ("active", "stage", "message", "run_id", "started_at", "finished_at",
                    "restoration_confirmed", "remote_status", "capture_session_baseline")
            self._state = {key: metadata[key] for key in keys if key in metadata}
            self._markers = markers
            self._capture_session_baseline = metadata.get("capture_session_baseline", 0)
            self._start_queued, self._stop_requested = False, False
            # Identity restoration is safe only when the saved counter is known
            # and this exact completed capture is still the viewer's feed.
            saved_baseline = metadata.get("capture_session_baseline")
            if type(saved_baseline) is int and saved_baseline >= 0:
                self.bench_log.restore_archived_identity(directory / "raw.txt", saved_baseline)
            return True

    def _persist(self):
        if self._directory is None:
            return
        for name, value in (("metadata.json", self._public()), ("markers.json", self._markers)):
            temporary = self._directory / (name + ".tmp")
            temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
            temporary.replace(self._directory / name)

    def start(self, nonhuman_surface_only=False, *, record_to_disk=True):
        if nonhuman_surface_only is not True:
            raise ValueError("Explicit nonhuman_surface_only=true confirmation is required")
        if type(record_to_disk) is not bool:
            raise ValueError("record_to_disk must be a boolean")
        with self._lock:
            if not self.enabled:
                raise RuntimeError("Object recorder is disabled; server CLI opt-in is required")
            if self._state["active"]:
                if self._stop_requested or self._state["stage"] in {"stop_requested", "restoring_original_firmware"}:
                    self._start_queued = True
                    self._queued_record_to_disk = record_to_disk
                    self._state["message"] = "Next object recording queued; waiting for confirmed firmware restoration"
                    self._persist()
                    return self._public()
                raise RuntimeError("An object recording is already active")
            now = time.time()
            stamp = datetime.fromtimestamp(now, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            run_id = "object-ui-" + stamp + "-" + uuid.uuid4().hex
            self._cleanup_temporary()
            self._record_to_disk = record_to_disk
            if record_to_disk:
                directory = self.results_dir / run_id
                directory.mkdir(parents=True, exist_ok=False)
            else:
                self._temporary_directory = tempfile.TemporaryDirectory(prefix="signal-scope-live-")
                directory = Path(self._temporary_directory.name)
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            if self.log_path.exists():
                shutil.copyfile(self.log_path, directory / "previous-feed.txt")
            # A new inode guarantees BenchLog resets even if the new feed grows
            # beyond its old offset before a browser request next reads it.
            temporary = directory / "new-feed.tmp"
            temporary.write_bytes(b"")
            temporary.replace(self.log_path)
            (directory / "raw.txt").write_bytes(b"")
            self._directory = directory
            self._markers = []
            self._stop_requested = False
            self._start_queued = False
            self._wake.clear()
            self._started_monotonic = time.monotonic()
            self._state = {"active": True, "stage": "starting", "message": "Starting nonhuman object diagnostic until Stop",
                           "run_id": run_id, "started_at": now, "finished_at": None,
                           "restoration_confirmed": False, "remote_status": None}
            self.bench_log.read_new()
            self._capture_session_baseline = self.bench_log.state()["session"]
            self._state["capture_session_baseline"] = self._capture_session_baseline
            self._persist()
            self._thread = threading.Thread(target=self._worker, args=(run_id,), daemon=True)
            self._thread.start()
            return self._public()

    def stop(self):
        with self._lock:
            self._start_queued = False
            if self._state["active"]:
                self._stop_requested = True
                self._state.update(stage="stop_requested", message="Stop requested; awaiting original-firmware restoration")
                self._persist()
                self._wake.set()
            return self._public()

    def mark(self, label):
        if not isinstance(label, str) or not label.strip() or len(label) > 120:
            raise ValueError("Marker label must contain 1–120 characters")
        with self._lock:
            if not self._state["active"]:
                raise ValueError("Markers can be added only during an active object recording")
            feed = self.bench_log.state()
            phase = feed["phases"][-1] if feed.get("phases") else None
            sample = phase["samples"][-1] if phase and phase.get("samples") else None
            marker = {"id": uuid.uuid4().hex, "label": label.strip(), "timestamp": time.time(),
                      "run_elapsed_seconds": max(0, time.monotonic()-self._started_monotonic),
                      "alignment": "nearest_observed_frame_not_exact",
                      "nearest_sequence": sample["sequence"] if sample else None,
                      "nearest_read_micros": sample["read_micros"] if sample else None,
                      "frame_age_seconds": feed.get("sample_age_seconds") if sample else None,
                      "phase_id": phase["id"] if phase else None,
                      "nearest_phase_id": phase["id"] if phase else None,
                      "capture_session": feed.get("session"),
                      "capture_segment": (feed.get("session", 0)-self._capture_session_baseline) or None}
            self._markers.append(marker)
            self._persist()
            return copy.deepcopy(marker)

    def delete_marker(self, marker_id):
        with self._lock:
            before = len(self._markers)
            self._markers = [m for m in self._markers if m["id"] != marker_id]
            if len(self._markers) == before:
                raise ValueError("Unknown object-recording marker")
            self._persist()
            if not self._state["active"]:
                self._save_exports()
            return self._public()

    def _poll_command(self, remote_run, offset):
        # Every path is derived exclusively from the internally generated run ID.
        script = ("import base64,json;from pathlib import Path;"
                  f"p=Path({remote_run!r});s=p/'status.json';c=p/'capture.txt';"
                  "(p/'lease.touch').touch() if p.is_dir() else None;"
                  "status=s.read_text() if s.exists() else None;"
                  "launch=Path(str(p)+'.launch.log');"
                  "launcher_failed=status is None and launch.exists() and launch.stat().st_size>0;"
                  "size=c.stat().st_size if c.exists() else 0;"
                  f"offset={offset};reset=size<offset;offset=0 if reset else offset;"
                  "f=c.open('rb') if c.exists() else None;"
                  "f.seek(offset) if f else None;data=f.read(2097152) if f else b'';"
                  "f.close() if f else None;"
                  "print(json.dumps({'status_text':status,'launcher_failed':launcher_failed,'reset':reset,'data':base64.b64encode(data).decode()}))")
        return "python3 -c " + shlex.quote(script)

    def _worker(self, run_id):
        remote_run = REMOTE_BASE + "/" + run_id
        offset, failures, stop_sent = 0, 0, False
        try:
            launch = ("nohup python3 " + shlex.quote(REMOTE_BASE + "/run_object_continuous.py")
                      + " --nonhuman-surface-only --run-name " + shlex.quote(run_id)
                      + " >" + shlex.quote(REMOTE_BASE + "/" + run_id + ".launch.log")
                      + " 2>&1 </dev/null &")
            self._transport(launch)
            while self.deadline_seconds is None or time.monotonic()-self._started_monotonic < self.deadline_seconds:
                try:
                    with self._lock:
                        should_stop = self._stop_requested and not stop_sent
                    if should_stop:
                        self._transport("test -d " + shlex.quote(remote_run)
                                        + " && touch " + shlex.quote(remote_run + "/stop.request"))
                        stop_sent = True
                    payload = json.loads(self._transport(self._poll_command(remote_run, offset)))
                    if payload.get("launcher_failed"):
                        raise _LaunchFailure("Remote runner failed before establishing status; restoration is unconfirmed")
                    data = base64.b64decode(payload["data"], validate=True)
                    status_text = payload.get("status_text")
                    status = json.loads(status_text) if status_text else None
                    with self._lock:
                        if payload.get("reset"):
                            # Preserve partial bytes if the remote reader rewinds.
                            raw = self._directory / "raw.txt"
                            if raw.stat().st_size:
                                shutil.copyfile(raw, self._directory / ("rewound-" + uuid.uuid4().hex + ".txt"))
                            raw.write_bytes(b"")
                            self.log_path.write_bytes(b"")
                            with self.bench_log.lock:
                                self.bench_log.reset_file()
                            offset = 0
                        if data:
                            with (self._directory / "raw.txt").open("ab") as handle:
                                handle.write(data)
                            with self.log_path.open("ab") as handle:
                                handle.write(data)
                            offset += len(data)
                            self.bench_log.read_new()
                        failures = 0
                        if status is not None:
                            (self._directory / "status.json").write_text(status_text)
                            stage = status.get("stage", "waiting_for_remote_status")
                            self._state.update(stage=stage, remote_status=status,
                                               message="Nonhuman object diagnostic: " + stage.replace("_", " "))
                            if stage in TERMINAL_STAGES:
                                restored = status.get("restore_exit") == 0
                                self._state.update(active=False, finished_at=time.time(), restoration_confirmed=restored)
                                if not restored:
                                    self._start_queued = False
                                    self._state.update(stage="restore_failed", error="Original firmware restoration failed or is unconfirmed",
                                                       message="RESTORE FAILED: original firmware is not confirmed restored")
                                elif stage not in {"complete", "stopped_original_restored"}:
                                    self._state["error"] = "Object capture failed; original firmware restored"
                                self._persist()
                                self._save_exports()
                                self._cleanup_temporary()
                                if restored and self._start_queued:
                                    self._launch_queued_start()
                                return
                        self._persist()
                except _LaunchFailure:
                    raise
                except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError):
                    failures += 1
                    with self._lock:
                        self._state.update(stage="reconnecting", message="Pi SSH temporarily unavailable; runner restoration remains independent")
                        self._persist()
                    if failures >= self.max_ssh_failures:
                        raise RuntimeError("Pi connection unavailable; remote restoration is unconfirmed")
                self._wake.wait(self.poll_interval)
                self._wake.clear()
            raise RuntimeError("Recording controller deadline exceeded; remote restoration is unconfirmed")
        except Exception as error:
            # The independent remote runner also expires its 30-second lease.
            # Request Stop once where possible; never claim that writing the
            # request alone establishes successful firmware restoration.
            if not stop_sent:
                try:
                    self._transport("test -d " + shlex.quote(remote_run)
                                    + " && touch " + shlex.quote(remote_run + "/stop.request"))
                    stop_sent = True
                except Exception:
                    pass
            with self._lock:
                self._start_queued = False
                self._state.update(active=False, stage="error", finished_at=time.time(),
                                   error=str(error) if isinstance(error, RuntimeError) else "Object recording controller failed",
                                   message="Recording stopped locally; remote firmware restoration is unconfirmed",
                                   restoration_confirmed=False, stop_request_sent=stop_sent)
                self._persist()
                self._save_exports()
                self._cleanup_temporary()

    def _launch_queued_start(self):
        """Called only after prior remote restoration and exports are complete."""
        self._start_queued = False
        try:
            self.start(True, record_to_disk=self._queued_record_to_disk)
        except Exception:
            # A local setup failure must not fall back into the old run's SSH
            # polling loop or imply that the confirmed restoration failed.
            self._state.update(active=False, stage="queued_start_failed",
                               message="Original firmware restored; queued recording could not start",
                               error="Queued object-recording setup failed", restoration_confirmed=True)
            self._persist()

    def _samples(self):
        if self._directory is None:
            return []
        samples, admitted, phase_number, capture_segment, phase_in_segment = [], False, 0, 0, 0
        for line in (self._directory / "raw.txt").read_text(errors="replace").splitlines():
            if line == OBJECT_HEADER:
                admitted, phase_in_segment = True, 0
                capture_segment += 1
            elif admitted and line.startswith("BYPASS_PHASE,"):
                phase_number += 1
                phase_in_segment += 1
            elif admitted and phase_in_segment and line.startswith("UNTRUSTED_BYPASS,"):
                fields = line.split(",")
                try:
                    if len(fields) != 4 or len(fields[3]) != 18:
                        continue
                    raw = bytes.fromhex(fields[3])
                    sequence, micros = int(fields[1]), int(fields[2])
                    if len(raw) != 9 or not 0 <= sequence < 2**32 or not 0 <= micros < 2**32:
                        continue
                    status = int(fields[3][:6], 16)
                    capture_session = self._capture_session_baseline + capture_segment
                    samples.append({"sequence": sequence, "read_micros": micros,
                                    "phase_number": phase_number, "capture_segment": capture_segment,
                                    "capture_session": capture_session,
                                    "phase_id": f"{capture_session}:{phase_in_segment}",
                                    "raw_hex": fields[3].upper(),
                                    "status_hex": fields[3][:6].upper(),
                                    "status_checks_pass": (status & 0xF00000) == 0xC00000 and (status & 0x1FFF) == 0,
                                    "ch1_counts": signed24(fields[3][6:12]), "ch2_counts": signed24(fields[3][12:18])})
                except ValueError:
                    continue
        return samples

    def export_json(self):
        with self._lock:
            return {**self._public(), "samples": self._samples(),
                    "timestamp_basis": "Uno host read micros; markers use controller clock",
                    "marker_alignment": "nearest_observed_frame_not_exact"}

    def export_csv(self):
        with self._lock:
            output = io.StringIO()
            fields = ["kind", "run_id", "not_eeg", "input_context", "phase_number", "sequence", "read_micros",
                      "raw_hex", "status_hex", "status_checks_pass", "ch1_counts", "ch2_counts", "id", "label",
                      "timestamp", "run_elapsed_seconds", "nearest_sequence", "nearest_read_micros",
                      "frame_age_seconds", "phase_id", "nearest_phase_id", "capture_session", "capture_segment", "alignment"]
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            common = {"run_id": self._state["run_id"], "not_eeg": True, "input_context": "nonhuman_object_surface"}
            for sample in self._samples():
                writer.writerow({**common, "kind": "sample", **sample})
            for marker in self._markers:
                writer.writerow({**common, "kind": "marker", **marker})
            return output.getvalue()

    def _save_exports(self):
        if self._record_to_disk and self._directory is not None:
            (self._directory / "export.json").write_text(json.dumps(self.export_json(), indent=2, allow_nan=False)+"\n")
            (self._directory / "export.csv").write_text(self.export_csv())

    def _cleanup_temporary(self):
        """Transport diagnostics are not user archives; discard after restoration."""
        if self._temporary_directory is not None:
            self._temporary_directory.cleanup()
            self._temporary_directory = None
            self._directory = None
