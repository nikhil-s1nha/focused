"""Causal experimental biosignal filtering; an event is not evidence of fear.

Input is already converted to microvolts. Keep raw ADC counts, gain/reference,
sample counters, acquisition mode, and timestamps in the acquisition layer.
"""
from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
from math import ceil, isfinite, sqrt
from typing import Iterable

import numpy as np
from scipy.signal import butter, iirnotch, sosfilt, sosfilt_zi, tf2sos


SOURCES = frozenset({"hardware", "internal_test", "shorted_input", "synthetic"})


@dataclass(frozen=True)
class ProcessingConfig:
    sample_rate: float = 125.0
    output_hz: float = 10.0
    highpass_hz: float = 1.0
    highpass_order: int = 2
    lowpass_hz: float = 30.0
    lowpass_order: int = 4
    notch_hz: float | None = None
    notch_q: float = 30.0
    startup_seconds: float = 5.0
    baseline_seconds: float = 30.0
    rms_seconds: float = 0.2
    mad_floor_uv: float = 0.5
    trigger_z: float = 4.0
    release_z: float = 2.0
    trigger_updates: int = 2
    refractory_seconds: float = 2.0
    gap_tolerance_samples: float = 1.5
    flatline_seconds: float = 1.0
    flatline_range_uv: float = 0.01
    # Supply from the actual ADC reference/gain: Vref / gain * 1e6.
    # Unknown range suppresses events; it is never silently assumed safe.
    adc_full_scale_uv: float | None = None
    clip_fraction: float = 0.98

    def __post_init__(self) -> None:
        positive = ("sample_rate", "output_hz", "highpass_hz", "lowpass_hz",
                    "notch_q", "baseline_seconds", "rms_seconds", "mad_floor_uv",
                    "flatline_seconds", "gap_tolerance_samples")
        for name in positive:
            value = getattr(self, name)
            if not isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if not 0 < self.highpass_hz < self.lowpass_hz < self.sample_rate / 2:
            raise ValueError("require 0 < highpass < lowpass < Nyquist")
        if self.output_hz > self.sample_rate:
            raise ValueError("output_hz cannot exceed sample_rate")
        if self.notch_hz is not None and not 0 < self.notch_hz < self.sample_rate / 2:
            raise ValueError("notch must lie strictly below Nyquist")
        for name in ("startup_seconds", "refractory_seconds", "flatline_range_uv"):
            if not isfinite(getattr(self, name)) or getattr(self, name) < 0:
                raise ValueError(f"{name} must be finite and nonnegative")
        for name in ("highpass_order", "lowpass_order", "trigger_updates"):
            value = getattr(self, name)
            if not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if not (isfinite(self.trigger_z) and isfinite(self.release_z)
                and 0 <= self.release_z < self.trigger_z):
            raise ValueError("require finite 0 <= release_z < trigger_z")
        if not 0 < self.clip_fraction < 1:
            raise ValueError("clip_fraction must be between zero and one")
        if self.adc_full_scale_uv is not None and (
                not isfinite(self.adc_full_scale_uv) or self.adc_full_scale_uv <= 0):
            raise ValueError("adc_full_scale_uv must be finite and positive")


@dataclass(frozen=True)
class SignalUpdate:
    timestamp: float
    source: str
    filtered_uv: float
    rms_uv: float
    reaction_score: float
    intensity: float
    reaction_event: bool
    test_event: bool
    signal_quality: float
    quality_reasons: tuple[str, ...]
    calibrated: bool
    baseline_progress: float

    def to_dict(self) -> dict:
        result = asdict(self)
        result["type"] = "signal"
        result["quality_reasons"] = list(self.quality_reasons)
        return result


class EEGProcessor:
    """Process samples in acquisition order; chunk boundaries have no effect.

    process(samples_uv, timestamps=None, source='hardware') returns updates near
    output_hz. Explicit timestamps must be acquisition/sample-clock seconds,
    never per-packet serial arrival times. Without timestamps, time is generated
    from the declared sampling rate and cannot discover transport data loss.
    source changes invalidate calibration and restart settling.
    """

    def __init__(self, config: ProcessingConfig | None = None):
        self.config = config or ProcessingConfig()
        c = self.config
        sections = [butter(c.highpass_order, c.highpass_hz, "highpass",
                           fs=c.sample_rate, output="sos"),
                    butter(c.lowpass_order, c.lowpass_hz, "lowpass",
                           fs=c.sample_rate, output="sos")]
        if c.notch_hz is not None:
            b, a = iirnotch(c.notch_hz, c.notch_q, fs=c.sample_rate)
            sections.insert(0, tf2sos(b, a))
        self.sos = np.vstack(sections)
        self._zi = None
        self._rms = deque(maxlen=max(1, round(c.rms_seconds * c.sample_rate)))
        self._raw = deque(maxlen=max(2, round(c.flatline_seconds * c.sample_rate)))
        self._baseline: list[float] = []
        self._baseline_target = max(2, ceil(c.baseline_seconds * c.output_hz))
        self._baseline_location = 0.0
        self._baseline_scale = c.mad_floor_uv
        self._last_t: float | None = None
        self._warm_until = float("inf")
        self._last_fault = "startup"
        self._was_flatline = False
        self._phase = 0.0
        self._source: str | None = None
        self._above = 0
        self._armed = True
        self._last_event = float("-inf")

    @property
    def calibrated(self) -> bool:
        return len(self._baseline) >= self._baseline_target

    def reset(self) -> None:
        """Explicitly discard all calibration, filter state, and detector history."""
        self.__init__(self.config)

    def _reset_signal(self, t: float, reason: str) -> None:
        self._zi = None
        self._rms.clear()
        self._raw.clear()
        self._warm_until = t + self.config.startup_seconds
        self._last_fault = reason
        self._was_flatline = False
        self._above = 0
        self._armed = True
        if reason == "sample_gap":
            self._last_event = float("-inf")

    def process(self, samples_uv: Iterable[float], timestamps: Iterable[float] | None = None,
                *, source: str = "hardware") -> list[SignalUpdate]:
        if source not in SOURCES:
            raise ValueError(f"unknown source {source!r}; use one of {sorted(SOURCES)}")
        samples = list(samples_uv)
        times = None if timestamps is None else list(timestamps)
        if times is not None and len(times) != len(samples):
            raise ValueError("timestamps must match samples")
        if times is not None and any(not isfinite(float(t)) for t in times):
            raise ValueError("timestamps must be finite")
        if source != self._source:
            self.reset()
            self._source = source
        c = self.config
        updates = []
        for i, value in enumerate(samples):
            x = float(value)
            t = (float(times[i]) if times is not None else
                 (0.0 if self._last_t is None else self._last_t + 1 / c.sample_rate))
            if self._last_t is None:
                self._reset_signal(t, "startup")
            elif t <= self._last_t or t - self._last_t > c.gap_tolerance_samples / c.sample_rate:
                self._reset_signal(t, "sample_gap")
            self._last_t = t
            finite = isfinite(x)
            clipped = finite and c.adc_full_scale_uv is not None and abs(x) >= (
                c.clip_fraction * c.adc_full_scale_uv)
            if not finite or clipped:
                self._reset_signal(t, "nonfinite" if not finite else "clipping")
                y = 0.0
            else:
                if self._zi is None:
                    self._zi = sosfilt_zi(self.sos) * x
                filtered, self._zi = sosfilt(self.sos, [x], zi=self._zi)
                y = float(filtered[0])
                self._raw.append(x)
            self._rms.append(y * y)
            self._phase += c.output_hz / c.sample_rate
            if self._phase + 1e-12 < 1:
                continue
            self._phase -= 1
            flatline = (len(self._raw) == self._raw.maxlen and
                        max(self._raw) - min(self._raw) <= c.flatline_range_uv)
            if self._was_flatline and not flatline:
                # A lead recovering from a flat value can introduce a large
                # filter transient; never mistake reconnection for a reaction.
                self._reset_signal(t, "flatline_recovery")
                y = 0.0
            self._was_flatline = flatline
            reasons = []
            if t < self._warm_until:
                reasons.append(self._last_fault)
            if len(self._rms) < self._rms.maxlen:
                reasons.append("insufficient_window")
            if len(self._raw) < self._raw.maxlen:
                reasons.append("insufficient_raw_window")
            if c.adc_full_scale_uv is None:
                reasons.append("adc_range_unknown")
            if flatline:
                reasons.append("flatline")
            rms = sqrt(sum(self._rms) / len(self._rms)) if self._rms else 0.0
            if reasons:
                # Contamination cannot become baseline or a calm measurement.
                self._above = 0
                self._armed = True
                score = 0.0
                event = False
            elif not self.calibrated:
                self._baseline.append(rms)
                if self.calibrated:
                    baseline = np.asarray(self._baseline)
                    self._baseline_location = float(np.median(baseline))
                    self._baseline_scale = max(c.mad_floor_uv, float(
                        1.4826 * np.median(abs(baseline - self._baseline_location))))
                score = 0.0
                event = False
            else:
                score = max(0.0, (rms - self._baseline_location) / self._baseline_scale)
                if score < c.release_z:
                    self._armed = True
                    self._above = 0
                elif score > c.trigger_z and self._armed:
                    self._above += 1
                else:
                    self._above = 0
                event = (self._armed and self._above >= c.trigger_updates
                         and t - self._last_event >= c.refractory_seconds)
                if event:
                    self._last_event = t
                    self._armed = False
                    self._above = 0
            numerical_quality = not reasons
            updates.append(SignalUpdate(
                timestamp=t, source=source, filtered_uv=y, rms_uv=rms,
                reaction_score=score, intensity=min(1.0, score / c.trigger_z),
                reaction_event=event and source == "hardware",
                test_event=event and source != "hardware",
                signal_quality=float(numerical_quality), quality_reasons=tuple(reasons),
                calibrated=self.calibrated,
                baseline_progress=min(1.0, len(self._baseline) / self._baseline_target)))
        return updates
