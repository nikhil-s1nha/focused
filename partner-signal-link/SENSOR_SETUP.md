# Sensor laptop setup: Signal Scope ↔ partner game

For Nikhil's current game, use [NIKHIL_HANDOFF.md](NIKHIL_HANDOFF.md): the
receiver is mounted inside the game server at **GAME_LAPTOP_IP:48080**. Do not
start a second receiver on 48081 or add a proxy for this setup.


## Current live detector and remote controls

The more-sensitive preset uses raw-change threshold **0.28153449356783367**, rearm at 80% of that threshold after 250 ms below it, and a five-second cooldown. Automatic events use `signal-scope.event.v2`; see [THRESHOLD_PROTOCOL.md](THRESHOLD_PROTOCOL.md). V1 manual tests remain available.

For game-owned Start/Stop, the partner must implement [GAME_CONTROL_PROTOCOL.md](GAME_CONTROL_PROTOCOL.md). Signal Scope now has **Record** and **Live** tabs sharing one waveform display. A game-owned Start switches to Live once; manually selecting Record does not force it back on every refresh. In Live, enable **Allow game Start/Stop** once the sender is configured. It opens an authenticated control stream to the existing game server; no acquisition-laptop LAN port is exposed. A fresh game Start begins the existing object-bench acquisition and detector. Game Stop stops its owned acquisition and automatic events. The local **Live detection → Stop** remains a backup. A dropped control stream stops the owned run; reconnecting never restarts it.

The game should display **starting** until an acknowledgment confirms **running**, which requires fresh frames and available automatic forwarding. Hardware startup is asynchronous. Remote mode starts without saving an archive and uses game control value 1.0. A local run can opt into **Save recording** before Start. Existing saved recordings remain intact.

The currently implemented source is unverified object-bench data. These controls do not enable body acquisition or establish EEG validity. Do not treat a raw threshold crossing as confirmed fear.

## Manual link instructions

Use the existing **Signal Scope** at `http://127.0.0.1:8767`. Its **Partner link**
panel configures a small local sending service. It does not create another
graph or open the Uno's serial port.

```text
Signal Scope markers :8767
          ↓ read-only polling
Local sender service :8769
          ↓ authenticated HTTP POST over LAN
Partner receiver → existing game server → Quest browser
```

## What to obtain from your partner

- The receiver's reachable base URL: currently `http://GAME_LAPTOP_IP:48080` for
  Nikhil's game. Enter the base URL, without `/signal-link/event`.
- The shared `SIGNAL_TOKEN`, at least 24 characters, shared privately.
- Confirmation that the receiver is running and its game adapter is connected.

Use the **partner laptop's LAN address**, not the Pi address, a public address,
or `127.0.0.1`. Both laptops must be on a network that allows traffic between
devices. Venue guest Wi-Fi may prevent this; use a shared private network if
needed. HTTP on this demo link is not encrypted, so use a trusted network.

## Start our side

1. Open Signal Scope. Acquisition can remain stopped: the sender and manual
   tests work without an active recording or connected sensor.
2. From the project root, start the local sender in another terminal:

   ```sh
   python3 -m backend.partner_sender --port 8769 --allow-host GAME_LAPTOP_IP
   ```

3. Open Signal Scope's **Partner link** panel at `http://127.0.0.1:8767`.
4. Enter the partner receiver URL and shared token, then save the connection.
5. Choose a test event—**Blink**, **Jaw clench**, or **Startle / flinch**—and a
   control value between 0 and 1. Send one test.

The value controls the strength passed to the game adapter. It is not a fear
probability, heart rate, or measured emotional intensity. Test messages use
`source: manual_test` and `emotion: null`.

Credentials remain in the sender service's memory. They are not written to a
configuration file or persisted in browser storage. Restarting the sender
requires entering the connection details again. Do not commit or screenshot the
token. The local sender is a localhost API service, not a separate UI.

The current address is outside RFC1918 private ranges. The explicit
`--allow-host GAME_LAPTOP_IP` allows only this agreed destination; it does not open
the sender to arbitrary public targets. Our observed route to this host is
directly over `en0`, from `SENSOR_LAPTOP_IP`. Recheck addresses after a network
change. Paste the token into Signal Scope's existing Partner link panel, not
into chat. A fresh sender process needs those settings before delivery can work.

## Forward markers

Once a test reaches your partner, use **Forward new markers** in the Partner link
panel. Then create new reaction markers during a Signal Scope recording.
The sender reads new manual bench markers from Signal Scope and forwards them
as `source: manual_marker`, `measurement: operator_annotation`, `emotion: null`.
Event timestamps are nonnegative integer Unix milliseconds, as required by
the partner's receiver.

Supported events are `blink`, `jaw_clench`, `startle_flinch`, and `reaction`.
Other custom marker labels map to `reaction`. The receiver and game decide
which existing effects to apply. See [README.md](README.md) for the complete
message contract and partner-side setup.

Starting forwarding skips existing markers. Old or failed deliveries are not
queued for later replay; reconnecting must not produce a burst of delayed game
effects. If a test fails, resolve the connection and send a **new** test.

**Stop forwarding** stops sending markers; it does not stop Signal Scope's
recording, unplug the hardware, or change the firmware. Likewise, a running
sender does not start a recording. Keep those two controls separate.

Do not also run `send.py --follow` for the same recording: use one forwarding
process so the partner does not receive duplicate annotations.

## Verify the complete path together

1. Send a manual test and note its event ID.
2. Confirm that the receiver accepted that ID.
3. Confirm the game adapter received it and called its mapped action.
4. Have your partner confirm the visible effect inside Quest.
5. Start forwarding, create one **new** marker, and repeat the same check.
6. Stop forwarding and verify that later markers no longer reach the partner.

These checks prove different things:

| Result | What it establishes |
| --- | --- |
| Local sender is running | Our service can accept UI requests. |
| Receiver accepted an event | The message reached the partner receiver. |
| Receiver reports a subscriber | A client has an open event stream. |
| Game reports action applied | The game handler ran for that event. |
| Partner sees the effect in Quest | The headset rendered the intended change. |

A local test or HTTP acknowledgement alone does not prove the last step.

## If it does not work

- **Local service unavailable:** check the terminal running port 8769. Re-enter
  the URL and token after restarting it.
- **Partner unreachable:** check the partner's current LAN IP, receiver port,
  receiver process, firewall, and Wi-Fi device isolation.
- **Unauthorized:** confirm both sides use the same token without extra spaces.
- **Accepted but no effect:** inspect the game subscriber and event mapping;
  the partner should check `/signal-link/health` through the game origin.
- **Forwarding but no events:** start a recording if needed and add a new marker
  after forwarding starts. Existing markers are intentionally skipped.
- **Desktop works, Quest does not:** the partner should preserve its working
  Quest connection and proxy the stream through the game's existing origin.
  Quest should not directly fetch an insecure remote HTTP stream from an HTTPS
  page.

## Scope of this integration

The sender never opens serial itself. In remote-control mode it delegates Start/Stop to the existing acquisition service; manual mode sends explicit test events and annotations. The current raw sensor
stream is unverified; this integration does not classify spikes as fear,
distinguish emotions, or claim to measure EEG or heartbeat from those bytes.
The partner can implement and test environmental reactions now without waiting
for the sensor path to be validated.
