import {timingSafeEqual} from 'node:crypto';

export const AUTOMATIC_CAPABILITY=Object.freeze({schema:'signal-scope.event.v2',source:'threshold_detector',
  measurement:'threshold_crossing',event:'reaction',emotion:null,quality:'unverified',detector_version:1});
const names = new Set(['blink', 'jaw_clench', 'startle_flinch', 'reaction']);
const uuid4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unixMs=value=>Number.isSafeInteger(value)&&value>=0;
const detectorKeys=['preset','threshold','rearm_threshold','score','quality','valid_measurement','reaction_validated'];
export function validateEvent(e) {
  if (!e || !['signal-scope.event.v1','signal-scope.event.v2'].includes(e.schema) ||
      typeof e.id !== 'string' || !/^[\w:-]{1,160}$/.test(e.id) || !names.has(e.event) || e.emotion !== null ||
      typeof e.label !== 'string' || e.label.length > 120 || /[\x00-\x1f\x7f]/.test(e.label) ||
      !unixMs(e.sent_at_ms) || !unixMs(e.created_at_ms) || e.created_at_ms>e.sent_at_ms ||
      !Number.isFinite(e.value) || e.value < 0 || e.value > 1)
    throw new Error('Invalid event contract');
  const result=Object.fromEntries(['schema','id','event','source','measurement','emotion','label','sent_at_ms','created_at_ms','value'].map(k=>[k,e[k]]));
  if(e.schema==='signal-scope.event.v1') {
    if(!['manual_test','manual_marker'].includes(e.source) || e.measurement!=='operator_annotation')throw new Error('Invalid v1 provenance');
  } else {
    const d=e.detector;
    if(!uuid4.test(e.id) || e.source!=='threshold_detector' || e.measurement!=='threshold_crossing' || e.event!=='reaction' ||
        !d || typeof d!=='object' || Array.isArray(d) || Object.keys(d).length!==detectorKeys.length ||
        !detectorKeys.every(k=>Object.hasOwn(d,k)) ||
        typeof d.preset!=='string' || d.preset.length<1 || d.preset.length>80 || /[\x00-\x1f\x7f]/.test(d.preset) ||
        !Number.isFinite(d.threshold) || !Number.isFinite(d.rearm_threshold) || !Number.isFinite(d.score) ||
        d.rearm_threshold<0 || d.threshold<=d.rearm_threshold || d.score<=d.threshold ||
        d.quality!=='unverified' || d.valid_measurement!==false || d.reaction_validated!==false ||
        e.sent_at_ms-e.created_at_ms>2000)throw new Error('Invalid v2 threshold provenance');
    result.detector=Object.fromEntries(detectorKeys.map(k=>[k,d[k]]));
  }
  // Explicit allowlist: never forwards raw samples, authentication, or inferred emotion.
  return result;
}

export function createSignalReceiver({token, onEvent=()=>{}}={}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('Set SIGNAL_TOKEN to at least 24 characters');
  const clients = new Set(), seen = new Map();
  let count=0, lastReceived=null;
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const expected=Buffer.from('Bearer '+token);
  async function handle(req,res,next=()=>{res.writeHead(404);res.end();}) {
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/signal-link/health' && req.method==='GET') return json(res,200,{ok:true,received:count,subscribers:clients.size,last_received_at_ms:lastReceived,capabilities:{automatic_threshold_events:{...AUTOMATIC_CAPABILITY}}});
    if(path==='/signal-link/events' && req.method==='GET') {
      // Same-origin only; no permissive CORS. The headset uses its game's origin.
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','X-Accel-Buffering':'no'});
      res.write(': connected\n\n'); clients.add(res);
      const timer=setInterval(()=>res.write(': heartbeat\n\n'),10000);
      req.on('close',()=>{clearInterval(timer);clients.delete(res);}); return;
    }
    if(path!=='/signal-link/event' || req.method!=='POST') return next();
    const provided=Buffer.from(req.headers.authorization || '');
    if(provided.length!==expected.length || !timingSafeEqual(provided,expected)) return json(res,401,{error:'Invalid sender token'});
    if(!(req.headers['content-type'] || '').startsWith('application/json')) return json(res,415,{error:'Use application/json'});
    let body='',size=0;
    try {
      for await(const chunk of req) {size+=chunk.length;if(size>4096){json(res,413,{error:'Event too large'});return;}body+=chunk;}
      const event=validateEvent(JSON.parse(body)), now=Date.now();
      for(const [id,at] of seen)if(now-at>60000)seen.delete(id);
      if(seen.has(event.id))return json(res,200,{accepted:true,duplicate:true,id:event.id,subscribers:clients.size});
      const delivered={...event,received_at_ms:now};
      onEvent(delivered);
      seen.set(event.id,now); if(seen.size>10000)seen.delete(seen.keys().next().value);
      count++;lastReceived=now;
      for(const client of clients) {
        if(client.writableLength>65536){client.destroy();clients.delete(client);continue;}
        client.write('data: '+JSON.stringify(delivered)+'\n\n');
      }
      json(res,202,{accepted:true,id:event.id,subscribers:clients.size});
    }catch(error){json(res,400,{error:'Invalid event or receiver handler failed'});}
  }
  function close(){for(const c of clients)c.destroy();clients.clear();}
  return {handle,close};
}
