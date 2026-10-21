import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractTrace, analyzeTrace, LocalChangeGate } from '../public/graph-detector.mjs';
import { createLocalGraphBridge } from '../roboflow/local-bridge.mjs';
import { createSignalLink } from '../signal-link/receiver.mjs';
import { SignalLinkAdapter } from '../public/signal-link/adapter.mjs';
import { EventDirector } from '../public/simple/event-director.mjs';
import { validVision } from '../public/signal-link/vision-contract.mjs';

// Synthetic raster fixtures exercise actual pixels, not canned model predictions.
function graph({ spike = false, secondTrace = false, blank = false } = {}) {
  const width = 600, height = 260, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 20; data[i + 3] = 255; }
  if (!blank) for (let x = 0; x < width; x++) {
    let y = Math.round(150 + 3 * Math.sin(x / 13));
    if (spike && Math.abs(x - 425) < 24) y -= Math.round(65 * (1 - Math.abs(x - 425) / 24));
    for (const center of secondTrace ? [y, 50] : [y]) for (let dy = -1; dy <= 1; dy++) {
      const i = ((center + dy) * width + x) * 4; data[i] = 0; data[i + 1] = 255; data[i + 2] = 136;
    }
  }
  return { data, width, height };
}
const roi = { x: 20, y: 30, width: 560, height: 200 };
const trace = (options = {}) => extractTrace(graph(options), { roi, color: [0, 255, 136] });

test('raster trace extraction localizes an injected spike and ignores the low amplitude baseline', () => {
  const stable = analyzeTrace(trace()), changed = analyzeTrace(trace({ spike: true }));
  assert.equal(stable.status, 'trace_stable'); assert.equal(stable.coverage, 1);
  assert.equal(changed.predictions.length, 1);
  const box = changed.predictions[0];
  assert.ok(Math.abs(box.x - 425) < 6); assert.ok(box.width > 25 && box.width < 60);
  assert.ok(box.amplitudePx > 50); assert.equal(box.confidence, undefined);
  assert.equal(analyzeTrace(trace({ spike: true }), { minAmplitude: 100 }).predictions.length, 0);
});

test('missing pixels, wrong trace color, and multiple same-colored channels are rejected', () => {
  for (const input of [trace({ blank: true }), trace({ secondTrace: true }), extractTrace(graph(), { roi, color: [255, 0, 0] })]) {
    const result = analyzeTrace(input); assert.equal(result.status, 'insufficient_trace'); assert.equal(result.predictions.length, 0);
  }
  assert.throws(() => analyzeTrace({ ...trace(), points: [NaN] }), /graph region/);
  assert.throws(() => analyzeTrace(trace(), { sensitivity: -1 }), /Invalid sensitivity/);
});

test('local gate requires a clear baseline, does not recount a peak on a new encounter, and rearms after clear frames', () => {
  const g = new LocalChangeGate(), clear = analyzeTrace(trace()), changed = analyzeTrace(trace({ spike: true })), c = { encounter_id: 'e1' };
  assert.equal(g.observe(changed, c, 0, 'session'), null);
  assert.equal(g.observe(changed, c, 1000, 'session'), null);
  g.observe(clear, c, 2000, 'session'); g.observe(clear, c, 3000, 'session');
  assert.equal(g.observe(changed, c, 4000, 'session'), null); assert.ok(g.observe(changed, c, 5000, 'session'));
  assert.equal(g.observe(changed, { encounter_id: 'e2' }, 10000, 'session'), null);
  assert.equal(g.observe(changed, { encounter_id: 'e2' }, 11000, 'session'), null);
  g.observe(clear, c, 12000, 'session'); g.observe(clear, c, 13000, 'session');
  g.observe(changed, c, 14000, 'session'); assert.ok(g.observe(changed, c, 15000, 'session'));
  g.observe(clear, c, 16000, 'session'); g.observe(clear, c, 17000, 'session');
  g.observe(analyzeTrace(trace({ blank: true })), c, 18000, 'session');
  assert.equal(g.observe(changed, c, 19000, 'session'), null);
});

async function harness(t) {
  let time = 10000;
  const link = createSignalLink({ now: () => time, signalToken: undefined });
  const bridge = createLocalGraphBridge({ now: () => time, getGameState: link.getGameState, publish: link.publishVision });
  const server = http.createServer((req, res) => { const path = new URL(req.url, 'http://localhost').pathname; if (!bridge.handle(req, res, path) && !link.handle(req, res, path)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { bridge.close(); link.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = (path, value, origin = base) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  const packet = (changed = false) => ({ trace: trace({ spike: changed }), capturedAt: time, inputMode: 'live', monitorId: 'monitor', selectionId: 'area', forwardToGame: true, options: { sensitivity: 4.5, minAmplitude: 10 } });
  const analyze = async (changed = false, overrides = {}) => { time += 1000; const r = await post('/graph-detector/analyze', { ...packet(changed), ...overrides }); assert.equal(r.status, 200); return r.json(); };
  const game = (event, encounter_id = 'e1', session_id = 's1') => post('/signal-link/game', { event, encounter_id, session_id, kind: 'rush', door: 'left' });
  return { base, post, packet, analyze, game, advance: ms => time += ms };
}

test('local HTTP analysis needs no model, key, or partner token; recordings never drive the game', async t => {
  const h = await harness(t);
  const status = await (await fetch(h.base + '/graph-detector/status')).json(); assert.equal(status.requiresKey, false);
  assert.equal((await h.analyze(true)).forwarding, 'waiting_for_active_encounter');
  await h.game('session_started'); await h.game('encounter_started');
  for (const changed of [false, false, true, true]) {
    const r = await h.analyze(changed, { inputMode: 'replay' });
    assert.equal(r.event, null); assert.equal(r.forwarding, 'replay_preview_only');
    assert.equal(r.predictions.length, Number(changed));
  }
});

test('pixels to HTTP to SSE to game director: real local changes affect a later scare and retain their provenance', async t => {
  const h = await harness(t); await h.game('session_started'); await h.game('encounter_started');
  const ac = new AbortController(), response = await fetch(h.base + '/signal-link/events', { signal: ac.signal }), reader = response.body.getReader();
  t.after(() => ac.abort()); await reader.read();
  await h.analyze(false); assert.equal((await h.analyze(false)).forwarding, 'armed');
  assert.equal((await h.analyze(true)).event, null);
  const result = await h.analyze(true); assert.equal(result.forwarding, 'sent');
  const m = result.event; assert.equal(m.source, 'local_graph_detector'); assert.equal(m.emotion, null); assert.equal(m.confidence, null); assert.ok(validVision(m));
  const wire = new TextDecoder().decode((await reader.read()).value); assert.ok(wire.includes(m.id));
  assert.equal((await h.analyze(true)).event, null);
  await h.game('encounter_started', 'e2'); assert.equal((await h.analyze(true)).event, null);
  let clock = 0; const d = new EventDirector({ now: () => clock, rng: () => .2 });
  d.start('s1'); clock = 8; const e = d.tick(); d.opening = false; d.finish();
  const adapter = new SignalLinkAdapter({ canApply: () => true, onVision: event => d.receiveVision(event) }); adapter.enabled = true;
  const associated = { ...m, encounter_id: e.encounter_id };
  assert.equal(adapter.receive(associated), true); assert.equal(d.tick(), null);
  assert.equal(adapter.receive(associated), false); clock = 14; assert.ok(d.tick()); assert.equal(d.weights[e.kind], 1.15);
  assert.equal(validVision({ ...m, confidence: .9 }), false);
  ac.abort(); await reader.cancel().catch(() => {});
});

test('invalid/stale/duplicate requests are rejected, disabling or stopping prevents events', async t => {
  const h = await harness(t);
  assert.equal((await h.post('/graph-detector/analyze', h.packet(), 'https://example.com')).status, 403);
  assert.equal((await h.post('/graph-detector/analyze', { ...h.packet(), capturedAt: 1 })).status, 400);
  assert.equal((await h.post('/graph-detector/analyze', { ...h.packet(), options: { sensitivity: 100 } })).status, 400);
  await h.game('session_started'); await h.game('encounter_started');
  await h.analyze(false); await h.analyze(false);
  assert.equal((await h.post('/graph-detector/analyze', h.packet())).status, 409);
  await h.analyze(true); assert.equal((await h.analyze(true, { forwardToGame: false })).event, null);
  await h.analyze(false); await h.analyze(false); await h.analyze(true);
  await h.game('session_ended'); const stopped = await h.analyze(true);
  assert.equal(stopped.forwarding, 'waiting_for_active_encounter'); assert.equal(stopped.event, null);
});

test('a monitor interruption discards a pending match and requires a fresh baseline', async t => {
  const h = await harness(t); await h.game('session_started'); await h.game('encounter_started');
  await h.analyze(false); await h.analyze(false); await h.analyze(true);
  h.advance(5000); assert.equal((await h.analyze(true)).event, null);
  assert.equal((await h.analyze(true)).event, null);
  await h.analyze(false); await h.analyze(false); await h.analyze(true);
  assert.equal((await h.analyze(true)).forwarding, 'sent');
});

test('changing the selected area cannot bypass the global five-second event cooldown', async t => {
  const h = await harness(t); await h.game('session_started'); await h.game('encounter_started');
  await h.analyze(false); await h.analyze(false); await h.analyze(true);
  assert.equal((await h.analyze(true)).forwarding, 'sent');
  const changedSelection = { selectionId: 'new-area' };
  await h.analyze(false, changedSelection); await h.analyze(false, changedSelection);
  await h.analyze(true, changedSelection);
  assert.equal((await h.analyze(true, changedSelection)).forwarding, 'cooldown');
});
