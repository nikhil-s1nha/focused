# Signal Scope automatic threshold events — v2 proposal

This extends the existing manual event link. The partner must install/support this contract and advertise it before Signal Scope enables automatic sending. Editing this reference receiver does not update the partner's game. This is an experimental raw-change trigger, not a fear classification or validated EEG measurement.

## Existing manual events remain v1

`signal-scope.event.v1` remains unchanged: `manual_marker` or `manual_test`, `measurement: "operator_annotation"`, `emotion: null`, and the existing four event names. Start/Stop automatic mode does not change manual forwarding. Receiver timestamps must be non-negative integer Unix milliseconds; fractional timestamps are rejected. No credentials are forwarded to browser clients.

## Required receiver health capability

`GET /signal-link/health` must return `ok: true` (or `enabled: true`) and this exact supported capability. Additional health fields are allowed. Missing, false, or mismatched fields keep automatic mode unavailable.

```json
{
  "ok": true,
  "capabilities": {
    "automatic_threshold_events": {
      "schema": "signal-scope.event.v2",
      "source": "threshold_detector",
      "measurement": "threshold_crossing",
      "event": "reaction",
      "emotion": null,
      "quality": "unverified",
      "detector_version": 1
    }
  }
}
```

The sender preserves only sanitized counts, timestamps, and a capability boolean in its public state. It never exposes the receiver authentication token or arbitrary returned health data.

## Event delivered to the partner

The existing authenticated `POST /signal-link/event` route and SSE `/signal-link/events` stream carry this new envelope:

```json
{
  "schema": "signal-scope.event.v2",
  "id": "460595d4-7075-4183-bb05-023d3e2794d3",
  "event": "reaction",
  "label": "Reaction",
  "value": 1.0,
  "source": "threshold_detector",
  "measurement": "threshold_crossing",
  "emotion": null,
  "created_at_ms": 1792285200000,
  "sent_at_ms": 1792285200050,
  "detector": {
    "preset": "pooled-more-sensitive-v1",
    "threshold": 0.28153449356783367,
    "rearm_threshold": 0.22522759485426695,
    "score": 0.35,
    "quality": "unverified",
    "valid_measurement": false,
    "reaction_validated": false
  }
}
```

`value` is a game control value in `[0,1]`, initially `1.0`; it is not confidence, probability, or a physiological quantity. `score` and thresholds are normalized raw-change scores, not volts. The event ID is a fresh canonical lowercase UUIDv4. `detector` has exactly the seven shown fields. A crossing requires `score > threshold`, with `0 <= rearm_threshold < threshold`. Timestamp order is `created_at_ms <= sent_at_ms`, with at most 2,000 ms between them. The source detector applies hysteresis/rearm; the sender separately enforces cooldown. Neither can infer emotion from this event.

The reference receiver allows only this schema/meaning and strips unrelated top-level data. It adds `received_at_ms`, returns HTTP 202 on first acceptance and HTTP 200 with `duplicate: true` for the same ID within 60 seconds. Duplicate IDs are not dispatched twice. The receiver's SSE has no replay queue. Sender retries and replay are disabled.

## Local sender API (loopback port 8769)

`POST /configure` with `{target, token}` keeps the existing LAN target validation. Omitting `token`, or using `null`, preserves the existing in-memory token; explicit `""` clears it for a receiver that permits unauthenticated manual messages. A process restart loses its in-memory connection/token and requires re-entry. Configure stops automatic and manual forwarding.

`POST /automatic/start`:

```json
{"preset":"pooled-more-sensitive-v1","threshold":0.28153449356783367,"rearm_threshold":0.22522759485426695,"value":1.0,"cooldown_ms":5000}
```

Automatic mode requires a configured authentication token. The sender performs a fresh health check and returns `{automatic, session, generation}`. `session` is a local controller UUID, not the partner authentication token. Keep it in the controller's memory. `generation` increases on every start, stop, suspension, or connection change. `/state` exposes automatic status, settings, capability, generation, in-flight status and skipped count, but not the session UUID.

`POST /threshold` contains `{session, generation, id, created_at_ms, detector}`. Its detector preset and thresholds must exactly match the active session. The sender fills the event envelope, timestamps, configured value, and current auth token. It rejects malformed provenance, skips inactive/stale sessions, stale/future events, duplicate IDs, cooldown events, concurrent dispatch, and unavailable/stale receiver health. Health must be at most ten seconds old; normal health checks run every three seconds. Health loss invalidates the session and requires an explicit new Start. Skips return `{status:"skipped",reason}`; they are never queued. Failed transmissions are never retried. A session is capped at 4,096 submitted IDs.

`POST /automatic/stop` and `/automatic/suspend` (empty JSON object) invalidate the session immediately. Stop wins against a pending start health check. A request already committed to network dispatch cannot be recalled; subsequent events are skipped. Network requests are bounded by a two-second timeout and do not follow redirects or ambient proxies. The transport never opens serial or changes acquisition firmware/settings.

## Rollout status

The configured partner receiver has advertised the exact v2 capability and one game stream client. Our sender was updated and authenticated configuration restored in memory between captures. The subsequent game Start command began live acquisition, and the receiver accepted an automatic v2 reaction event. Signal Scope displayed both live waveforms. Visible in-game effects still require the partner to confirm. Remote acquisition controls use the separate GAME_CONTROL_PROTOCOL.md handshake.


This contract and the local reference implementation must be agreed with the partner before automatic events are enabled. The already-running sender is not hot patched by editing its source. A controlled sender restart and token re-entry are required; do not restart it during an ongoing capture or assume source edits are deployed. Manual v1 test messages can be used to verify the original link separately from automatic v2 acceptance.
