"""One bounded nonhuman surface test on Pi; restore original app.

Run only with electrodes on a nonhuman surface, not a person or toy wiring.
This runner requests internal controls and one external object-input phase. Keep it independent of SSH
with nohup so normal network interruption does not interrupt restoration.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--nonhuman-surface-only', action='store_true', required=True)
parser.add_argument('--run-name', required=True)
args = parser.parse_args()
if not args.run_name.replace('-', '').isalnum():
    parser.error('Run name must contain only letters, numbers, and hyphens')
root = Path('/root/adaptive-horror')
base = root / 'firmware/id-bypass-diagnostic'
run = base / args.run_name
run.mkdir(exist_ok=False)
capture = run / 'capture.txt'
capture.touch()
diagnostic = base / 'FrameFormatObjectBench.ino.hex'
original = base / 'uno-original-app.hex'
reader = base / 'stream_serial.py'
if not reader.is_file():
    raise RuntimeError('Serial reader missing; no firmware changed')
for path, expected in (
    (diagnostic, '7e545461c8e7d55d1bf3a4a9d82f868b1d2c9238e315b291db9817905de0dfd7'),
    (original, '763cbcfb69ca864be27617c677a6cb4d4c8fabd210d447239e3239eb115f238a'),
):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Unexpected firmware bytes: {path.name}')
owner = subprocess.run(['fuser', '/dev/ttyACM0'], capture_output=True)
if owner.returncode == 0:
    raise RuntimeError('Serial port is already in use; no firmware changed')
status = {'started_at': time.time(), 'nonhuman_surface_only_confirmed': True,
          'source': 'untrusted_bench_bytes', 'body_acquisition_enabled': False,
          'upload_exit': None, 'capture_exit': None, 'restore_exit': None}

def save(stage):
    status['stage'] = stage
    temporary = run / 'status.tmp'
    temporary.write_text(json.dumps(status, indent=2) + '\n')
    temporary.replace(run / 'status.json')

def upload(path, log):
    command = [str(root / 'tools/arduino-cli'), 'upload', '--fqbn', 'arduino:avr:uno',
               '--port', '/dev/ttyACM0', '--input-file', str(path), '--verify',
               '--config-file', str(root / 'arduino-cli.yaml')]
    with (run / log).open('wb') as output:
        return subprocess.run(command, stdout=output, stderr=subprocess.STDOUT,
                              timeout=70).returncode

try:
    save('uploading_bench_diagnostic')
    status['upload_exit'] = upload(diagnostic, 'upload.log')
    if status['upload_exit'] != 0:
        raise RuntimeError('Diagnostic upload failed')
    save('capturing_untrusted_bench_bytes')
    with capture.open('wb') as output, (run / 'capture.err').open('wb') as error:
        status['capture_exit'] = subprocess.run(
            ['python3', str(reader), '--seconds', '24', '--reset'],
            stdout=output, stderr=error, timeout=32).returncode
except Exception as error:
    status['error'] = str(error)
finally:
    save('restoring_original_firmware')
    try:
        status['restore_exit'] = upload(original, 'restore.log')
    except Exception as error:
        status['restore_error'] = str(error)
    status['finished_at'] = time.time()
    save('restore_failed' if status['restore_exit'] != 0 else
         'complete' if status['capture_exit'] == 0 else 'capture_failed_original_restored')
