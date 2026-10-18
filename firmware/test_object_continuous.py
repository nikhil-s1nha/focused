"""Pure offline tests; importing the runner never opens USB or starts a process."""
import os
from pathlib import Path
import tempfile
import unittest

from firmware.run_object_continuous import RecoveryPolicy, is_frame_line, requested_stop_reason


class RecoveryPolicyTests(unittest.TestCase):
    def test_initial_silence_waits_full_reset_grace(self):
        policy = RecoveryPolicy(reset_at=100)
        self.assertFalse(policy.needs_restart(104.999))
        self.assertFalse(policy.needs_restart(105))
        self.assertFalse(policy.needs_restart(109.999))
        self.assertTrue(policy.needs_restart(110))

    def test_five_second_staleness_after_established_stream(self):
        policy = RecoveryPolicy(reset_at=0, last_frame_at=18)
        self.assertFalse(policy.needs_restart(22.999))
        self.assertTrue(policy.needs_restart(23))
        policy.last_frame_at = 22
        self.assertFalse(policy.needs_restart(23))

    def test_three_restarts_only_and_full_grace_before_exhaustion(self):
        policy = RecoveryPolicy(reset_at=0)
        for count, now in enumerate((10, 20, 30), 1):
            self.assertTrue(policy.needs_restart(now))
            policy.restarted(now)
            self.assertEqual(policy.restart_count, count)
            self.assertIsNone(policy.last_frame_at)
            self.assertFalse(policy.needs_restart(now+9.999))
        self.assertFalse(policy.exhausted(35))
        self.assertFalse(policy.exhausted(39.999))
        self.assertTrue(policy.exhausted(40))
        self.assertFalse(policy.needs_restart(40))
        self.assertFalse(policy.needs_restart(1_000_000))
        # Valid-looking raw frames may resume without granting another reset.
        policy.last_frame_at = 100
        self.assertFalse(policy.exhausted(101))
        self.assertTrue(policy.exhausted(105))
        self.assertFalse(policy.needs_restart(105))

    def test_zero_restart_budget_never_resets(self):
        policy = RecoveryPolicy(reset_at=0, max_restarts=0)
        self.assertFalse(policy.needs_restart(100))
        self.assertTrue(policy.exhausted(100))


class StopAndFrameTests(unittest.TestCase):
    def test_stop_request_wins_over_expired_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            lease = run/'lease.touch'
            lease.touch()
            os.utime(lease, (100, 100))
            self.assertIsNone(requested_stop_reason(run, lease, now=130))
            self.assertEqual(requested_stop_reason(run, lease, now=130.001), 'controller_lease_expired')
            (run/'stop.request').touch()
            self.assertEqual(requested_stop_reason(run, lease, now=1000), 'user_stop')

    def test_only_well_formed_raw_rows_reset_stale_timer(self):
        self.assertTrue(is_frame_line(b'UNTRUSTED_BYPASS,0,8000,C00000000001FFFFFF\r'))
        # Invalid status remains raw diagnostic data, not certified samples.
        self.assertTrue(is_frame_line(b'UNTRUSTED_BYPASS,0,8000,000000000000000000'))
        for line in (
            b'UNTRUSTED_BYPASS,0,8000,GGGGGGGGGGGGGGGGGG',
            b'UNTRUSTED_BYPASS,-1,8000,C00000000001FFFFFF',
            b'UNTRUSTED_BYPASS,0,4294967296,C00000000001FFFFFF',
            b'UNTRUSTED_BYPASS,x,8000,C00000000001FFFFFF',
            b'UNTRUSTED_BYPASS,0,8000,C00000000001FFFF',
            b'HOST_EVENT,0,8000,C00000000001FFFFFF',
        ):
            self.assertFalse(is_frame_line(line), line)


if __name__ == '__main__':
    unittest.main()
