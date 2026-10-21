import { randomUUID } from 'node:crypto';
import { analyzeTrace, validTrace, LocalChangeGate, DETECTOR_VERSION } from '../public/graph-detector.mjs';

export function createLocalGraphBridge({ now = Date.now, getGameState = () => null, publish = () => false } = {}) {
  const gate = new LocalChangeGate();
  let frames = 0, emitted = 0, lastCapture = -1, lastKey = '', lastFrameAt = -Infinity, lastPublishedAt = -Infinity;
  function json(res, code, value) { if (!res.destroyed) res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(value)); }
  const fail = (status, message) => Object.assign(Error(message), { status });
  async function route(req, res, pathname) {
    const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) || (req.method !== 'GET' && req.headers.origin !== origin)) throw fail(403, 'Use the graph monitor on this computer');
    if (pathname === '/graph-detector/status' && req.method === 'GET') return json(res, 200, { source: 'local_graph_detector', version: DETECTOR_VERSION, frames, emitted, game: getGameState(), requiresKey: false });
    if (pathname !== '/graph-detector/analyze' || req.method !== 'POST') throw fail(405, 'Method not allowed');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Send JSON');
    const context = getGameState();
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 40000) throw fail(413, 'Trace too large'); chunks.push(chunk); }
    let m; try { m = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'Invalid JSON'); }
    if (!m || !validTrace(m.trace) || !['live', 'replay'].includes(m.inputMode) || typeof m.forwardToGame !== 'boolean' ||
      !Number.isSafeInteger(m.capturedAt) || m.capturedAt > now() || now() - m.capturedAt > 3000 ||
      typeof m.monitorId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(m.monitorId) ||
      typeof m.selectionId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(m.selectionId)) throw fail(400, 'Invalid or stale graph trace');
    let result; try { result = analyzeTrace(m.trace, m.options); } catch (e) { throw fail(400, e.message); }
    const current = getGameState();
    const sameEncounter = context?.packet_sending && current?.packet_sending && context.encounter_id &&
      context.session_id === current.session_id && context.encounter_id === current.encounter_id && m.capturedAt >= current.received_at_ms;
    let forwarding = !m.forwardToGame ? 'disabled' : m.inputMode !== 'live' ? 'replay_preview_only' : !sameEncounter ? 'waiting_for_active_encounter' : 'waiting_for_clear_trace';
    let event = null;
    if (m.forwardToGame && m.inputMode === 'live' && sameEncounter) {
      const key = JSON.stringify([m.monitorId, m.selectionId, current.session_id, m.trace.roi, m.options]);
      if (lastKey === key && m.capturedAt <= lastCapture) throw fail(409, 'This frame was already processed');
      // Pausing or losing the monitor requires a fresh clear baseline, never a queued event.
      if (now() - lastFrameAt > 3000) gate.reset();
      lastKey = key; lastCapture = m.capturedAt; lastFrameAt = now();
      const match = gate.observe(result, current, now(), key);
      forwarding = result.status === 'insufficient_trace' ? 'select_one_trace' : gate.armed ? 'armed' : 'waiting_for_clear_trace';
      if (match && now() - lastPublishedAt < 5000) forwarding = 'cooldown';
      if (match && now() - lastPublishedAt >= 5000) {
        const candidate = { schema: 'horror.vision.v1', source: 'local_graph_detector', event: 'visual_pattern', id: randomUUID(),
          session_id: current.session_id, encounter_id: current.encounter_id, model_id: DETECTOR_VERSION, label: 'graph_change',
          confidence: null, score: match.score, amplitude_px: match.amplitudePx, coverage: result.coverage,
          emotion: null, quality: 'unverified', created_at_ms: m.capturedAt, received_at_ms: now() };
        if (publish(candidate)) { event = candidate; emitted++; lastPublishedAt = now(); forwarding = 'sent'; }
      }
    } else gate.reset();
    frames++;
    return json(res, 200, { ...result, event, forwarding, latencyMs: now() - m.capturedAt });
  }
  return {
    handle(req, res, pathname) {
      if (!['/graph-detector/status', '/graph-detector/analyze'].includes(pathname)) return false;
      route(req, res, pathname).catch(e => json(res, e.status || 500, { error: e.status ? e.message : 'Local graph analysis failed' })); return true;
    },
    close() { gate.reset(); },
  };
}
