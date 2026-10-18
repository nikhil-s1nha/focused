// Pure view model: acquisition authority stays on the server, never in a button label.
export const SENSITIVE_THRESHOLD = 0.28153449;

const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value : '';

export function liveView(state, {busy = false, available = true, error = ''} = {}) {
  const s = state || {};
  const acquisition = s.acquisition || {};
  const detector = s.detector || {};
  const forwarding = s.forwarding || {};
  const phase = text(s.phase || s.stage);
  const stopping = s.stopping === true || phase === 'stopping' || acquisition.state === 'stopping';
  const starting = s.starting === true || phase === 'starting' || acquisition.state === 'starting';
  const active = s.active === true || s.running === true;
  const receiving = text(acquisition.state || s.acquisition_state) || (active ? 'waiting' : 'off');
  const detectorState = text(detector.state || s.detector_state) || 'waiting';
  const latest = s.latest_event || s.last_delivery || detector.latest_event || null;
  const blockedReason = text(forwarding.reason || s.protocol_block_reason || s.forwarding_block_reason);
  return {
    active, stopping, starting,
    startDisabled: busy || !available || !state || s.enabled === false || active || stopping || starting,
    stopDisabled: busy || (!active && !stopping && !starting),
    settingsDisabled: busy || stopping || starting,
    status: !available ? 'Service unavailable' : stopping ? 'Stopping…' : starting ? 'Starting…' : active ? 'Live detection on' : 'Live detection off',
    acquisition: receiving,
    detector: detectorState,
    score: numberOrNull(detector.score ?? s.score),
    threshold: numberOrNull(detector.threshold ?? s.threshold) ?? SENSITIVE_THRESHOLD,
    lastTrigger: detector.last_trigger_at_ms ?? s.last_trigger_at_ms ?? detector.last_trigger_at ?? s.last_trigger_at ?? null,
    cooldown: numberOrNull(detector.cooldown_remaining ?? s.cooldown_remaining),
    value: numberOrNull(s.value ?? s.control_value) ?? 1,
    recordToDisk: s.record_to_disk === true,
    latest,
    forwardingAllowed: forwarding.allowed === true || s.forwarding_allowed === true,
    blockedReason,
    error: error || text(s.error),
  };
}

export function connectionPayload(target, token) {
  const payload = {target: target.trim()};
  // A blank form never destroys the sender's in-memory credential.
  if (token.trim()) payload.token = token.trim();
  return payload;
}

export function startPayload(value, recordToDisk) {
  const strength = Number(value);
  if (value === '' || value == null || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Strength must be between 0 and 1.');
  return {nonhuman_surface_only: true, record_to_disk: recordToDisk === true, value: strength};
}

export function triggerTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toLocaleTimeString();
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toLocaleTimeString();
  return '—';
}

export function forwardingMessage(view, available = true) {
  if (!available) return 'Live detection service unavailable.';
  if (view.stopping) return 'Stopping automatic sending…';
  if (!view.active && !view.starting) return 'Live detection stopped. No automatic events sent.';
  if (view.forwardingAllowed) return 'Automatic events enabled. Acceptance does not confirm a visible game effect.';
  const reason = (view.blockedReason || 'waiting for receiver protocol capability').trim().replace(/[.!?]+$/, '');
  return `Automatic sending blocked: ${reason}. Local monitoring can still run.`;
}

export function remoteControlView(sender, {busy = false} = {}) {
  const remote = sender?.remote_control;
  const supported = remote != null && typeof remote === 'object';
  const enabled = remote?.enabled === true;
  const connected = remote?.connected === true;
  const command = remote?.last_command;
  const ack = remote?.last_ack;
  return {
    supported, enabled, connected,
    disabled: busy || !sender?.configured || !supported,
    status: !supported ? 'Game controls unavailable' : !enabled ? 'Game controls off' : connected ? 'Game controls connected' : 'Waiting for game controls',
    state: text(remote?.state || remote?.status),
    owned: remote?.owned === true,
    command: typeof command === 'string' ? command : text(command?.action || command?.command || command?.type),
    commandId: text(command?.id),
    ack: typeof ack === 'string' ? ack : text(ack?.status || ack?.result),
    ackId: text(ack?.id || ack?.command_id),
    error: text(remote?.error || (remote?.status === 'failed' ? remote?.reason : '')),
  };
}

export function automaticCapabilityLabel(sender) {
  if (sender?.automatic?.capable === true || sender?.remote?.automatic_threshold_events === true) return 'Automatic events: ready';
  return sender?.remote?.ok ? 'Automatic events: receiver capability missing' : 'Automatic events: waiting for receiver';
}
