"""Read-only file-tail viewer for explicitly untrusted, electrode-free bench bytes.

Run: python -m backend.bypass_viewer --log firmware/results/bench-live-20261017.txt
No serial access, ADC conversions, filtering, calibration, or reaction scoring.
"""
from __future__ import annotations

import argparse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit


HEADER = "ID_BYPASS_CONTINUOUS_BENCH_ONLY,ELECTRODE_CABLE_MUST_BE_UNPLUGGED,NOT_EEG"
OBJECT_HEADER = "FRAME_FORMAT_OBJECT_BENCH_ONLY,NONHUMAN_SURFACE_ONLY,NOT_EEG"
PAGE = Path(__file__).resolve().parent.parent / "signal-viewer" / "bench.html"


def signed24(text):
    number = int(text, 16)
    return number - (1 << 24) if number & (1 << 23) else number


class BenchLog:
    """Incremental parser; only a matching fresh header admits sample rows."""

    def __init__(self, path, *, max_samples=1500, clock=time.monotonic):
        self.path = Path(path)
        self.max_samples, self.clock = max_samples, clock
        self.lock = threading.RLock()
        self.identity = None
        self.offset = 0
        self.partial = b""
        self.session = 0
        self.phase_number = 0
        self.active = False
        self.completed = False
        self.phases = deque(maxlen=12)
        self.last_sample_at = None
        self.malformed_rows = 0
        self.ignored_rows = 0
        self.file_missing = True
        self.input_context = "electrode_cable_disconnected"

    def reset_file(self):
        self.offset, self.partial = 0, b""
        self.active, self.completed = False, False
        self.phases.clear()
        self.last_sample_at = None
        self.malformed_rows = self.ignored_rows = 0

    def restore_archived_identity(self, archive_path, capture_session_baseline):
        """Rebuild a matching saved feed's identities without changing any file.

        Session counters normally live only in memory. A restarted viewer may
        therefore call the same saved phase ``1:1`` instead of ``18:1`` and lose
        marker alignment. This operation is for a terminal restored archive:
        the current feed must match its raw bytes exactly, and the original
        pre-capture session counter must be known. It does not admit other feeds
        or mark historical samples as newly received acquisition.
        """
        if type(capture_session_baseline) is not int or capture_session_baseline < 0:
            return False
        with self.lock:
            try:
                archived = Path(archive_path).read_bytes()
                with self.path.open("rb") as handle:
                    before = os.fstat(handle.fileno())
                    current = handle.read()
                    after = os.fstat(handle.fileno())
                latest = self.path.stat()
            except OSError:
                return False
            signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            if current != archived or signature(before) != signature(after) or signature(after) != signature(latest):
                return False
            lines = current.split(b"\n")
            partial = lines.pop()
            decoded = [line.decode("ascii", errors="replace").strip() for line in lines]
            if OBJECT_HEADER not in decoded or HEADER in decoded:
                return False
            restored = BenchLog(self.path, max_samples=self.max_samples, clock=self.clock)
            restored.session = capture_session_baseline
            for line in decoded:
                restored.feed_line(line)
            restored.identity = (after.st_dev, after.st_ino)
            restored.offset, restored.partial = len(current), partial
            restored.file_missing = False
            restored.completed = True
            restored.last_sample_at = None
            for field in ("identity", "offset", "partial", "session", "phase_number", "active",
                          "completed", "phases", "last_sample_at", "malformed_rows", "ignored_rows",
                          "file_missing", "input_context"):
                setattr(self, field, getattr(restored, field))
            return True

    def feed_line(self, line):
        if line in (HEADER, OBJECT_HEADER):
            self.session += 1
            self.input_context = ("nonhuman_object_surface" if line == OBJECT_HEADER
                                  else "electrode_cable_disconnected")
            self.phase_number = 0
            self.active, self.completed = True, False
            self.phases.clear()
            self.last_sample_at = None
            self.malformed_rows = self.ignored_rows = 0
            return
        if not self.active or self.completed:
            if line.startswith("UNTRUSTED_BYPASS,"):
                self.ignored_rows += 1
            return
        fields = line.split(",")
        try:
            if fields[0] == "BYPASS_PHASE":
                values = dict(zip(fields[1::2], fields[2::2]))
                self.phase_number += 1
                self.phases.append({"id": f"{self.session}:{self.phase_number}",
                    "spi_hz_requested": int(values["SPI_HZ"]),
                    "mux_requested": values["MUX"], "read_mode": values["READ_MODE"],
                    "id_reads": [], "valid_id_reads": None, "config_mismatches": None,
                    "frame_count": 0, "invalid_status_count": 0, "gap_count": 0,
                    "samples": deque(maxlen=self.max_samples), "summary": None,
                    "transaction_probes": [],
                    "first_unwrapped": None, "last_micros": None,
                    "unwrapped": None, "last_sequence": None})
            elif fields[0] == "BYPASS_COMPLETE":
                self.completed = True
            elif not self.phases:
                if fields[0] == "UNTRUSTED_BYPASS":
                    self.ignored_rows += 1
            else:
                phase = self.phases[-1]
                if fields[0] == "UNTRUSTED_ID_READS":
                    phase["id_reads"] = fields[1:]
                elif fields[0] == "ID_GUARD_BYPASSED_FOR_BENCH_ONLY":
                    phase["valid_id_reads"] = int(fields[-1])
                elif fields[0] == "CONFIG_READBACK_MISMATCHES":
                    phase["config_mismatches"] = int(fields[1])
                elif fields[0] == "BYPASS_SUMMARY":
                    phase["summary"] = dict(zip(fields[1::2], fields[2::2]))
                elif fields[0] == "UNTRUSTED_BYPASS":
                    self._sample(fields, phase)
                elif fields[0] == "RAW_TRANSACTION":
                    if len(fields) != 4 or len(fields[3]) != 38:
                        raise ValueError("Expected opcode RX plus eighteen payload bytes")
                    bytes.fromhex(fields[3])
                    if len(phase["transaction_probes"]) < 8:
                        phase["transaction_probes"].append({"sequence": int(fields[1]),
                            "read_micros": int(fields[2]), "raw_hex": fields[3].upper(),
                            "opcode_rx_hex": fields[3][:2].upper(),
                            "payload_hex": fields[3][2:].upper()})
        except (ValueError, KeyError, IndexError):
            self.malformed_rows += 1

    def _sample(self, fields, phase):
        if len(fields) != 4 or len(fields[3]) != 18:
            raise ValueError("Expected nine raw bytes")
        sequence, micros = int(fields[1]), int(fields[2])
        raw = fields[3]
        if not 0 <= sequence < 2**32 or not 0 <= micros < 2**32:
            raise ValueError("Invalid unsigned counter")
        if len(bytes.fromhex(raw)) != 9:
            raise ValueError("Expected exactly nine bytes")
        status = int(raw[:6], 16)
        status_ok = (status & 0xF00000) == 0xC00000 and (status & 0x1FFF) == 0
        previous = phase["last_micros"]
        delta = None if previous is None else (micros-previous) % (2**32)
        # 24 ms is a display break threshold, not a verified sampling rate.
        gap = previous is not None and (sequence != phase["last_sequence"]+1
                                       or delta == 0 or delta > 24000)
        unwrapped = micros if previous is None else phase["unwrapped"]+delta
        if phase["first_unwrapped"] is None:
            phase["first_unwrapped"] = unwrapped
        phase["samples"].append({"sequence": sequence, "read_micros": micros,
            "elapsed_seconds": (unwrapped-phase["first_unwrapped"])/1e6,
            "counts": [signed24(raw[6:12]), signed24(raw[12:18])],
            "status_hex": raw[:6].upper(), "status_checks_pass": status_ok,
            "break_before": previous is None or gap})
        phase["last_micros"], phase["last_sequence"] = micros, sequence
        phase["unwrapped"] = unwrapped
        phase["frame_count"] += 1
        phase["invalid_status_count"] += not status_ok
        phase["gap_count"] += gap
        self.last_sample_at = self.clock()

    def read_new(self):
        with self.lock:
            try:
                with self.path.open("rb") as handle:
                    info = os.fstat(handle.fileno())
                    identity = (info.st_dev, info.st_ino)
                    if identity != self.identity or info.st_size < self.offset:
                        self.reset_file()
                        self.identity = identity
                    handle.seek(self.offset)
                    # Bound each poll's work and retained incomplete input.
                    data = handle.read(2 * 1024 * 1024)
                    self.offset = handle.tell()
                self.file_missing = False
            except FileNotFoundError:
                self.file_missing = True
                return
            lines = (self.partial + data).split(b"\n")
            self.partial = lines.pop()
            if len(self.partial) > 65536:
                self.partial = b""
                self.malformed_rows += 1
            for line in lines:
                self.feed_line(line.decode("ascii", errors="replace").strip())

    def state(self):
        with self.lock:
            self.read_new()
            age = None if self.last_sample_at is None else max(0, self.clock()-self.last_sample_at)
            current = self.phases[-1] if self.phases else None
            if self.file_missing:
                status = "waiting_for_file"
            elif not self.active:
                status = "waiting_for_fresh_header"
            elif self.completed:
                status = "completed_saved_capture"
            elif current is None or not current["frame_count"]:
                status = "no_frames_in_current_phase"
            elif age is not None and age > 2:
                status = "stale_capture_incomplete"
            else:
                status = "capturing_untrusted_bytes"
            private = {"first_unwrapped", "last_micros", "unwrapped", "last_sequence"}
            phases = [{**{k: v for k, v in phase.items() if k not in private and k != "samples"},
                       "samples": list(phase["samples"])} for phase in self.phases]
            return {"source": "untrusted_bench_log", "units": "raw signed 24-bit counts",
                "not_eeg": True, "filtered": False, "status": status,
                "input_context": self.input_context,
                "session": self.session, "completed": self.completed,
                "sample_age_seconds": age, "phases": phases,
                "malformed_rows": self.malformed_rows, "ignored_rows": self.ignored_rows,
                "retained_samples_per_phase": self.max_samples,
                "file_name": self.path.name, "gap_break_threshold_us": 24000,
                "clock_basis": "actual Uno host-read micros per phase; not ADC timestamps"}


def handler_for(log):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/api/state":
                body = json.dumps(log.state(), allow_nan=False).encode()
                content = "application/json"
            elif path in ("/", "/bench.html"):
                body, content = PAGE.read_bytes(), "text/html; charset=utf-8"
            elif path == "/raw.txt":
                try:
                    body = log.path.read_bytes()
                except FileNotFoundError:
                    self.send_error(404, "Capture file not created yet")
                    return
                content = "text/plain; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if path == "/raw.txt":
                self.send_header("Content-Disposition", 'attachment; filename="'+log.path.name+'"')
            self.end_headers()
            self.wfile.write(body)
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", default="firmware/results/bench-live-20261017.txt")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8768)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), handler_for(BenchLog(args.log)))
    print(f"UNTRUSTED BENCH COUNTS — http://{args.host}:{args.port}/ — {args.log}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
