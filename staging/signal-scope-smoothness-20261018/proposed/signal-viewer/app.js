import {initBenchPanel, isBenchView, setBenchView, benchConnection} from '/bench-panel.js?v=object-recorder-1';
const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'connection-dot','connection-label','source-banner','source-title','source-description',
  'demo-pulse','elapsed','live-indicator','channel-select','window-select','scale-select','pause-button',
  'filtered-canvas','raw-canvas','filtered-range','raw-range','plot-overlay','demo-watermark',
  'sample-info','display-state','rms-value','reaction-value','reaction-detail','rate-value',
  'rate-detail','baseline-value','baseline-progress','quality-detail','record-button',
  'record-label','export-button','record-state','event-log','clear-event-log','source-dialog','source-select',
  'serial-fields','demo-note','port-select','bench-confirm','source-error','source-apply','toast'
].map((id) => [id, $(id)]));

let state = null;
let summary = {};
let samples = [];
let markers = [];
let channel = 1;
let windowSeconds = 10;
let scale = 'auto';
let paused = false;
let pauseSamples = [];
let pauseMarkers = [];
let pauseEnd = 0;
let lastPacket = 0;
let streamConnected = false;
let sourceKey = null;
let sessionKey = null;
let sessionStart = null;
let totalSamples = 0;
let lastDraw = 0;
let dirty = true;
let toastTimer;
let markersRevision = -1;
let recording = {active:false,samples:0,markers:0};
const markerKeys = new Set();
const canvases = [elements['filtered-canvas'], elements['raw-canvas']];
const num = (x, digits=1) => Number.isFinite(Number(x)) && x !== null && x !== undefined ? Number(x).toFixed(digits) : '—';
const isDemo = () => !state || state.source === 'synthetic' || state.mode === 'demo';
const currentMetrics = () => summary.channels?.[channel] || summary;

function toast(text) {
  clearTimeout(toastTimer);
  elements.toast.textContent = text;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

function clearView() {
  samples = [];
  markers = [];
  markerKeys.clear();
  markersRevision = -1;
  sessionStart = null;
  totalSamples = 0;
  if (paused) togglePause();
  renderEventLog();
  dirty = true;
}

function ingestState(next) {
  if (!next) return;
  const nextKey = next.source || state?.source;
  const nextSession = next.session_id ?? next.generation ?? null;
  if (typeof nextSession === 'number' && typeof sessionKey === 'number' && nextSession < sessionKey) return;
  if ((sourceKey && nextKey !== sourceKey) ||
      (sessionKey !== null && nextSession !== null && sessionKey !== nextSession)) clearView();
  sourceKey = nextKey;
  if (nextSession !== null) sessionKey = nextSession;
  state = {...state, ...next};
  if (next.summary) summary = next.summary;
  if (next.recording) recording = next.recording;
  const revision = Number(next.markers_revision);
  if (Array.isArray(next.marker_history) && Number.isFinite(revision) && revision >= markersRevision) {
    if (revision !== markersRevision) {
      markers = [];
      markerKeys.clear();
      ingestMarkers(next.marker_history);
      const survivingIds = new Set(markers.map(m => m.id));
      pauseMarkers = pauseMarkers.filter(m => survivingIds.has(m.id));
      renderEventLog();
      dirty = true;
    }
    markersRevision = revision;
  } else if (Array.isArray(next.markers) && (!Number.isFinite(revision) || revision >= markersRevision)) {
    ingestMarkers(next.markers);
    if (Number.isFinite(revision)) markersRevision = revision;
  }
  updateStatus();
}

function ingestMarkers(incoming) {
  let changed = false;
  for (const marker of incoming) {
    const timestamp = Number(marker.timestamp ?? marker.t);
    if (!Number.isFinite(timestamp)) continue;
    const label = String(marker.label || 'Event').slice(0, 80);
    const key = marker.id || timestamp + ':' + label;
    if (markerKeys.has(key)) continue;
    markerKeys.add(key);
    markers.push({...marker,timestamp,label});
    changed = true;
  }
  if (markers.length > 500) {
    markers = markers.slice(-500);
    markerKeys.clear();
    for (const m of markers) markerKeys.add(m.id || m.timestamp + ':' + m.label);
  }
  if (changed) {
    renderEventLog();
    dirty = true;
  }
}

function ingestBatch(packet) {
  ingestState(packet);
  lastPacket = performance.now();
  for (const sample of packet.samples || []) {
    const timestamp = Number(sample.timestamp ?? sample.t);
    if (!Number.isFinite(timestamp)) continue;
    if (samples.length && timestamp <= samples[samples.length - 1].timestamp) continue;
    samples.push({...sample,timestamp});
    totalSamples++;
    if (sessionStart === null) sessionStart = timestamp;
  }
  const latest = samples.at(-1)?.timestamp;
  if (latest !== undefined) {
    const cutoff = latest - 120;
    let first = 0;
    while (first < samples.length && samples[first].timestamp < cutoff) first++;
    if (first) samples.splice(0, first);
    if (samples.length > 50000) samples.splice(0, samples.length - 50000);
  }
  dirty = true;
  updateMetrics();
}

function updateStatus() {
  if (isBenchView()) {
    const capture=benchConnection();
    elements['connection-dot'].className='dot '+(capture.online?'online':'offline');
    elements['connection-label'].textContent=capture.label;
    return;
  }
  const fresh = lastPacket > 0 && performance.now() - lastPacket < 2500;
  const receiving = streamConnected && fresh && state?.status === 'running';
  elements['connection-dot'].className = 'dot ' + (receiving ? 'online' : 'offline');
  elements['connection-label'].textContent = receiving ? 'Receiving ' + (isDemo() ? 'demo' : 'bench data') : streamConnected ? (state?.status === 'error' ? 'Source error' : 'Waiting for samples') : 'Reconnecting';
  elements['source-banner'].className = 'source-banner ' + (isDemo() ? 'demo' : 'bench') + (state?.status==='error'?' source-error':'');
  elements['source-banner'].querySelector('.banner-icon').textContent = isDemo() ? 'D' : 'B';
  elements['source-title'].textContent = isDemo() ? 'DEMO · Generated waveform — no EEG sensor connected' : 'BENCH · ' + (state?.source === 'internal_test' ? 'Internal test generator' : 'Internally shorted ADC inputs');
  elements['source-description'].textContent = isDemo() ?
    'Simulated electrical activity for testing this viewer. These are not measurements from your body.' :
    'Real sensor electronics, not human EEG. Electrodes must stay disconnected. ' + (state?.message || '');
  if(!isDemo() && state?.status==='error'){
    elements['source-title'].textContent='BENCH · Sensor connection error — no live EEG';
    const idLine=[...(state.diagnostics||[])].reverse().find(d=>String(d.line||'').startsWith('DEVICE_ID,'));
    const id=idLine?.line.split(',')[1];
    elements['source-description'].textContent=id ?
      'Initialization failed: chip ID '+id+' (expected 0x73). No valid samples received. Check sensor power and jumper wiring with USB unplugged.' :
      'No valid sensor stream. '+(state.message||'Check the selected source and USB connection.');
  }
  elements['demo-watermark'].hidden = !isDemo();
  elements['demo-pulse'].hidden = !isDemo();
  elements['demo-pulse'].disabled = !streamConnected || state?.status !== 'running';
  elements['record-button'].classList.toggle('recording', !!recording.active);
  elements['record-button'].disabled = !recording.active && !receiving;
  elements['record-button'].title = !recording.active && !receiving ?
    'Recording requires a connected source that is receiving samples.' : '';
  elements['record-label'].textContent = recording.active ? 'Stop recording' : 'Start recording';
  elements['export-button'].disabled = !(Number(recording.samples) > 0);
  elements['record-state'].textContent = recording.active ?
    Number(recording.samples || 0).toLocaleString() + ' samples recorded' :
    Number(recording.samples) > 0 ? 'Saved locally · ' + Number(recording.samples).toLocaleString() + ' samples' : 'Recording off';
  if (recording.truncated) elements['record-state'].textContent += ' · recording limit reached';
  elements['clear-event-log'].disabled = !markers.length && !(Number(recording.markers) > 0);
  const hasData = samples.length > 0;
  elements['plot-overlay'].hidden = hasData && receiving;
  if (!hasData || !receiving) {
    elements['plot-overlay'].textContent = hasData ? 'Signal stopped · showing last received samples' : (state?.status === 'error' ? 'No valid sensor samples · check the connection error above' : 'Waiting for samples…');
  }
  elements['live-indicator'].style.background = receiving && !paused ? 'var(--green)' : 'var(--amber)';
  updateMetrics();
}

function updateMetrics() {
  const m = currentMetrics() || {};
  const stale = !streamConnected || !lastPacket || performance.now() - lastPacket > 2500 || state?.status !== 'running';
  const valid = !stale && m.calibrated === true && Number(m.signal_quality) > 0 && !(m.quality_reasons || []).length;
  elements['rms-value'].textContent = stale ? '—' : num(m.rms_uv, 2);
  elements['reaction-value'].textContent = valid ? num(m.intensity, 2) : '—';
  elements['reaction-detail'].textContent = stale ? 'No fresh signal' : !m.calibrated ? 'Available after baseline' : !valid ? 'Unavailable · quality gate' : isDemo() ? 'Synthetic score · not fear' : 'Bench score · not human reaction';
  const rate = m.observed_read_rate_hz ?? summary.observed_read_rate_hz ?? (isDemo() ? state?.sample_rate : null);
  elements['rate-value'].textContent = stale ? '—' : num(rate, 1);
  elements['rate-detail'].textContent = isDemo() ? 'Generated rate · not hardware' : 'Observed Uno read rate';
  const progress = Math.max(0, Math.min(1, Number(m.baseline_progress) || 0));
  elements['baseline-value'].textContent = stale ? 'No signal' : m.calibrated ? 'Calibrated' : 'Calibrating ' + Math.round(progress * 100) + '%';
  elements['baseline-progress'].style.width = (stale ? 0 : progress * 100) + '%';
  const reasons = (m.quality_reasons || []).map((reason) => String(reason).replaceAll('_', ' ')).join(' · ');
  elements['quality-detail'].textContent = stale ? 'Fresh samples required' : reasons || (m.calibrated ? 'Numerical checks passed' : 'Collecting a quiet baseline');
  const duration = sessionStart === null ? 0 : Math.max(0, (samples.at(-1)?.timestamp || sessionStart) - sessionStart);
  elements.elapsed.textContent = String(Math.floor(duration / 60)).padStart(2,'0') + ':' + String(Math.floor(duration % 60)).padStart(2,'0');
  elements['sample-info'].textContent = totalSamples.toLocaleString() + ' samples · ' + (isDemo() ? 'synthetic' : state?.source || 'waiting') + ' · CH' + (channel + 1);
}

function renderEventLog() {
  const log = elements['event-log'];
  log.replaceChildren();
  if (!markers.length) {
    const empty = document.createElement('span');
    empty.className = 'empty-log';
    empty.textContent = 'No events marked yet.';
    log.append(empty);
    return;
  }
  for (const marker of markers.slice(-6).reverse()) {
    const chip = document.createElement('span');
    chip.className = 'event-chip';
    const time = document.createElement('time');
    time.textContent = new Date(marker.timestamp * 1000).toLocaleTimeString([], {hour12:false});
    chip.append(time, document.createTextNode(marker.label));
    if (marker.id) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'event-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Delete event ' + marker.label + ' at ' + time.textContent);
      remove.title = 'Delete event from the log and recording annotations';
      remove.addEventListener('click', () => deleteEvent(marker.id));
      chip.append(remove);
    }
    log.append(chip);
  }
}

function togglePause() {
  paused = !paused;
  if (paused) {
    pauseSamples = samples.slice();
    pauseMarkers = markers.slice();
    pauseEnd = samples.at(-1)?.timestamp || Date.now() / 1000;
    toast('Display paused. Acquisition and recording continue.');
  }
  elements['pause-button'].setAttribute('aria-pressed', String(paused));
  elements['pause-button'].textContent = paused ? '▶ Resume' : 'Ⅱ Pause';
  elements['display-state'].textContent = paused ? 'Display paused · capture continues' : 'Scrolling live';
  dirty = true;
  updateStatus();
}

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const n = value / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}

function drawTrace(canvas, field, color, rangeElement) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,height);
  const left = width < 500 ? 48 : 62, right = 20, top = 20, bottom = 28;
  const pw = width - left - right, ph = height - top - bottom;
  const shown = paused ? pauseSamples : samples;
  const end = paused ? pauseEnd : shown.at(-1)?.timestamp || Date.now() / 1000;
  const start = end - windowSeconds;
  const visible = shown.filter((s) => s.timestamp >= start && s.timestamp <= end);
  let low = Infinity, high = -Infinity;
  for (const sample of visible) {
    const v = Array.isArray(sample[field]) ? sample[field][channel] : sample[field];
    if (Number.isFinite(v)) { low = Math.min(low,v); high = Math.max(high,v); }
  }
  let center = 0, half = Number(scale);
  if (scale === 'auto') {
    if (field === 'raw_uv' && Number.isFinite(low) && Number.isFinite(high)) center = (low + high) / 2;
    half = Number.isFinite(low) ? niceCeiling(Math.max(Math.abs(low-center),Math.abs(high-center), .5) * 1.22) : 25;
  }
  if (!Number.isFinite(half) || half <= 0) half = 25;
  const yMin = center - half, yMax = center + half;
  const x = (t) => left + (t - start) / windowSeconds * pw;
  const y = (v) => top + (yMax - v) / (yMax - yMin) * ph;
  ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8fa69e';
  for (let i=0;i<=4;i++) {
    const yy = top + i/4*ph;
    ctx.strokeStyle = '#20302e';
    ctx.beginPath();ctx.moveTo(left,yy+.5);ctx.lineTo(left+pw,yy+.5);ctx.stroke();
    const value = yMax - i/4*(yMax-yMin);
    const label = Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value).toLocaleString();
    ctx.textAlign='right';ctx.fillText(label,left-10,yy+3);
  }
  const ticks = width < 500 ? 5 : 10;
  for (let i=0;i<=ticks;i++) {
    const xx = left + i/ticks*pw;
    ctx.strokeStyle = '#192723';
    ctx.beginPath();ctx.moveTo(xx+.5,top);ctx.lineTo(xx+.5,top+ph);ctx.stroke();
    ctx.textAlign = i===0 ? 'left' : i===ticks ? 'right' : 'center';
    const ago = windowSeconds * (1-i/ticks);
    ctx.fillText(i===ticks ? 'now' : '−' + (Number.isInteger(ago) ? ago : ago.toFixed(1)) + 's',xx,height-9);
  }
  // Minor grid is visual spacing only; the labelled axes define the scale.
  ctx.strokeStyle='#13221e';
  const minorSpacing = Math.max(10,pw/ticks/5);
  for (let xx=left+minorSpacing;xx<left+pw;xx+=minorSpacing) {
    ctx.beginPath();ctx.moveTo(xx+.5,top);ctx.lineTo(xx+.5,top+ph);ctx.stroke();
  }
  ctx.save();
  ctx.beginPath();ctx.rect(left,top,pw,ph);ctx.clip();
  ctx.strokeStyle=color;ctx.lineWidth=field==='filtered_uv'?1.65:1.1;
  ctx.lineJoin='round';ctx.lineCap='round';
  ctx.beginPath();
  let priorTime = null;
  let started = false;
  const maxGap = 2.5 / Number(state?.sample_rate || 125);
  for (const sample of visible) {
    const value = Array.isArray(sample[field]) ? sample[field][channel] : sample[field];
    if (!Number.isFinite(value)) { started=false;priorTime=null;continue; }
    const xx=x(sample.timestamp), yy=y(value);
    if (!started || (priorTime !== null && sample.timestamp-priorTime > maxGap)) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
    started=true;priorTime=sample.timestamp;
  }
  ctx.stroke();
  const shownMarkers = (paused ? pauseMarkers : markers).filter((m) => m.timestamp >= start && m.timestamp <= end);
  shownMarkers.forEach((marker,index) => {
    const xx=x(marker.timestamp);
    ctx.strokeStyle='#d7b97a95';ctx.lineWidth=1;ctx.setLineDash([3,4]);
    ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,top+ph);ctx.stroke();ctx.setLineDash([]);
    if (field === 'filtered_uv') {
      const label = marker.label.length>22 ? marker.label.slice(0,21)+'…' : marker.label;
      const textWidth = ctx.measureText(label).width;
      const tx = Math.max(left+3,Math.min(xx+5,left+pw-textWidth-7));
      const ty = top+13+(index%3)*15;
      ctx.fillStyle='#101b1de8';ctx.fillRect(tx-3,ty-10,textWidth+6,14);
      ctx.fillStyle='#efd19b';ctx.textAlign='left';ctx.fillText(label,tx,ty);
    }
  });
  ctx.restore();
  const unit = half < 10 ? 2 : 0;
  rangeElement.textContent = scale === 'auto' && field === 'raw_uv' ?
    'Auto ±' + half.toFixed(unit) + ' µV · centered ' + center.toFixed(1) :
    (scale === 'auto' ? 'Auto ' : '') + '±' + half.toFixed(unit) + ' µV';
}

function render(now) {
  if (!isBenchView() && !document.hidden && (dirty || !paused) && now-lastDraw > 40) {
    drawTrace(canvases[0],'filtered_uv','#59e0aa',elements['filtered-range']);
    drawTrace(canvases[1],'raw_uv','#a1afbd',elements['raw-range']);
    dirty=false;lastDraw=now;
  }
  requestAnimationFrame(render);
}

async function mark(label) {
  try {
    const result = await api('/api/marker',{label});
    if (result.marker_history) ingestState(result);
    else if (result.marker) ingestMarkers([result.marker]);
    else if (result.timestamp) ingestMarkers([result]);
    toast('Marked: ' + label + (recording.active ? '' : ' · start recording to include samples in export'));
  } catch (error) { toast(error.message); }
}

async function deleteEvent(id) {
  try {
    ingestState(await api('/api/markers/delete', {id}));
    toast('Event deleted. Waveform samples kept.');
  } catch (error) { toast(error.message); }
}

elements['clear-event-log'].addEventListener('click', async () => {
  if (!window.confirm('Clear all event markers? This also removes annotations from the current recording and future exports. Waveform samples are kept.')) return;
  try {
    ingestState(await api('/api/markers/delete', {all:true}));
    toast('Event log cleared. Waveform samples kept.');
  } catch (error) { toast(error.message); }
});

async function refreshPorts() {
  try {
    const result = await api('/api/ports');
    const list = Array.isArray(result) ? result : result.ports || [];
    const previous = elements['port-select'].value;
    elements['port-select'].replaceChildren();
    if (!list.length) elements['port-select'].add(new Option('No USB serial device detected',''));
    for (const entry of list) {
      const path = typeof entry === 'string' ? entry : entry.path || entry.device || entry.port;
      if (path) elements['port-select'].add(new Option(path,path));
    }
    if ([...elements['port-select'].options].some((o)=>o.value===previous)) elements['port-select'].value=previous;
  } catch (error) { elements['source-error'].textContent=error.message; }
}

function updateSourceForm() {
  const demo = elements['source-select'].value === 'synthetic';
  const diagnostic=elements['source-select'].value === 'raw_diagnostic';
  elements['serial-fields'].hidden=demo || diagnostic;
  elements['demo-note'].hidden=!demo;
  $('raw-source-note').hidden=!diagnostic;
  $('calibrate-button').disabled=diagnostic || isBenchView();
  elements['source-error'].textContent='';
}

$('source-open').addEventListener('click', async () => {
  elements['source-select'].value=isBenchView()?'raw_diagnostic':state?.source || 'synthetic';
  elements['bench-confirm'].checked=false;
  updateSourceForm();
  elements['source-dialog'].showModal();
  if (['internal_test','shorted_input'].includes(elements['source-select'].value)) await refreshPorts();
});
$('source-close').addEventListener('click',()=>elements['source-dialog'].close());
elements['source-select'].addEventListener('change',()=>{updateSourceForm();if(['internal_test','shorted_input'].includes(elements['source-select'].value))refreshPorts();});
$('refresh-ports').addEventListener('click',refreshPorts);
$('source-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const source=elements['source-select'].value;
  if (source==='raw_diagnostic') {
    setBenchView(true);
    elements['source-dialog'].close();
    toast('Showing diagnostic capture · existing recording and markers preserved');
    return;
  }
  if (source!=='synthetic' && !elements['bench-confirm'].checked) {
    elements['source-error'].textContent='Disconnect electrodes from the board and confirm before opening a bench source.';
    return;
  }
  if (source!=='synthetic' && !elements['port-select'].value) {
    elements['source-error'].textContent='No USB serial device is available. Connect the Uno with a data cable, then refresh.';
    return;
  }
  elements['source-apply'].disabled=true;
  try {
    const next=await api('/api/source',{source,...(source==='synthetic'?{}:{port:elements['port-select'].value})});
    clearView();ingestState(next);setBenchView(false);elements['source-dialog'].close();
    toast(source==='synthetic'?'Showing labelled demo data':'Opening bench source · no firmware changes');
  } catch(error) { elements['source-error'].textContent=error.message; }
  finally { elements['source-apply'].disabled=false; }
});
$('calibrate-button').addEventListener('click',async()=>{
  if (isBenchView() || elements['source-select'].value==='raw_diagnostic') return;
  try { ingestState(await api('/api/calibrate',{}));toast('Baseline reset. Collecting a new quiet baseline.'); }
  catch(error){elements['source-error'].textContent=error.message;}
});
elements['pause-button'].addEventListener('click',togglePause);
elements['channel-select'].addEventListener('change',()=>{channel=Number(elements['channel-select'].value);dirty=true;updateMetrics();});
elements['window-select'].addEventListener('change',()=>{windowSeconds=Number(elements['window-select'].value);dirty=true;});
elements['scale-select'].addEventListener('change',()=>{scale=elements['scale-select'].value;dirty=true;});
document.querySelectorAll('[data-marker]').forEach((button)=>button.addEventListener('click',()=>mark(button.dataset.marker)));
$('custom-event-form').addEventListener('submit',(event)=>{
  event.preventDefault();const input=$('custom-event');const label=input.value.trim();
  if(label){mark(label);input.value='';}
});
elements['record-button'].addEventListener('click',async()=>{
  if(!recording.active && Number(recording.samples)>0 &&
     !window.confirm('Start a new recording? This replaces the current in-memory recording. Export it first if you need to keep it.')) return;
  try{
    const next=await api('/api/recording',{recording:!recording.active});
    if(next.recording)ingestState(next);else{recording=next;updateStatus();}
    toast(recording.active?'Recording started · stored on this laptop':'Recording stopped · export is ready');
  }catch(error){toast(error.message);}
});
elements['export-button'].addEventListener('click',()=>{
  const link=document.createElement('a');link.href='/api/export.csv';link.download='signal-recording.csv';document.body.append(link);link.click();link.remove();
});
elements['demo-pulse'].addEventListener('click',async()=>{
  try{const result=await api('/api/demo-pulse',{});if(result.marker_history)ingestState(result);else if(result.marker)ingestMarkers([result.marker]);toast('Artificial spike added to demo data');}
  catch(error){toast(error.message);}
});
document.addEventListener('keydown',(event)=>{
  if(isBenchView() || event.repeat || elements['source-dialog'].open || ['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement?.tagName))return;
  if(event.code==='Space'){event.preventDefault();togglePause();}
  if(event.key.toLowerCase()==='b')mark('Blink');
  if(event.key.toLowerCase()==='j')mark('Jaw clench');
  if(event.key.toLowerCase()==='s')mark('Scare / stimulus');
});
new ResizeObserver(()=>{dirty=true;}).observe(document.querySelector('.workspace'));
window.addEventListener('resize',()=>{dirty=true;});
setInterval(updateStatus,500);
const stream=new EventSource('/api/events');
stream.onopen=()=>{streamConnected=true;updateStatus();};
stream.onerror=()=>{streamConnected=false;updateStatus();dirty=true;};
stream.onmessage=(event)=>{
  try{
    const packet=JSON.parse(event.data);
    if(packet.type==='samples' || packet.samples)ingestBatch(packet);
    else ingestState(packet);
  }catch(error){console.error('Could not read acquisition message',error);}
};
api('/api/state').then(ingestState).catch(()=>{});
requestAnimationFrame(render);

initBenchPanel(() => { dirty=true; updateStatus(); });
