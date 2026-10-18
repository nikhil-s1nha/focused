#!/bin/zsh
set -eu
cd -- "$(dirname "$0")"
if [[ ! -x backend/.venv/bin/python ]]; then
  print 'Set up the Python environment first. See backend/VIEWER.md.'
  exit 1
fi
exec backend/.venv/bin/python -m backend.viewer_server --host 127.0.0.1 --port 8767
