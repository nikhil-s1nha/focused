> Historical manual-v1 handoff. For current automatic v2 events and remote Start/Stop, use [THRESHOLD_PROTOCOL.md](THRESHOLD_PROTOCOL.md) and [GAME_CONTROL_PROTOCOL.md](GAME_CONTROL_PROTOCOL.md). Venue addresses below are placeholders.

# Nikhil's game: exact connection handoff

Updated October 17, 2026, from the game agent's inspected handoff and the
sensor-side network findings. This document specializes the generic package
instructions for the current game implementation.

## Current connection

| Item | Value |
| --- | --- |
| Game repository / directory | `focused`, branch `vr-scene-expansion`, `haunted-room/` |
| Game stack | Custom Node ESM HTTP server, Three.js/WebXR, Node >=20.19 |
| Partner address | `GAME_LAPTOP_IP` |
| Sensor laptop address | `SENSOR_LAPTOP_IP` |
| Observed sensor-to-partner route | Directly over `en0` |
| Target entered in Signal Scope | `http://GAME_LAPTOP_IP:48080` |
| Actual event POST endpoint | `http://GAME_LAPTOP_IP:48080/signal-link/event` |
| Browser subscription | `/signal-link/events` on the game origin |
| Local sender service | `127.0.0.1:8769` |

The receiver is already mounted in the game server. **Use port 48080. Do not
start the package's standalone 48081 receiver or add a Vite proxy.** The game
server and browser stream must use the same receiver instance.

The host is reachable from the sensor laptop on the observed network, but
reachability is not authenticated event delivery. These addresses are outside
RFC1918 private ranges; the sender permits only the explicitly agreed partner
host using `--allow-host`. A direct route does not establish that every device
on the network is trusted. Use the agreed trusted network and recheck addresses
when changing networks; no public deployment or router port forwarding is
needed.

## Start both sides

On the game laptop, from the repository:

```sh
cd haunted-room
HOST=0.0.0.0 PORT=48080 npm run start:signal
```

The game agent reports that this generates or reuses `.env.signal-link`, unless
`SIGNAL_TOKEN` is already set. That file is gitignored and must not be included
in a shared archive. The shared token must be at least 24 characters.

On the sensor laptop, from the Signal Scope project root:

```sh
python3 -m backend.partner_sender --port 8769 --allow-host GAME_LAPTOP_IP
```

Open existing **Signal Scope** at `http://127.0.0.1:8767`. In **Partner link**:

1. Set the target to `http://GAME_LAPTOP_IP:48080`.
2. Obtain the token privately from the partner and paste it into this panel.
   Do not paste it into chat, a report, a screenshot, or source control.
3. Save the connection.

Token entry is complete on our side; the authenticated test blink was accepted by the partner receiver. It remains only in sender memory
and must be entered again after restarting that service. Starting the sender
does not start acquisition, reset hardware, or enable body sensing. Manual
tests work with acquisition stopped.

## Prepare the game before sending a test

On the game laptop, open:

```text
http://127.0.0.1:48080/simple.html
```

**Enable sound and click Begin night watch.** Expand the Signal Scope/operator
link panel so both operators can compare event IDs and counters. Manual proxy
can remain selected: marker SSE does not require the continuous Live stream.

Do not use `?test=1` for this verification. That independent preview stays in
the **ready** phase; the adapter can receive a marker but skip applying it.
Spectator pages also skip effects. Random preview effects are not proof that
our event arrived.

## Test and interpret the result

Send a **Blink** test with value `0.7` from the Partner link panel. Match the
event ID between sender and game; check that **received** and **applied** both
increase, then confirm the lamp flickers. Test other events individually,
waiting at least five seconds between effects to avoid cooldowns.

| Manual event | Current `simple.html` effect | Limitation |
| --- | --- | --- |
| `blink` | Fluorescent stutter | Value changes duration; current depth is fixed. |
| `jaw_clench` | Right-side breath cue | Sound must be enabled; current cue strength is fixed. |
| `startle_flinch` | Left-door feint, then close | Value changes opening and duration. |
| `reaction` | Brief light reduction, then restore | Value changes reduction and duration. |

The game has an 800 ms global cooldown and per-event cooldowns up to 4.5 seconds.
Inactive, spectator, cooldown, or audio-disabled events are skipped, not queued.
An accepted event can therefore produce no effect for a documented reason.

After a manual test succeeds, click **Forward new markers** in Signal Scope
and add a new marker during a recording. Existing markers are skipped. New
markers older than three seconds or failed deliveries are dropped rather than
replayed. Stop forwarding independently from stopping acquisition. Use only
one marker-forwarding process.

## Exact message scope

This connection currently sends only `manual_test` and `manual_marker` events,
with `emotion: null`. It sends no raw EEG, heartbeat measurements, inferred
fear, or automatic physiological classifications. A control value between 0
and 1 is an operator-set amount, not a probability or diagnosis.

The receiver accepts the `signal-scope.event.v1` fields described in README,
without extra fields. Both `created_at_ms` and `sent_at_ms` must be
**nonnegative integer Unix milliseconds**; fractional milliseconds are
rejected. A new event produces HTTP 202; a duplicate produces HTTP 200 with
`duplicate: true` and no repeat broadcast.

The separate `/api/signal` continuous-control pipeline and its separate
`PUBLISH_TOKEN` are out of scope for this manual-marker handoff. Do not route
unverified sensor values there or relabel them as manual annotations.

## Completion checklist

- [ ] Token entered in the existing Signal Scope panel.
- [ ] Manual test accepted by the partner receiver.
- [ ] Matching event ID received and applied by the running game.
- [ ] Intended visual or audio effect confirmed on the partner desktop.
- [ ] New Signal Scope marker follows the same path.
- [ ] Stop forwarding prevents subsequent markers from being sent.
- [ ] Quest effect confirmed when the headset becomes available.

The game agent reports the headset is currently unavailable. Its previous
connection used `adb reverse tcp:48080 tcp:48080` and
`http://localhost:48080/simple.html?quest=1`. That localhost address works on
Quest only while the USB forwarding is established. Desktop success does not
prove headset rendering; record those checks separately.

## Cross-laptop delivery verified

On October 17, 2026, our sender sent manual_test blink value 0.7. The partner receiver accepted event 9eddfac8-342c-4c85-b44c-8937db91cee4 and reported one connected client. The health endpoint returned the same last-event ID. This verifies authenticated cross-laptop delivery. Game applied-counter and visible effect confirmation remain pending. No token is included in this document.
