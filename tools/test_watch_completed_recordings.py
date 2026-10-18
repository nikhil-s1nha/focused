import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recording_watch', Path(__file__).with_name('watch_completed_recordings.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

OLD = 'object-ui-20261018T001042Z-'+'0'*32
FIRST = 'object-ui-20261018T002800Z-053a830ab45f4c4fb8f909f68b8f09ed'
NEXT = 'object-ui-20261018T003000Z-'+'1'*32
ACTIVE = 'object-ui-20261018T004000Z-'+'2'*32


def make_run(root, run_id, *, active=False, stage='stopped_original_restored', markers=None):
    run = root/run_id
    run.mkdir(parents=True)
    (run/'raw.txt').write_text('UNTRUSTED_BYPASS,0,42,000000000000000000\n')
    (run/'markers.json').write_text(json.dumps([] if markers is None else markers))
    (run/'metadata.json').write_text(json.dumps({'active': active, 'finished_at': None if active else 2}))
    (run/'status.json').write_text(json.dumps({'stage': stage}))
    return run


def policy_file(root, recordings, first=FIRST, cohort='replacement-sensor-20261018T002800Z'):
    path = root/'active.json'
    path.write_text(json.dumps({'version': 1, 'cohort_id': cohort, 'first_run_id': first,
                               'source_path': str(recordings), 'analysis_policy': 'Independent per recording; no pooling.'}))
    return path


def argv(root, recordings, policy):
    return ['watch_completed_recordings.py', '--once', '--recordings', str(recordings),
            '--policy', str(policy), '--worker-output', str(root/'worker'),
            '--output-root', str(root/'results')]


class WatcherInputTests(unittest.TestCase):
    def test_old_and_active_capture_are_excluded_before_reading_old_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_run(root, OLD)
            make_run(root, FIRST)
            make_run(root, ACTIVE, active=True)
            original = Path.read_bytes
            seen = []
            def audited_read(path):
                seen.append(path)
                if OLD in str(path): raise AssertionError('Pre-boundary archive was read')
                return original(path)
            with patch.object(Path, 'read_bytes', audited_read):
                _, runs = module.completed_signature(root, FIRST)
            self.assertEqual([run['run_id'] for run in runs], [FIRST])
            self.assertTrue(seen)

    def test_finished_edit_versions_and_empty_markers_are_included(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = make_run(root, FIRST, active=True)
            empty, runs = module.completed_signature(root, FIRST)
            self.assertEqual(runs, [])
            (run/'metadata.json').write_text(json.dumps({'active': False, 'finished_at': 2}))
            finished, runs = module.completed_signature(root, FIRST)
            self.assertEqual(len(runs), 1)
            self.assertNotEqual(empty, finished)  # no labels is still a reportable completed run
            (run/'markers.json').write_text(json.dumps([{'label': 'UI test'}]))
            edited, _ = module.completed_signature(root, FIRST)
            self.assertNotEqual(finished, edited)  # insufficient labels are reported, not silently skipped
            (run/'status.json').write_text(json.dumps({'stage': 'stopped_original_restored', 'frames_received_total': 42}))
            revised, _ = module.completed_signature(root, FIRST)
            self.assertNotEqual(edited, revised)

    def test_incomplete_inputs_nonterminal_and_unknown_metadata_are_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = make_run(root, FIRST, stage='restoring_original_firmware')
            next_run = make_run(root, NEXT)
            (next_run/'metadata.json').write_text(json.dumps({'finished_at': 2}))
            active = make_run(root, ACTIVE)
            (active/'markers.json').write_text('{')
            self.assertEqual(module.completed_signature(root, FIRST)[1], [])
            (first/'status.json').write_text(json.dumps({'stage': 'restore_failed'}))
            self.assertEqual(module.completed_signature(root, FIRST)[1], [])

    def test_missing_invalid_or_path_traversal_policy_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root/'active.json'
            with self.assertRaises(OSError): module.load_policy(path)
            path.write_text(json.dumps({'version': 1, 'cohort_id': '../old', 'first_run_id': FIRST, 'source_path': str(root)}))
            with self.assertRaises(ValueError): module.load_policy(path)
            path.write_text(json.dumps({'version': 1, 'cohort_id': 'new', 'first_run_id': 'object-ui-no-boundary', 'source_path': str(root)}))
            with self.assertRaises(ValueError): module.load_policy(path)


class IndependentDispatchTests(unittest.TestCase):
    def test_only_current_cohort_frozen_config_is_passed_without_modification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recordings = root/'captures'
            output = root/'results'
            policy = {'first_run_id': FIRST, 'cohort_id': 'replacement-current'}
            old_config = output/'old-cohort'/'detector-config.json'
            old_config.parent.mkdir(parents=True)
            old_config.write_text('{"threshold": 999}')
            command = module.independent_command(recordings, output, policy, FIRST)
            self.assertNotIn('--detector-config', command)
            current_config = output/policy['cohort_id']/'detector-config.json'
            current_config.parent.mkdir(parents=True)
            saved = b'{"threshold": 1.0139512788744232}\n'
            current_config.write_bytes(saved)
            command = module.independent_command(recordings, output, policy, FIRST)
            self.assertEqual(command[command.index('--detector-config')+1], str(current_config.resolve()))
            self.assertEqual(current_config.read_bytes(), saved)

    def test_two_new_finished_runs_dispatch_as_two_single_run_commands_and_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recordings = root/'captures'
            make_run(recordings, OLD)
            make_run(recordings, FIRST, markers=[{'label': 'Blink'}])
            make_run(recordings, NEXT, markers=[{'label': 'Jaw clench'}])
            make_run(recordings, ACTIVE, active=True)
            policy = policy_file(root, recordings)
            calls = []
            def execute(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.sys, 'argv', argv(root, recordings, policy)), patch.object(module.subprocess, 'run', execute):
                self.assertEqual(module.main(), 0)
                self.assertEqual(module.main(), 0)  # restart skips unchanged successful versions
            self.assertEqual(len(calls), 2)
            self.assertEqual([command[command.index('--run-id')+1] for command in calls], [FIRST, NEXT])
            for command in calls:
                self.assertEqual(command[2], 'backend.reaction_analysis.independent_capture')
                self.assertEqual(command[command.index('--first-run')+1], FIRST)
                self.assertEqual(command.count('--run-id'), 1)
                self.assertNotIn('backend.reaction_analysis.binary_threshold', command)
                self.assertNotIn(OLD, command)
                self.assertTrue(command[-1].endswith('replacement-sensor-20261018T002800Z'))
            status = json.loads((root/'worker/watcher-status.json').read_text())
            self.assertFalse(status['cross_recording_pooling'])
            self.assertFalse(status['prior_sensor_training'])
            self.assertFalse(status['live_hardware_access'])
            self.assertFalse(status['viewer_changed'])
            self.assertEqual(status['eligible_completed_runs'], 2)
            progress = json.loads((root/'worker/progress.json').read_text())
            self.assertEqual(set(progress['successful_run_versions']), {FIRST, NEXT})

    def test_failed_run_retries_independently_without_repeating_successful_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recordings = root/'captures'
            make_run(recordings, FIRST)
            make_run(recordings, NEXT)
            policy = policy_file(root, recordings)
            calls = []
            def fail_first(command, **kwargs):
                run_id = command[command.index('--run-id')+1]
                calls.append(run_id)
                return subprocess.CompletedProcess(command, 2 if run_id == FIRST else 0)
            with patch.object(module.sys, 'argv', argv(root, recordings, policy)), patch.object(module.subprocess, 'run', fail_first):
                self.assertEqual(module.main(), 2)
            self.assertEqual(calls, [FIRST, NEXT])
            calls.clear()
            def succeed(command, **kwargs):
                calls.append(command[command.index('--run-id')+1])
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.sys, 'argv', argv(root, recordings, policy)), patch.object(module.subprocess, 'run', succeed):
                self.assertEqual(module.main(), 0)
            self.assertEqual(calls, [FIRST])

    def test_boundary_change_cancels_remaining_old_policy_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recordings = root/'captures'
            make_run(recordings, FIRST)
            make_run(recordings, NEXT)
            policy = policy_file(root, recordings)
            calls = []
            def change_boundary(command, **kwargs):
                calls.append(command[command.index('--run-id')+1])
                policy_file(root, recordings, first=NEXT, cohort='second-replacement')
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.sys, 'argv', argv(root, recordings, policy)), patch.object(module.subprocess, 'run', change_boundary):
                self.assertEqual(module.main(), 0)
            self.assertEqual(calls, [FIRST])
            calls.clear()
            def execute(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command, 0)
            with patch.object(module.sys, 'argv', argv(root, recordings, policy)), patch.object(module.subprocess, 'run', execute):
                self.assertEqual(module.main(), 0)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][calls[0].index('--run-id')+1], NEXT)
            self.assertTrue(calls[0][-1].endswith('second-replacement'))

    def test_missing_policy_never_dispatches_or_scans_captures(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(module.sys, 'argv', argv(root, root/'captures', root/'absent.json')), \
                 patch.object(module.subprocess, 'run') as runner, \
                 patch.object(module, 'completed_signature') as scanner:
                self.assertEqual(module.main(), 2)
                runner.assert_not_called()
                scanner.assert_not_called()


if __name__ == '__main__':
    unittest.main()
