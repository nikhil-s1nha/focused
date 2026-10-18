#!/bin/zsh
cd -- "${0:A:h}"
set -eu
extra_args=()
if [[ -n "${SIGNAL_SCOPE_ALLOW_HOST:-}" ]]; then
  extra_args=(--allow-host "$SIGNAL_SCOPE_ALLOW_HOST")
fi
exec backend/.venv/bin/python -m backend.partner_sender --port 8769 "${extra_args[@]}"
