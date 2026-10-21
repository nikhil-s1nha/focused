import { randomUUID } from 'node:crypto';

const CLOUD = 'https://serverless.roboflow.com';
const slug = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const unit = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const safeText = v => typeof v === 'string' && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function validateConfig(raw, previous) {
  const allowed = ['mode', 'modelId', 'workspace', 'workflowId', 'outputKey', 'apiKey', 'confidence', 'reactionClasses', 'forwardToGame'];
  if (!raw || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.includes(k))) throw new RequestError(400, 'Invalid configuration fields');
  const c = { ...previous, ...raw };
  if (raw.apiKey === '') c.apiKey = previous.apiKey;
  if (!['model', 'workflow'].includes(c.mode)) throw new RequestError(400, 'Choose model or workflow');
  if (c.mode === 'model' && !/^[a-zA-Z0-9_-]{1,80}\/[1-9]\d{0,5}$/.test(c.modelId)) throw new RequestError(400, 'Model ID must be project-name/version');
  if (c.mode === 'workflow' && (!slug(c.workspace) || !slug(c.workflowId) || !slug(c.outputKey))) throw new RequestError(400, 'Workflow workspace, ID, and output key are required');
  if (typeof c.apiKey !== 'string' || c.apiKey.length > 4096 || /\s/.test(c.apiKey)) throw new RequestError(400, 'Invalid API key');
  if (!unit(c.confidence) || c.confidence < .1) throw new RequestError(400, 'Confidence must be between 0.1 and 1');
  if (!Array.isArray(c.reactionClasses) || c.reactionClasses.length > 20 || c.reactionClasses.some(x => !safeText(x) || !x.trim())) throw new RequestError(400, 'Use up to 20 exact class names');
  c.reactionClasses = [...new Set(c.reactionClasses.map(x => x.trim()))];
  if (typeof c.forwardToGame !== 'boolean' || (c.forwardToGame && !c.reactionClasses.length)) throw new RequestError(400, 'Choose matching classes before enabling game events');
  return c;
}

export function normalizePredictions(raw, { mode = 'model', outputKey = 'predictions' } = {}) {
  let result = raw;
  if (mode === 'workflow') {
    const output = raw?.outputs?.[0];
    if (!output || !Object.hasOwn(output, outputKey)) throw new RequestError(502, `Workflow must expose the configured prediction output`);
    result = output[outputKey];
    if (Array.isArray(result) && result.length === 1 && result[0]?.predictions) result = result[0];
  }
  let predictions = result?.predictions ?? (Array.isArray(result) ? result : null);
  if (predictions && !Array.isArray(predictions) && typeof predictions === 'object') {
    predictions = Object.entries(predictions).map(([name, p]) => ({ class: name, confidence: p?.confidence }));
  }
  if (!Array.isArray(predictions)) throw new RequestError(502, 'No supported detection or classification predictions in response');
  const items = [];
  for (const p of predictions.slice(0, 300)) {
    if (!p || !safeText(p.class) || !p.class || !unit(p.confidence)) continue;
    const boxFields = ['x', 'y', 'width', 'height'];
    const hasBox = boxFields.some(k => p[k] !== undefined);
    if (hasBox && (!boxFields.every(k => Number.isFinite(p[k])) || p.width <= 0 || p.height <= 0)) continue;
    const item = { class: p.class, confidence: p.confidence };
    if (hasBox) for (const k of boxFields) item[k] = p[k];
    items.push(item);
  }
  const image = result?.image;
  return { predictions: items, image: image && ['width', 'height'].every(k => Number.isFinite(image[k]) && image[k] > 0) ? { width: image.width, height: image.height } : null };
}

// A sustained match produces one event; two clear frames rearm it. No random markers.
export class DetectionGate {
  constructor() { this.reset(); }
  reset() { this.context = ''; this.label = ''; this.hits = 0; this.misses = 0; this.latched = false; this.lastEmit = -Infinity; }
  observe(predictions, config, context, now) {
    const key = `${context.session_id}/${context.encounter_id}`;
    if (key !== this.context) { const lastEmit = this.lastEmit; this.reset(); this.lastEmit = lastEmit; this.context = key; }
    const match = predictions.filter(p => p.confidence >= config.confidence && config.reactionClasses.includes(p.class)).sort((a, b) => b.confidence - a.confidence)[0];
    if (!match) { this.hits = 0; this.label = ''; if (++this.misses >= 2) this.latched = false; return null; }
    this.misses = 0;
    this.hits = this.label === match.class ? this.hits + 1 : 1;
    this.label = match.class;
    if (this.hits < 2 || this.latched || now - this.lastEmit < 5000) return null;
    this.latched = true; this.lastEmit = now;
    return match;
  }
}

function localRequest(req, write) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  try {
    const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) return false;
    return !write || req.headers.origin === origin;
  } catch { return false; }
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError(415, 'Content-Type must be application/json');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 3_000_000) throw new RequestError(413, 'Frame too large; choose a smaller image');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON'); }
}
function imageData(raw) {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new RequestError(400, 'Send a base64 JPEG or PNG frame');
  const bytes = Buffer.from(raw, 'base64');
  if (!(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new RequestError(400, 'Only JPEG and PNG frames are supported');
  return raw;
}

export function createRoboflowBridge({ fetchImpl = globalThis.fetch, now = Date.now, getGameState = () => null, publish = () => false, env = process.env, timeoutMs = 12000 } = {}) {
  const defaults = { mode: 'model', modelId: '', workspace: '', workflowId: '', outputKey: 'predictions', apiKey: '', confidence: .65, reactionClasses: [], forwardToGame: false };
  let config = { ...defaults }, version = 0, controller = null, closed = false, frames = 0, emitted = 0, lastResult = null;
  if (env.ROBOFLOW_MODEL_ID) config = validateConfig({ modelId: env.ROBOFLOW_MODEL_ID, apiKey: env.ROBOFLOW_API_KEY || '' }, config);
  const gate = new DetectionGate();
  function invalidate() { version++; controller?.abort(); gate.reset(); }
  function status() {
    const { apiKey, ...safe } = config;
    return { ...safe, configured: !!apiKey && (config.mode === 'model' ? !!config.modelId : !!config.workflowId), hasApiKey: !!apiKey, provider: CLOUD, busy: !!controller, frames, emitted, lastResult, game: getGameState() };
  }
  function json(res, code, value) { if (!res.destroyed) res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(value)); }
  async function route(req, res, pathname) {
    const write = req.method !== 'GET';
    if (!localRequest(req, write)) throw new RequestError(403, 'Roboflow setup and inference are available only from this computer with a same-origin request');
    if (pathname === '/roboflow/status' && req.method === 'GET') return json(res, 200, status());
    if (pathname === '/roboflow/config' && req.method === 'POST') {
      const next = validateConfig(await body(req), config);
      invalidate(); config = next;
      return json(res, 200, status());
    }
    if (pathname === '/roboflow/config' && req.method === 'DELETE') {
      invalidate(); config = { ...defaults }; lastResult = null;
      return json(res, 200, status());
    }
    if (pathname !== '/roboflow/infer' || req.method !== 'POST') throw new RequestError(405, 'Method not allowed');
    if (!status().configured) throw new RequestError(503, 'Configure your trained Roboflow model or Workflow and private API key first');
    if (controller) throw new RequestError(429, 'A frame is already being analyzed');
    const request = await body(req);
    // Recheck after the asynchronous body read: two requests cannot take the slot.
    if (controller) throw new RequestError(429, 'A frame is already being analyzed');
    if (closed || !status().configured) throw new RequestError(409, 'Configuration changed; try again');
    const image = imageData(request?.image);
    if (!['live', 'replay'].includes(request.inputMode) || !Number.isSafeInteger(request.capturedAt) || now() - request.capturedAt > 5000 || request.capturedAt > now() + 1000) throw new RequestError(400, 'Use a fresh frame and a live or replay input mode');
    const generation = version, context = getGameState(), capturedAt = request.capturedAt;
    const abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(), timeoutMs); timeout.unref?.();
    const disconnected = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', disconnected);
    try {
      const url = config.mode === 'model'
        // The project/version route treats 1 as 1%, so use percent units throughout.
        ? `${CLOUD}/${config.modelId}?confidence=${config.confidence * 100}&format=json`
        : `${CLOUD}/${config.workspace}/workflows/${config.workflowId}`;
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': config.mode === 'model' ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: config.mode === 'model' ? image : JSON.stringify({ inputs: { image: { type: 'base64', value: image } } }),
      });
      if (!response.ok) throw new RequestError(response.status === 429 ? 429 : 502,
        [401, 403].includes(response.status) ? 'Roboflow rejected the API key or model access' : response.status === 404 ? 'Roboflow model or Workflow was not found' : response.status === 429 ? 'Roboflow rate limit reached; wait before restarting' : 'Roboflow could not analyze this frame');
      let bytes = 0, chunks = [];
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2_000_000) throw new RequestError(502, 'Roboflow response is too large'); chunks.push(chunk); }
      const result = normalizePredictions(JSON.parse(Buffer.concat(chunks).toString('utf8')), config);
      if (abort.signal.aborted || generation !== version || closed || res.destroyed) throw new RequestError(409, 'Analysis canceled');
      frames++;
      const current = getGameState();
      const sameEncounter = context?.packet_sending && current?.packet_sending && context.encounter_id && context.session_id === current.session_id && context.encounter_id === current.encounter_id && capturedAt >= context.received_at_ms && now() - capturedAt <= 15000;
      let event = null;
      let forwarding = !config.forwardToGame ? 'disabled' : request.inputMode !== 'live' ? 'replay_preview_only' : !sameEncounter ? 'waiting_for_active_encounter' : 'waiting_for_stable_match';
      if (config.forwardToGame && request.inputMode === 'live' && sameEncounter) {
        const match = gate.observe(result.predictions, config, current, now());
        if (match) {
          const candidate = { schema: 'horror.vision.v1', id: randomUUID(), event: 'visual_pattern', source: 'roboflow', emotion: null, quality: 'unverified', session_id: current.session_id, encounter_id: current.encounter_id, model_id: config.mode === 'model' ? config.modelId : `${config.workspace}/${config.workflowId}`.slice(0, 128), label: match.class, confidence: match.confidence, created_at_ms: capturedAt, received_at_ms: now() };
          if (publish(candidate)) { event = candidate; emitted++; forwarding = 'sent'; }
        }
      } else gate.reset();
      lastResult = { receivedAt: now(), detections: result.predictions.length, forwarding };
      return json(res, 200, { ...result, event, forwarding, latencyMs: now() - capturedAt, source: 'roboflow', simulated: false });
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(abort.signal.aborted ? 504 : 502, abort.signal.aborted ? 'Analysis timed out or was canceled' : 'Roboflow connection or response failed');
    } finally { clearTimeout(timeout); res.off('close', disconnected); if (controller === abort) controller = null; }
  }
  return {
    handle(req, res, pathname) {
      if (!['/roboflow/status', '/roboflow/config', '/roboflow/infer'].includes(pathname)) return false;
      route(req, res, pathname).catch(error => json(res, error.status || 500, { error: error.status ? error.message : 'Roboflow bridge failed' }));
      return true;
    },
    status,
    close() { closed = true; invalidate(); config.apiKey = ''; },
  };
}
