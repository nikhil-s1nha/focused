# Signal Scope ingress

The package ZIP was unavailable. This equivalent zero-dependency Node receiver preserves `signal-scope.event.v1` and is mounted **once inside the existing game server**. There is no separate 48081 service. Existing HTTP/HTTPS, HOST/PORT, WebSocket `/signals`, `/api/signal`, and spectator relay behavior remain intact.

## Start and connect

Use Node >=20.19. Keep the game's existing startup settings and Quest connection. Set `SIGNAL_TOKEN` privately in the game server environment to a random token of at least 24 characters, then run `npm start` with the same existing HOST/PORT/TLS variables. `.env.example` contains placeholders only; Node does not auto-load it. To generate without printing the secret: `export SIGNAL_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"`. Share its value privately with the sensor operator; never put it in a URL, browser, commit, screenshot, or logs.

- Sender URL: `http(s)://GAME_LAPTOP_LAN_IP:EXISTING_GAME_PORT/signal-link/event`.
- Browser SSE URL: relative `/signal-link/events` through the existing game origin, including its Quest USB forwarding or TLS.
- Health: `/signal-link/health` reports configuration, connected subscribers, accepted/duplicate/rejected counts, and last accepted event ID/name/time. It does not expose the token.

If the current game binds only to 127.0.0.1, sensor-laptop LAN ingress is not reachable yet. Arrange the existing server's approved LAN bind while preserving Quest forwarding/TLS; do not start another receiver, expose public ports, or change the Quest browser to an insecure remote event endpoint. On macOS, find LAN IPv4 with `ipconfig getifaddr en0` (Wi-Fi interface may differ). Both laptops must use reachable LAN addresses on a network without client isolation. A token rejection is HTTP401; disabled configuration is503; wrong content type415; malformed event400; oversized body413.

On the sensor laptop set `SIGNAL_TOKEN` privately and `SIGNAL_URL` to the sender URL, then run:

```sh
python3 signal-link/send.py --event blink --value 0.7
```

The sender uses only Python standard library, creates UUIDs/timestamps, and sends one manual event. It does not acquire sensors or poll Signal Scope; marker-follow mode from the absent package is not implemented here. Keep acquisition unchanged. Sender success means receiver acceptance, not that the headset rendered an action. Match the printed event ID against the game status panel, then visually confirm the effect.

## Contract and failure behavior

Supported events: `blink`, `jaw_clench`, `startle_flinch`, `reaction`. Required fields are `schema`, `id`, `event`, `source`, `measurement`, `emotion`, `label`, `value`, `created_at_ms`, `sent_at_ms`; unknown fields are rejected. Sources are `manual_test` or `manual_marker`; measurement accepts `manual_test` or `operator_annotation`; emotion must be null. Value is a finite control amount 0–1. Times are nonnegative integer Unix milliseconds. IDs are 1–128 characters; labels 1–160; control characters are rejected. The server adds `received_at_ms`. These are manual controls/annotations, **not an EEG/fear classifier or verified physiological measurements**. Cross-laptop timestamps do not establish latency without synchronized clocks.

POST requires a Bearer token and application/json, with a maximum 8192-byte body. Valid events return202 and their ID/receive time; duplicate IDs return200 with `duplicate:true` and do not broadcast. A bounded 2048-ID dedup set stores IDs, not a replay backlog. Browser-side dedup remains required. SSE sends ordinary `data:` messages, immediate headers and a connection comment, a15-second heartbeat, no IDs/replay, and disconnects stalled consumers. Reconnection cannot replay old events. No effect runs merely because a stream connects/disconnects.

To disable ingress, unset SIGNAL_TOKEN and restart with existing startup configuration: health remains available and POST returns503. Existing manual game controls and legacy signal flow continue.

## Files / validation

- `signal-link/receiver.mjs`: validation, authenticated ingress, same-origin live SSE, health.
- `server.mjs`: mount and `createSceneServer({signalToken})` injection; returned `signalLink.close()` closes SSE subscribers during shutdown/tests. Call that before waiting for `server.close()` when streams are open.
- `signal-link/send.py`: private-env manual sender.
- `test/signal-link-receiver.test.mjs`: contract, real HTTP auth/size/errors, same-origin health/game, SSE and duplicate/reconnect coverage.
- `.env.example`: configuration placeholders.

Run `node --test test/signal-link-receiver.test.mjs test/relay.test.mjs test/spectate-relay.test.mjs`. Backend testing initially hit environment sandbox `listen EPERM` before opening temporary loopback ports; this is a test-environment limitation, not a successful integration test. Pure contract validation passed. Parent task records subsequent actual test results and browser mapping checks. Cross-laptop delivery and physical Quest rendering remain pending until those devices are available.
