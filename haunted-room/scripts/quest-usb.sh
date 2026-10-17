#!/usr/bin/env sh
# Quest 3S USB port-forward setup. Run with the scene server already running
# (npm start). Requires Android platform-tools and a USB-connected Quest with
# developer mode + USB debugging authorized in the headset.
set -eu

PORT="${PORT:-8080}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found."
  echo "Install Android platform-tools, e.g.:  brew install android-platform-tools"
  exit 1
fi

echo "Devices reported by adb:"
adb devices

STATE="$(adb get-state 2>/dev/null || true)"
if [ "$STATE" != "device" ]; then
  echo
  echo "No authorized Quest detected (state: ${STATE:-none})."
  echo "1. Enable developer mode via the Meta Horizon phone app."
  echo "2. Connect USB-C and put the headset ON — the authorization"
  echo "   dialog only appears inside the headset."
  echo "3. Accept 'Allow USB debugging', then re-run: npm run quest"
  exit 1
fi

adb reverse "tcp:${PORT}" "tcp:${PORT}"
echo
echo "Port reverse active: Quest localhost:${PORT} -> this laptop :${PORT}"
echo
echo "In the headset now:"
echo "  1. Open Quest Browser and go to  http://localhost:${PORT}"
echo "     (loopback is a secure context, so Enter VR works without TLS)"
echo "  2. Verify the ENTER VR button appears, then run the acceptance"
echo "     checklist in README.md (stereo, head tracking, HUD, controllers)."
echo
echo "When finished:  adb reverse --remove tcp:${PORT}"
