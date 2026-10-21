import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRoboflowBridge, normalizePredictions, DetectionGate } from '../roboflow/bridge.mjs';
import { createSignalLink } from '../signal-link/receiver.mjs';
import { SignalLinkAdapter } from '../public/signal-link/adapter.mjs';
import { EventDirector } from '../public/simple/event-director.mjs';

const prediction = { class: 'spike', confidence: .92, x: 30, y: 20, width: 10, height: 8 };
const result = () => Response.json({ predictions: [prediction], image: { width: 100, height: 80 } });
const config = { mode: 'model', modelId: 'graph-model/1', apiKey: 'unit-test-not-a-real-key', confidence: .65, reactionClasses: ['spike'], forwardToGame: true };
// Small local test fixture; fetch is injected, no frames are sent to Roboflow in tests.
const image = Buffer.from([255, 216, 255, 224, ...Array(30).fill(0)]).toString('base64');

async function harness(t, options = {}) {
  let now = 10000;
  const calls = [];
  const link = createSignalLink({ now: () => now, signalToken: undefined });
  const bridge = createRoboflowBridge({ env: {}, now: () => now, getGameState: link.getGameState, publish: link.publishVision, fetchImpl: async (...args) => { calls.push(args); return result(); }, ...options });
  const server = http.createServer((q, r) => { const pathname = new URL(q.url, 'http://localhost').pathname; if (!bridge.handle(q, r, pathname) && !link.handle(q, r, pathname)) r.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { bridge.close(); link.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = (path, data, origin = base) => fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const infer = (inputMode = 'live') => post('/roboflow/infer', { image, inputMode, capturedAt: now });
  const game = (event, encounter_id = undefined, session_id = 'round-1') => post('/signal-link/game', { event, session_id, ...(encounter_id ? { encounter_id, kind: 'rush', door: 'left' } : {}) });
  return { base, post, infer, game, bridge, link, calls, advance: ms => now += ms };
}

test('normalizes real detection and classification shapes, never fabricates boxes', () => {
  assert.deepEqual(normalizePredictions({ predictions: [prediction] }).predictions, [prediction]);
  assert.deepEqual(normalizePredictions({ predictions: { calm: { confidence: .8 } } }).predictions, [{ class: 'calm', confidence: .8 }]);
  assert.equal(normalizePredictions({ outputs: [{ predictions: { predictions: [prediction] } }] }, { mode: 'workflow' }).predictions.length, 1);
  assert.deepEqual(normalizePredictions({ predictions: [{ ...prediction, width: -5 }, { class: 'spike', confidence: 100 }] }).predictions, []);
  assert.throws(() => normalizePredictions({ error: 'something else' }), /No supported/);
});

test('gate needs two matches, rearming, and five seconds between events', () => {
  const gate = new DetectionGate(), context = { session_id: 's', encounter_id: 'e' };
  assert.equal(gate.observe([prediction], config, context, 0), null);
  assert.ok(gate.observe([prediction], config, context, 1000));
  assert.equal(gate.observe([prediction], config, context, 10000), null);
  gate.observe([], config, context, 11000); gate.observe([], config, context, 12000);
  assert.equal(gate.observe([prediction], config, context, 13000), null);
  assert.ok(gate.observe([prediction], config, context, 14000));
  gate.observe([], config, context, 14500); gate.observe([], config, context, 14600);
  gate.observe([prediction], config, context, 14700);
  assert.equal(gate.observe([prediction], config, context, 15000), null);
});

test('configuration stays private, same-origin only, and missing setup never simulates success', async t => {
  const h = await harness(t);
  assert.equal((await h.infer()).status, 503);
  assert.equal((await h.post('/roboflow/config', config, 'https://other.example')).status, 403);
  assert.equal((await h.post('/roboflow/config', { ...config, modelId: '../escape' })).status, 400);
  const response = await h.post('/roboflow/config', config);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).hasApiKey, true);
  const status = await (await fetch(h.base + '/roboflow/status')).text();
  assert.ok(!status.includes(config.apiKey));
  assert.equal((await h.post('/roboflow/config', { ...config, apiKey: '' })).status, 200);
  assert.equal((await h.post('/roboflow/infer', { image: 'invalid', inputMode: 'live', capturedAt: 10000 })).status, 400);
});

test('real response path forwards stable live matches only, tied to an active encounter', async t => {
  const h = await harness(t); await h.post('/roboflow/config', config);
  assert.equal((await h.game('session_started')).status, 202); // works without partner token
  assert.equal((await h.game('encounter_started', 'encounter-1')).status, 202);
  assert.equal((await (await h.infer('replay')).json()).forwarding, 'replay_preview_only');
  assert.equal((await (await h.infer('replay')).json()).event, null);
  const streamAbort = new AbortController();
  const stream = await fetch(h.base + '/signal-link/events', { signal: streamAbort.signal });
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  await reader.read();
  t.after(() => streamAbort.abort());
  const first = await (await h.infer()).json(); assert.equal(first.event, null);
  h.advance(1000);
  const second = await (await h.infer()).json();
  assert.equal(second.simulated, false); assert.equal(second.event.label, 'spike');
  assert.equal(second.event.encounter_id, 'encounter-1'); assert.equal(second.event.emotion, null);
  const wire = decoder.decode((await reader.read()).value);
  assert.equal(JSON.parse(wire.slice(wire.indexOf('data: ') + 6).trim()).id, second.event.id);
  streamAbort.abort(); await reader.cancel().catch(() => {});
  const [url, request] = h.calls[0];
  assert.ok(url.startsWith('https://serverless.roboflow.com/graph-model/1'));
  assert.equal(new URL(url).searchParams.get('confidence'), '65');
  assert.ok(!url.includes(config.apiKey)); assert.equal(request.headers.Authorization, `Bearer ${config.apiKey}`);
  assert.equal((await (await h.infer()).json()).event, null);
  await h.game('session_ended');
  assert.equal((await (await h.infer()).json()).forwarding, 'waiting_for_active_encounter');
});

test('model/Workflow HTTP failures do not leak upstream text or produce events', async t => {
  const h = await harness(t, { fetchImpl: async () => new Response(config.apiKey, { status: 403 }) });
  await h.post('/roboflow/config', config);
  const r = await h.infer(); assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes(config.apiKey)); assert.equal(h.bridge.status().emitted, 0);
});

test('Workflow uses the configured output and bearer auth', async t => {
  let request;
  const h = await harness(t, { fetchImpl: async (url, options) => { request = { url, ...options }; return Response.json({ outputs: [{ boxes: { predictions: [prediction] } }] }); } });
  await h.post('/roboflow/config', { ...config, mode: 'workflow', workspace: 'my-workspace', workflowId: 'eeg', outputKey: 'boxes' });
  const r = await (await h.infer()).json(); assert.equal(r.predictions[0].class, 'spike');
  assert.equal(request.url, 'https://serverless.roboflow.com/my-workspace/workflows/eeg');
  assert.equal(JSON.parse(request.body).inputs.image.type, 'base64');
  assert.ok(!request.body.includes(config.apiKey));
});

test('concurrent frames, in-flight Stop, and disconnect invalidate forwarding', async t => {
  let release;
  const h = await harness(t, { fetchImpl: async () => { await new Promise(r => release = r); return result(); } });
  await h.post('/roboflow/config', config); await h.game('session_started'); await h.game('encounter_started', 'e');
  const pending = h.infer();
  while (!release) await new Promise(r => setImmediate(r));
  assert.equal((await h.infer()).status, 429);
  await h.game('session_ended'); release();
  assert.equal((await (await pending).json()).event, null);
  const next = h.infer(); release = null;
  while (!release) await new Promise(r => setImmediate(r));
  await fetch(h.base + '/roboflow/config', { method: 'DELETE', headers: { Origin: h.base } });
  release(); assert.equal((await next).status, 409);
  assert.equal(h.bridge.status().configured, false);
});

test('vision observation reaches the scheduler, respects pace, and slightly favors matched stimulus', () => {
  let time = 0; const d = new EventDirector({ now: () => time, rng: () => .2 });
  d.start('round-1'); time = 8; const encounter = d.tick(); d.opening = false; d.finish();
  const adapter = new SignalLinkAdapter({ canApply: () => true, onVision: m => d.receiveVision(m) }); adapter.enabled = true;
  const event = { schema: 'horror.vision.v1', source: 'roboflow', event: 'visual_pattern', id: 'id', session_id: 'round-1', encounter_id: encounter.encounter_id, model_id: 'graph-model/1', label: 'spike', confidence: .92, emotion: null, quality: 'unverified', created_at_ms: 1000, received_at_ms: 2000 };
  assert.equal(adapter.receive(event), true); assert.equal(d.tick(), null);
  assert.equal(adapter.receive(event), false);
  time = 14; assert.ok(d.tick()); assert.equal(d.weights[encounter.kind], 1.15);
  d.stop(); assert.equal(adapter.receive({ ...event, id: 'new' }), false);
});

test('timeouts fail closed and release the inference slot', async t => {
  const h = await harness(t, { timeoutMs: 15, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) });
  await h.post('/roboflow/config', config);
  assert.equal((await h.infer()).status, 504);
  assert.equal(h.bridge.status().busy, false);
  assert.equal(h.bridge.status().emitted, 0);
});

test('100 percent confidence is sent as 100, not the API’s ambiguous value 1', async t => {
  const h = await harness(t);
  await h.post('/roboflow/config', { ...config, confidence: 1 });
  assert.equal((await h.infer()).status, 200);
  assert.equal(new URL(h.calls[0][0]).searchParams.get('confidence'), '100');
});
