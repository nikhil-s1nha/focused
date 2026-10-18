#!/usr/bin/env python3
"""Offline ADS1292R diagnostic validation; never opens hardware or fixes bytes.

Status consistency is necessary, not proof of valid ADC measurements. A scan
reports alignment hypotheses only; it never changes source bytes or trust.
All ID/register tokens in UNTRUSTED_* firmware records are hexadecimal, even
when they contain only digits. Expected ADS1292R ID is 0x73 = decimal 115.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

EXPECTED_ID = 0x73
STATUS_MASK = 0xF01FFF
STATUS_VALUE = 0xC00000
HEADERS = {
    "FRAME_FORMAT_OBJECT_BENCH_ONLY,NONHUMAN_SURFACE_ONLY,NOT_EEG",
    "ID_BYPASS_BENCH_ONLY,ELECTRODES_DISCONNECTED,NOT_EEG",
    "ID_BYPASS_CONTINUOUS_BENCH_ONLY,ELECTRODES_DISCONNECTED,NOT_EEG",
}
MODES = ("native", "bit_reverse_each_byte", "invert", "invert_bit_reverse_each_byte")


def signed24(data: bytes) -> int:
    if len(data) != 3:
        raise ValueError("A channel occupies exactly three bytes")
    return int.from_bytes(data, "big", signed=True)


def status_passes(status: int) -> bool:
    return 0 <= status <= 0xFFFFFF and status & STATUS_MASK == STATUS_VALUE


def decode_frame(raw: bytes) -> dict:
    if len(raw) != 9:
        raise ValueError("A native frame occupies exactly nine bytes")
    status = int.from_bytes(raw[:3], "big")
    return {"status_hex": f"{status:06X}", "status_checks_pass": status_passes(status),
            "ch1_counts": signed24(raw[3:6]), "ch2_counts": signed24(raw[6:9])}


def transformed(raw: bytes, mode: str) -> bytes:
    if mode not in MODES:
        raise ValueError("Unknown fixed transformation")
    if "bit_reverse" in mode:
        raw = bytes(int(f"{b:08b}"[::-1], 2) for b in raw)
    if mode.startswith("invert"):
        raw = bytes(b ^ 0xFF for b in raw)
    return raw


def bit_window(raw: bytes, offset: int, width: int) -> int:
    """Actual captured bits only: no wrapping, padding or invented edge bits."""
    if offset < 0 or width <= 0 or offset + width > len(raw) * 8:
        raise ValueError("Window falls outside captured bits")
    return (int.from_bytes(raw, "big") >> (len(raw) * 8 - offset - width)) & ((1 << width) - 1)


def scan_status_windows(rows: list[bytes], top: int = 5) -> dict:
    """Train ranking on first half, report held-out last half without re-ranking.

    Windows moved into channel bits are not a recovered 72-bit frame. Even an
    all-pass window cannot establish register settings, amplitude or provenance.
    """
    if not rows:
        return {"candidates": [], "recovered_adc_data": False}
    if any(len(r) != 9 for r in rows):
        raise ValueError("Expected native nine-byte rows")
    split = max(1, len(rows) // 2)
    candidates = []
    for mode in MODES:
        data = [transformed(row, mode) for row in rows]
        for offset in range(49):
            hits = [status_passes(bit_window(row, offset, 24)) for row in data]
            candidates.append({"mode": mode, "status_bit_offset": offset,
                "complete_frame_available": offset == 0,
                "train_hits": sum(hits[:split]), "train_total": split,
                "holdout_hits": sum(hits[split:]), "holdout_total": len(rows)-split,
                "total_hits": sum(hits), "total": len(rows)})
    candidates.sort(key=lambda c: (-c["train_hits"], c["status_bit_offset"], MODES.index(c["mode"])))
    return {"candidates_tested": len(candidates), "candidates": candidates[:top],
            "recovered_adc_data": False,
            "interpretation": "Fixed status-window hypotheses only; no byte correction, no physiological validity, no significance claim."}


def audit_extended(probes: list[bytes], frames: dict[tuple[int, int], bytes], keys) -> dict:
    """19 bytes contain opcode RX followed by eighteen actually clocked bytes."""
    if any(len(p) != 19 for p in probes):
        raise ValueError("Expected opcode RX plus eighteen payload bytes")
    native = {"probes": len(probes), "native_payload_matches_main_row": 0,
              "native_first_status_passes": 0, "native_second_status_passes": 0,
              "native_payload_repeats": 0}
    for key, p in zip(keys, probes):
        native["native_payload_matches_main_row"] += frames.get(key) == p[1:10]
        native["native_first_status_passes"] += decode_frame(p[1:10])["status_checks_pass"]
        native["native_second_status_passes"] += decode_frame(p[10:19])["status_checks_pass"]
        native["native_payload_repeats"] += p[1:10] == p[10:19]
    candidates = []
    # Only offsets that leave two complete adjacent 72-bit frames are tested.
    for mode in MODES:
        for offset in range(9):
            both = repeat = 0
            for raw in probes:
                p = transformed(raw, mode)
                first = bit_window(p, offset, 72)
                second = bit_window(p, offset + 72, 72)
                both += status_passes(first >> 48) and status_passes(second >> 48)
                repeat += first == second
            candidates.append({"mode": mode, "bit_offset": offset,
                               "both_statuses_pass": both, "repeated_payload": repeat,
                               "total": len(probes)})
    candidates.sort(key=lambda c: (-c["both_statuses_pass"], -c["repeated_payload"], c["bit_offset"]))
    return {**native, "two_complete_frame_hypotheses": candidates[:5],
            "recovered_adc_data": False}


def parse_capture(text: str) -> dict:
    segments, current, segment_number, malformed = [], None, 0, []
    ignored_frames = 0
    lines = text.splitlines(keepends=True)
    pending_tail = lines.pop() if lines and not lines[-1].endswith("\n") else ""
    for line_number, line in enumerate(lines, 1):
        line = line.strip()
        fields = line.split(",")
        if line in HEADERS or (fields[0].startswith("ID_BYPASS_") and "BENCH_ONLY" in fields[0]):
            segment_number += 1
            current = None
        elif fields[0] == "BYPASS_PHASE" and segment_number:
            current = {"segment": segment_number, "phase": line, "frames": [], "ids": [],
                       "registers": [], "probes": [], "logged_config_mismatches": None}
            segments.append(current)
        elif fields[0] in ("UNTRUSTED_BYPASS", "RAW_TRANSACTION", "UNTRUSTED_ID_READS", "UNTRUSTED_REG", "CONFIG_READBACK_MISMATCHES"):
            if current is None:
                ignored_frames += fields[0] == "UNTRUSTED_BYPASS"
                continue
            try:
                if fields[0] in ("UNTRUSTED_BYPASS", "RAW_TRANSACTION"):
                    if len(fields) != 4:
                        raise ValueError("Wrong field count")
                    seq, micros, raw = int(fields[1]), int(fields[2]), bytes.fromhex(fields[3])
                    if not (0 <= seq < 2**32 and 0 <= micros < 2**32):
                        raise ValueError("Counter outside unsigned32 range")
                    expected_len = 9 if fields[0] == "UNTRUSTED_BYPASS" else 19
                    if len(raw) != expected_len or len(fields[3]) != expected_len * 2:
                        raise ValueError("Wrong byte count")
                    target = "frames" if fields[0] == "UNTRUSTED_BYPASS" else "probes"
                    current[target].append((seq, micros, raw))
                elif fields[0] == "UNTRUSTED_ID_READS":
                    ids = [int(v, 16) for v in fields[1:]]
                    if not ids or any(v not in range(256) for v in ids):
                        raise ValueError("Invalid ID bytes")
                    current["ids"].extend(ids)
                elif fields[0] == "UNTRUSTED_REG":
                    values = dict(zip(fields[1::2], fields[2::2]))
                    reg = {key: int(values[key], 16) for key in ("ADDRESS", "REQUESTED", "READ_A", "READ_B", "VERIFY_MASK")}
                    if any(v not in range(256) for v in reg.values()):
                        raise ValueError("Invalid register bytes")
                    mask = reg["VERIFY_MASK"]
                    reg["recomputed_match"] = all((reg[k] & mask) == (reg["REQUESTED"] & mask) for k in ("READ_A", "READ_B"))
                    reg["logged_match"] = int(values["MATCH"]) == 1
                    current["registers"].append(reg)
                else:
                    current["logged_config_mismatches"] = int(fields[1])
            except (ValueError, KeyError, IndexError) as exc:
                malformed.append({"line": line_number, "reason": str(exc)})
    return {"phases": segments, "malformed_rows": malformed, "ignored_frames_before_header": ignored_frames,
            "pending_tail_characters": len(pending_tail)}


def audit_phase(phase: dict, scan: bool) -> dict:
    frames = phase["frames"]
    decoded = [decode_frame(r) for _, _, r in frames]
    span_us = 0
    gaps = []
    for previous, frame in zip(frames, frames[1:]):
        delta = (frame[1] - previous[1]) % 2**32
        span_us += delta
        if frame[0] != (previous[0]+1) % 2**32 or not 0 < delta <= 24000:
            gaps.append({"before_sequence": previous[0], "after_sequence": frame[0], "delta_us": delta})
    mismatches = sum(not r["recomputed_match"] for r in phase["registers"])
    result = {"segment": phase["segment"], "phase": phase["phase"], "frames": len(frames),
        "native_status_passes": sum(d["status_checks_pass"] for d in decoded),
        "all_zero_payloads": sum(r == bytes(9) for _, _, r in frames),
        "id_reads_hex": [f"0x{v:02X}" for v in phase["ids"]],
        "expected_id_hex": "0x73", "expected_id_decimal": EXPECTED_ID,
        "valid_id_reads": sum(v == EXPECTED_ID for v in phase["ids"]),
        "config_registers_checked": len(phase["registers"]), "recomputed_config_mismatches": mismatches,
        "logged_config_mismatches": phase["logged_config_mismatches"],
        "incorrect_logged_register_results": sum(r["logged_match"] != r["recomputed_match"] for r in phase["registers"]),
        "status_common": Counter(d["status_hex"] for d in decoded).most_common(6),
        "host_read_span_seconds": span_us / 1e6,
        "within_segment_host_read_rate_hz": (len(frames)-1)*1e6/span_us if span_us and frames else None,
        "host_sequence_or_time_gaps": gaps,
        "physiological_validity_established": False}
    keys = [(s, m) for s, m, _ in phase["probes"]]
    if keys:
        result["extended_transactions"] = audit_extended([r for _, _, r in phase["probes"]],
                                      {(s, m): r for s, m, r in frames}, keys)
    if scan:
        result["status_window_scan"] = scan_status_windows([r for _, _, r in frames])
    return result


def audit_file(path: Path, scan: bool = True) -> dict:
    # Snapshot once: an actively growing capture remains untouched.
    contents = path.read_bytes()
    parsed = parse_capture(contents.decode("ascii", errors="replace"))
    recording = None
    metadata = path.with_name("metadata.json")
    if path.name == "raw.txt" and metadata.exists():
        try:
            saved = json.loads(metadata.read_text())
            recording = {key: saved.get(key) for key in ("active", "stage", "run_id", "started_at", "finished_at")}
        except (OSError, ValueError):
            recording = {"metadata_read_failed": True}
    return {"file": str(path.resolve()), "sha256": hashlib.sha256(contents).hexdigest(),
            "bytes_in_snapshot": len(contents), "status_mask": "0xF01FFF", "status_value": "0xC00000",
            "recording_state_at_audit": recording,
            "snapshot_scope": "partial_active_recording" if recording and recording.get("active") else "saved_file_snapshot",
            "warning": "Offline diagnostic only. No repaired bytes, no microvolts, no EEG or emotion inference.",
            "malformed_rows": parsed["malformed_rows"],
            "pending_tail_characters": parsed["pending_tail_characters"],
            "ignored_frames_before_header": parsed["ignored_frames_before_header"],
            "phases": [audit_phase(p, scan) for p in parsed["phases"]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--recording-root", type=Path, help="Audit every saved raw.txt under this directory, including active snapshots")
    parser.add_argument("--skip-scan", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    files = list(dict.fromkeys(args.files + (sorted(args.recording_root.glob("*/raw.txt")) if args.recording_root else [])))
    if not files:
        parser.error("Provide files or --recording-root containing recordings")
    report = {"files": [audit_file(p, not args.skip_scan) for p in files]}
    data = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(data)
    else:
        print(data, end="")


if __name__ == "__main__":
    main()
