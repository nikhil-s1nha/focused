"""Known-byte protocol tests: no board, serial port, or live server required."""
import unittest
from firmware.protocol_audit import (
    EXPECTED_ID, audit_extended, audit_phase, bit_window, decode_frame,
    parse_capture, scan_status_windows, status_passes,
)

HEADER = "FRAME_FORMAT_OBJECT_BENCH_ONLY,NONHUMAN_SURFACE_ONLY,NOT_EEG"
PHASE = "BYPASS_PHASE,SPI_HZ,125000,READ_MODE,RDATA,MUX,SHORT"


class ProtocolAuditTest(unittest.TestCase):
    def test_id_is_hex_73_not_decimal_73(self):
        parsed = parse_capture(f"{HEADER}\n{PHASE}\nUNTRUSTED_ID_READS,73,49,00,FF\n")
        self.assertEqual(EXPECTED_ID, 115)
        result = audit_phase(parsed["phases"][0], False)
        self.assertEqual(result["valid_id_reads"], 1)
        self.assertEqual(result["id_reads_hex"], ["0x73", "0x49", "0x00", "0xFF"])

    def test_channel_boundaries_sign_and_status(self):
        f = decode_frame(bytes.fromhex("CFE0008000007FFFFF"))
        self.assertTrue(f["status_checks_pass"])
        self.assertEqual((f["ch1_counts"], f["ch2_counts"]), (-8388608, 8388607))
        self.assertEqual(decode_frame(bytes.fromhex("C00000FFFFFF000001"))["ch1_counts"], -1)

    def test_status_allows_live_bits_but_rejects_fixed_bit_errors(self):
        for live in range(128):
            self.assertTrue(status_passes(0xC00000 | live << 13))
        for bit in list(range(13)) + list(range(20, 24)):
            self.assertFalse(status_passes(0xC00000 ^ (1 << bit)))
        self.assertFalse(status_passes(0x1C00000))
        self.assertFalse(status_passes(-1))

    def test_reject_truncation_and_unadmitted_frames(self):
        p = parse_capture("UNTRUSTED_BYPASS,0,3,C00000000000000000\n" + HEADER + "\n" + PHASE +
                          "\nUNTRUSTED_BYPASS,0,3,C00000\nUNTRUSTED_BYPASS,1,4,GG0000000000000000\n")
        self.assertEqual(p["ignored_frames_before_header"], 1)
        self.assertEqual(len(p["malformed_rows"]), 2)
        self.assertEqual(p["phases"][0]["frames"], [])

    def test_restart_segments_and_unsigned_clock_rollover(self):
        p = parse_capture(f"{HEADER}\n{PHASE}\nUNTRUSTED_BYPASS,0,4294963200,C00000000000000000\n"
                          f"UNTRUSTED_BYPASS,1,3896,C00000000000000000\n{HEADER}\n{PHASE}\n"
                          "UNTRUSTED_BYPASS,0,3000,C00000000000000000\n")
        a, b = [audit_phase(x, False) for x in p["phases"]]
        self.assertEqual((a["segment"], b["segment"]), (1, 2))
        self.assertAlmostEqual(a["host_read_span_seconds"], 0.007992)
        self.assertEqual(a["host_sequence_or_time_gaps"], [])

    def test_active_capture_tail_is_pending_not_a_malformed_frame(self):
        p = parse_capture(f"{HEADER}\n{PHASE}\nUNTRUSTED_BYPASS,0,3000,C00000000000000000\nUNTRUSTED_BYPASS,1,40")
        self.assertEqual(len(p["phases"][0]["frames"]), 1)
        self.assertGreater(p["pending_tail_characters"], 0)
        self.assertEqual(p["malformed_rows"], [])

    def test_config_checks_recompute_and_ignore_gpio_live_input_bits(self):
        p = parse_capture(f"{HEADER}\n{PHASE}\n"
            "UNTRUSTED_REG,ADDRESS,0B,REQUESTED,0C,READ_A,0F,READ_B,0E,VERIFY_MASK,0C,MATCH,1\n"
            "UNTRUSTED_REG,ADDRESS,02,REQUESTED,A0,READ_A,00,READ_B,00,VERIFY_MASK,FF,MATCH,1\n"
            "CONFIG_READBACK_MISMATCHES,0\n")
        r = audit_phase(p["phases"][0], False)
        self.assertEqual(r["recomputed_config_mismatches"], 1)
        self.assertEqual(r["incorrect_logged_register_results"], 1)

    def test_extended_opcode_excluded_and_repeated_payload_checked(self):
        frame = bytes.fromhex("C00000123456FFFFFF")
        r = audit_extended([b"\x00" + frame*2], {(1, 2): frame}, [(1, 2)])
        self.assertEqual(r["native_payload_matches_main_row"], 1)
        self.assertEqual(r["native_payload_repeats"], 1)
        self.assertEqual(r["native_first_status_passes"], 1)
        self.assertEqual(r["native_second_status_passes"], 1)
        self.assertFalse(r["recovered_adc_data"])

    def test_window_rejects_wrapping_or_padding(self):
        with self.assertRaises(ValueError):
            bit_window(bytes(9), 49, 24)
        with self.assertRaises(ValueError):
            bit_window(bytes(9), -1, 24)

    def test_scan_is_holdout_and_never_proclaims_recovered_data(self):
        frame = bytes.fromhex("C00000123456ABCDEF")
        report = scan_status_windows([frame]*10)
        first = report["candidates"][0]
        self.assertEqual(first["mode"], "native")
        self.assertEqual(first["status_bit_offset"], 0)
        self.assertEqual((first["train_hits"], first["holdout_hits"]), (5, 5))
        self.assertFalse(report["recovered_adc_data"])


if __name__ == "__main__":
    unittest.main()
