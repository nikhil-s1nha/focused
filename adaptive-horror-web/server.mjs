import http from 'node:http';
import https from 'node:https';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {validSignal} from './public/director.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const routes = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript']],
  ['/director.mjs', ['public/director.mjs', 'text/javascript']],
  ['/aframe.js', ['node_modules/aframe/dist/aframe-master.min.js', 'text/javascript']]
]);
const handler = async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/signal') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) { res.writeHead(413).end(); return; }
    }
    try {
      const signal = JSON.parse(body);
      if (!validSignal(signal)) throw new Error('invalid');
      broadcast(signal);
      res.writeHead(204).end();
    } catch { res.writeHead(400).end('Invalid signal'); }
    return;
  }
  const route = routes.get(req.url);
  if (req.method !== 'GET' || !route) { res.writeHead(404).end(); return; }
  try {
    res.writeHead(200, {'Content-Type': route[1], 'Cache-Control': 'no-store'});
    res.end(await readFile(path.join(root, route[0])));
  } catch { res.writeHead(500).end('Install dependencies with npm install first.'); }
};
const tls = process.env.TLS_CERT && process.env.TLS_KEY;
const server = tls ? https.createServer({cert: await readFile(process.env.TLS_CERT), key: await readFile(process.env.TLS_KEY)}, handler) : http.createServer(handler);
const wss = new WebSocketServer({server, path: '/signals', maxPayload: 8192});
function broadcast(signal) {
  // Explicit allowlist: raw electrode measurements are never relayed or recorded here.
  const output = {type:'signal', intensity:signal.intensity,
    signal_quality:signal.signal_quality, timestamp:signal.timestamp, source:signal.source};
  if (typeof signal.calibrated === 'boolean') output.calibrated = signal.calibrated;
  for (const key of ['reaction_event','test_event']) {
    if (typeof signal[key] === 'boolean') output[key] = signal[key];
  }
  if (Number.isFinite(signal.baseline_progress)) output.baseline_progress = Math.max(0,Math.min(1,signal.baseline_progress));
  if (Array.isArray(signal.quality_reasons)) output.quality_reasons = signal.quality_reasons.filter(v=>typeof v==='string'&&v.length<=64).slice(0,16);
  const payload = JSON.stringify(output);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
}
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1', () => {
  console.log(`Scene: ${tls ? 'https' : 'http'}://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8080}`);
  console.log('Local demo relay; not an authenticated production service.');
});
