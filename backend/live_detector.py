"""Live numeric raw-change events over the existing nonhuman diagnostic feed.

This controller never accesses serial or changes firmware itself. Acquisition is
owned by BenchRecorder's existing fixed runner. Raw counts remain unverified;
an emitted event is neither an EEG identification nor an emotion classification.
"""
from __future__ import annotations

import copy
import math
import threading
import time
import uuid

from backend.reaction_analysis.raw_spike_detector import RawSpikeConfig, RawSpikeDetector


PRESET = "pooled-more-sensitive-v1"
THRESHOLD = 0.28153449356783367
CHANNEL_SCALES = (11959145.600000048, 12582892.5)
REARM_THRESHOLD = THRESHOLD * 0.8
EXPECTED_MUX = "CH1_SHORT_CH2_EXTERNAL_OBJECT"
ACTIVE_STAGE = "capturing_untrusted_bench_bytes"


class LiveDetectorController:
    """Foreground-owned monitoring, with optional archive saving independent of events.

    ``start`` starts a daemon polling thread by default; no thread/acquisition is
    started by construction. Set ``background=False`` for deterministic tests
    and call ``process_once``. The callback must be immediate/nonblocking: it is
    serialized with Stop, so no event callback can begin after Stop returns.
    There is deliberately no pending event queue or replay API.
    """

    def __init__(self, bench_log, bench_recorder, *, on_event=None, poll_interval=0.1,
                 clock=time.monotonic, wall_clock=time.time, background=True,
                 max_frame_age=1.0, cooldown_seconds=5.0, rearm_seconds=0.25):
        self.bench_log, self.recorder = bench_log, bench_recorder
        self.on_event = on_event
        self.poll_interval = poll_interval
        self.clock, self.wall_clock = clock, wall_clock
        self.background = background
        self.max_frame_age = max_frame_age
        self.cooldown_seconds, self.rearm_seconds = cooldown_seconds, rearm_seconds
        self._lock = threading.RLock()
        self._thread = None
        self._wake = threading.Event()
        self._generation = 0
        self._active = False
        self._session_id = None
        self._run_id = None
        self._baseline = None
        self._record_to_disk = False
        self._value = 1.0
        self._event = "reaction"
        self._detector = RawSpikeDetector(RawSpikeConfig(CHANNEL_SCALES, THRESHOLD, PRESET))
        self._phase_key = None
        self._seen_count = 0
        self._first_phase = True
        self._armed = False
        self._low_since = None
        self._score = None
        self._last_trigger = None
        self._last_trigger_at = None
        self._last_frame_at = None
        self._acquisition_state = "idle"
        self._detector_state = "stopped"
        self._error = None

    @staticmethod
    def _settings(control_value, event):
        if isinstance(control_value, bool) or not isinstance(control_value, (int, float)):
            raise ValueError("control_value must be a finite number between zero and one")
        if not math.isfinite(control_value) or not 0 <= control_value <= 1:
            raise ValueError("control_value must be a finite number between zero and one")
        if event != "reaction":
            raise ValueError("The supported event is reaction")

    def configure(self, *, control_value=None, event=None):
        with self._lock:
            value = self._value if control_value is None else control_value
            label = self._event if event is None else event
            self._settings(value, label)
            self._value, self._event = float(value), label
            return self.state()

    def start(self, nonhuman_surface_only=False, *, record_to_disk=False,
              control_value=1, event="reaction"):
        self._settings(control_value, event)
        if type(record_to_disk) is not bool:
            raise ValueError("record_to_disk must be boolean")
        with self._lock:
            if self._active:
                raise RuntimeError("Live detection is already active")
            if self.recorder.state().get("active"):
                raise RuntimeError("Wait for the current acquisition to finish before starting live detection")
            # Acquire only a new explicitly requested run; never attach to history.
            acquisition = self.recorder.start(nonhuman_surface_only, record_to_disk=record_to_disk)
            self._generation += 1
            self._session_id = str(uuid.uuid4())
            self._run_id = acquisition["run_id"]
            self._baseline = acquisition.get("capture_session_baseline", self.bench_log.state().get("session", 0))
            self._record_to_disk = record_to_disk
            self._value, self._event = float(control_value), event
            self._active = True
            self._detector.reset()
            self._phase_key, self._seen_count = None, 0
            self._first_phase, self._armed = True, False
            self._low_since = self._score = self._last_trigger = self._last_trigger_at = None
            self._last_frame_at = None
            self._acquisition_state, self._detector_state = "starting", "waiting_for_frames"
            self._error = None
            self._wake.clear()
            if self.background:
                self._thread = threading.Thread(target=self._worker, args=(self._generation,), daemon=True,
                                                name="signal-scope-live-detector")
                self._thread.start()
            return self.state()

    def stop(self):
        with self._lock:
            self._active = False
            self._generation += 1
            self._reset_continuity("stopped")
            self._wake.set()
            acquisition = self.recorder.state()
            # A replaced/externally owned run must never be stopped by this session.
            if acquisition.get("active") and acquisition.get("run_id") == self._run_id:
                self.recorder.stop()
                self._acquisition_state = "stopping"
            return self.state()

    def _worker(self, generation):
        while True:
            with self._lock:
                if not self._active or generation != self._generation:
                    return
            try:
                self.process_once(generation=generation)
            except Exception:
                with self._lock:
                    if generation == self._generation and self._active:
                        self._first_phase = False
                        self._reset_continuity("waiting_for_fresh_frames")
                        self._acquisition_state = "poll_error"
                        self._error = "Feed poll failed; waiting for a fresh baseline"
            self._wake.wait(self.poll_interval)
            self._wake.clear()

    def _reset_continuity(self, state):
        self._detector.reset()
        self._phase_key, self._seen_count = None, 0
        self._armed, self._low_since, self._score = False, None, None
        self._detector_state = state

    def _cooldown(self, now):
        return 0.0 if self._last_trigger is None else max(0.0, self.cooldown_seconds - (now - self._last_trigger))

    def state(self):
        with self._lock:
            acquisition = self.recorder.state()
            owned = acquisition.get("run_id") == self._run_id
            stopping = bool(owned and acquisition.get("active") and not self._active)
            acquisition_state = ("stopping" if stopping else
                                 self._acquisition_state if self._active else "off")
            detector_state = self._detector_state
            cooldown = self._cooldown(self.clock())
            if self._active and cooldown > 0 and detector_state in {"armed", "triggered", "waiting_for_rearm"}:
                detector_state = "cooldown"
            return {"active": self._active, "stopping": stopping,
                    "enabled": bool(getattr(self.recorder, "enabled", False)),
                    "generation": self._generation, "session_id": self._session_id,
                    "run_id": self._run_id, "preset": PRESET, "value": self._value,
                    "control_value": self._value, "event": self._event,
                    "record_to_disk": self._record_to_disk,
                    "acquisition": {"state": acquisition_state,
                                    "stage": acquisition.get("stage") if owned else None,
                                    "last_frame_at": self._last_frame_at,
                                    "receiving": self._active and self._acquisition_state == "receiving",
                                    "owned": owned, "restoration_confirmed": acquisition.get("restoration_confirmed", False)},
                    "detector": {"state": detector_state, "armed": self._armed,
                                 "score": self._score, "threshold": THRESHOLD,
                                 "rearm_threshold": REARM_THRESHOLD,
                                 "last_trigger_at": self._last_trigger_at,
                                 "cooldown_remaining": cooldown},
                    "quality": "unverified", "valid_measurement": False,
                    "reaction_validated": False, "body_acquisition_enabled": False,
                    "source": "untrusted_raw_counts", "error": self._error}

    @staticmethod
    def _raw_hex(sample):
        counts = sample["counts"]
        if len(counts) != 2 or any(type(n) is not int or not -(1 << 23) <= n < (1 << 23) for n in counts):
            raise ValueError("Expected two signed 24-bit counts")
        status = sample["status_hex"]
        if len(status) != 6:
            raise ValueError("Expected a three-byte status word")
        return status + "".join(n.to_bytes(3, "big", signed=True).hex() for n in counts)

    def process_once(self, *, generation=None):
        with self._lock:
            if not self._active or (generation is not None and generation != self._generation):
                return self.state()
            acquisition = self.recorder.state()
            if acquisition.get("run_id") != self._run_id or not acquisition.get("active"):
                self._active = False
                self._reset_continuity("acquisition_ended")
                return self.state()
            if acquisition.get("stage") != ACTIVE_STAGE:
                self._reset_continuity("waiting_for_frames")
                self._acquisition_state = acquisition.get("stage", "waiting")
                return self.state()
            feed = self.bench_log.state()
            age = feed.get("sample_age_seconds")
            phases = feed.get("phases", [])
            phase = phases[-1] if phases else None
            valid = (feed.get("session", 0) > self._baseline and not feed.get("completed")
                     and feed.get("input_context") == "nonhuman_object_surface"
                     and phase and phase.get("mux_requested") == EXPECTED_MUX
                     and phase.get("read_mode") == "RDATA" and phase.get("samples")
                     and isinstance(age, (int, float)) and math.isfinite(age) and 0 <= age <= self.max_frame_age)
            if not valid:
                self._reset_continuity("waiting_for_fresh_frames")
                self._acquisition_state = "stale_or_no_frames"
                return self.state()
            now = self.clock()
            self._acquisition_state = "receiving"
            self._last_frame_at = self.wall_clock() - age
            key = (feed["session"], phase["id"])
            samples = phase["samples"]
            count = phase["frame_count"]
            if key != self._phase_key or count < self._seen_count:
                initial = self._first_phase
                self._reset_continuity("waiting_for_rearm")
                self._phase_key, self._seen_count = key, count
                self._first_phase = False
                # Seed from the newest frame only; arriving backlog is never replayed.
                try:
                    self._update_frame(samples[-1], feed["session"], now - age, emit=False)
                    self._armed = initial
                    if initial:
                        self._detector_state = "armed"
                except (ValueError, KeyError, TypeError):
                    self._reset_continuity("invalid_frame")
                return self.state()
            delta = count - self._seen_count
            self._seen_count = count
            if delta <= 0:
                return self.state()
            newest_micros = samples[-1]["read_micros"]
            for sample in samples[-min(delta, len(samples)):]:
                sample_age = age + max(0, (newest_micros - sample["read_micros"]) / 1e6)
                if sample_age > self.max_frame_age:
                    self._detector.reset()
                    self._armed, self._low_since = False, None
                    continue
                try:
                    self._update_frame(sample, feed["session"], now - sample_age)
                except (ValueError, KeyError, TypeError):
                    self._detector.reset()
                    self._armed, self._low_since, self._score = False, None, None
                    self._detector_state = "invalid_frame"
            return self.state()

    def _update_frame(self, sample, segment, sample_time, *, emit=True):
        result = self._detector.update(raw_hex=self._raw_hex(sample), sequence=sample["sequence"],
                                       read_micros=sample["read_micros"], segment=segment)
        score = result["step_score"]
        self._score = score
        if score is None:
            self._armed, self._low_since = False, None
            self._detector_state = "waiting_for_rearm"
            return
        if score <= REARM_THRESHOLD:
            if self._low_since is None:
                self._low_since = sample_time
            if sample_time - self._low_since >= self.rearm_seconds:
                self._armed = True
            self._detector_state = "armed" if self._armed else "waiting_for_rearm"
            return
        self._low_since = None
        if score <= THRESHOLD:
            return
        should_emit = emit and self._armed and self._cooldown(sample_time) == 0
        self._armed = False
        self._detector_state = "waiting_for_rearm"
        if not should_emit:
            return
        # State and the immediate callback share the same lock as Stop. No saved
        # event is retried; failure drops this event and waits for a new burst.
        self._last_trigger = sample_time
        self._last_trigger_at = self.wall_clock() - max(0, self.clock() - sample_time)
        self._detector_state = "triggered"
        packet = {"id": str(uuid.uuid4()), "created_at_ms": int(self._last_trigger_at * 1000),
                  "generation": self._generation, "session_id": self._session_id,
                  "event": self._event, "control_value": self._value,
                  "score": score, "threshold": THRESHOLD, "rearm_threshold": REARM_THRESHOLD,
                  "preset": PRESET, "run_id": self._run_id, "sequence": sample["sequence"],
                  "read_micros": sample["read_micros"], "capture_session": segment,
                  "quality": "unverified", "valid_measurement": False,
                  "reaction_validated": False, "source": "untrusted_raw_counts"}
        if self.on_event is not None:
            try:
                self.on_event(copy.deepcopy(packet))
            except Exception:
                self._error = "Event callback failed; event dropped without replay"
