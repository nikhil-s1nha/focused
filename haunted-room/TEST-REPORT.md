# Verification — October 17, 2026

## Automated: 6 tests passed

- Malformed/out-of-range/unknown-source input rejected.
- Sustained low input reaches PEAK with tension capped at 0.85.
- Sustained high input enters RELIEF and reduces tension.
- Low quality and stale input enter WAIT without escalating.
- Reset returns to ready; the timed ending settles tension.
- Real local HTTP → WebSocket test: accepted publication, invalid value rejection, raw/extra field omission, optional bearer token enforcement, oversized request rejection, local scene and Three.js module serving.

`npm test` exits successfully. `npm audit` reports zero vulnerabilities for the active haunted-room package (Three.js 0.186.1, ws 8.22.0). App/server modules pass Node syntax checks. No bundler is required; Three.js and addons are served locally.

## Browser: passed on desktop preview

Observed actual rendered room, fixed geometry, lighting, responsive UI, and initial ready state. Began a manual run; setting input to zero reached PEAK with tension 0.69. Setting high input reduced tension to 0.05. Connected the real mock publisher through the HTTP relay and WebSocket; UI showed SYNTHETIC, quality 0.95, receiving, and RELIEF. Stopped the publisher; UI showed WAIT, waiting for fresh input, and tension zero. Reset restored Ready and 2:00 remaining. Saved preview.jpg.

The browser reported VR NOT SUPPORTED, as expected in this desktop preview environment. That proves neither an XR session nor Quest compatibility. The in-world HUD and controller interactions are implemented but need physical headset verification. Spatial audio nodes and opt-in UI are implemented; perceived direction and volume need headset listening checks. Real hardware input, HTTPS certificate trust on Quest, and a ten-minute headset performance run remain unverified.

## Physical Quest acceptance

Use README.md's USB or trusted-HTTPS route. Verify Enter VR, stereo/head tracking, comfortable HUD, controller start/reset/sound, effects, WAIT on dropout, and re-entry. Do not present synthetic input as live hardware. Sensor acquisition, calibration and body-connected hardware review are the sensor owner's tasks.
