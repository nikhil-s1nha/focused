"""Bench CSV to labelled JSONL. No device writes, network relay or body mode.

Run with `python -m backend.acquire_signal --help`. A separate serial reader
feeds stdin; saved CSV can also be replayed. ADC settings come from an explicit
bench profile, not from assuming a received count value is human EEG.
"""
from __future__ import annotations

import argparse
from collections import deque
from dataclasses import replace
import json
import math
from pathlib import Path
import select
import statistics
import sys
import time

from .eeg_processing import EEGProcessor, ProcessingConfig

PROFILES = Path(__file__).with_name("acquisition_profiles.json")
UINT32 = 2**32


class BenchAcquisition:
    def __init__(self, source: str, channel: int = 2, *, config=None):
        profiles = json.loads(PROFILES.read_text())
        if source not in profiles or channel not in (1, 2):
            raise ValueError("Only explicit bench sources and channel 1 or 2 are supported")
        self.source, self.channel = source, channel
        self.profile = profiles[source]
        self.rate = self.profile["sample_rate"]
        self.full_scale = self.profile["nominal_reference_volts"] * 1e6 / self.profile["gain"]
        self.scale = self.full_scale / 2**23
        self.processor = EEGProcessor(replace(config or ProcessingConfig(),
            sample_rate=self.rate, adc_full_scale_uv=self.full_scale))
        self.last_sequence = self.last_micros = self.timestamp = None
        self.samples = self.missing = self.duplicates = self.resets = 0
        self.last_raw = None
        self.metadata_fault = None
        self.read_intervals = deque(maxlen=self.profile["read_rate_window_intervals"])
        self.observed_read_rate = None

    def reset(self):
        self.processor.reset()
        self.last_sequence = self.last_micros = self.timestamp = None
        self.read_intervals.clear()
        self.observed_read_rate = None
        self.resets += 1

    def status(self, reason: str, timestamp: float) -> dict:
        return {"type": "status", "source": self.source, "timestamp": timestamp,
                "reason": reason, "samples_received": self.samples,
                "missing_transmitted_records": self.missing,
                "duplicate_records": self.duplicates, "resets": self.resets}

    def invalid_signal(self, reason: str, timestamp: float) -> dict:
        return {"type": "signal", "source": self.source, "timestamp": timestamp,
                "intensity": 0.0, "signal_quality": 0.0, "calibrated": False,
                "baseline_progress": 0.0, "reaction_event": False,
                "test_event": False, "quality_reasons": [reason],
                "channel": self.channel}

    def invalidate(self, reason: str, now: float) -> list[dict]:
        self.reset()
        return [self.status(reason, now), self.invalid_signal(reason, now)]

    def reject_metadata(self, now: float) -> list[dict]:
        # A new process/profile review is required; later data cannot clear this.
        self.metadata_fault = "source_profile_mismatch"
        return self.invalidate(self.metadata_fault, now)

    def metadata_matches(self, line: str) -> bool:
        fields = line.split(",")
        gain = self.profile["gain"]
        try:
            if fields[0] == "DEVICE_ID":
                return len(fields) == 2 and int(fields[1], 16) == 0x73
            if fields[0] == "REGISTER":
                expected = {1: 0, 2: 0xA3 if self.source == "internal_test" else 0xA0,
                            4: 0x15 if gain == 1 else 1, 5: 0x15 if gain == 1 else 1,
                            6: 0x0C if gain == 1 else 0, 7: 0, 9: 2, 10: 3}
                if len(fields) != 3:
                    return False
                address, value = int(fields[1], 16), int(fields[2], 16)
                return address in expected and value == expected[address]
            if fields[0] == "CONFIG":
                mux = "TEST" if self.source == "internal_test" else "SHORTED"
                test = "SQUARE1HZ" if self.source == "internal_test" else "OFF"
                return line in (
                    f"CONFIG,SPS_125,GAIN_{gain},VREF_NOMINAL_V_2.42,MUX_{mux}_BOTH",
                    f"CONFIG,RESPIRATION_OFF,LEADOFF_OFF,RLD_OFF,TEST_SIGNAL_{test}")
            if fields[0] == "CONVERSION":
                if len(fields) == 3 and fields[1] == "INPUT_UV_PER_COUNT":
                    return math.isclose(float(fields[2]), self.scale, rel_tol=2e-6)
                return line == (f"CONVERSION,INPUT_UV_EQUALS_COUNTS_TIMES_2420000_DIV_{gain}"
                                "_DIV_8388608")
        except (ValueError, IndexError):
            return False
        return False

    def feed(self, line: str, arrival_time: float) -> list[dict]:
        self.last_raw = None
        line = line.strip()
        if not line:
            return []
        if self.metadata_fault:
            return []
        if line.startswith(("BENCH_TEST_ONLY,", "BENCH_NOISE_ONLY,")):
            expected = "BENCH_TEST_ONLY," if self.source == "internal_test" else "BENCH_NOISE_ONLY,"
            if not line.startswith(expected):
                return self.reject_metadata(arrival_time)
            return self.invalidate("device_startup", arrival_time)
        if line.startswith("ERROR,"):
            return self.invalidate(line, arrival_time)
        if line.startswith(("DEVICE_ID,", "REGISTER,", "CONFIG,", "CONVERSION,")):
            if not self.metadata_matches(line):
                return self.reject_metadata(arrival_time)
            return []
        if line.startswith(("source,", "NOTE,")):
            return []
        prefix = line.split(",", 1)[0]
        if prefix in ("INTERNAL_TEST", "SHORTED_INPUT") and prefix != self.source.upper():
            return self.reject_metadata(arrival_time)
        if prefix != self.source.upper():
            return self.invalidate("unrecognized_serial_record", arrival_time)
        try:
            values = list(map(int, line.split(",")[1:]))
            if len(values) != 4:
                raise ValueError()
            seq, micros, ch1, ch2 = values
            if not (0 <= seq < UINT32 and 0 <= micros < UINT32
                    and all(-2**23 <= x < 2**23 for x in (ch1, ch2))):
                raise ValueError()
        except ValueError:
            return self.invalidate("malformed_serial_record", arrival_time)

        messages = []
        previous_time = self.timestamp
        if self.last_sequence is not None:
            step = (seq - self.last_sequence) % UINT32
            dt = (micros - self.last_micros) % UINT32 / 1e6
            if step == 0:
                self.duplicates += 1
                return self.invalidate("duplicate_sequence", arrival_time)
            if step >= UINT32 // 2 or dt <= 0 or dt >= UINT32 / 2e6:
                return self.invalidate("device_counter_reset_or_out_of_order", arrival_time)
            else:
                if step != 1:
                    self.missing += step - 1
                    self.processor.reset()  # Never carry a baseline across transport loss.
                    self.read_intervals.clear()
                    self.observed_read_rate = None
                    messages.append(self.status("sequence_gap", arrival_time))
                if dt > 1.5 / self.rate:
                    self.processor.reset()
                    self.read_intervals.clear()
                    self.observed_read_rate = None
                    messages.append(self.status("read_timing_gap", arrival_time))
                elif step == 1:
                    self.read_intervals.append(dt)
                    if len(self.read_intervals) == self.read_intervals.maxlen:
                        self.observed_read_rate = 1 / statistics.median(self.read_intervals)
                self.timestamp += dt
        if self.timestamp is None:
            # Device micros is a host-read clock, not a precise ADC acquisition clock.
            self.timestamp = max(arrival_time, (previous_time or 0) + 1 / self.rate)
        self.last_sequence, self.last_micros = seq, micros
        self.samples += 1
        self.last_raw = {"type": "raw_sample", "source": self.source,
            "sequence": seq, "device_read_micros": micros,
            "timestamp": self.timestamp, "received_at": arrival_time,
            "ch1_counts": ch1, "ch2_counts": ch2,
            "channel": self.channel, "uv_per_count_nominal": self.scale,
            "observed_read_rate_hz": self.observed_read_rate,
            "profile": self.profile}
        if self.observed_read_rate is not None and abs(self.observed_read_rate / self.rate - 1) > (
                self.profile["read_rate_relative_tolerance"]):
            measured = self.observed_read_rate
            self.metadata_fault = "sample_rate_mismatch"
            invalid = self.invalidate(self.metadata_fault, arrival_time)
            invalid[0]["observed_read_rate_hz"] = measured
            return messages + invalid
        selected = ch1 if self.channel == 1 else ch2
        for update in self.processor.process([selected * self.scale],
                                              [self.timestamp], source=self.source):
            message = update.to_dict()
            message.update(channel=self.channel, sequence=seq,
                           timestamp_basis="unwrapped_uno_host_read_clock",
                           observed_read_rate_hz=self.observed_read_rate,
                           missing_transmitted_records=self.missing)
            if self.observed_read_rate is None:
                message.update(signal_quality=0.0, calibrated=False,
                               intensity=0.0, reaction_event=False, test_event=False)
                message["quality_reasons"].append("read_rate_unverified")
            messages.append(message)
        return messages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, choices=["internal_test", "shorted_input"])
    parser.add_argument("--channel", type=int, default=2, choices=[1, 2])
    parser.add_argument("--input", default="-", help="CSV file or - for serial-reader stdin")
    parser.add_argument("--raw-log", help="New JSONL recording path; never overwritten")
    parser.add_argument("--stale-seconds", type=float, default=2)
    args = parser.parse_args()
    if not math.isfinite(args.stale_seconds) or args.stale_seconds <= 0:
        parser.error("stale-seconds must be finite and positive")
    adapter = BenchAcquisition(args.source, args.channel)
    raw = open(args.raw_log, "x") if args.raw_log else None

    def emit(message):
        message["replay"] = args.input != "-"
        print(json.dumps(message, allow_nan=False), flush=True)

    emit({"type": "session", "source": args.source, "channel": args.channel,
          "profile": adapter.profile, "replay": args.input != "-",
          "experimental": True, "body_acquisition_enabled": False})
    if raw:
        raw.write(json.dumps({"type": "session", "source": args.source,
                              "profile": adapter.profile}) + "\n")
    stream = sys.stdin if args.input == "-" else open(args.input)
    last_sample = time.monotonic()
    stale = False
    try:
        # Read bytes for stdin: TextIO buffering + select can otherwise strand lines.
        if args.input == "-":
            import os
            buffer = b""
            while True:
                ready, _, _ = select.select([stream], [], [], .25)
                if ready:
                    chunk = os.read(stream.fileno(), 16384)
                    if not chunk:
                        break
                    buffer += chunk
                    if len(buffer) > 65536 and b"\n" not in buffer:
                        buffer = b""
                        for message in adapter.invalidate("oversized_serial_record", time.time()):
                            emit(message)
                    while b"\n" in buffer:
                        encoded, buffer = buffer.split(b"\n", 1)
                        for message in adapter.feed(encoded.decode(errors="replace"), time.time()):
                            emit(message)
                        if adapter.last_raw:
                            last_sample, stale = time.monotonic(), False
                            if raw:
                                raw.write(json.dumps(adapter.last_raw) + "\n")
                if not stale and time.monotonic() - last_sample > args.stale_seconds:
                    for message in adapter.invalidate("serial_stale", time.time()):
                        emit(message)
                    stale = True
        else:
            for line in stream:
                for message in adapter.feed(line, time.time()):
                    emit(message)
                if raw and adapter.last_raw:
                    raw.write(json.dumps(adapter.last_raw) + "\n")
    except KeyboardInterrupt:
        pass
    finally:
        for message in adapter.invalidate("stream_closed", time.time()):
            emit(message)
        if stream is not sys.stdin:
            stream.close()
        if raw:
            raw.close()


if __name__ == "__main__":
    main()
