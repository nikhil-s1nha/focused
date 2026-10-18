# Signal Scope → Quest game: partner setup

This package sends explicit events from the sensor laptop to the game laptop.
It does not change acquisition, firmware, or the game’s rendering. Node 18+ and
Python 3 are sufficient; there are no packages to install.

## Connection

```text
Sensor laptop                       Partner laptop                         Quest
Signal Scope :8767 → send.py ──LAN──→ receiver :48081 → game /signal-link → browser
                       HTTP POST                    same-origin SSE
```

`127.0.0.1` always means the device making the request. The sender therefore
uses the partner’s LAN IP, not `127.0.0.1`. The game browser uses a relative URL
through its existing connection to the game server. Keep the working Quest
HTTPS/USB-forwarding setup unchanged. If only port 48080 is forwarded to the
headset, proxying below lets events travel over that same port.

Both laptops must be on a network that permits peer traffic. A venue guest Wi-Fi
may block this; use a shared private hotspot or router if necessary. Allow Node
through the partner laptop’s firewall for local-network access. No public port
forwarding is needed. Use a trusted private LAN: this demo link uses HTTP, not
encrypted transport. Do not put the token in browser code or commit it.

## 1. Partner: start the receiver

Unzip this folder and open a terminal inside it. Generate a token once:

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

Share that token privately with the sensor operator. In this terminal:

```sh
export SIGNAL_TOKEN='PASTE_THE_GENERATED_TOKEN'
npm start
```

Leave it running. It listens on all interfaces at port 48081. Health:
`http://127.0.0.1:48081/signal-link/health`. This shows accepted events, connected
game subscribers, and last receipt time. The health response contains no token.

Find the partner’s Wi-Fi LAN IPv4 in network settings (Mac: System Settings →
Wi-Fi → Details → TCP/IP; Windows: `ipconfig`). Share that address with the
sensor operator. Do not use a public/WAN IP or the Pi’s address.

## 2. Partner: connect the existing game

Proxy `/signal-link` through the existing game dev server to the receiver.
For **Vite**, merge this into the current `server` configuration; preserve the
existing plugins, port, HTTPS and host settings:

```js
// vite.config.js / vite.config.ts — fragment, not a replacement config
server: {
  // ...existing settings
  proxy: {
    // ...existing proxy routes
    '/signal-link': { target: 'http://127.0.0.1:48081', changeOrigin: true }
  }
}
```

Restart the game dev server after changing its proxy. Open
`/signal-link/health` on the **game’s** origin; it must return JSON, not the game
HTML. SSE responses must not be buffered. For another framework, ask its coding
agent to add the equivalent streaming HTTP reverse proxy. Alternatively, a
custom Node server can use `createSignalReceiver({token}).handle(req,res,next)`
before its static/game handler; then POST directly to that server’s LAN port
and omit the standalone receiver. Do not run two receivers expecting shared state.

Copy `client.js` into the game’s source tree and import it from the app startup:

```js
import {connectSignals} from './client.js';

const disconnect = connectSignals({
  onStatus(status) { console.log('Signal link:', status); },
  onSignal(signal) {
    console.log('Incoming event:', signal);
    // Call the SAME functions that your existing buttons call.
    // Replace these example function names with your actual game functions:
    // if (signal.event === 'startle_flinch') setTension(signal.value);
    // if (signal.event === 'blink') triggerLightFlicker();
    // if (signal.event === 'jaw_clench') playFootstep();
  }
});
// On component unmount / scene teardown: disconnect();
// Vite hot reload: if (import.meta.hot) import.meta.hot.dispose(disconnect);
```

In React, create this connection inside a `useEffect` and return `disconnect`
from the effect. Create only one connection per game instance. The mapping is
entirely the game team's choice. The three example reactions are event names,
not measured emotions. This package does not generate new rooms or models.

## 3. Sensor operator: send a test

Open a terminal in this package folder on the sensor laptop:

```sh
export SIGNAL_TOKEN='SAME_TOKEN_AS_PARTNER'
python3 send.py --target http://PARTNER_LAN_IP:48081 --event startle_flinch --value 0.7
```

Replace `PARTNER_LAN_IP` with the real IP. An `accepted: true` response confirms
receiver delivery. `subscribers: 1` means a browser has the stream open, not that
the game effect ran. Verify the event in the partner console and the visible
environment change in Quest. A count of 0 means connect the game client first.

## 4. Sensor operator: forward new Signal Scope markers

Keep the existing Signal Scope at `http://127.0.0.1:8767` running. No restart,
serial access, reflash, or new viewer is required:

```sh
python3 send.py --target http://PARTNER_LAN_IP:48081 --follow
```

Now use Signal Scope’s **Mark blink**, **Mark jaw clench**, or **Mark startle /
flinch** buttons during its existing recording. New markers are polled every
200 ms and sent once. Ctrl+C stops forwarding without stopping acquisition.
Custom labels become `reaction`. Startup skips old markers; markers older than
3 seconds and failed deliveries are dropped. Reconnection never replays a
backlog. There is deliberately no retry queue that could cause delayed scares.

## Event contract (v1)

```json
{
  "schema": "signal-scope.event.v1",
  "id": "unique-event-id",
  "event": "startle_flinch",
  "source": "manual_marker",
  "measurement": "operator_annotation",
  "emotion": null,
  "label": "Startle / flinch",
  "value": 1,
  "created_at_ms": 1792278000000,
  "sent_at_ms": 1792278000100
}
```

`event` is `blink`, `jaw_clench`, `startle_flinch`, or `reaction`. `source` is
`manual_marker` (Signal Scope) or `manual_test` (CLI). `value` is an operator-set
control amount from 0 to 1; it is NOT fear probability or measured arousal.
Markers default to 1. Times are Unix milliseconds; receiver adds
`received_at_ms` using its own clock. Do not subtract timestamps across laptops
to claim latency unless clocks are synchronized.

The receiver deduplicates IDs for 60 seconds; reconnecting browsers get only
future events. No history replay, heartbeat-derived game effects, or offline
delivery guarantee. A positive HTTP acknowledgement is not a headset render
acknowledgement. Keep manual game controls as a fallback.

The present ADC stream is unverified. This integration ships manual annotations,
not raw bytes, EEG classification, heartbeat, or fear detection. Automatic spike
events can be added later with their own source/quality contract after validating
the signal path; the v1 receiver intentionally rejects other sources.

## Troubleshooting and acceptance checklist

- Receiver unreachable: verify its terminal is running, actual LAN IP, port
  48081, same network, firewall and guest-network client isolation.
- HTTP 401: both terminals need the exact same token, at least 24 characters.
- HTTP 400: wrong event schema; use the included sender first.
- Accepted but no effect: check subscribers, browser console and game function
  mapping. Test `/signal-link/health` through the game origin, not only :48081.
- Desktop works but Quest fails: verify Quest uses the same working game origin
  and proxy; don't fetch `http://PARTNER_IP:48081` directly from an HTTPS page.
- Link drops: EventSource reconnects automatically. No old effects replay.
- Follow mode silent: create a NEW marker after starting it; old ones are skipped.

Run `npm test` to verify contract rejection, authenticated delivery, SSE,
duplicate handling and the real Python sender. Local tests cannot confirm venue
Wi-Fi, the partner's repository integration or headset rendering; validate those
with a visible test event before the demo.
