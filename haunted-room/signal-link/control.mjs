import {randomUUID} from 'node:crypto';
export const CONTROL_CAPABILITY={schema:'signal-scope.control.v1',transport:'sse',stream:'/signal-link/control/events',ack:'/signal-link/control/ack',actions:['start','stop']};
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
export function createControl({authorized,json,now=Date.now}){
 let client=null,state={status:'disconnected'},current=null;const closed=new Set();
 const snapshot=()=>({...state,connected:!!client});
 function command(action,round){
  if(!uuid(round))return;
  if(action==='start'&&(closed.has(round)||current?.round_id===round))return;
  if(action==='stop')closed.add(round);
  if(action==='stop'&&current?.round_id!==round)return;
  if(!client){state={status:'disconnected'};return;}
  if(action==='start'&&current){return;}
  const c={schema:'signal-scope.control.v1',id:randomUUID(),action,round_id:round,created_at_ms:now()};
  current=c;state={status:'awaiting_ack',action,round_id:round};
  if(client.writableLength<32768)client.write(`data: ${JSON.stringify(c)}\n\n`);else client.destroy();
 }
 function handle(req,res,path){
  if(path==='/signal-link/control/state'){if(req.method!=='GET'){json(res,405,{});return true;}json(res,200,snapshot());return true;}
  if(!['/signal-link/control/events','/signal-link/control/ack'].includes(path))return false;
  if(!authorized(req)){json(res,401,{error:'Unauthorized'});req.resume();return true;}
  if(req.method!==(path.endsWith('/events')?'GET':'POST')){json(res,405,{});return true;}
  if(path.endsWith('/events')){
   if(client){json(res,409,{error:'Controller already connected'});return true;}
   current=null;state={status:'idle'};client=res;
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write(': idle; new Start required\n\n');
   const beat=setInterval(()=>{if(res.writableLength<32768)res.write(': heartbeat\n\n');else res.destroy();},5000);beat.unref();
   res.on('close',()=>{clearInterval(beat);if(current)closed.add(current.round_id);current=null;client=null;state={status:'disconnected'};});return true;
  }
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){json(res,415,{});req.resume();return true;}
  let body='',bytes=0;req.on('data',b=>{bytes+=b.length;if(bytes<=4096)body+=b;});
  req.on('end',()=>{let a;try{a=JSON.parse(body);}catch{};
   const keys=['schema','id','round_id','action','status','received_at_ms','reason'];
   if(bytes>4096||!a||Object.keys(a).some(k=>!keys.includes(k))||a.schema!=='signal-scope.control-ack.v1'||!current||a.id!==current.id||a.round_id!==current.round_id||a.action!==current.action||!Number.isSafeInteger(a.received_at_ms)||a.received_at_ms<0||!['starting','running','stopping','stopped','rejected','failed'].includes(a.status)||(a.reason!==undefined&&(typeof a.reason!=='string'||a.reason.length>128))){json(res,400,{error:'Invalid or unmatched acknowledgment'});return;}
   if((a.action==='stop'&&['starting','running'].includes(a.status))||(a.action==='start'&&['stopping','stopped'].includes(a.status))){json(res,400,{});return;}
   if(state.status==='running'&&a.status==='starting'){json(res,200,{accepted:true});return;}
   state={status:a.status,action:a.action,round_id:a.round_id,received_at_ms:a.received_at_ms};
   if(['stopped','rejected','failed'].includes(a.status)){closed.add(a.round_id);current=null;}
   json(res,200,{accepted:true});
  });req.on('error',()=>res.destroy());return true;
 }
 return {handle,command,snapshot,close(){client?.end();}};
}
