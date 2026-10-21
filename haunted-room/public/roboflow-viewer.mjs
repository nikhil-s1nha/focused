import { extractTrace } from './graph-detector.mjs';
const $ = id => document.getElementById(id);
const canvas = $('overlay'), ctx = canvas.getContext('2d'), video = $('video'), image = $('image');
const frameCanvas = document.createElement('canvas'), frameCtx = frameCanvas.getContext('2d');
let media = null, stream = null, objectUrl = null, inputMode = 'replay', configured = false;
let running = false, busy = false, generation = 0, controller = null, timer = null, frames = 0, events = 0;
let roi = null, selectionMode = '', drag = null, selectionId = crypto.randomUUID();
const monitorId = crypto.randomUUID(), local = () => $('engine').value === 'local';
const report = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
function buttons() {
  const ready = local() ? !!roi : configured;
  $('once').disabled = !ready || !media || busy || running || !!selectionMode;
  $('start').disabled = !ready || media !== video || busy || running || !!selectionMode;
  $('stop').disabled = !running && !busy; $('clear').disabled = !media;
  for (const id of ['selectRegion', 'wholeFrame', 'pickColor']) $(id).disabled = !media || busy;
}
async function api(path, options = {}) {
  const r = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
  const data = await r.json(); if (!r.ok) throw Error(data.error || `Request failed (${r.status})`); return data;
}
function showConfig(c) {
  configured = c.configured;
  for (const key of ['mode', 'modelId', 'workspace', 'workflowId', 'outputKey', 'confidence']) $(key).value = c[key];
  $('reactionClasses').value = c.reactionClasses.join(', '); $('forwardToGame').checked = c.forwardToGame;
  $('apiKey').value = ''; $('apiKey').placeholder = c.hasApiKey ? 'key configured — leave blank to keep' : 'stored in server memory only';
  fields(); buttons();
  if (!local()) report(configured ? 'Configured. Choose input and analyze to verify the connection.' : 'Not connected. Enter a trained model or Workflow and API key.');
}
function fields() { $('modelFields').hidden = $('mode').value !== 'model'; $('workflowFields').hidden = $('mode').value !== 'workflow'; }
$('mode').onchange = fields;
function stop(message) {
  running = false; generation++; clearTimeout(timer); controller?.abort(); controller = null;
  if (media === video) video.pause();
  buttons(); if (message) report(message);
}
function resetSelection() {
  roi = null; selectionMode = ''; drag = null; selectionId = crypto.randomUUID(); canvas.dataset.selecting = 'false';
  $('selection').textContent = 'no graph area selected';
}
function clear() {
  stop(); stream?.getTracks().forEach(t => t.stop()); stream = null;
  video.srcObject = null; video.removeAttribute('src'); video.load(); image.removeAttribute('src');
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; media = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height); $('empty').hidden = false; $('source').textContent = 'no input';
  resetSelection(); $('predictions').textContent = 'No analysis yet.'; buttons();
}
function dimensions() { return media === video ? [video.videoWidth, video.videoHeight] : [image.naturalWidth, image.naturalHeight]; }
function drawFrame() {
  const [w, h] = dimensions(); if (!w || !h) throw Error('Input is not ready');
  const scale = Math.min(1, 1600 / Math.max(w, h));
  if (roi && (Math.round(w * scale) !== frameCanvas.width || Math.round(h * scale) !== frameCanvas.height)) {
    resetSelection(); throw Error('Input size changed. Select the graph area again.');
  }
  frameCanvas.width = Math.round(w * scale); frameCanvas.height = Math.round(h * scale);
  frameCtx.drawImage(media, 0, 0, frameCanvas.width, frameCanvas.height);
  canvas.width = frameCanvas.width; canvas.height = frameCanvas.height;
  ctx.drawImage(frameCanvas, 0, 0); $('empty').hidden = true;
}
function outline(region = roi) {
  if (!local() || !region) return;
  ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = '#ffc857'; ctx.setLineDash([6, 4]); ctx.strokeRect(region.x, region.y, region.width, region.height); ctx.restore();
}
function drawPredictions(result) {
  // The frozen frame is the exact one sent to inference, not a newer video frame.
  ctx.drawImage(frameCanvas, 0, 0);
  const sx = canvas.width / (result.image?.width || canvas.width), sy = canvas.height / (result.image?.height || canvas.height);
  const fontSize = Math.max(12, Math.round(canvas.width / 65)); ctx.font = `${fontSize}px monospace`; ctx.lineWidth = Math.max(2, canvas.width / 500);
  for (const p of result.predictions) {
    if (p.x === undefined) continue; // Classification responses have no spatial boxes.
    const x = Math.max(0, (p.x - p.width / 2) * sx), y = Math.max(0, (p.y - p.height / 2) * sy);
    const w = Math.min(canvas.width - x, p.width * sx), h = Math.min(canvas.height - y, p.height * sy);
    if (w <= 0 || h <= 0) continue;
    ctx.strokeStyle = '#00ee85'; ctx.strokeRect(x, y, w, h);
    const label = p.score === undefined ? `${p.class} ${(p.confidence * 100).toFixed(1)}%` : `change ${p.amplitudePx.toFixed(0)}px`;
    const textWidth = ctx.measureText(label).width + 10;
    const labelX = Math.max(0, Math.min(x, canvas.width - textWidth)), labelY = Math.max(fontSize + 8, y);
    ctx.fillStyle = '#00ee85'; ctx.fillRect(labelX, labelY - fontSize - 8, Math.min(textWidth, canvas.width), fontSize + 8);
    ctx.fillStyle = '#00190c'; ctx.fillText(label, labelX + 5, labelY - 4, canvas.width - 10);
  }
  outline();
}
async function infer(continuous = false) {
  if (busy || !media || (local() ? !roi : !configured)) return;
  const gen = generation; busy = true; const abort = new AbortController(); controller = abort; buttons();
  try {
    if (media === video && video.ended) { stop('Video finished.'); return; }
    drawFrame();
    const capturedAt = Date.now();
    let payload, path;
    if (local()) {
      const hex = $('traceColor').value, color = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      const tolerance = Number($('tolerance').value);
      if (!Number.isFinite(tolerance) || tolerance < 5 || tolerance > 150) throw Error('Color tolerance must be 5–150');
      const trace = extractTrace(frameCtx.getImageData(0, 0, frameCanvas.width, frameCanvas.height), { roi, color, tolerance });
      payload = { trace, inputMode, capturedAt, monitorId, selectionId, forwardToGame: $('localForward').checked,
        options: { sensitivity: Number($('sensitivity').value), minAmplitude: Number($('minAmplitude').value) } };
      path = '/graph-detector/analyze'; report('Analyzing graph locally…');
    } else {
      payload = { image: frameCanvas.toDataURL('image/jpeg', .9).split(',')[1], inputMode, capturedAt };
      path = '/roboflow/infer'; report('Analyzing frame with Roboflow…');
    }
    const result = await api(path, { method: 'POST', body: JSON.stringify(payload), signal: abort.signal });
    if (gen !== generation) return;
    frames++; if (result.event) events++;
    drawPredictions(result);
    $('stats').textContent = `frames: ${frames} · game events: ${events} · ${result.latencyMs}ms · ${result.forwarding}`;
    if (local()) {
      const metrics = `trace coverage: ${(result.coverage * 100).toFixed(0)}%` + (result.thresholdPx === null ? '' : ` · threshold: ${result.thresholdPx.toFixed(1)}px · baseline: ${result.baseline.toFixed(1)}px`);
      $('predictions').textContent = metrics + '\n' + (result.predictions.length ? result.predictions.map(p => `graph_change  ${p.amplitudePx.toFixed(1)}px · deviation score ${p.score.toFixed(1)} (not probability)`).join('\n') : result.status === 'insufficient_trace' ? 'Cannot isolate one trace. Tighten the graph area, pick its line color, or adjust color tolerance.' : 'No large graph changes in this frame.');
      report(result.status === 'insufficient_trace' ? 'Trace unclear — no game event sent. Adjust the area or color.' : `Local analysis: ${result.predictions.length} change(s). ${result.event ? 'Event sent to game.' : ''}`, result.status === 'insufficient_trace');
    } else {
      $('predictions').textContent = result.predictions.length ? result.predictions.map(p => `${p.class}  ${(p.confidence * 100).toFixed(1)}%${p.x === undefined ? '  (classification — no box)' : ''}`).join('\n') : 'No detections returned by the model.';
      report(`Roboflow response received. ${result.predictions.length} prediction(s).`);
    }
  } catch (error) {
    if (gen === generation) { stop(); report(error.message, true); }
  } finally {
    busy = false; if (controller === abort) controller = null; buttons();
    if (continuous && running && gen === generation) timer = setTimeout(() => infer(true), 1000);
  }
}
$('configure').onsubmit = async e => {
  e.preventDefault(); stop(); $('save').disabled = true;
  const config = Object.fromEntries(['mode', 'modelId', 'workspace', 'workflowId', 'outputKey', 'apiKey'].map(k => [k, $(k).value.trim()]));
  config.confidence = Number($('confidence').value); config.reactionClasses = $('reactionClasses').value.split(',').map(s => s.trim()).filter(Boolean); config.forwardToGame = $('forwardToGame').checked;
  try { showConfig(await api('/roboflow/config', { method: 'POST', body: JSON.stringify(config) })); if (configured) $('settings').open = false; }
  catch (error) { report(error.message, true); } finally { $('apiKey').value = ''; $('save').disabled = false; }
};
$('disconnect').onclick = async () => { stop(); try { showConfig(await api('/roboflow/config', { method: 'DELETE' })); $('settings').open = true; } catch (e) { report(e.message, true); } };
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return; clear(); inputMode = 'replay'; objectUrl = URL.createObjectURL(file);
  const selected = file.type.startsWith('video/') ? video : image; media = selected;
  const gen = generation;
  try {
    await new Promise((resolve, reject) => { selected.addEventListener(selected === video ? 'loadeddata' : 'load', resolve, { once: true }); selected.addEventListener('error', () => reject(Error('This image/video cannot be opened by the browser')), { once: true }); selected.src = objectUrl; });
    if (gen !== generation) return;
    drawFrame(); $('source').textContent = `${file.name} · replay preview only`; buttons(); report(local() ? 'Input ready. Select one graph area and pick the trace color.' : 'Input ready. Analyze sends it to Roboflow.');
  } catch (e) { if (gen === generation) { clear(); report(e.message, true); } }
};
$('share').onclick = async () => {
  clear(); const gen = generation;
  try {
    const chosen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (gen !== generation) { chosen.getTracks().forEach(t => t.stop()); return; }
    stream = chosen; video.srcObject = stream; media = video; inputMode = 'live';
    stream.getVideoTracks()[0].addEventListener('ended', () => { clear(); report('Window sharing ended.'); }, { once: true });
    await video.play(); if (gen !== generation) return;
    drawFrame(); $('source').textContent = 'shared graph window · live'; buttons(); report(local() ? 'Window selected. Select one graph area and pick the trace color.' : 'Window selected. Start sends frames to Roboflow.');
  } catch (e) { if (gen === generation) { clear(); report(e.name === 'NotAllowedError' ? 'Window sharing was canceled or denied.' : e.message, true); } }
};
$('once').onclick = () => infer();
$('start').onclick = async () => { try { await video.play(); running = true; buttons(); infer(true); } catch (e) { report(e.message, true); } };
$('stop').onclick = () => stop('Analysis stopped.');
$('clear').onclick = () => { clear(); $('file').value = ''; report('Input cleared.'); };
addEventListener('pagehide', clear);
function setRegion(r) {
  roi = r; selectionId = crypto.randomUUID(); selectionMode = ''; drag = null; canvas.dataset.selecting = 'false';
  $('selection').textContent = `${r.width} × ${r.height}px at ${r.x}, ${r.y}`;
  ctx.drawImage(frameCanvas, 0, 0); outline(); buttons();
}
function point(e) { const r = canvas.getBoundingClientRect(); return { x: Math.min(canvas.width - 1, Math.max(0, Math.round((e.clientX - r.left) * canvas.width / r.width))), y: Math.min(canvas.height - 1, Math.max(0, Math.round((e.clientY - r.top) * canvas.height / r.height))) }; }
function rectangle(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; }
$('selectRegion').onclick = () => { stop(); selectionMode = 'region'; canvas.dataset.selecting = 'true'; ctx.drawImage(frameCanvas, 0, 0); buttons(); report('Drag around one trace; exclude axes, text, and other channels.'); };
$('wholeFrame').onclick = () => { stop(); setRegion({ x: 0, y: 0, width: canvas.width, height: canvas.height }); report('Whole frame selected. Pick the trace color, then analyze.'); };
$('pickColor').onclick = () => { stop(); selectionMode = 'color'; canvas.dataset.selecting = 'true'; buttons(); report('Click directly on the graph line to sample its color.'); };
canvas.onpointerdown = e => {
  if (!media || !local() || !selectionMode) return;
  const p = point(e);
  if (selectionMode === 'color') {
    const rgb = frameCtx.getImageData(p.x, p.y, 1, 1).data;
    $('traceColor').value = '#' + [...rgb].slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
    selectionId = crypto.randomUUID(); selectionMode = ''; canvas.dataset.selecting = 'false'; buttons(); report('Trace color selected. Ready to analyze.');
  } else { drag = p; canvas.setPointerCapture(e.pointerId); }
};
canvas.onpointermove = e => { if (!drag) return; ctx.drawImage(frameCanvas, 0, 0); outline(rectangle(drag, point(e))); };
canvas.onpointerup = e => {
  if (!drag) return;
  const r = rectangle(drag, point(e)); drag = null;
  if (r.width < 20 || r.height < 20) { report('Select an area at least 20 × 20 pixels.', true); return; }
  setRegion(r); report('Area selected. Pick the graph line color, then analyze.');
};
canvas.onpointercancel = () => { drag = null; ctx.drawImage(frameCanvas, 0, 0); outline(); };
for (const id of ['traceColor', 'tolerance', 'sensitivity', 'minAmplitude', 'localForward']) $(id).onchange = () => { stop(); selectionId = crypto.randomUUID(); report('Settings updated. Analyze or start to continue.'); };
$('engine').onchange = () => {
  stop(); selectionMode = ''; canvas.dataset.selecting = 'false';
  $('localSettings').hidden = !local(); $('settings').hidden = local();
  $('privacy').textContent = local() ? 'Local analysis runs on this computer. Recorded files are preview-only. For live game events, share the EEG graph window and start the game.' : "Analyze sends the selected frame to Roboflow's cloud using your account. Recorded files are preview-only.";
  if (media) { ctx.drawImage(frameCanvas, 0, 0); outline(); }
  buttons(); report(local() ? 'Local graph detector ready. Select a trace and analyze.' : configured ? 'Roboflow configured.' : 'Enter a trained Roboflow model or Workflow and API key.');
};
api('/roboflow/status').then(showConfig).catch(e => { if (!local()) report('Inference bridge unavailable: ' + e.message, true); });
api('/graph-detector/status').catch(e => { if (local()) report('Local graph bridge unavailable: ' + e.message, true); });
