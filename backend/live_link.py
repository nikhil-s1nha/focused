"""Connect the live raw-step controller to the authenticated local sender.

No authentication secrets cross this adapter. A sender-scoped session is kept
in memory and never exposed in viewer state. Failed/stale events are not queued.
"""
from __future__ import annotations

import json
import threading
import uuid
import urllib.error
import urllib.request

from .live_detector import LiveDetectorController


def local_request(path, payload=None):
    request = urllib.request.Request('http://127.0.0.1:8769' + path,
        data=None if payload is None else json.dumps(payload, allow_nan=False).encode(),
        headers={} if payload is None else {'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=3) as response:
        return json.load(response)


class LiveModeService:
    def __init__(self, bench_log, recorder, *, request=local_request, controller_factory=LiveDetectorController):
        self.request = request
        self.lock = threading.RLock()
        self.command_lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.epoch = 0
        self.requested = False
        self.session = None
        self.sender_generation = None
        self.owner_id = None
        self.used_owner_ids = set()
        self.latest_event = None
        self.forwarding = {'allowed': False, 'reason': 'Start live detection to enable automatic forwarding.'}
        self.controller = controller_factory(bench_log, recorder, on_event=self.on_event)
        self.stop_worker = threading.Event()
        self.worker = None
        self.restart_required = False

    def state(self):
        result = self.controller.state()
        with self.lock:
            return {**result, 'forwarding': dict(self.forwarding),
                    'owner_id': self.owner_id,
                    'latest_event': dict(self.latest_event) if self.latest_event else None}

    def start(self, *, nonhuman_surface_only=False, record_to_disk=False, value=1, owner_id=None):
        if owner_id is not None:
            try:
                valid = isinstance(owner_id, str) and str(uuid.UUID(owner_id)) == owner_id and uuid.UUID(owner_id).version == 4
            except (ValueError, AttributeError):
                valid = False
            if not valid:
                raise ValueError('Invalid acquisition owner')
        with self.command_lock:
            if owner_id is not None and owner_id in self.used_owner_ids:
                raise ValueError('This acquisition command has already been used')
            if owner_id is not None:
                if len(self.used_owner_ids) >= 8192:
                    raise ValueError('Acquisition command limit reached')
                self.used_owner_ids.add(owner_id)
            return self._start(nonhuman_surface_only=nonhuman_surface_only,
                               record_to_disk=record_to_disk, value=value, owner_id=owner_id)

    def _start(self, *, nonhuman_surface_only=False, record_to_disk=False, value=1, owner_id=None):
        # Recorder ownership and explicit source context are checked by controller.
        self.controller.start(nonhuman_surface_only=nonhuman_surface_only,
                                       record_to_disk=record_to_disk, control_value=value)
        with self.lock:
            self.epoch += 1
            self.requested = True
            self.owner_id = owner_id
            self.session = None
            self.sender_generation = None
            self.latest_event = None
            self.restart_required = False
            self.forwarding = {'allowed': False, 'reason': 'Checking automatic-event protocol…'}
        self.refresh()
        return self.state()

    def stop(self, *, owner_id=None):
        with self.command_lock:
            if owner_id is not None and owner_id != self.owner_id:
                # Remember cancellation even if a delayed Start has not arrived.
                # The unrelated current acquisition is never stopped.
                try:
                    if (isinstance(owner_id, str) and str(uuid.UUID(owner_id)) == owner_id
                            and uuid.UUID(owner_id).version == 4 and len(self.used_owner_ids) < 8192):
                        self.used_owner_ids.add(owner_id)
                        return {**self.state(), 'owner_cancelled': True, 'cancelled_owner_id': owner_id}
                except (ValueError, AttributeError):
                    pass
                raise ValueError('Stop does not own the current acquisition')
            result = self._stop()
            if owner_id is not None:
                result.update(owner_cancelled=True, cancelled_owner_id=owner_id)
            return result

    def _stop(self):
        # Invalidate locally before any blocking request. An already transmitted
        # event cannot be recalled, but no queued or subsequent event is sent.
        with self.lock:
            self.epoch += 1
            self.requested = False
            self.session = None
            self.sender_generation = None
            self.forwarding = {'allowed': False, 'reason': 'Stopped.'}
        self.controller.stop()
        try:
            self.request('/automatic/stop', {})
        except (OSError, ValueError):
            pass
        return self.state()

    def configure(self, *, value=1):
        if self.controller.state().get('active'):
            raise ValueError('Stop live detection before changing effect strength.')
        self.controller.configure(control_value=value)
        return self.state()

    def refresh(self):
        # The worker and Start may request a refresh together. Only one can
        # establish the sender session; events are never queued behind it.
        if not self.refresh_lock.acquire(blocking=False):
            return
        try:
            self._refresh()
        finally:
            self.refresh_lock.release()

    def _refresh(self):
        state = self.controller.state()
        with self.lock:
            epoch = self.epoch
            requested = self.requested and not self.restart_required and state.get('active') is True
            existing_session = self.session
        if not requested:
            return
        try:
            transport = self.request('/state')
            automatic = transport.get('automatic')
            if not isinstance(automatic, dict):
                reason = 'Sender update required; the existing manual link is still available.'
            elif not transport.get('configured'):
                reason = 'Enter the receiver URL and shared token in Partner link.'
            elif existing_session and automatic.get('active') and automatic.get('generation') == self.sender_generation:
                return
            elif existing_session:
                with self.lock:
                    if epoch == self.epoch:
                        self.restart_required = True
                        self.session = None
                        self.sender_generation = None
                        self.forwarding = {'allowed': False, 'reason': 'Automatic link interrupted. Stop and Start to resume sending.'}
                return
            elif not automatic.get('capable'):
                reason = 'Receiver has not advertised the v2 threshold-event protocol.'
            else:
                # The user must first Start this mode; capability appearing while
                # stopped never activates it, and past spikes are never replayed.
                detector = state.get('detector', {})
                with self.lock:
                    if epoch != self.epoch or not self.requested:
                        return
                    # Serialize the bounded handshake with Stop so a late
                    # response cannot activate an orphan sender session.
                    response = self.request('/automatic/start', {
                        'preset': detector.get('preset', state.get('preset', 'pooled-more-sensitive-v1')),
                        'threshold': detector.get('threshold', .28153449356783367),
                        'rearm_threshold': detector.get('rearm_threshold', .22522759485426695),
                        'value': state.get('value', 1), 'cooldown_ms': 5000})
                    session = response.get('session'); generation = response.get('generation')
                    if not isinstance(session, str) or not session or type(generation) is not int:
                        raise ValueError('Invalid local sender session')
                    self.session = session; self.sender_generation = generation
                    self.forwarding = {'allowed': True, 'reason': 'Ready for new threshold events.'}
                return
            with self.lock:
                if epoch == self.epoch:
                    self.session = None; self.sender_generation = None
                    self.forwarding = {'allowed': False, 'reason': reason}
        except (OSError, ValueError, TypeError):
            with self.lock:
                if epoch == self.epoch:
                    if self.session:
                        self.restart_required = True
                    self.session = None; self.sender_generation = None
                    self.forwarding = {'allowed': False, 'reason': 'Sender unavailable or protocol not ready; events are dropped.'}

    def on_event(self, event):
        current = self.controller.state()
        with self.lock:
            if (not self.requested or not self.session or not current.get('active')
                    or event.get('generation') != current.get('generation')
                    or event.get('session_id') != current.get('session_id')):
                return {'status': 'not_sent', 'reason': self.forwarding['reason']}
            epoch = self.epoch
            payload = {'session': self.session, 'generation': self.sender_generation,
                       'id': event['id'], 'created_at_ms': event['created_at_ms'],
                       'detector': {'preset': event.get('preset', 'pooled-more-sensitive-v1'),
                                    'threshold': event['threshold'], 'rearm_threshold': event['rearm_threshold'],
                                    'score': event['score'], 'quality': 'unverified',
                                    'valid_measurement': False, 'reaction_validated': False}}
            # This single request is bounded; no retry queue exists. Stop shares
            # the lock so its acknowledgement cannot precede an unsent request.
            try:
                response = self.request('/threshold', payload)
                row = {k: response[k] for k in ('id', 'status', 'http_status', 'reason', 'subscribers') if k in response}
                row.setdefault('id', event['id'])
                row.setdefault('status', 'failed')
            except (OSError, ValueError, TypeError):
                row = {'id': event['id'], 'status': 'failed', 'reason': 'Delivery failed; dropped without replay.'}
            if self.epoch == epoch:
                self.latest_event = row
            return row

    def run(self):
        while not self.stop_worker.wait(1):
            try:
                self.refresh()
            except Exception:
                # Keep health polling separate from the acquisition controller.
                with self.lock:
                    self.forwarding = {'allowed': False, 'reason': 'Automatic link unavailable.'}
                    self.session = None

    def start_worker(self):
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def close(self):
        self.stop_worker.set()
        if self.requested:
            self.stop()
        if hasattr(self.controller, 'close'):
            self.controller.close()
        if self.worker:
            self.worker.join(timeout=2)
