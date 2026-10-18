import {createControl,CONTROL_CAPABILITY} from './control.mjs';
import {sanitizeThreshold,THRESHOLD_CAPABILITY} from '../public/signal-link/threshold-contract.mjs';
import {validReaction} from '../public/signal-link/reaction-contract.mjs';
import { timingSafeEqual } from 'node:crypto';

const EVENTS = new Set(['blink', 'jaw_clench', 'startle_flinch', 'reaction']);
const FIELDS = ['schema','id','event','source','measurement','emotion','label','value','created_at_ms','sent_at_ms'];
const bounded = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
export function sanitizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !FIELDS.includes(k))) return null;
  if (input.schema !== 'signal-scope.event.v1' || !bounded(input.id,128) || !EVENTS.has(input.event)) return null;
  if (!['manual_test','manual_marker'].includes(input.source) || !['manual_test','operator_annotation'].includes(input.measurement) || input.emotion !== null || !bounded(input.label,160)) return null;
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0 || input.value > 1) return null;
  if (![input.created_at_ms,input.sent_at_ms].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return Object.fromEntries(FIELDS.map(k => [k,input[k]]));
}

/** One mounted receiver: authenticated ingress and same-origin, live-only SSE. */
export function createSignalLink({ signalToken = process.env.SIGNAL_TOKEN, now = Date.now, heartbeatMs = 15000 } = {}) {
  const enabled = typeof signalToken === 'string' && signalToken.length >= 24;
  const clients = new Set(), seen = new Map(), gameClients = new Set();
  let gameState=null;
  let packetSending=false, activeSession=null;
  let accepted = 0, duplicates = 0, rejected = 0, lastEvent = null;
  function json(res,status,body) { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(body)); }
  function authorized(req) {
    const supplied = req.headers.authorization;
    if (typeof supplied !== 'string') return false;
    const actual = Buffer.from(supplied), expected = Buffer.from(`Bearer ${signalToken}`);
    return actual.length === expected.length && timingSafeEqual(actual,expected);
  }
  const control=createControl({authorized,json,now});
  function handle(req,res,pathname = new URL(req.url,'http://local').pathname) {
    if(control.handle(req,res,pathname))return true;
    if (!['/signal-link/event','/signal-link/events','/signal-link/health','/signal-link/game','/signal-link/game-events','/signal-link/game-state'].includes(pathname)) return false;
    const method = ['/signal-link/event','/signal-link/game'].includes(pathname) ? 'POST' : 'GET';
    if (req.method !== method) { res.writeHead(405,{Allow:method}).end(); return true; }
    if(pathname==='/signal-link/game-state'||pathname==='/signal-link/game-events') {
      if(!authorized(req)){json(res,401,{error:'Unauthorized'});return true;}
      if(pathname.endsWith('game-state')){json(res,200,{current:gameState});return true;}
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.flushHeaders();res.write(': connected\n\n');gameClients.add(res);
      const beat=setInterval(()=>{if(res.writableLength<32768)res.write(': heartbeat\n\n');else res.destroy();},heartbeatMs);beat.unref();
      res.on('close',()=>{clearInterval(beat);gameClients.delete(res);});return true;
    }
    if (pathname === '/signal-link/health') { json(res,200,{enabled,capabilities:{automatic_threshold_events:THRESHOLD_CAPABILITY,acquisition_control:CONTROL_CAPABILITY},status:enabled?'ready':'Configure SIGNAL_TOKEN with at least 24 characters',clients:clients.size,accepted,duplicates,rejected,last_event:lastEvent}); return true; }
    if (pathname === '/signal-link/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.flushHeaders(); res.write(': connected\n\n'); clients.add(res);
      const heartbeat = setInterval(() => { if (res.writableLength < 32768) res.write(': heartbeat\n\n'); else res.destroy(); },heartbeatMs);
      heartbeat.unref();
      res.on('close',() => { clearInterval(heartbeat); clients.delete(res); });
      return true;
    }
    if (!enabled) { json(res,503,{error:'Signal link disabled: configure SIGNAL_TOKEN with at least 24 characters'}); req.resume(); return true; }
    const gamePost=pathname==='/signal-link/game';
    const sameOrigin=gamePost && req.headers.origin && (()=>{try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}})();
    if (!(gamePost ? sameOrigin : authorized(req))) { rejected++; json(res,401,{error:'Unauthorized'}); req.resume(); return true; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { rejected++; json(res,415,{error:'Content-Type must be application/json'}); req.resume(); return true; }
    let bytes = 0, chunks = [];
    req.on('data',chunk => { bytes += chunk.length; if (bytes <= 8192) chunks.push(chunk); });
    req.on('end',() => {
      if (bytes > 8192) { rejected++; json(res,413,{error:'Event exceeds 8192 bytes'}); return; }
      let event; try {
        const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(gamePost){
          if(['session_started','encounter_started','encounter_finished','session_ended'].includes(raw.event)&&bounded(raw.session_id,128)&&(!raw.encounter_id||bounded(raw.encounter_id,128))){
            event={event:raw.event,session_id:raw.session_id};
            for(const key of ['encounter_id','kind','door','character'])if(bounded(raw[key],128))event[key]=raw[key];
          }
        }else if(raw.schema==='signal-scope.event.v2'){event=sanitizeThreshold(raw);
        }else if(validReaction(raw)&&raw.received_at_ms===undefined){
          if(now()-raw.created_at_ms>15000||raw.created_at_ms-now()>5000){json(res,400,{error:'Stale/future reaction; synchronize sender clock'});return;}
          event=raw;
        }else event=sanitizeEvent(raw);
      } catch {}
      if (!event) { rejected++; json(res,400,{error:'Invalid signal-scope.event.v1 event'}); return; }
      if(gamePost){
        if(event.event==='session_started')control.command('start',event.session_id);
        if(event.event==='session_ended')control.command('stop',event.session_id);
        if(event.event==='session_started'){packetSending=true;activeSession=event.session_id;}
        if(event.event==='session_ended'&&event.session_id===activeSession)packetSending=false;
        gameState={...event,packet_sending:packetSending,active_session_id:activeSession,received_at_ms:now()};for(const client of gameClients){if(client.writableLength<32768)client.write(`data: ${JSON.stringify(gameState)}\n\n`);else client.destroy();}json(res,202,{accepted:true});return;}
      for(const [id,at] of seen)if(now()-at>=60000)seen.delete(id);
      if (seen.has(event.id)) { duplicates++; json(res,200,{accepted:true,duplicate:true,id:event.id}); return; }
      seen.set(event.id,now());
      const frame = {...event,received_at_ms:now()}; accepted++; lastEvent = {id:event.id,event:event.event,received_at_ms:frame.received_at_ms};
      const text = `data: ${JSON.stringify(frame)}\n\n`;
      for (const client of clients) { if (client.writableLength < 32768) client.write(text); else client.destroy(); }
      json(res,202,{accepted:true,duplicate:false,id:event.id,received_at_ms:frame.received_at_ms});
    });
    req.on('error',() => { if (!res.writableEnded) res.destroy(); });
    return true;
  }
  return {handle, close() { control.close(); for (const client of [...clients,...gameClients]) client.end(); clients.clear(); seen.clear(); }};
}
