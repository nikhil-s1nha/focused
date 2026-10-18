# Adaptive horror: two-person integration starter

This is a new, deliberately small A-Frame WebXR room, not a finished horror game.
It has a manual intensity slider, a three-state director, fog, a shadow figure,
light flicker, an opt-in spatial drone, an in-headset text HUD, and a WebSocket
input relay. No external models or audio files are needed. The right controller
trigger toggles the audio. Desktop mouse drag/WASD are development controls.

## Start locally

Requires Node.js 22+ and Python 3.9+ for the optional test feed.

```sh
cd adaptive-horror-web
npm install
npm test
npm start
```

Open http://127.0.0.1:8080/ on the development laptop. Manual mode is the default.
Move intensity near zero and hold it to build tension, then near one and hold
it to trigger relief. Middle-range input holds the current tension. The rules
and thresholds are all in `public/director.mjs` under `CONFIG`.

In another terminal:

```sh
python3 mock_feed.py
```

Choose **Live stream** in the page. This feed is explicitly labelled SYNTHETIC;
it is a deterministic test wave, not BrainFlow output or a real measurement.

## Exact division of work

| Owner | Deliverable | Done when |
|---|---|---|
| Sensor owner | Verify Uno detects the ADS1292R using a chip-ID/internal-test sketch; then acquire and timestamp real samples. | Known internal test signal arrives without relying on a person's electrodes. |
| Sensor owner | Produce a bounded response proxy and signal-quality value. Keep original sample rate; publish summaries at 10 Hz. | Same message shape below is POSTed to the relay and source is honestly marked hardware. |
| Scene owner | Open the room in Quest immersive VR, add/tune three scares, and keep all effects controlled by director state. | Enter VR works, stereoscopic rendering/head tracking work, and manual slider causes the expected changes. |
| Together | Replace mock input with live feed; simulate dropouts. | Hardware input visibly affects VR, and poor/disconnected input causes WAIT and reduced tension. |

Proposed two-hour checkpoint sequence (estimates, not guarantees):

1. First 20 minutes: sensor internal-test acquisition; partner proves headset VR.
2. Next 40 minutes: stable acquisition and quality checks; partner tunes manual effects.
3. Next 30 minutes: connect the exact message below and test data loss.
4. Final 30 minutes: rehearse/record the two-minute demo; preserve labelled manual fallback.

If a checkpoint fails, keep the working manual scene and report what is still
simulated. No emotion classifier, procedural new models, physics engine,
heart-rate integration, or robot arm is necessary for this checkpoint.

## Shared signal contract

POST JSON to `http://127.0.0.1:8080/api/signal` from a local bridge:

```json
{
  "type": "signal",
  "source": "hardware",
  "intensity": 0.42,
  "signal_quality": 0.9,
  "timestamp": 1792256400.0
}
```

- `intensity`: finite number 0–1, an experimental response control, not a probability of fear.
- `signal_quality`: finite number 0–1; current minimum is 0.5.
- `timestamp`: Unix seconds from the producer; receiver uses its own monotonic receipt time for freshness.
- `source`: exactly `hardware`, `synthetic`, or `manual`.
- `POST /api/signal` accepts at most 8 KiB and returns 204 or 400. Raw measurements stay in the acquisition process; the relay only broadcasts these five fields.
- Browser subscribes to `/signals` on the same host using WebSocket; HTTPS automatically chooses WSS. It reconnects automatically.
- Keep raw board acquisition separate from this low-rate control channel. Terminal printing is optional debugging, not the integration transport.
- On bad quality or >3 seconds without input, director enters WAIT and eases tension. New input resumes adaptation.

The current acquisition hardware is **ProtoCentral ADS1292R, 5 V logic → Uno R3 → USB → Orange Pi 5 Pro**. No Pi GPIO connections. BrainFlow support for this exact custom path is not established; do not select an unrelated supported EEG board driver. An Uno serial reader is a distinct adapter and is not implemented by this scene starter.

## Quest access: HTTPS is a real prerequisite

The HTTP localhost command above is for desktop development. It does **not**
complete Quest setup. The Quest needs a reachable HTTPS address with a certificate
trusted by its browser, and any relay must be WSS/same-origin HTTPS.

The server accepts your existing certificate and private key:

```sh
HOST=0.0.0.0 PORT=8443 TLS_CERT=/absolute/path/certificate.pem TLS_KEY=/absolute/path/private-key.pem npm start
```

The certificate must cover the hostname/address the Quest actually opens.
A random self-signed certificate or one trusted only by your laptop does not
automatically work on the Quest. Do not turn off browser certificate/security
checks. A trusted HTTPS reverse proxy can instead forward both `/` and the
WebSocket upgrade at `/signals` to this local server. Keep the relay local/private;
there is no authentication in this hackathon starter. Merely opening the flat page
inside Quest is not VR acceptance: enter immersive mode and test stereo/head tracking.

If the acquisition bridge runs on a different computer, its POST target must be
the reachable scene server address, with trusted HTTPS as applicable. Do not use
localhost to refer to another machine.

## Body-connected operation

Bench checks use the internal test signal, electrodes unplugged. The current
USB chain is not patient isolated. A body-connected demo needs a reviewed battery
acquisition setup with no conductive path to mains-powered laptops, displays,
robot hardware, or test equipment. The current schematic documents bench wiring;
it does not establish body safety. Do not run the default respiration-excitation
configuration on forehead electrodes. Validate that configuration and intended
use with an appropriate hardware mentor first.

## Research: existing game versus XR starter

| Source | Useful parts | Remaining work |
|---|---|---|
| [Bridge Horror House](https://github.com/bridge-mind/bridge-horror-house) (MIT) | Actual three.js horror game with procedural house, ghost, synthesized audio, flicker and scare director. | Desktop pointer-lock/WASD. Requires WebXR input/camera/render-path work and a headset test. Not a drop-in Quest game. |
| [A-Frame XR boilerplate](https://github.com/AdaRoseCannon/aframe-xr-boilerplate) (MIT code) | XR interactions, tracked hands, locomotion examples. | Extra CDN plugins, physics and assets to trim; check individual asset licenses. Template, not a horror game. |
| [Lidar](https://github.com/BSoDium/Lidar) (MIT) | Existing dark-maze WebXR game concept. | README says movement is not implemented; older React/Webpack setup and Quest not verified here. |

**Recommendation for this timebox:** use this minimal room as the working XR/input
integration target. If art/gameplay is the bottleneck, borrow or adapt selected
procedural house/audio code from Bridge Horror House and retain its MIT notice.
Porting a whole desktop game may take longer than building the three effects.

For Bridge Horror House, source-level edit points include
[`ScareDirector.js`](https://github.com/bridge-mind/bridge-horror-house/blob/main/src/systems/ScareDirector.js)
(`house.flickerAll`, `audio.whisper`, `audio.thump`, `ghost.appearAt`) and
[`Game.js`](https://github.com/bridge-mind/bridge-horror-house/blob/main/src/Game.js)
(`scene.fog.density`, renderer exposure). Don't assume these hooks alone add VR.

Additional options:

- [A-Frame](https://aframe.io/docs/) (MIT): Quest support and editable entities; this starter uses version 1.8.0 installed locally.
- [A-Frame visual inspector](https://aframe.io/docs/1.7.0/introduction/visual-inspector-and-dev-tools.html): desktop Ctrl+Alt+I / Ctrl+Option+I to inspect/edit scene properties; not an in-headset authoring UI. It may load inspector code from the network; game runtime assets here are local.
- [Environment component](https://github.com/supermedium/aframe-environment-component) (MIT): quick procedural forest alternative; not installed here.
- [Kenney Graveyard Kit](https://kenney.nl/assets/graveyard-kit) (CC0): optional art assets; not downloaded here.
- [three.js WebXR basics](https://threejs.org/manual/en/webxr-basics.html): headset connection and secure-context setup.

No candidate has been tested on your physical Quest by this research. Credit all
reused work in the submission and preserve the relevant licenses. The original
small integration code here is event work, not proof of a completed sensor or VR demo.
