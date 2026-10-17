# Focused — The Quiet Room

A two-minute adaptive haunted room for the Quest 3S browser. Built from the requirements in the October 17 partner handoff. The PDF contained no starter source; this implementation keeps the existing Three.js renderer and uses the handoff's signal contract. No A-Frame migration, external artwork, CDN runtime, or hardware acquisition code is required.

## Start here

```sh
cd haunted-room
npm ci
npm test
npm start
```

If you are already in this folder, omit `cd haunted-room`. Open **http://127.0.0.1:8080** on the laptop running the server. Select **Manual demo**, press **Begin experience**, and use the response slider. Drag the scene to look around. No forced locomotion is used.

- Near 0: after smoothing and dwell time, lights dim, fog thickens and the shadow becomes visible.
- Near 1: after smoothing and dwell time, the director enters RELIEF and the room eases off.
- Sound starts off. Explicitly opt in for a quiet spatial drone. No microphone access is used.
- Reset returns to the ready state; after 120 active seconds the room settles and ends.
- Creator settings enable/disable effects, choose one of three shadow positions, and adjust response thresholds. Shadow repositioning is a setup control: configure it before beginning your demonstration.

The input is a response **proxy**, not validated fear or emotion classification. Every manual/synthetic source remains labeled, including inside VR.

## Test your teammate's integration without hardware

Terminal 1: `npm start`. Terminal 2: `npm run mock`. Choose **Live stream**, then **Begin experience**. The HUD must show **SYNTHETIC / DEMO**, not hardware.

Stop the feed. After three seconds, the director enters WAIT and decreases tension. The WebSocket can remain connected while the upstream feed is stale; those are separate states. Restarting the feed recovers automatically. The director uses monotonic receipt time, so machine clock skew cannot keep stale samples fresh. Socket reconnection uses exponential backoff from 0.5 to 10 seconds. Changing source clears old input and dwell history.

## Signal contract — send this to your teammate

Publish approximately 10 times/second to **POST /api/signal**:

```json
{"type":"signal","source":"hardware","intensity":0.42,"signal_quality":0.9,"timestamp":1792256400.0}
```

Generate `timestamp` at runtime as Unix **seconds** (`time.time()` in Python). `intensity` and `signal_quality` are finite 0–1 values. `source` is exactly `hardware`, `synthetic`, or `manual`. Use hardware only for the intended physical acquisition path. The browser reports that label as **bridge-reported**; it cannot authenticate the sensor's provenance.

Accepted messages return 204, invalid messages 400, oversized messages 413. The server relays only these five fields to **/signals** via WebSocket. No raw electrode measurements are stored or forwarded. No latest message is replayed to a new client; it waits for a fresh publication.

Python publisher:

```python
import json, time, urllib.request
payload = dict(type="signal", source="synthetic", intensity=0.42,
               signal_quality=0.9, timestamp=time.time())
request = urllib.request.Request(
    "http://SCENE_HOST:8080/api/signal",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(request, timeout=2) as response:
    assert response.status == 204
```

Replace SCENE_HOST with the scene laptop's reachable address. On the Pi, 127.0.0.1 refers to the Pi, not your laptop. For another machine to publish, run `HOST=0.0.0.0 npm start` and use a reachable trusted network. Binding is localhost by default. Set `PUBLISH_TOKEN` to require a bearer token on POSTs; set the same variable for `npm run mock`. For any externally reachable deployment, require authenticated publishing and use trusted HTTPS/WSS. This is a local-development server, not a public production service.

## Quest 3S — prove this before polishing art

### Quick USB route

1. Enable Quest developer mode, install Android platform tools, connect the headset by USB and authorize debugging yourself in the headset.
2. `adb devices` should list it as `device`.
3. With this server running: `adb reverse tcp:8080 tcp:8080`.
4. Open **http://localhost:8080** in Quest Browser. Loopback can be a secure context; verify **Enter VR** is offered.
5. Set input and allowed effects, then enter VR. Point either controller at **BEGIN / RESET** and press trigger. When ready/ended, trigger away from buttons can also begin.
6. Point and trigger **SOUND: OFF** to opt in, or press A/X. Read source/input/tension/state/quality on the world-space panel. Exit with normal headset controls.
7. To remove USB forwarding: `adb reverse --remove tcp:8080`.

The USB route is an Android port-forwarding technique, not a claim of already-verified Quest operation. The physical acceptance checklist below still needs your headset.

### Trusted HTTPS on Wi-Fi (handoff deployment path)

Obtain a certificate and key whose exact hostname/address and issuer are trusted by Quest. A certificate trusted only on the laptop is insufficient. Do not bypass browser certificate/secure-context protections.

```sh
HOST=0.0.0.0 PORT=8443 \
TLS_CERT=/absolute/path/fullchain.pem \
TLS_KEY=/absolute/path/key.pem \
PUBLISH_TOKEN=YOUR_LOCAL_PUBLISH_SECRET \
npm start
```

Open `https://YOUR-CERTIFICATE-HOSTNAME:8443` in Quest Browser. The page chooses **wss://…/signals** automatically. A trusted HTTPS reverse proxy must forward both normal HTTP and WebSocket upgrades. Never commit certificate keys or tokens. The Quest's network route is independent of a Mac–Pi Ethernet link; venue Wi-Fi may isolate clients.

## Director tuning

`public/director.mjs` owns CONFIG: smoothing 1.5 s, low 0.30, high 0.75, dwell 4 s, relief 8 s, stale 3 s, minimum quality 0.50, tension cap 0.85, experience 120 s. These are demonstration settings, not validated physiological thresholds. Timing advances during active rendered frames; browser suspension does not consume the session.

All effects read the same director output. Poor or absent signals enter WAIT, reset dwell history and reduce tension. Rapid strobing is avoided; lighting uses gentle slow modulation. No room geometry, floor or tracked camera moves in response to input. Sound is opt-in and muted outside an active usable-signal session.

## Files and credits

- `server.mjs`: local HTTP/HTTPS static server and WebSocket relay; optional publisher token.
- `relay.mjs`: validation and explicit field allowlist.
- `public/director.mjs`: renderer-independent state machine.
- `public/app.mjs`: room geometry, effects, spatial audio, VR HUD, tracked-controller targets and browser UI.
- `mock-feed.mjs`: labeled mathematical synthetic signal; not BrainFlow.
- `test/`: director behavior and a real HTTP-to-WebSocket integration test.

Scene geometry, interface and synthesized sound are project code; no external models or sound assets. Three.js is MIT; ws is MIT. Full upstream licenses are in installed packages. Preserve these credits and cite earlier work in the hackathon submission. The original EEG observatory prototype remains in the repository parent folder; this `haunted-room/` project is the active experience.

## Verified and still required

Automated checks cover input validation, low-input peak/cap, high-input relief, poor-signal/dropout easing, reset/ending, HTTP-to-WebSocket delivery, field stripping, publisher authorization, body-size limits and serving local runtime modules. Browser testing covers rendering and the start/reset flow; see TEST-REPORT.md for final results.

Actual Quest acceptance remains manual:

- [ ] Trusted origin/USB loopback loads; Enter VR enters stereo tracked rendering.
- [ ] Head movement is tracked and room floor stays fixed.
- [ ] HUD is readable; controller start/reset and sound toggle work.
- [ ] Manual low/high input visibly builds/relieves atmosphere.
- [ ] Live mock displays SYNTHETIC and changes effects.
- [ ] Stop feed / poor quality enters WAIT and eases off.
- [ ] Reconnect/restart stream without reloading or leaving VR.
- [ ] Run the complete two-minute session and a ten-minute stability test.
- [ ] Hardware connection and acquisition safety/configuration are reviewed by the sensor owner before a body-connected demonstration.
- [ ] Real changing input is visibly correlated with a repeatable scene effect.
- [ ] Record the demonstration, with truthful source labels.

## Two-minute demo rehearsal

0:00 — show input/source/HUD, enter VR and begin. 0:15 — use low manual input or the actual available source; explain it honestly. 0:45 — show lighting/fog/shadow change. 1:00 — hold high input and show RELIEF. 1:25 — stop the synthetic/live publisher and show WAIT. 1:40 — restore input. 2:00 — show the ending. Capture the headset's view; no slide deck is needed.

References: [Three.js VR](https://threejs.org/manual/pages/how-to-create-vr-content.html), [WebXR secure context](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API), [Android local server forwarding](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server).
