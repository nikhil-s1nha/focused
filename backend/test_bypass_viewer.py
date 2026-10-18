"""File-only parser checks. No server, serial connection, or hardware access."""
from pathlib import Path
import tempfile
import unittest

from backend.bypass_viewer import BenchLog, HEADER, OBJECT_HEADER, signed24


PHASE = "BYPASS_PHASE,SPI_HZ,125000,READ_MODE,RDATAC,MUX,INTERNAL_SHORT"


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name, "capture.txt")
        self.now = 10.0
        self.log = BenchLog(self.path, clock=lambda: self.now)

    def tearDown(self):
        self.directory.cleanup()

    def append(self, text):
        with self.path.open("a") as handle:
            handle.write(text)
        return self.log.state()

    def begin(self):
        return self.append(HEADER+"\n"+PHASE+"\n")

    def test_no_header_or_no_phase_never_accepts_samples(self):
        self.assertEqual(self.log.state()["status"], "waiting_for_file")
        state = self.append("UNTRUSTED_BYPASS,0,1000,C00000000001000002\n")
        self.assertEqual(state["status"], "waiting_for_fresh_header")
        self.assertEqual(state["phases"], [])
        self.append(HEADER+"\nUNTRUSTED_BYPASS,0,1000,C00000000001000002\n")
        self.assertEqual(self.log.state()["phases"], [])
        self.assertEqual(self.log.state()["ignored_rows"], 1)

    def test_actual_counts_timestamps_status_and_metadata(self):
        self.begin()
        self.append("UNTRUSTED_ID_READS,31,00\nCONFIG_READBACK_MISMATCHES,7\n")
        self.append("UNTRUSTED_BYPASS,0,1000,C000007FFFFF800000\n")
        state = self.append("UNTRUSTED_BYPASS,1,9000,000000FFFFFF000001\n")
        phase = state["phases"][0]
        self.assertEqual(phase["samples"][0]["counts"], [8388607, -8388608])
        self.assertEqual(phase["samples"][1]["counts"], [-1, 1])
        self.assertEqual(phase["samples"][1]["elapsed_seconds"], .008)
        self.assertEqual(phase["invalid_status_count"], 1)
        self.assertEqual(phase["config_mismatches"], 7)
        self.assertEqual(phase["id_reads"], ["31", "00"])
        self.assertFalse(state["filtered"])
        self.assertTrue(state["not_eeg"])
        self.assertEqual(phase["samples"][0]["read_micros"], 1000)

    def test_status_reserved_bits_and_gaps_break_lines(self):
        self.begin()
        self.append("UNTRUSTED_BYPASS,0,1000,C00001000000000000\n")
        state = self.append("UNTRUSTED_BYPASS,2,50000,C00000000000000000\n")
        phase = state["phases"][0]
        self.assertEqual(phase["invalid_status_count"], 1)
        self.assertEqual(phase["gap_count"], 1)
        self.assertTrue(phase["samples"][1]["break_before"])

    def test_stage_boundary_resets_time_and_stale_is_explicit(self):
        self.begin()
        self.append("UNTRUSTED_BYPASS,0,400000,C00000000001000002\n")
        self.now += 2.1
        self.assertEqual(self.log.state()["status"], "stale_capture_incomplete")
        state = self.append(PHASE+"\n")
        self.assertEqual(state["status"], "no_frames_in_current_phase")
        state = self.append("UNTRUSTED_BYPASS,0,1000,C00000000001000002\n")
        self.assertEqual(len(state["phases"]), 2)
        self.assertEqual(state["phases"][1]["samples"][0]["elapsed_seconds"], 0)
        self.assertTrue(state["phases"][1]["samples"][0]["break_before"])

    def test_wrap_is_unwrapped_without_a_fake_gap(self):
        self.begin()
        self.append("UNTRUSTED_BYPASS,0,4294963296,C00000000001000002\n")
        state = self.append("UNTRUSTED_BYPASS,1,4000,C00000000001000002\n")
        sample = state["phases"][0]["samples"][1]
        self.assertEqual(sample["elapsed_seconds"], .008)
        self.assertFalse(sample["break_before"])

    def test_partial_rows_bounded_samples_completion_and_new_header(self):
        self.log.max_samples = 2
        self.begin()
        self.append("UNTRUSTED_BYPASS,0,1000,C00000000001000002")
        self.assertEqual(self.log.state()["phases"][0]["samples"], [])
        self.append("\nUNTRUSTED_BYPASS,1,9000,C00000000001000002\n")
        self.append("UNTRUSTED_BYPASS,2,17000,C00000000001000002\n")
        state = self.append("BYPASS_COMPLETE,RESET_LOW,NO_ACQUISITION,RESTORE_NORMAL_FIRMWARE\n")
        self.assertEqual(state["status"], "completed_saved_capture")
        self.assertEqual(state["phases"][0]["frame_count"], 3)
        self.assertEqual(len(state["phases"][0]["samples"]), 2)
        self.now += 100
        self.assertEqual(self.log.state()["status"], "completed_saved_capture")
        state = self.begin()
        self.assertEqual(state["session"], 2)
        self.assertFalse(state["completed"])
        self.assertEqual(len(state["phases"]), 1)
        self.assertEqual(state["phases"][0]["frame_count"], 0)

    def test_malformed_rows_and_forced_probes_never_generate_points(self):
        self.begin()
        self.append("UNTRUSTED_BYPASS,0,1000,nothex\n")
        self.append("FORCED_CLOCK_PROBE_NOT_SAMPLE,C00000000001000002\n")
        state = self.log.state()
        self.assertEqual(state["malformed_rows"], 1)
        self.assertEqual(state["phases"][0]["frame_count"], 0)

    def test_truncated_file_requires_new_header(self):
        self.begin()
        self.append("UNTRUSTED_BYPASS,0,1000,C00000000001000002\n")
        self.path.write_text("truncated\n")
        state = self.log.state()
        self.assertEqual(state["status"], "waiting_for_fresh_header")
        self.assertEqual(state["phases"], [])

    def test_matching_archive_restores_sessions_without_replaying_or_writing(self):
        raw = (OBJECT_HEADER + "\n" + PHASE + "\n"
               "UNTRUSTED_BYPASS,0,1000,C00000000001000002\n")
        # Two acquisition headers correspond to two distinct restart segments.
        self.path.write_text(raw + raw)
        archive = self.path.with_name("archive.txt")
        archive.write_bytes(self.path.read_bytes())
        original = self.path.read_bytes()
        self.assertEqual(self.log.state()["session"], 2)
        self.assertTrue(self.log.restore_archived_identity(archive, 17))
        state = self.log.state()
        self.assertEqual(state["session"], 19)
        self.assertEqual(state["phases"][0]["id"], "19:1")
        self.assertEqual(state["phases"][0]["frame_count"], 1)
        self.assertEqual(state["status"], "completed_saved_capture")
        self.assertIsNone(state["sample_age_seconds"])
        self.assertEqual(self.log.state()["phases"][0]["frame_count"], 1)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual(self.append(raw)["session"], 20)

    def test_different_archive_or_invalid_saved_counter_leaves_identity_untouched(self):
        self.path.write_text(OBJECT_HEADER + "\n" + PHASE + "\n")
        archive = self.path.with_name("archive.txt")
        archive.write_text("different bytes\n")
        self.log.read_new()
        identity = (self.log.session, self.log.offset, self.log.identity)
        self.assertFalse(self.log.restore_archived_identity(archive, 17))
        self.assertEqual((self.log.session, self.log.offset, self.log.identity), identity)
        archive.write_bytes(self.path.read_bytes())
        for invalid in (None, True, -1, 17.0, "17"):
            self.assertFalse(self.log.restore_archived_identity(archive, invalid))
            self.assertEqual((self.log.session, self.log.offset, self.log.identity), identity)

    def test_signed_boundaries(self):
        self.assertEqual(signed24("000000"), 0)
        self.assertEqual(signed24("FFFFFF"), -1)
        self.assertEqual(signed24("800000"), -8388608)

    def test_object_header_and_probe_preserve_provenance_without_extra_points(self):
        self.append(OBJECT_HEADER+'\n'+PHASE+'\n')
        raw = '00' + 'C00000000001000002' * 2
        state = self.append('RAW_TRANSACTION,0,1000,'+raw+'\n')
        self.assertEqual(state['input_context'], 'nonhuman_object_surface')
        self.assertTrue(state['not_eeg'])
        phase = state['phases'][0]
        self.assertEqual(phase['frame_count'], 0)
        self.assertEqual(phase['transaction_probes'][0]['raw_hex'], raw)
        self.append(HEADER+'\n')
        self.assertEqual(self.log.state()['input_context'], 'electrode_cable_disconnected')


if __name__ == "__main__":
    unittest.main()
