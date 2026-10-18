#!/usr/bin/env python3
"""Apply only after explicit user approval and after recording has stopped.

No device, serial, firmware, recording or server-control operations are performed.
The existing auto-refresh mechanism will pick up these frontend file replacements.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply-after-user-approval', action='store_true', required=True)
args = parser.parse_args()
stage = Path(__file__).resolve().parent
root = stage.parent.parent
manifest = json.loads((stage/'manifest.json').read_text())
expected = {'signal-viewer/bench-trace.js', 'signal-viewer/app.js', 'signal-viewer/bench-panel.js'}
if set(manifest) != expected:
    raise SystemExit('Refusing unexpected deployment file list.')
try:
    with urlopen('http://127.0.0.1:8767/api/bench-recording', timeout=3) as response:
        state = json.load(response)
except Exception as error:
    raise SystemExit('Cannot confirm the recorder has stopped; no files changed: '+str(error))
if state.get('active') is not False or state.get('start_queued'):
    raise SystemExit('Recording or a queued start is still active. Nothing changed. Stop and wait before applying.')
for name, hashes in manifest.items():
    target, proposed = root/name, stage/'proposed'/name
    current = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    if current != hashes['base_sha256']:
        raise SystemExit('Active file changed since staging; rebase rather than overwrite: '+name)
    if hashlib.sha256(proposed.read_bytes()).hexdigest() != hashes['proposed_sha256']:
        raise SystemExit('Staged proposal changed; regenerate/review manifest before applying: '+name)
backup = stage/('applied-backup-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir()
for name in manifest:
    source = root/name
    if source.exists():
        destination = backup/name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
temporary = []
try:
    for name in manifest:
        target = root/name
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.staged-scope-', delete=False) as handle:
            handle.write((stage/'proposed'/name).read_bytes())
            temporary.append((Path(handle.name), target))
    # New helper first, importer last; every replacement is atomic.
    for pending, target in temporary:
        os.replace(pending, target)
finally:
    for pending, _ in temporary:
        pending.unlink(missing_ok=True)
print('Applied frontend smoothness files. Recorder/device untouched. Backup:', backup)
