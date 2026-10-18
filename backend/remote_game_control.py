"""Authenticated game control orchestration; no serial/firmware or body-mode API.

One reader accepts fresh commands; one worker serializes bounded local requests.
Commands update desired state, never a replay queue. All I/O is injectable.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.request
import uuid

CONTROL_CAPABILITY = {
    "schema": "signal-scope.control.v1", "transport": "sse",
    "stream": "/signal-link/control/events", "ack": "/signal-link/control/ack",
    "actions": ["start", "stop"],
}
START_PAYLOAD = {"nonhuman_surface_only": True, "record_to_disk": False, "value": 1}


def capability_supported(value):
    return isinstance(value, dict) and all(k in value and type(value[k]) is type(v) and value[k] == v
                                           for k, v in CONTROL_CAPABILITY.items())


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value and uuid.UUID(value).version == 4
    except (ValueError, AttributeError):
        return False


def validate_command(value, now_ms):
    if not isinstance(value, dict) or set(value) != {"schema", "id", "action", "round_id", "created_at_ms"}:
        raise ValueError("Invalid control fields")
    if (value["schema"] != "signal-scope.control.v1" or not valid_uuid(value["id"])
            or not valid_uuid(value["round_id"]) or value["action"] not in ("start", "stop")
            or type(value["created_at_ms"]) is not int or not 0 <= value["created_at_ms"] <= 9007199254740991):
        raise ValueError("Invalid control command")
    if not 0 <= now_ms - value["created_at_ms"] <= 3000:
        raise ValueError("Stale or future command")
    return dict(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def open_control_stream(url, token):
    request = urllib.request.Request(url, headers={"Accept": "text/event-stream", "Authorization": "Bearer " + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    response = opener.open(request, timeout=12)
    if response.status != 200 or response.headers.get_content_type() != "text/event-stream":
        response.close()
        raise ValueError("Expected authenticated SSE stream")
    return response


def sse_messages(lines):
    """Bounded SSE data parser. Heartbeats/comments do not create commands."""
    data, size = [], 0
    for raw in lines:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="strict")
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > 4096:
            raise ValueError("Control event too large")
        line = raw.rstrip("\r\n")
        if not line:
            if data:
                yield json.loads("\n".join(data))
            data, size = [], 0
        elif line.startswith("data:"):
            field = line[5:]
            if field.startswith(" "):
                field = field[1:]
            size += len(field.encode("utf-8"))
            if size > 4096:
                raise ValueError("Control event too large")
            data.append(field)
    # An incomplete final SSE message is not a command.


class RemoteGameControl:
    def __init__(self, config_provider, local_request, remote_request, stream_factory=open_control_stream,
                 *, clock=time.time, monotonic=time.monotonic, background=True, startup_timeout=45, cleanup_window=12, degradation_timeout=15):
        self.config_provider = config_provider
        self.local_request = local_request
        self.remote_request = remote_request
        self.stream_factory = stream_factory
        self.clock, self.monotonic = clock, monotonic
        self.background, self.startup_timeout = background, startup_timeout
        self.cleanup_window, self.degradation_timeout = cleanup_window, degradation_timeout
        self.lock = threading.RLock()
        self.operation_lock = threading.Lock()
        self.wake, self.closed = threading.Event(), threading.Event()
        self.enabled = self.connected = self.capable = False
        self.generation = 0
        self.desired = None
        self.owned = None
        self.pending_owner = None
        self.command = None
        self.stop_command = None
        self.phase = "disabled"
        self.reason = "Remote game control is disabled"
        self.seen, self.closed_rounds = set(), set()
        self.connection_config = None
        self.stream = None
        self.reader = self.worker = None
        self.starting = False
        self.last_ack = None
        self.last_command_packet = None
        self.last_heartbeat = None

    def state(self):
        with self.lock:
            last_command = dict(self.last_command_packet) if self.last_command_packet else None
            return {"enabled": self.enabled, "connected": self.connected, "capable": self.capable,
                    "status": self.phase, "reason": self.reason, "generation": self.generation,
                    "round_id": self.desired or (self.owned["round_id"] if self.owned else None),
                    "owned": bool(self.owned), "starting": self.starting, "cleanup_pending": bool(self.pending_owner),
                    "last_ack": dict(self.last_ack) if self.last_ack else None,
                    "last_heartbeat": self.last_heartbeat, "last_command": last_command}

    def _config(self):
        try:
            config = self.config_provider()
            capability = config.get("capabilities", {}).get("acquisition_control")
            if (not isinstance(config.get("target"), str) or not config["target"]
                    or not isinstance(config.get("token"), str) or not config["token"]
                    or not capability_supported(capability)):
                return None
            return {"target": config["target"].rstrip("/"), "token": config["token"]}
        except (OSError, TypeError, ValueError, AttributeError):
            return None

    def enable(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("enabled must be boolean")
        with self.lock:
            if self.closed.is_set():
                raise ValueError("Controller is closed")
            self.enabled = enabled
            if enabled:
                self.phase = "waiting_for_partner" if not self.owned else self.phase
                self.reason = "Waiting for a fresh game Start"
            if enabled and self.background and self.reader is None:
                self.reader = threading.Thread(target=self.run, daemon=True, name="game-control-stream")
                self.worker = threading.Thread(target=self._work, daemon=True, name="game-control-operations")
                self.reader.start(); self.worker.start()
        if not enabled:
            self.disconnect("Remote control disabled")
        self.wake.set()
        return self.state()

    def disconnect(self, reason="Control stream disconnected"):
        with self.lock:
            self.generation += 1
            if self.desired:
                self.closed_rounds.add(self.desired)
            self.desired = None
            self.connected = False
            self.connection_config = None
            self.reason = reason
            self.phase = "stopping" if self.owned or self.starting or self.pending_owner else ("waiting_for_partner" if self.enabled else "disabled")
            stream, self.stream = self.stream, None
        if stream is not None:
            def close_stream():
                try: stream.close()
                except (OSError, ValueError): pass
            # urllib's close can wait for a reader holding its buffer lock. The
            # acquisition worker must not wait for the twelve-second read timeout.
            if threading.current_thread() is self.reader:
                close_stream()
            else:
                threading.Thread(target=close_stream, daemon=True,
                                 name="game-control-stream-close").start()
        self.wake.set()

    def _connection_ready(self, config, stream=None):
        if config is None or self._config() != config:
            return False
        with self.lock:
            if not self.enabled or self.closed.is_set():
                return False
            self.connection_config = dict(config)
            self.stream = stream
            self.connected = self.capable = True
            self.last_heartbeat = self.monotonic()
            if not self.owned and not self.starting and not self.pending_owner:
                self.phase = "idle"
                self.reason = "Waiting for a fresh game Start"
            return True

    def _ack(self, command, status, reason=None):
        if command is None:
            return
        packet = command["packet"]
        ack = {"schema": "signal-scope.control-ack.v1", "id": packet["id"], "round_id": packet["round_id"],
               "action": packet["action"], "status": status, "received_at_ms": command["received_at_ms"]}
        if reason:
            ack["reason"] = reason
        with self.lock:
            self.last_ack = dict(ack)
        try:
            config = command["config"]
            self.remote_request(config["target"] + CONTROL_CAPABILITY["ack"], ack, config["token"])
        except (OSError, ValueError, TypeError):
            pass  # No ACK replay queue; acquisition cleanup does not depend on ACK delivery.

    def accept(self, value):
        """Called only for new SSE messages; updates desired state without local I/O."""
        now = int(self.clock() * 1000)
        try:
            packet = validate_command(value, now)
        except (TypeError, ValueError):
            return {"accepted": False, "reason": "invalid_or_stale_command"}
        rejection = None
        with self.lock:
            if not self.enabled or not self.connected or not self.connection_config:
                return {"accepted": False, "reason": "control_disconnected"}
            if packet["id"] in self.seen:
                return {"accepted": False, "reason": "duplicate"}
            if len(self.seen) >= 8192:
                return {"accepted": False, "reason": "command_limit"}
            self.seen.add(packet["id"])
            self.last_command_packet = {key: packet[key] for key in ("id", "round_id", "action", "created_at_ms")}
            command = {"packet": packet, "received_at_ms": now, "config": dict(self.connection_config)}
            round_id = packet["round_id"]
            if packet["action"] == "start":
                if round_id in self.closed_rounds:
                    rejection = "round_already_closed"
                elif self.desired or self.owned or self.starting or self.pending_owner:
                    rejection = "acquisition_busy"
                else:
                    self.generation += 1
                    self.desired, self.command, self.stop_command = round_id, command, None
                    self.phase, self.reason = "starting", "Applying game Start"
            else:
                self.closed_rounds.add(round_id)
                current_round = self.desired or (self.owned["round_id"] if self.owned else None)
                if current_round and current_round != round_id:
                    rejection = "different_round"
                else:
                    self.generation += 1
                    self.desired, self.stop_command = None, command
                    self.phase, self.reason = "stopping", "Applying game Stop"
        if rejection:
            self._ack(command, "rejected", rejection)
            return {"accepted": False, "reason": rejection}
        self.wake.set()
        return {"accepted": True}

    @staticmethod
    def _identity(state):
        if not isinstance(state, dict):
            raise ValueError("Invalid local state")
        session, run = state.get("session_id"), state.get("run_id")
        return (session, run) if isinstance(session, str) and session and isinstance(run, str) and run else None

    def _local_state(self):
        state = self.local_request("/api/live-detection")
        if not isinstance(state, dict) or type(state.get("active")) is not bool:
            raise ValueError("Invalid local state")
        return state

    def tick(self):
        """At most one serialized local operation/supervision step; never starts on reconnect."""
        config = self._config()
        with self.lock:
            self.capable = config is not None
            changed = self.connected and config != self.connection_config
            timed_out = self.connected and self.last_heartbeat is not None and self.monotonic() - self.last_heartbeat > 12
        if changed or timed_out:
            self.disconnect("Control heartbeat timeout" if timed_out else "Partner configuration or capability changed")
        if not self.operation_lock.acquire(blocking=False):
            return
        try:
            with self.lock:
                desired, owned, command, stop = self.desired, self.owned, self.command, self.stop_command
                pending = self.pending_owner
                generation = self.generation
            if pending:
                self._resolve_pending_start(pending)
            elif owned and desired != owned["round_id"]:
                self._stop_owned(owned, stop or owned["command"])
            elif owned:
                self._supervise(owned)
            elif desired and command:
                self._start_owned(command, generation)
            elif stop:
                self._ack(stop, "stopped", "no_remote_owned_acquisition")
                with self.lock:
                    if self.stop_command is stop:
                        self.stop_command = None
                        self.phase = "idle" if self.connected else ("waiting_for_partner" if self.enabled else "disabled")
                        self.reason = "Stopped"
        finally:
            self.operation_lock.release()

    def _start_owned(self, command, generation):
        packet = command["packet"]
        try:
            before = self._local_state()
            if before["active"] or before.get("stopping"):
                raise ValueError("local_acquisition_busy")
        except (OSError, ValueError, TypeError):
            self._finish_failed_start(command, generation, "local_acquisition_busy_or_unavailable")
            return
        with self.lock:
            if generation != self.generation or self.desired != packet["round_id"] or not self.connected:
                return
            self.starting = True
        self._ack(command, "starting")
        # Stop may have arrived during the bounded ACK request.
        with self.lock:
            cancelled = generation != self.generation or not self.desired or not self.connected
            if cancelled:
                self.starting = False
                return
        try:
            result = self.local_request("/api/live-detection/start", dict(START_PAYLOAD, owner_id=packet["id"]))
            identity = self._identity(result)
            if not identity or result.get("active") is not True or result.get("owner_id") != packet["id"]:
                raise ValueError("Start outcome unknown")
            owned = {"round_id": packet["round_id"], "identity": identity, "command": command,
                     "started_at": self.monotonic(), "running_ack": False, "stop_attempts": 0}
            with self.lock:
                self.owned = owned
                self.starting = False
                cancelled = generation != self.generation or self.desired != packet["round_id"] or not self.connected
            if cancelled:
                self._stop_owned(owned, self.stop_command or command)
            else:
                self._supervise(owned, result)
        except (OSError, ValueError, TypeError):
            # A lost Start reply does not establish failure. The viewer may still
            # be starting this owner; observe it for a bounded cleanup window.
            pending = {"command": command, "deadline": self.monotonic() + self.cleanup_window,
                       "next_check": self.monotonic()}
            with self.lock:
                self.starting = False
                self.desired = None
                self.closed_rounds.add(packet["round_id"])
                self.pending_owner = pending
                self.phase, self.reason = "cleanup_pending", "Checking outcome of timed-out Start"
            self._resolve_pending_start(pending)

    def _resolve_pending_start(self, pending):
        now = self.monotonic()
        if now < pending["next_check"]:
            return
        command = pending["command"]
        packet = command["packet"]
        pending["next_check"] = now + .5
        # An owner-tagged Stop also tombstones that owner in the viewer, so a
        # delayed Start request cannot later activate it. Never stop by round only.
        try:
            cancel = self.local_request("/api/live-detection/stop", {"owner_id": packet["id"]})
            if isinstance(cancel, dict) and cancel.get("owner_cancelled") is True and cancel.get("cancelled_owner_id") == packet["id"]:
                pending["cancel_confirmed"] = True
                # Explicit cancellation tombstones a not-yet-arrived Start. It is
                # safe to finish without touching another current local owner.
                if (cancel.get("owner_id") != packet["id"] or
                        (cancel.get("active") is False and cancel.get("stopping") is not True)):
                    with self.lock:
                        if self.pending_owner is not pending:
                            return
                        stop = self.stop_command or command
                        self.pending_owner = None
                        self.stop_command = None
                        self.phase = "idle" if self.connected else ("waiting_for_partner" if self.enabled else "disabled")
                        self.reason = "Timed-out Start cancelled"
                    self._ack(command, "failed", "start_cancelled_after_timeout")
                    self._ack(stop, "stopped", "owner_cancelled")
                    return
        except (OSError, ValueError, TypeError):
            pass
        try:
            state = self._local_state()
            identity = self._identity(state)
            if state.get("owner_id") == packet["id"] and identity:
                owned = {"round_id": packet["round_id"], "identity": identity, "command": command,
                         "started_at": now, "running_ack": False, "stop_attempts": 0,
                         "pending_failure": "start_timed_out_stopping_owned_run"}
                with self.lock:
                    if self.pending_owner is not pending:
                        return
                    self.pending_owner = None
                    self.owned = owned
                    self.desired = None
                self._stop_owned(owned, self.stop_command or command)
                return
        except (OSError, ValueError, TypeError):
            pass
        if now >= pending["deadline"]:
            with self.lock:
                if self.pending_owner is pending:
                    self.pending_owner = None
                    # Never ACK stopped: the remote Start outcome was not established.
                    self.stop_command = None
                    self.phase, self.reason = "failed", "start_outcome_unknown_use_local_stop"
            self._ack(command, "failed", "start_outcome_unknown_use_local_stop")

    def _finish_failed_start(self, command, generation, reason):
        with self.lock:
            self.closed_rounds.add(command["packet"]["round_id"])
            if generation == self.generation:
                self.desired = None
                self.phase, self.reason = "failed", reason
        self._ack(command, "failed", reason)

    def _supervise(self, owned, state=None):
        try:
            state = state if state is not None else self._local_state()
            if self._identity(state) != owned["identity"] or state.get("owner_id") != owned["command"]["packet"]["id"]:
                with self.lock:
                    if self.owned is owned:
                        self.closed_rounds.add(owned["round_id"])
                        self.owned = self.desired = None
                        self.phase, self.reason = "failed", "local_session_replaced"
                self._ack(owned["command"], "failed", "local_session_replaced")
                return
            if not state.get("active"):
                self.disconnect("Local live mode stopped")
                return
            ready = state.get("acquisition", {}).get("receiving") is True and state.get("forwarding", {}).get("allowed") is True
            if ready:
                with self.lock:
                    if self.desired != owned["round_id"] or self.owned is not owned:
                        return
                    first_ready = not owned["running_ack"]
                    owned["running_ack"] = True
                    owned.pop("unready_since", None)
                    self.phase, self.reason = "running", "Receiving frames and forwarding threshold events"
                if first_ready:
                    self._ack(owned["command"], "running")
            else:
                now = self.monotonic()
                if owned["running_ack"]:
                    owned.setdefault("unready_since", now)
                    with self.lock:
                        self.phase, self.reason = "degraded", "Waiting for fresh frames and automatic forwarding"
                    expired = now - owned["unready_since"] > self.degradation_timeout
                    failure = "readiness_lost"
                else:
                    expired = now - owned["started_at"] > self.startup_timeout
                    failure = "startup_timeout"
                if expired:
                    self.disconnect("Acquisition readiness timeout")
                    owned["pending_failure"] = failure
                    self._stop_owned(owned, owned["command"])

        except (OSError, ValueError, TypeError, AttributeError):
            self.disconnect("Local acquisition state unavailable")

    def _stop_owned(self, owned, command):
        if self.monotonic() < owned.get("next_stop_check", 0):
            return
        try:
            state = self._local_state()
            if self._identity(state) != owned["identity"] or state.get("owner_id") != owned["command"]["packet"]["id"]:
                self._ack(command, "rejected", "local_session_replaced")
                with self.lock:
                    if self.owned is owned:
                        self.owned = None
                        self.stop_command = None
                        self.phase, self.reason = "failed", "local_session_replaced"
                return
            if state["active"]:
                state = self.local_request("/api/live-detection/stop", {"owner_id": owned["command"]["packet"]["id"]})
                if not isinstance(state, dict):
                    raise ValueError("Invalid stop response")
            # Acquisition cancellation precedes any bounded remote ACK request.
            if owned.get("pending_failure"):
                self._ack(owned["command"], "failed", owned.pop("pending_failure"))
            if not owned.get("stop_announced"):
                owned["stop_announced"] = True
                self._ack(command, "stopping")
            if state.get("active") is True or state.get("stopping") is True:
                with self.lock:
                    self.phase, self.reason = "stopping", "Waiting for owned acquisition to finish"
                return
            with self.lock:
                if self.owned is owned:
                    self.owned = None
                    self.stop_command = None
                    self.phase = "idle" if self.connected else ("waiting_for_partner" if self.enabled else "disabled")
                    self.reason = "Stopped"
            self._ack(command, "stopped")
        except (OSError, ValueError, TypeError):
            owned["stop_attempts"] = owned.get("stop_attempts", 0) + 1
            owned["next_stop_check"] = self.monotonic() + min(10.0, .5 * 2 ** min(owned["stop_attempts"] - 1, 5))
            with self.lock:
                self.phase, self.reason = "failed", "stop_not_confirmed"
            if not owned.get("stop_failed_ack"):
                owned["stop_failed_ack"] = True
                self._ack(command, "failed", "stop_not_confirmed")
            # Retain ownership and recheck with capped backoff. A failed HTTP reply
            # can still have stopped the run; confirmation never permanently ceases.

    def _work(self):
        while not self.closed.is_set():
            self.wake.wait(.25); self.wake.clear()
            try:
                self.tick()
            except Exception:
                self.disconnect("Control worker unavailable")

    def run(self):
        """Authenticated SSE-reader loop; connection changes never create a Start."""
        while not self.closed.is_set():
            with self.lock: enabled = self.enabled
            config = self._config() if enabled else None
            if config is None:
                self.closed.wait(.5)
                continue
            try:
                with self.stream_factory(config["target"] + CONTROL_CAPABILITY["stream"], config["token"]) as stream:
                    if not self._connection_ready(config, stream):
                        continue
                    def lines():
                        source = iter(lambda: stream.readline(4097), b"") if hasattr(stream, "readline") else iter(stream)
                        for line in source:
                            with self.lock:
                                if not self.enabled or self.connection_config != config:
                                    return
                                self.last_heartbeat = self.monotonic()
                            yield line
                    for message in sse_messages(lines()):
                        self.accept(message)
            except (OSError, ValueError, TypeError, UnicodeError):
                pass
            finally:
                self.disconnect("Control stream disconnected")
            self.closed.wait(1)

    def close(self):
        if self.closed.is_set():
            return
        self.enable(False)
        self.tick()
        self.closed.set(); self.wake.set()
        for thread in (self.reader, self.worker):
            if thread and thread is not threading.current_thread():
                thread.join(timeout=1)
