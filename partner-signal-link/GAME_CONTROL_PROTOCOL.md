# Game Start/Stop → Signal Scope acquisition — proposed control link

The game owns the round Start and Stop buttons. Signal Scope owns acquisition, the selected detector and outgoing v2 threshold events. No game command selects a body-connected mode, changes hardware settings, injects excitation, or saves raw recordings. This controller always starts the existing nonhuman surface bench mode with `record_to_disk: false` and effect `value: 1`.

## Partner receiver capability

On the existing partner origin (port 48080), `GET /signal-link/health` must include both the automatic-event capability from `THRESHOLD_PROTOCOL.md` and:

```json
{"capabilities":{"acquisition_control":{"schema":"signal-scope.control.v1","transport":"sse","stream":"/signal-link/control/events","ack":"/signal-link/control/ack","actions":["start","stop"]}}}
```

Signal Scope must be explicitly enabled locally for remote control. It connects outward to the partner; no LAN listener is added on the acquisition laptop. The existing shared bearer token authenticates the stream and acknowledgments. Tokens stay in memory and never appear in UI state or logs.

## Control stream

`GET /signal-link/control/events`, with `Authorization: Bearer <shared token>`, returns `text/event-stream`. Send an SSE comment heartbeat at least every five seconds. Do not replay old commands on connection or accept `Last-Event-ID` for replay. A new connection begins idle and requires a newly clicked Start with a new round ID.

Each SSE message contains exactly these fields:

```text
data: {"schema":"signal-scope.control.v1","id":"8070c1cd-c9d7-47c1-8195-6aa935f0db1e","action":"start","round_id":"043cfcf9-9ac9-4b1e-8baa-127c18d9cc5c","created_at_ms":1792285200000}

```

`id` and `round_id` are canonical lowercase UUIDv4 strings. Generate a new command ID for every button action; reuse the round ID only for its matching Stop. `created_at_ms` is integer Unix milliseconds, no more than 3,000 ms old and never in the future. Both computers' clocks need to agree. `action` is only `start` or `stop`. Unknown/extra fields, stale commands and duplicates are not executed.

Start is refused if another local acquisition is active or a prior remote acquisition is still stopping. A Stop only stops the acquisition owned by that matching round; it never stops an unrelated local run or another round. A Stop received before its matching Start closes that round, preventing a delayed Start. Once a round is stopped or its control connection drops, a new Start requires a new round ID.

## Acknowledgments

Signal Scope posts to `/signal-link/control/ack` using the shared bearer token:

```json
{"schema":"signal-scope.control-ack.v1","id":"8070c1cd-c9d7-47c1-8195-6aa935f0db1e","round_id":"043cfcf9-9ac9-4b1e-8baa-127c18d9cc5c","action":"start","status":"running","received_at_ms":1792285200020}
```

`id`, `round_id`, and `action` identify the original command. Status is one of `starting`, `running`, `stopping`, `stopped`, `rejected`, or `failed`; an optional fixed, nonsecret `reason` explains the result. Display ACKs as the actual state rather than optimistically showing acquisition running when Start is clicked. A starting ACK means the command is being applied. A running ACK is sent only after local acquisition reports `receiving: true` and detector forwarding reports `allowed: true`; it does not certify signal validity or fear recognition. Acknowledgments are best effort, bounded and not replayed.

## Ordering and interruption

Only one local start/stop operation executes at a time. A Stop or connection loss immediately invalidates any pending Start. If the Start HTTP request is already in flight, it cannot be recalled; Signal Scope stops the resulting owned run as soon as that request returns. The stream has no acquisition-command queue. Disconnect/timeout disables the desired run and stops a remote-owned acquisition. Reconnection does not restart it or replay old commands.

The local Start includes an internal `owner_id` equal to its command ID; Stop includes that same ID and the viewer enforces it. The controller also checks the local acquisition's session/run ownership before Stop. A timed-out Start is cancelled by owner ID; the viewer explicitly confirms cancellation and prevents that same delayed Start from activating later. If cancellation cannot be confirmed, Signal Scope watches for the owned run for twelve seconds and reports a failure requiring local Stop rather than claiming it stopped. Failed Stop requests retain ownership and retry with backoff capped at ten seconds. If another local session replaced it, remote Stop is rejected rather than stopping the other session. Stream reads time out after twelve seconds without incoming bytes; the partner's five-second comment heartbeat keeps the link alive. Local requests and ACK requests must have bounded timeouts supplied by the integration. Stop applies local cancellation before sending remote acknowledgments. Losing fresh frames or forwarding changes the local state to degraded; if readiness does not return within fifteen seconds, the owned acquisition stops. Initial startup has a forty-five-second readiness limit.

## Integration status

This is a protocol proposal and local implementation. The partner must add the authenticated stream, button messages, ACK handler and exact capability to their game server. Updating Signal Scope source alone cannot add those partner endpoints. Keep remote control disabled until that handshake is available.

## Verified live handoff

The configured receiver advertised this capability. A fresh game Start reached Signal Scope, selected Live, started frame receipt and automatic threshold forwarding. Two v2 reaction events were accepted by the receiver. The matching game Stop stopped forwarding and acquisition; the acquisition service confirmed restoration and returned a stopped acknowledgment. The connection-cleanup update was loaded between runs. Visible game rendering still requires the partner’s confirmation.
