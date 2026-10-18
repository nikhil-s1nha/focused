"""Local, stand-alone two-channel bench/synthetic waveform viewer server.

Default sources never write firmware. An explicit local CLI option enables the
fixed, bounded nonhuman-object bench runner; no body-input mode or game relay.
"""
from __future__ import annotations

import argparse
from collections import deque
import csv
import glob
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path
import queue
import random
import select
import stat
import threading
import time
import uuid
from urllib.parse import urlsplit

import numpy as np
from scipy.signal import sosfilt, sosfilt_zi

from .bypass_viewer import BenchLog
from .bench_recorder import BenchRecorder
from .acquire_signal import BenchAcquisition, PROFILES
from .eeg_processing import EEGProcessor, ProcessingConfig


STATIC_ROOT = Path(__file__).resolve().parent.parent / "signal-viewer"
BENCH_LOG_PATH = Path(__file__).resolve().parent.parent / "firmware/results/bench-live-20261017.txt"
SERIAL_SOURCES = frozenset({"internal_test", "shorted_input"})
SOURCE_LABELS = {"synthetic": "DEMO — generated synthetic waveform, no sensor attached",
                 "internal_test": "BENCH — sensor internal test signal, not EEG",
                 "shorted_input": "BENCH — internally shorted inputs, not EEG"}
SAMPLE_RATE = 125
SAMPLE_QUALITY_SCOPE = "latest_ch2_summary_gated_by_immediate_raw_flags_on_both_channels"


def serial_ports() -> list[str]:
    patterns = ("/dev/cu.usb*", "/dev/tty.usb*", "/dev/ttyACM*", "/dev/ttyUSB*",
                "/dev/serial/by-id/*")
    return sorted({p for pattern in patterns for p in glob.glob(pattern)})


def json_bytes(value) -> bytes:
    return json.dumps(value, allow_nan=False, separators=(",", ":")).encode()


def ui_version(directory=STATIC_ROOT):
    digest=hashlib.sha256()
    for name in ('index.html','app.js','bench-panel.js','styles.css','auto-refresh.js','partner-link.js','partner-live-state.js','scope-tabs.js'):
        path=Path(directory)/name
        digest.update(name.encode())
        digest.update(path.read_bytes() if path.is_file() else b'')
    return digest.hexdigest()


def initial_summary(reason="startup") -> dict:
    return {"timestamp": None, "signal_quality": 0.0, "quality_reasons": [reason],
            "calibrated": False, "baseline_progress": 0.0,
            "intensity": 0.0, "reaction_score": 0.0, "rms_uv": 0.0,
            "reaction_event": False, "test_event": False}


class TraceFilter:
    """Full-rate display filter, independent of the 10 Hz scoring summaries."""

    def __init__(self, sos):
        self.sos = np.array(sos, copy=True)
        self.zi = None

    def reset(self):
        self.zi = None

    def feed(self, value):
        if not math.isfinite(value):
            self.reset()
            return None
        if self.zi is None:
            self.zi = sosfilt_zi(self.sos) * value
        output, self.zi = sosfilt(self.sos, [value], zi=self.zi)
        return float(output[0])


class SerialReader:
    """One nonblocking, exclusive serial descriptor. Never writes serial bytes.

    Opening an Uno serial port can trigger its normal USB reset. It never
    uploads a sketch or changes ADC settings. TIOCEXCL prevents new opens while
    attached; stop any reader already running before attachment.
    """

    def __init__(self, port: str):
        import fcntl
        import termios

        if port not in serial_ports():
            raise ValueError("Choose an available USB serial port from /api/ports")
        if not stat.S_ISCHR(os.stat(port).st_mode):
            raise ValueError("Serial port must be a character device")
        self.fd = None
        self.buffer = b""
        fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, termios.TIOCEXCL)
            settings = termios.tcgetattr(fd)
            settings[:4] = [0, 0, termios.CLOCAL | termios.CREAD | termios.CS8, 0]
            settings[4:6] = [termios.B115200, termios.B115200]
            settings[6][termios.VMIN] = settings[6][termios.VTIME] = 0
            termios.tcsetattr(fd, termios.TCSANOW, settings)
            termios.tcflush(fd, termios.TCIFLUSH)
            self.fd = fd
        except BaseException:
            os.close(fd)
            raise

    def read_lines(self) -> list[str]:
        if self.fd is None:
            return []
        ready, _, _ = select.select([self.fd], [], [], 0)
        if not ready:
            return []
        try:
            chunk = os.read(self.fd, 16384)
        except BlockingIOError:
            return []
        if not chunk:
            raise OSError("Serial device disconnected")
        self.buffer += chunk
        if len(self.buffer) > 65536:
            self.buffer = b""
            raise ValueError("Oversized serial input; detached")
        lines = self.buffer.split(b"\n")
        self.buffer = lines.pop()
        return [line.decode("ascii", errors="replace").strip() for line in lines]

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)


class ViewerEngine:
    def __init__(self, *, max_recording_samples=75000, clock=time.time,
                 monotonic=time.monotonic):
        self.lock = threading.RLock()
        self.clock, self.monotonic = clock, monotonic
        self.max_recording_samples = max_recording_samples
        self.listeners: set[queue.Queue] = set()
        self.reader = None
        self.source = "synthetic"
        self.mode = "demo"
        self.status = "running"
        self.message = SOURCE_LABELS[self.source]
        self.generation = 0
        self.recording = False
        self.record_samples: list[dict] = []
        self.record_markers: list[dict] = []
        self.truncated = False
        self.pending: list[dict] = []
        self.pending_markers: list[dict] = []
        self.marker_history = deque(maxlen=500)
        self.markers_revision = 0
        self.diagnostics = deque(maxlen=10)
        self.rng = random.Random(20261017)
        self.demo_started = self.clock()
        self.demo_sequence = 0
        self.demo_pulse_until = 0.0
        self.last_serial_sample = self.monotonic()
        self.stale = False
        self._configure_processing()

    def _configure_processing(self):
        self.summaries = [initial_summary(), initial_summary()]
        if self.source == "synthetic":
            config = ProcessingConfig(adc_full_scale_uv=100000)
            self.processors = [EEGProcessor(config), EEGProcessor(config)]
            self.adapters = []
        else:
            self.adapters = [BenchAcquisition(self.source, channel=i) for i in (1, 2)]
            self.processors = [adapter.processor for adapter in self.adapters]
        self.filters = [TraceFilter(processor.sos) for processor in self.processors]

    def recording_state(self):
        return {"active": self.recording, "samples": len(self.record_samples),
                "markers": len(self.record_markers), "truncated": self.truncated,
                "max_samples": self.max_recording_samples}

    def summary(self):
        return {**self.summaries[1], "channel": 2,
                "channels": [dict(item) for item in self.summaries]}

    def state(self):
        with self.lock:
            return {"mode": self.mode, "source": self.source,
                    "source_label": SOURCE_LABELS[self.source], "status": self.status,
                    "message": self.message, "sample_rate": SAMPLE_RATE,
                    "channel_count": 2, "units": "microvolts", "generation": self.generation,
                    "summary": self.summary(), "recording": self.recording_state(),
                    "ports": serial_ports(), "body_acquisition_enabled": False,
                    "conversion_profile": self.conversion_profile(),
                    "diagnostics": list(self.diagnostics),
                    "marker_history": list(self.marker_history),
                    "markers_revision": self.markers_revision,
                    "filter": {"highpass_hz": 1, "lowpass_hz": 30, "causal": True},
                    "baseline_seconds": 30, "startup_seconds": 5}

    def conversion_profile(self):
        if self.source == "synthetic":
            return {"basis": "generated directly in microvolts; no ADC or electrodes",
                    "sample_rate": SAMPLE_RATE}
        return dict(self.adapters[1].profile)

    def _clear_current_markers(self):
        self.pending_markers.clear()
        self.marker_history.clear()
        self.markers_revision += 1

    def marker_state(self):
        with self.lock:
            return {"generation": self.generation, "source": self.source,
                    "marker_history": list(self.marker_history),
                    "markers_revision": self.markers_revision,
                    "recording": self.recording_state()}

    def subscribe(self):
        with self.lock:
            client = queue.Queue(maxsize=20)
            self.listeners.add(client)
            client.put({"type": "state", **self.state()})
            return client

    def unsubscribe(self, client):
        with self.lock:
            self.listeners.discard(client)

    def _broadcast(self, item):
        for client in tuple(self.listeners):
            if client.full():
                try:
                    client.get_nowait()
                except queue.Empty:
                    pass
            try:
                client.put_nowait(item)
            except queue.Full:
                pass

    def switch_source(self, source: str, port=None):
        if source not in SOURCE_LABELS:
            raise ValueError("Source must be synthetic, internal_test, or shorted_input")
        if source != "synthetic" and (not isinstance(port, str) or not port):
            raise ValueError("An explicit USB serial port is required")
        with self.lock:
            if self.reader:
                self.reader.close()
                self.reader = None
            self.source = source
            self.mode = "demo" if source == "synthetic" else "serial"
            self.generation += 1
            self.pending.clear()
            self._clear_current_markers()
            self.diagnostics.clear()
            self._configure_processing()
            self.last_serial_sample = self.monotonic()
            self.stale = False
            if source == "synthetic":
                self.status = "running"
                self.message = SOURCE_LABELS[source]
                self.demo_started, self.demo_sequence = self.clock(), 0
                self.demo_pulse_until = 0.0
            else:
                self.status = "connecting"
                self.message = "Waiting for labelled bench frames; keep electrodes disconnected"
                try:
                    self.reader = SerialReader(port)
                except (OSError, ValueError) as error:
                    self.status = "error"
                    self.message = f"Serial attachment failed: {error}"
                    self.summaries = [initial_summary("serial_unavailable") for _ in range(2)]
                    self._broadcast({"type": "state", **self.state()})
                    raise ValueError(self.message) from error
            self.mark("Source: " + source)
            self._broadcast({"type": "state", **self.state()})
            return self.state()

    def demo_pulse(self):
        with self.lock:
            if self.source != "synthetic":
                raise ValueError("Simulated pulses are available only in DEMO synthetic mode")
            self.demo_pulse_until = self.clock() + .6
            return self.mark("Simulated electrical burst — DEMO")

    def calibrate(self):
        with self.lock:
            self.generation += 1
            self.pending.clear()
            self._clear_current_markers()
            for processor in self.processors:
                processor.reset()
            for trace in self.filters:
                trace.reset()
            self.summaries = [initial_summary("recalibrating") for _ in range(2)]
            self.mark("Calibration restarted")
            return self.state()

    def mark(self, label):
        if not isinstance(label, str) or not label.strip() or len(label) > 120:
            raise ValueError("Marker label must contain 1–120 characters")
        with self.lock:
            marker = {"id": uuid.uuid4().hex, "timestamp": self.clock(), "label": label.strip(),
                      "source": self.source, "generation": self.generation}
            self.pending_markers.append(marker)
            self.pending_markers = self.pending_markers[-100:]
            self.marker_history.append(marker)
            self.markers_revision += 1
            if self.recording:
                self.record_markers.append(marker)
                self.record_markers = self.record_markers[-10000:]
            return marker

    def delete_markers(self, *, marker_id=None, all_markers=False):
        if all_markers is not True and (not isinstance(marker_id, str) or not marker_id):
            raise ValueError("Provide a marker id or all: true")
        if all_markers is True and marker_id is not None:
            raise ValueError("Choose a single marker id or all: true")
        with self.lock:
            def retained(marker):
                return not all_markers and marker.get("id") != marker_id
            self.pending_markers = [m for m in self.pending_markers if retained(m)]
            self.marker_history = deque((m for m in self.marker_history if retained(m)), maxlen=500)
            self.record_markers = [m for m in self.record_markers if retained(m)]
            self.markers_revision += 1
            result = {"type": "markers", **self.marker_state()}
            self._broadcast(result)
            return result

    def set_recording(self, active):
        if not isinstance(active, bool):
            raise ValueError("recording must be true or false")
        with self.lock:
            if active and self.status != "running":
                raise ValueError("Recording requires a running source; saved recording retained")
            if active and not self.recording:
                self.record_samples.clear()
                self.record_markers.clear()
                self.truncated = False
            self.recording = active
            if active:
                self.mark("Recording started")
            return self.recording_state()

    def _append_sample(self, timestamp, raw, sequence, counts=None, provenance=None):
        # Summary quality is computed at 10 Hz. Check every raw sample here so
        # a rail hit between summaries cannot inherit an earlier good label.
        flags = []
        for value, processor in zip(raw, self.processors):
            reasons = []
            if not math.isfinite(value):
                reasons.append("nonfinite")
            elif processor.config.adc_full_scale_uv is None:
                reasons.append("adc_range_unknown")
            elif abs(value) >= processor.config.clip_fraction * processor.config.adc_full_scale_uv:
                reasons.append("clipping")
            flags.append(reasons)
        summaries = [{**summary, "timestamp": summary.get("timestamp"),
                      "quality_reasons": list(summary.get("quality_reasons", []))}
                     for summary in self.summaries]
        raw_quality = [0.0 if reasons else 1.0 for reasons in flags]
        provenance = provenance or {}
        item = {"timestamp": timestamp,
                "raw_uv": [value if math.isfinite(value) else None for value in raw],
                "filtered_uv": [f.feed(value) for f, value in zip(self.filters, raw)],
                "sequence": sequence, "source": self.source,
                "source_label": SOURCE_LABELS[self.source], "sample_rate": SAMPLE_RATE,
                "generation": self.generation, "raw_quality_reasons": flags,
                "raw_signal_quality": raw_quality, "latest_summaries": summaries,
                "channel_signal_quality": [min(quality, summary.get("signal_quality", 0))
                                           for quality, summary in zip(raw_quality, summaries)],
                "signal_quality": min(self.summaries[1].get("signal_quality", 0), *raw_quality),
                "calibrated": self.summaries[1].get("calibrated", False),
                "quality_scope": SAMPLE_QUALITY_SCOPE,
                "device_read_micros": provenance.get("device_read_micros"),
                "received_at": provenance.get("received_at"),
                "uv_per_count_nominal": provenance.get("uv_per_count_nominal"),
                "observed_read_rate_hz": provenance.get("observed_read_rate_hz"),
                "timestamp_basis": ("generated_sample_clock" if self.source == "synthetic"
                                    else "unwrapped_uno_host_read_clock"),
                "conversion_profile": dict(provenance.get("profile", self.conversion_profile()))}
        if counts is not None:
            item["raw_counts"] = list(counts)
        self.pending.append(item)
        if self.recording:
            if len(self.record_samples) >= self.max_recording_samples:
                self.recording = False
                self.truncated = True
                self.mark("Recording limit reached; capture stopped")
            else:
                self.record_samples.append(item)

    def demo_until(self, now):
        # Fixed sample clock independent of display refresh. A slow browser does
        # not affect capture. Bound catch-up after a host sleep to one second.
        target = max(0, int((now - self.demo_started) * SAMPLE_RATE))
        if target - self.demo_sequence > SAMPLE_RATE:
            self.demo_started, self.demo_sequence = now, 0
            self.calibrate()
            target = 0
        while self.demo_sequence < target:
            seq = self.demo_sequence
            t = seq / SAMPLE_RATE
            epoch = self.demo_started + t
            # Known generated waves: alpha-like oscillation + slow drift + mains.
            # A periodic envelope burst is a synthetic event, never called fear.
            burst = 1 + (2.5 if 44 <= t % 55 < 45 else 0)
            if epoch < self.demo_pulse_until:
                burst = max(burst, 5.0)
            raw = [burst * 14 * math.sin(2 * math.pi * 10 * t)
                   + 9 * math.sin(2 * math.pi * .25 * t)
                   + 5 * math.sin(2 * math.pi * 60 * t) + self.rng.gauss(0, 1.2),
                   burst * 10 * math.sin(2 * math.pi * 9 * t + .6)
                   + 6 * math.sin(2 * math.pi * .2 * t)
                   + 4 * math.sin(2 * math.pi * 60 * t) + self.rng.gauss(0, 1.0)]
            for channel, processor in enumerate(self.processors):
                for update in processor.process([raw[channel]], [epoch], source="synthetic"):
                    self.summaries[channel] = update.to_dict()
            self._append_sample(epoch, raw, seq)
            self.demo_sequence += 1

    def feed_serial(self, line, arrival):
        """Called under the engine lock by its single acquisition worker."""
        messages = [adapter.feed(line, arrival) for adapter in self.adapters]
        faults = [m for channel_messages in messages for m in channel_messages
                  if m.get("type") == "status"]
        if faults:
            self.generation += 1
            self.pending.clear()
            self._clear_current_markers()
            for trace in self.filters:
                trace.reset()
            reason = faults[-1]["reason"]
            self.diagnostics.append({"timestamp": arrival, "source": self.source,
                                     "reason": str(reason), "line": line[:240]})
            self.message = f"{reason}: {line[:180]}"
            self.summaries = [initial_summary(str(reason)) for _ in range(2)]
        for index, channel_messages in enumerate(messages):
            for message in channel_messages:
                if message.get("type") == "signal":
                    self.summaries[index] = message
        if any(adapter.metadata_fault for adapter in self.adapters):
            self.status = "error"
            fault = next(adapter.metadata_fault for adapter in self.adapters if adapter.metadata_fault)
            detail = f"{fault} for {self.source}: received {line[:160]!r}"
            if line.startswith("DEVICE_ID,"):
                detail += "; expected DEVICE_ID,0x73"
            elif fault == "sample_rate_mismatch":
                measured = next((m.get("observed_read_rate_hz") for m in faults
                                 if m.get("observed_read_rate_hz") is not None), None)
                detail += f"; expected 125 samples/s, observed {measured}"
            previous_errors = [item["line"] for item in self.diagnostics
                               if item["line"].startswith("ERROR,")]
            if previous_errors and previous_errors[-1] != line:
                detail += f"; previous device error: {previous_errors[-1]}"
            self.message = detail + ". Capture stopped; verify wiring/configuration before reattaching."
            if self.reader:
                self.reader.close()
                self.reader = None
            return
        record = self.adapters[1].last_raw
        if record is not None:
            self.last_serial_sample, self.stale = self.monotonic(), False
            self.status = "running"
            self.message = SOURCE_LABELS[self.source]
            raw_counts = [record["ch1_counts"], record["ch2_counts"]]
            raw = [count * record["uv_per_count_nominal"] for count in raw_counts]
            self._append_sample(record["timestamp"], raw, record["sequence"], raw_counts,
                                provenance=record)

    def tick(self):
        with self.lock:
            if self.source == "synthetic":
                self.demo_until(self.clock())
            elif self.reader is not None:
                try:
                    for line in self.reader.read_lines():
                        self.feed_serial(line, self.clock())
                        if self.reader is None:
                            break
                except (OSError, ValueError) as error:
                    self.reader.close()
                    self.reader = None
                    self.status, self.message = "disconnected", str(error)
                    self.generation += 1
                    self.pending.clear()
                    self._clear_current_markers()
                    self.summaries = [initial_summary("serial_disconnected") for _ in range(2)]
                if (not self.stale and self.monotonic() - self.last_serial_sample > 2):
                    self.stale = True
                    self.generation += 1
                    self.pending.clear()
                    self._clear_current_markers()
                    self.status = "disconnected"
                    self.message = "No valid serial samples for two seconds"
                    for adapter in self.adapters:
                        adapter.invalidate("serial_stale", self.clock())
                    for trace in self.filters:
                        trace.reset()
                    self.summaries = [initial_summary("serial_stale") for _ in range(2)]

    def publish(self):
        with self.lock:
            batch = {"type": "samples", "timestamp": self.clock(),
                     "source": self.source, "source_label": SOURCE_LABELS[self.source],
                     "mode": self.mode, "sample_rate": SAMPLE_RATE, "units": "microvolts",
                     "generation": self.generation, "samples": self.pending,
                     "summary": self.summary(), "markers": self.pending_markers,
                     "marker_history": list(self.marker_history),
                     "markers_revision": self.markers_revision,
                     "status": self.status, "message": self.message,
                     "diagnostics": list(self.diagnostics),
                     "recording": self.recording_state()}
            self.pending, self.pending_markers = [], []
            self._broadcast(batch)
            return batch

    def export_json(self):
        with self.lock:
            return {"format": "adaptive-signal-viewer-v1", "exported_at": self.clock(),
                    "experimental": True, "body_acquisition_enabled": False,
                    "recording": self.recording_state(),
                    "diagnostics": list(self.diagnostics),
                    "viewer_state": self.state(),
                    "conversion_profiles": json.loads(PROFILES.read_text()),
                    "demo_profile": {"basis": "generated microvolts, not sensor data",
                                     "sample_rate": SAMPLE_RATE},
                    "sample_quality_metadata": {
                        "signal_quality_scope": SAMPLE_QUALITY_SCOPE,
                        "raw_flags_scope": "immediate numeric checks only; not physiological validity",
                        "latest_summaries": "per-channel 10 Hz summaries with their own timestamps",
                        "device_clock_scope": "Uno host read time, not an ADC conversion timestamp",
                        "legacy_missing_provenance": "unknown; not inferred from current source"},
                    "samples": list(self.record_samples), "markers": list(self.record_markers)}

    def export_csv(self):
        recording = self.export_json()
        output = io.StringIO()
        fields = ["timestamp", "source", "kind", "sequence", "ch1_raw_uv",
                         "ch1_filtered_uv", "ch2_raw_uv", "ch2_filtered_uv",
                         "signal_quality", "calibrated", "marker",
                         "ch1_raw_counts", "ch2_raw_counts", "device_read_micros", "received_at",
                         "generation", "uv_per_count_nominal", "observed_read_rate_hz",
                         "timestamp_basis", "source_label", "sample_rate", "conversion_profile_json",
                         "ch1_raw_flags", "ch2_raw_flags", "ch1_summary_timestamp",
                         "ch1_summary_quality", "ch1_summary_calibrated", "ch1_summary_reasons",
                         "ch2_summary_timestamp", "ch2_summary_quality", "ch2_summary_calibrated",
                         "ch2_summary_reasons", "quality_scope", "marker_id",
                         "marker_timestamp_precision", "marker_provenance"]
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        events = [(s["timestamp"], "sample", s) for s in recording["samples"]]
        events += [(m["timestamp"], "marker", m) for m in recording["markers"]]
        for timestamp, kind, item in sorted(events, key=lambda row: row[0]):
            row = {"timestamp": timestamp, "source": item["source"], "kind": kind,
                   "generation": item.get("generation", "")}
            if kind == "marker":
                row.update(marker=item["label"], marker_id=item.get("id", ""),
                           marker_timestamp_precision=item.get("timestamp_precision", ""),
                           marker_provenance=item.get("provenance", ""))
            else:
                row.update(sequence=item["sequence"], ch1_raw_uv=item["raw_uv"][0],
                           ch1_filtered_uv=item["filtered_uv"][0], ch2_raw_uv=item["raw_uv"][1],
                           ch2_filtered_uv=item["filtered_uv"][1],
                           signal_quality=item["signal_quality"], calibrated=item["calibrated"])
                for name in ("device_read_micros", "received_at", "uv_per_count_nominal",
                             "observed_read_rate_hz", "timestamp_basis", "source_label",
                             "sample_rate", "quality_scope"):
                    row[name] = item.get(name, "")
                if "conversion_profile" in item:
                    row["conversion_profile_json"] = json.dumps(item["conversion_profile"], sort_keys=True)
                for index in range(2):
                    prefix = f"ch{index+1}_"
                    if "raw_counts" in item:
                        row[prefix+"raw_counts"] = item["raw_counts"][index]
                    if "raw_quality_reasons" in item:
                        row[prefix+"raw_flags"] = json.dumps(item["raw_quality_reasons"][index])
                    if "latest_summaries" in item:
                        summary = item["latest_summaries"][index]
                        row[prefix+"summary_timestamp"] = summary.get("timestamp")
                        row[prefix+"summary_quality"] = summary.get("signal_quality")
                        row[prefix+"summary_calibrated"] = summary.get("calibrated")
                        row[prefix+"summary_reasons"] = json.dumps(summary.get("quality_reasons", []))
            writer.writerow(row)
        return output.getvalue()

    def restore_recording(self, path):
        """Explicit CLI-only restore of this viewer's JSON export. Never attach USB."""
        data = json.loads(Path(path).read_text())
        if data.get("format") != "adaptive-signal-viewer-v1" or data.get("body_acquisition_enabled") is not False:
            raise ValueError("Restore requires a labelled viewer JSON export")
        restored_samples = data.get("samples", [])
        restored_markers = data.get("markers", [])
        viewer = data.get("viewer_state", {})
        if not isinstance(restored_samples, list) or not isinstance(restored_markers, list):
            raise ValueError("Invalid recording arrays")
        for sample in restored_samples:
            if (not isinstance(sample, dict) or sample.get("source") not in SOURCE_LABELS
                    or not math.isfinite(float(sample.get("timestamp", float("nan"))))):
                raise ValueError("Invalid recorded sample source or timestamp")
            for name in ("raw_uv", "filtered_uv"):
                values = sample.get(name)
                if not isinstance(values, list) or len(values) != 2 or any(
                        value is not None and not math.isfinite(float(value)) for value in values):
                    raise ValueError("Invalid recorded two-channel waveform")
        marker_ids = {}

        def restore_marker(marker, generation=None):
            if (not isinstance(marker, dict) or marker.get("source") not in SOURCE_LABELS
                    or not isinstance(marker.get("label"), str) or not 0 < len(marker["label"]) <= 120
                    or not math.isfinite(float(marker.get("timestamp", float("nan"))))):
                raise ValueError("Invalid recorded marker")
            key = (marker["timestamp"], marker["source"], marker["label"])
            identifier = marker.get("id") or marker_ids.setdefault(key, uuid.uuid4().hex)
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("Invalid marker id")
            result = {**marker, "id": identifier}
            if generation is not None:
                result["generation"] = generation
            return result

        with self.lock:
            if self.reader:
                raise ValueError("Cannot restore while a serial reader is attached")
            self.source = viewer.get("source", "synthetic")
            if self.source not in SOURCE_LABELS:
                raise ValueError("Invalid restored source")
            self.mode = "demo" if self.source == "synthetic" else "serial"
            self.generation = max(0, int(viewer.get("generation", 0))) + 1
            self._configure_processing()
            self.record_samples = restored_samples[-self.max_recording_samples:]
            self.record_markers = [restore_marker(m) for m in restored_markers[-10000:]]
            self.recording = False
            self.truncated = bool(data.get("recording", {}).get("truncated", False)
                                  or len(restored_samples) > self.max_recording_samples)
            self._clear_current_markers()
            history = viewer.get("marker_history", [])
            if not isinstance(history, list):
                raise ValueError("Invalid marker history")
            self.marker_history.extend(restore_marker(m, self.generation) for m in history[-500:])
            self.diagnostics.extend(viewer.get("diagnostics", [])[-10:])
            if self.source == "synthetic":
                self.status, self.message = "running", SOURCE_LABELS[self.source]
                self.demo_started, self.demo_sequence = self.clock(), 0
            else:
                self.status = "error" if viewer.get("status") == "error" else "disconnected"
                self.message = (viewer.get("message") if self.status == "error" else
                                "Recording restored; USB source detached. Reattach explicitly.")

    def close(self):
        with self.lock:
            if self.reader:
                self.reader.close()
                self.reader = None


def make_handler(engine: ViewerEngine, directory=STATIC_ROOT, *, bench_log=None, bench_recorder=None, live_mode=None):
    # A fixed local capture file; this path never opens or commands USB hardware.
    bench_log = bench_log if bench_log is not None else BenchLog(BENCH_LOG_PATH)
    bench_recorder = bench_recorder if bench_recorder is not None else BenchRecorder(bench_log)
    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def log_message(self, *_):
            pass

        def end_headers(self):
            self.send_header('Cache-Control','no-store')
            super().end_headers()

        def send_json(self, value, status=200):
            data = json_bytes(value)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/api/state":
                self.send_json(engine.state())
            elif path == "/api/ui-version":
                self.send_json({'version':ui_version(directory)})
            elif path == "/api/bench-recording":
                self.send_json(bench_recorder.state())
            elif path == "/api/live-detection":
                self.send_json(live_mode.state() if live_mode else {
                    "active": False, "enabled": False,
                    "error": "Live detection is not enabled on this server."})
            elif path in ("/api/bench-recording/export.json", "/api/bench-recording/export.csv"):
                csv_format = path.endswith(".csv")
                data = (bench_recorder.export_csv().encode() if csv_format else
                        json_bytes(bench_recorder.export_json()))
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8" if csv_format else "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", 'attachment; filename="object-bench-recording.' + ("csv" if csv_format else "json") + '"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            elif path == "/api/bench-state":
                try:
                    self.send_json(bench_log.state())
                except OSError:
                    self.send_json({"error": "Bench capture file is unavailable"}, 503)
            elif path == "/api/bench-raw":
                try:
                    data = bench_log.path.read_bytes()
                except FileNotFoundError:
                    self.send_json({"error": "Bench capture file has not been created"}, 404)
                    return
                except OSError:
                    self.send_json({"error": "Bench capture file is unavailable"}, 503)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", 'attachment; filename="bench-capture.txt"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            elif path == "/api/ports":
                self.send_json({"ports": serial_ports()})
            elif path in ("/api/events", "/events"):
                client = engine.subscribe()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                try:
                    while True:
                        try:
                            event = client.get(timeout=10)
                            self.wfile.write(b"data: " + json_bytes(event) + b"\n\n")
                        except queue.Empty:
                            self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    engine.unsubscribe(client)
            elif path in ("/api/export.csv", "/api/export.json"):
                csv_format = path.endswith(".csv")
                data = engine.export_csv().encode() if csv_format else json_bytes(engine.export_json())
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8" if csv_format else "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", 'attachment; filename="signal-recording.' + ("csv" if csv_format else "json") + '"')
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            elif path.startswith("/api/"):
                self.send_json({"error": "Unknown endpoint"}, 404)
            else:
                super().do_GET()

        def do_POST(self):
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                self.send_json({"error": "Cross-origin controls are not allowed"}, 403)
                return
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 4096:
                    raise ValueError("Expected a JSON body of at most 4096 bytes")
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("Content-Type must be application/json")
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError("JSON body must be an object")
                path = urlsplit(self.path).path
                if path.startswith("/api/live-detection/"):
                    hostname = urlsplit("http://" + self.headers.get("Host", "")).hostname
                    if hostname not in ("127.0.0.1", "localhost", "::1"):
                        self.send_json({"error": "Live detection controls are localhost-only"}, 403)
                        return
                    if live_mode is None:
                        raise RuntimeError("Live detection is not enabled on this server")
                    if path == "/api/live-detection/start":
                        ownership = {"owner_id": payload["owner_id"]} if "owner_id" in payload else {}
                        result = live_mode.start(nonhuman_surface_only=payload.get("nonhuman_surface_only"),
                                                record_to_disk=payload.get("record_to_disk", False),
                                                value=payload.get("value", 1), **ownership)
                    elif path == "/api/live-detection/stop":
                        ownership = {"owner_id": payload["owner_id"]} if "owner_id" in payload else {}
                        result = live_mode.stop(**ownership)
                    elif path == "/api/live-detection/settings":
                        result = live_mode.configure(value=payload.get("value", 1))
                    else:
                        self.send_json({"error": "Unknown endpoint"}, 404)
                        return
                elif path.startswith("/api/bench-recording/"):
                    hostname = urlsplit("http://" + self.headers.get("Host", "")).hostname
                    if hostname not in ("127.0.0.1", "localhost", "::1"):
                        self.send_json({"error": "Bench controls are localhost-only"}, 403)
                        return
                    if path == "/api/bench-recording/start":
                        if live_mode and live_mode.state().get("active"):
                            raise RuntimeError("Stop live detection before starting a separate recording")
                        result = bench_recorder.start(nonhuman_surface_only=payload.get("nonhuman_surface_only"))
                    elif path == "/api/bench-recording/stop":
                        if live_mode and live_mode.state().get("active"):
                            live_mode.stop()
                            result = bench_recorder.state()
                        else:
                            result = bench_recorder.stop()
                    elif path == "/api/bench-recording/marker":
                        marker = bench_recorder.mark(payload.get("label"))
                        result = {**bench_recorder.state(), "marker": marker}
                    elif path == "/api/bench-recording/marker/delete":
                        result = bench_recorder.delete_marker(payload.get("id"))
                    else:
                        self.send_json({"error": "Unknown endpoint"}, 404)
                        return
                elif path == "/api/source":
                    result = engine.switch_source(payload.get("source"), payload.get("port"))
                elif path == "/api/calibrate":
                    result = engine.calibrate()
                elif path == "/api/demo-pulse":
                    marker = engine.demo_pulse()
                    result = {"marker": marker, **engine.marker_state()}
                elif path == "/api/marker":
                    marker = engine.mark(payload.get("label"))
                    result = {"marker": marker, **engine.marker_state()}
                elif path == "/api/markers/delete":
                    result = engine.delete_markers(marker_id=payload.get("id"),
                                                   all_markers=payload.get("all", False))
                elif path == "/api/recording":
                    result = engine.set_recording(payload.get("recording"))
                else:
                    self.send_json({"error": "Unknown endpoint"}, 404)
                    return
                self.send_json(result)
            except (ValueError, TypeError, UnicodeError, RuntimeError) as error:
                self.send_json({"error": str(error)}, 400)

    return Handler


def run_worker(engine, stop):
    next_publish = engine.monotonic()
    while not stop.wait(.005):
        engine.tick()
        now = engine.monotonic()
        if now >= next_publish:
            engine.publish()
            next_publish = now + .05


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--restore-recording", type=Path,
                        help="Explicit local viewer JSON export to restore; never reconnects USB")
    parser.add_argument("--enable-object-bench", action="store_true",
                        help="Enable fixed Pi/Uno nonhuman surface capture controls; never human EEG")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    if args.enable_object_bench and args.host not in ("127.0.0.1", "localhost", "::1"):
        parser.error("Object bench controls require a localhost-only server")
    engine = ViewerEngine()
    if args.restore_recording:
        engine.restore_recording(args.restore_recording)
    stop = threading.Event()
    bench_log = BenchLog(BENCH_LOG_PATH)
    bench_recorder = BenchRecorder(bench_log, enabled=args.enable_object_bench)
    bench_recorder.restore_latest_finished()
    from .live_link import LiveModeService
    live_mode = LiveModeService(bench_log, bench_recorder)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine,
        bench_log=bench_log, bench_recorder=bench_recorder, live_mode=live_mode))
    thread = threading.Thread(target=run_worker, args=(engine, stop), daemon=True)
    thread.start()
    live_mode.start_worker()
    print(f"Signal Scope: http://{args.host}:{server.server_port} · source={engine.source}; "
          f"object bench controls={'enabled' if args.enable_object_bench else 'disabled'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        live_mode.close()
        engine.close()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
