"""Analyze each finished capture independently within the active sensor cohort.

Never opens serial, SSH, a browser, or the live viewer. Active captures and runs
before the policy boundary are excluded. Ctrl-C or WORKER_OUTPUT/watcher.stop
stops this worker. The app's paused scheduled automation is not modified.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[1]
RUN_ID = re.compile(r'object-ui-\d{8}T\d{6}Z-[0-9a-f]{32}\Z')
TERMINAL = {'stopped_original_restored', 'capture_failed_original_restored'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def validate_run_id(value):
    if not isinstance(value, str) or not RUN_ID.fullmatch(value):
        raise ValueError('Expected a complete generated object-ui run ID.')
    datetime.strptime(value[10:26], '%Y%m%dT%H%M%SZ')
    return value


def load_policy(path: Path):
    """Fail closed: no missing-policy fallback to all captures or old thresholds."""
    policy = json.loads(path.read_text())
    if not isinstance(policy, dict) or policy.get('version') != 1:
        raise ValueError('Unsupported or missing sensor-cohort policy version.')
    cohort = policy.get('cohort_id')
    if not isinstance(cohort, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', cohort):
        raise ValueError('Invalid cohort_id; must be a single safe directory name.')
    validate_run_id(policy.get('first_run_id'))
    if not isinstance(policy.get('source_path'), str) or not policy['source_path']:
        raise ValueError('Policy must identify its source_path.')
    return policy, digest(policy)


def completed_signature(recordings: Path, first_run_id: str):
    """Discover eligible versions without reading any pre-boundary archive.

    The independent analyzer subsequently freezes/hashes actual raw bytes. Here
    raw size/mtime/ctime detect normal archive changes without repeatedly hashing
    every large raw log during idle polls. Marker/status/metadata bytes are hashed.
    """
    validate_run_id(first_run_id)
    signatures = []
    for directory in sorted(recordings.glob('object-ui-*')):
        if not RUN_ID.fullmatch(directory.name) or directory.name < first_run_id:
            continue
        try:
            names = ('metadata.json', 'status.json', 'markers.json', 'raw.txt')
            before = {name: (directory/name).stat() for name in names}
            metadata_bytes = (directory/'metadata.json').read_bytes()
            metadata = json.loads(metadata_bytes)
            if not isinstance(metadata, dict) or metadata.get('active') is not False:
                continue
            finished = metadata.get('finished_at')
            if not isinstance(finished, (int, float)) or isinstance(finished, bool) or not math.isfinite(finished):
                continue
            status_bytes = (directory/'status.json').read_bytes()
            status = json.loads(status_bytes)
            if not isinstance(status, dict) or status.get('stage') not in TERMINAL:
                continue
            markers = (directory/'markers.json').read_bytes()
            decoded = json.loads(markers)
            if not isinstance(decoded, list) or not all(isinstance(marker, dict) for marker in decoded):
                continue
            after = {name: (directory/name).stat() for name in names}
            fingerprint = lambda info: (info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            if any(fingerprint(before[name]) != fingerprint(after[name]) for name in names):
                continue
            raw = after['raw.txt']
            if raw.st_size == 0:
                continue
            signatures.append({'run_id': directory.name, 'raw_size': raw.st_size,
                               'raw_mtime_ns': raw.st_mtime_ns, 'raw_ctime_ns': raw.st_ctime_ns,
                               'markers_sha256': hashlib.sha256(markers).hexdigest(),
                               'status_sha256': hashlib.sha256(status_bytes).hexdigest(),
                               'metadata_sha256': hashlib.sha256(metadata_bytes).hexdigest(),
                               'finished_at': finished})
        except (OSError, ValueError, TypeError):
            continue
    return digest(signatures), signatures


def independent_command(recordings: Path, output_root: Path, policy: dict, run_id: str):
    validate_run_id(run_id)
    if run_id < policy['first_run_id']:
        raise ValueError('Run precedes the current sensor boundary.')
    cohort_output = output_root/policy['cohort_id']
    command = [sys.executable, '-m', 'backend.reaction_analysis.independent_capture',
            '--recordings', str(recordings.resolve()),
            '--first-run', policy['first_run_id'], '--run-id', run_id,
            '--output', str(cohort_output.resolve())]
    # The user explicitly selected this frozen replacement-sensor demo threshold.
    # Evaluate it separately; never fit or overwrite it using subsequent captures.
    selected_config = cohort_output/'detector-config.json'
    if selected_config.is_file():
        command.extend(['--detector-config', str(selected_config.resolve())])
    return command


def atomic_json(path: Path, value):
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False)+'\n')
    temporary.replace(path)


def read_progress(path: Path, policy_signature: str):
    try:
        progress = json.loads(path.read_text())
        versions = progress.get('successful_run_versions')
        if progress.get('policy_signature') == policy_signature and isinstance(versions, dict):
            return {run_id: signature for run_id, signature in versions.items()
                    if isinstance(run_id, str) and RUN_ID.fullmatch(run_id) and isinstance(signature, str)}
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return {}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recordings', type=Path, default=REPO/'backend/results/bench-recordings')
    parser.add_argument('--policy', type=Path, default=REPO/'backend/results/sensor-cohorts/active.json')
    parser.add_argument('--worker-output', type=Path, default=REPO/'backend/results/sensor-cohort-worker')
    parser.add_argument('--output-root', type=Path, default=REPO/'backend/results')
    parser.add_argument('--poll-seconds', type=float, default=2)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    args.worker_output.mkdir(parents=True, exist_ok=True)
    lock = (args.worker_output/'watcher.lock').open('a+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        print('An independent analysis watcher already owns this worker directory.', flush=True)
        return 1
    status_path = args.worker_output/'watcher-status.json'
    progress_path = args.worker_output/'progress.json'
    status = {'pid': os.getpid(), 'started_at': utc_now(), 'state': 'waiting',
              'policy_path': str(args.policy.resolve()), 'analysis_mode': 'independent_per_recording',
              'cross_recording_pooling': False, 'prior_sensor_training': False,
              'failures': 0, 'live_hardware_access': False, 'viewer_changed': False}
    current_policy_signature, successful, retries = None, {}, {}
    return_code = 0
    try:
        while not (args.worker_output/'watcher.stop').exists():
            try:
                policy, policy_signature = load_policy(args.policy)
                source = Path(policy['source_path'])
                if not source.is_absolute(): source = REPO/source
                if source.resolve() != args.recordings.resolve():
                    raise ValueError('Recordings path does not match active cohort source_path.')
            except (OSError, ValueError, TypeError) as error:
                message = str(error)
                if status.get('error') != message:
                    print('Analysis waiting for a valid sensor-cohort policy: '+message, flush=True)
                status.update(state='waiting_for_policy', error=message)
                atomic_json(status_path, status)
                if args.once:
                    return_code = 2
                    break
                time.sleep(max(.25, args.poll_seconds))
                continue
            if policy_signature != current_policy_signature:
                current_policy_signature = policy_signature
                successful = read_progress(progress_path, policy_signature)
                retries = {}
                status.update(cohort_id=policy['cohort_id'], first_run_id=policy['first_run_id'],
                              policy_signature=policy_signature, error=None, state='waiting')
            _, runs = completed_signature(args.recordings, policy['first_run_id'])
            status.update(eligible_completed_runs=len(runs), run_ids=[run['run_id'] for run in runs])
            for run in runs:
                run_id, version = run['run_id'], digest(run)
                if successful.get(run_id) == version or time.monotonic() < retries.get(run_id, {}).get('at', 0):
                    continue
                if (args.worker_output/'watcher.stop').exists(): break
                # A replacement boundary may change while the queue is processed.
                # Never dispatch remaining jobs under a stale cohort policy.
                try:
                    _, checked_signature = load_policy(args.policy)
                except (OSError, ValueError, TypeError):
                    break
                if checked_signature != policy_signature:
                    break
                command = independent_command(args.recordings, args.output_root, policy, run_id)
                status.update(state='analysing', analysing_run_id=run_id, last_attempt_at=utc_now(), error=None)
                atomic_json(status_path, status)
                with (args.worker_output/'watcher-analysis.log').open('a') as log:
                    log.write('\nIndependent recording '+run_id+' at '+status['last_attempt_at']+'\n')
                    log.flush()
                    try:
                        code = subprocess.run(command, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=180).returncode
                    except subprocess.TimeoutExpired:
                        code = 124
                    except OSError as error:
                        log.write(str(error)+'\n')
                        code = 127
                status.update(last_exit_code=code, analysing_run_id=None)
                if code == 0:
                    successful[run_id] = version
                    retries.pop(run_id, None)
                    atomic_json(progress_path, {'policy_signature': policy_signature,
                                'cohort_id': policy['cohort_id'], 'successful_run_versions': successful})
                    status.update(state='waiting', last_success_run_id=run_id, last_success_at=utc_now(),
                                  successful_runs=len(successful))
                    print('Analyzed independently: '+run_id, flush=True)
                else:
                    failures = retries.get(run_id, {}).get('failures', 0)+1
                    retries[run_id] = {'failures': failures, 'at': time.monotonic()+min(60, 5*failures)}
                    status.update(state='retry_wait', failures=status['failures']+1,
                                  error='Independent analysis failed for '+run_id)
                    if args.once: return_code = 2
                    print('Independent analysis failed; this run has a bounded retry.', flush=True)
                atomic_json(status_path, status)
            status['pending_retry_run_ids'] = sorted(retries)
            atomic_json(status_path, status)
            if args.once: break
            time.sleep(max(.25, args.poll_seconds))
    except KeyboardInterrupt:
        pass
    finally:
        status.update(state='stopped', stopped_at=utc_now())
        atomic_json(status_path, status)
        lock.close()
    return return_code


if __name__ == '__main__':
    raise SystemExit(main())
