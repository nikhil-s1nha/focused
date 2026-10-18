// Live monitoring and the existing manual sender use separate state and controls.
import {liveView, connectionPayload, startPayload, triggerTime, forwardingMessage, remoteControlView, automaticCapabilityLabel} from './partner-live-state.js';
import {installScopeTabs} from './scope-tabs.js';

const senderApi = 'http://127.0.0.1:8769';
const footer = document.querySelector('.app-footer');
const live = document.createElement('section');
live.className = 'event-panel';
live.id = 'live-detection';
live.innerHTML = `
  <div class="event-top"><div><h2>Live detection</h2><p>More sensitive · <span id="live-threshold">0.28153449</span> · raw signal, unverified</p></div><span id="live-state" role="status">Connecting…</span></div>
  <div class="event-buttons" style="margin:16px 0">
    <button id="live-start" class="button primary" disabled>Start</button>
    <button id="live-stop" class="button secondary" disabled>Stop</button>
    <label><input id="live-save" type="checkbox"> Save recording</label>
    <label>Strength <input id="live-value" type="number" min="0" max="1" step="0.1" value="1" style="width:72px" aria-describedby="live-strength-note"></label>
    <span class="subtle">Event: reaction</span>
  </div>
  <p id="live-strength-note" class="subtle">Strength controls the game effect, not fear probability. Set it before Start.</p>
  <div class="metrics" aria-label="Live detector status" style="margin:12px 0">
    <div class="metric"><div class="metric-label">Acquisition</div><div id="live-acquisition" class="metric-value" style="font-size:20px">Off</div></div>
    <div class="metric"><div class="metric-label">Detector</div><div id="live-detector" class="metric-value" style="font-size:20px">Waiting</div><div id="live-cooldown" class="metric-detail"></div></div>
    <div class="metric"><div class="metric-label">Score / threshold</div><div id="live-score" class="metric-value" style="font-size:20px">— / 0.2815</div><div class="metric-detail">Normalized raw change</div></div>
    <div class="metric"><div class="metric-label">Last trigger</div><div id="live-last-trigger" class="metric-value" style="font-size:20px">—</div></div>
  </div>
  <p id="live-forwarding" class="setup-note" role="status">Checking automatic delivery capability…</p>
  <div style="display:flex;flex-wrap:wrap;gap:8px 20px"><span>Event ID: <code id="live-event-id" style="overflow-wrap:anywhere">—</code></span><span>Delivery: <strong id="live-delivery">—</strong></span></div>
  <p id="live-error" class="error-text" role="alert"></p>`;
footer.before(live);

const section = document.createElement('section');
section.className = 'event-panel';
section.id = 'partner-link';
section.innerHTML = `
  <div class="event-top"><div><h2>Partner link</h2><p>Manual markers and tests. In the game: open simple.html, enable sound, then Begin night watch. Wait 5 seconds between tests.</p></div><span id="partner-state" role="status">Connecting to sender…</span></div>
  <form id="partner-settings" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:16px 0">
    <label>Partner receiver URL<br><input id="partner-target" type="url" placeholder="http://GAME_LAPTOP_IP:48080" value="http://127.0.0.1:48080" required style="width:290px" autocomplete="off"></label>
    <label>Shared token (optional)<br><input id="partner-token" type="password" placeholder="Blank keeps the saved token" minlength="24" maxlength="512" autocomplete="off" aria-describedby="partner-auth-note"></label>
    <button class="button secondary" type="submit">Save connection</button>
  </form>
  <p id="partner-auth-note" class="subtle">Leaving the token blank keeps existing authentication.</p>
  <div class="event-buttons">
    <button id="partner-start" class="button primary" disabled>Forward new markers</button>
    <button id="partner-stop" class="button secondary" disabled>Stop forwarding</button>
    <label>Test value <input id="partner-value" type="number" min="0" max="1" step="0.1" value="1" style="width:72px"></label>
    <button data-partner-event="blink" class="event-button" disabled>Send test blink</button>
    <button data-partner-event="jaw_clench" class="event-button" disabled>Send test jaw clench</button>
    <button data-partner-event="startle_flinch" class="event-button" disabled>Send test startle</button>
  </div>
  <div class="event-top" style="margin-top:20px">
    <label><input id="remote-game-allow" type="checkbox" disabled> Allow game Start/Stop</label>
    <span id="remote-game-state" role="status">Checking game controls…</span>
  </div>
  <p id="remote-game-detail" class="subtle">The local Stop button remains available.</p>
  <p id="remote-game-last" class="subtle">Last game command: — · Acknowledgment: —</p>
  <p id="remote-game-error" class="error-text" role="alert"></p>
  <p id="partner-summary" class="setup-note">Waiting for local sender service.</p>
  <p id="partner-error" class="error-text" role="alert"></p>
  <div id="partner-history" class="event-log"></div>`;
footer.before(section);
const scopeTabs = installScopeTabs({liveControls:live,partnerControls:section});

const el = id => document.getElementById(id);
const label = value => value ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : '—';
let disposed = false;

async function request(base, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(base + path, {
      cache:'no-store', signal:controller.signal,
      ...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out. Checking the current state…');
    throw error;
  } finally { clearTimeout(timer); }
}

let liveState = null;
let liveAvailable = false;
let liveBusy = false;
let liveError = '';
let liveInputsInitialized = false;
let liveInputsEdited = false;
let liveRevision = 0;

function renderLive() {
  const view = liveView(liveState, {busy:liveBusy, available:liveAvailable, error:liveError});
  el('live-state').textContent = view.status;
  el('live-start').disabled = view.startDisabled;
  el('live-stop').disabled = view.stopDisabled;
  el('live-save').disabled = view.settingsDisabled || view.active;
  el('live-value').disabled = view.settingsDisabled || view.active;
  el('live-acquisition').textContent = label(view.acquisition);
  el('live-acquisition').dataset.state = view.acquisition;
  el('live-detector').textContent = label(view.detector);
  el('live-detector').dataset.state = view.detector;
  el('live-cooldown').textContent = view.cooldown == null || view.cooldown <= 0 ? '' : `${view.cooldown.toFixed(1)} s remaining`;
  el('live-threshold').textContent = view.threshold.toFixed(8);
  el('live-score').textContent = `${view.score == null ? '—' : view.score.toFixed(4)} / ${view.threshold.toFixed(4)}`;
  el('live-last-trigger').textContent = triggerTime(view.lastTrigger);
  el('live-forwarding').textContent = forwardingMessage(view, liveAvailable);
  el('live-event-id').textContent = view.latest?.id || view.latest?.event_id || '—';
  const delivery = view.latest?.status || view.latest?.result;
  el('live-delivery').textContent = delivery
    ? `${label(delivery)}${view.latest.http_status ? ` (HTTP ${view.latest.http_status})` : ''}${view.latest.reason ? ` · ${view.latest.reason}` : ''}`
    : '—';
  el('live-error').textContent = view.error;
  if (liveState && (!liveInputsInitialized || view.active) && !liveInputsEdited) {
    el('live-value').value = String(view.value);
    el('live-save').checked = view.recordToDisk;
    liveInputsInitialized = true;
  }
  syncRemoteTab();
}

function syncRemoteTab() {
  if (liveState && state?.remote_control) {
    scopeTabs?.observeRemote({active:liveState.active === true,owned:state.remote_control.owned === true});
  }
}

async function liveAction(path) {
  if (liveBusy) return;
  let payload;
  try { payload = path === '/start' ? startPayload(el('live-value').value, el('live-save').checked) : {}; }
  catch (error) { liveError = error.message; renderLive(); return; }
  liveRevision += 1;
  liveBusy = true; liveError = ''; renderLive();
  try {
    liveState = await request('', '/api/live-detection' + path, payload);
    liveAvailable = true;
    liveInputsEdited = false;
    // Read the authoritative state after a transition; never assume Start/Stop succeeded.
    liveState = await request('', '/api/live-detection');
  } catch (error) { liveError = error.message; }
  finally { liveBusy = false; renderLive(); }
}
el('live-start').onclick = () => liveAction('/start');
el('live-stop').onclick = () => liveAction('/stop');
for (const id of ['live-value','live-save']) el(id).addEventListener('input', () => { liveInputsEdited = true; });

async function pollLive() {
  if (disposed) return;
  const revision = liveRevision;
  try {
    if (!liveBusy) {
      const nextState = await request('', '/api/live-detection');
      if (revision === liveRevision && !liveBusy) {
        liveState = nextState;
        liveAvailable = true;
        renderLive();
      }
    }
  } catch (error) {
    if (revision === liveRevision && !liveBusy) {
      liveAvailable = false;
      // Preserve the last known active state so a failed poll never strands Stop.
      renderLive();
    }
  } finally { if (!disposed) setTimeout(pollLive, 500); }
}

let state = null;
let busy = false;
let error = '';
let targetInitialized = false;
let targetEdited = false;
let partnerRevision = 0;

function renderPartner() {
  el('partner-state').textContent = !state ? 'Sender unavailable' : !state.configured ? 'Not configured' : state.following ? 'Forwarding markers' : 'Forwarding paused';
  el('partner-start').disabled = busy || !state?.configured || state?.following;
  el('partner-stop').disabled = busy || !state?.following;
  for (const button of section.querySelectorAll('[data-partner-event]')) button.disabled = busy || !state?.configured;
  section.querySelector('[type=submit]').disabled = busy || !state;
  el('partner-error').textContent = error || state?.scope_error || state?.error || '';
  const remote = remoteControlView(state, {busy});
  el('remote-game-allow').checked = remote.enabled;
  el('remote-game-allow').disabled = remote.disabled;
  el('remote-game-state').textContent = remote.status;
  el('remote-game-detail').textContent = !remote.supported
    ? 'Remote control support is not available in the running sender. Local Start/Stop still works.'
    : `${remote.state ? `Connection: ${label(remote.state)}. ` : ''}${remote.owned ? 'This session was started by the game. ' : ''}Game Start monitors without saving. The local Stop button remains available.`;
  el('remote-game-last').textContent = `Last game command: ${remote.command ? label(remote.command) : '—'}${remote.commandId ? ` (${remote.commandId})` : ''} · Acknowledgment: ${remote.ack ? label(remote.ack) : '—'}${remote.ackId ? ` (${remote.ackId})` : ''}`;
  el('remote-game-error').textContent = remote.error;
  if (state) {
    if (!targetInitialized && !targetEdited && state.target) {
      el('partner-target').value = state.target;
      targetInitialized = true;
    }
    const health = state.remote?.ok ? `Receiver reachable · ${state.remote.subscribers ?? 0} game stream subscriber(s)` : 'Receiver not yet reachable';
    el('partner-summary').textContent = state.configured
      ? `${health} · ${automaticCapabilityLabel(state)} · Auth: ${state.authentication || 'unknown'} · ${state.sent} accepted · ${state.dropped} failed. Acceptance does not confirm a game effect.`
      : 'Enter his LAN URL. A blank token preserves existing authentication.';
  } else el('partner-summary').textContent = 'Waiting for the local sender on port 8769.';
  const log = el('partner-history');
  log.replaceChildren();
  for (const row of (state?.history || []).slice(0,6)) {
    const item = document.createElement('span');
    item.className = 'event-chip';
    item.textContent = `${new Date(row.at * 1000).toLocaleTimeString()} · ${row.event} · ${row.source} · ${row.status}${row.http_status ? ` (HTTP ${row.http_status})` : ''}${row.subscribers === 0 ? ' (no game listening)' : ''}`;
    item.title = row.id;
    log.append(item);
  }
  syncRemoteTab();
}

async function partnerAction(path, body) {
  if (busy) return;
  partnerRevision += 1;
  busy = true; error = ''; renderPartner();
  try {
    await request(senderApi, path, body);
    if (path === '/configure') el('partner-token').value = '';
    state = await request(senderApi, '/state');
  } catch (failure) { error = failure.message; }
  finally { busy = false; renderPartner(); }
}
el('partner-target').addEventListener('input', () => { targetEdited = true; });
el('partner-settings').addEventListener('submit', event => {
  event.preventDefault();
  partnerAction('/configure', connectionPayload(el('partner-target').value, el('partner-token').value));
});
el('partner-start').onclick = () => partnerAction('/follow', {enabled:true});
el('partner-stop').onclick = () => partnerAction('/follow', {enabled:false});
el('remote-game-allow').onchange = () => partnerAction('/remote-control', {enabled:el('remote-game-allow').checked});
for (const button of section.querySelectorAll('[data-partner-event]')) {
  button.onclick = () => partnerAction('/test', {event:button.dataset.partnerEvent, value:Number(el('partner-value').value)});
}
async function pollPartner() {
  if (disposed) return;
  const revision = partnerRevision;
  try {
    if (!busy) {
      const nextState = await request(senderApi, '/state');
      if (revision === partnerRevision && !busy) { state = nextState; renderPartner(); }
    }
  } catch { if (revision === partnerRevision && !busy) { state = null; renderPartner(); } }
  finally { if (!disposed) setTimeout(pollPartner, 1000); }
}
window.addEventListener('pagehide', () => { disposed = true; });
pollLive();
pollPartner();
