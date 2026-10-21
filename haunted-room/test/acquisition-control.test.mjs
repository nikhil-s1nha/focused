import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {randomUUID} from 'node:crypto';import {createSignalLink} from '../signal-link/receiver.mjs';
test('authenticated control, exact commands, matching ACK and no replay',async()=>{
 const token='test-token-at-least-24-characters',link=createSignalLink({signalToken:token});const server=http.createServer((q,r)=>link.handle(q,r));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,auth={Authorization:`Bearer ${token}`};let reader;
 const post=async(event,session_id)=>fetch(base+'/signal-link/game',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({event,session_id})});
 const ack=a=>fetch(base+'/signal-link/control/ack',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(a)});
 try{
 assert.equal((await fetch(base+'/signal-link/control/events')).status,401);
 const h=await(await fetch(base+'/signal-link/health')).json();assert.equal(h.capabilities.acquisition_control.schema,'signal-scope.control.v1');
 const stream=await fetch(base+'/signal-link/control/events',{headers:auth});reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/idle/);
 const round=randomUUID();await post('session_started',round);const chunk=new TextDecoder().decode((await reader.read()).value);const c=JSON.parse(chunk.trim().slice(6));assert.deepEqual(Object.keys(c).sort(),['schema','id','action','round_id','created_at_ms'].sort());assert.equal(c.action,'start');assert.equal(c.round_id,round);
 const a={schema:'signal-scope.control-ack.v1',id:c.id,round_id:round,action:'start',status:'running',received_at_ms:Date.now()};assert.equal((await ack({...a,id:randomUUID()})).status,400);assert.equal((await ack(a)).status,200);
 assert.equal((await(await fetch(base+'/signal-link/control/state')).json()).status,'running');
 await post('session_ended',round);const stop=JSON.parse(new TextDecoder().decode((await reader.read()).value).trim().slice(6));assert.equal(stop.action,'stop');assert.notEqual(stop.id,c.id);assert.equal(stop.round_id,round);
 assert.equal((await ack({...a,id:stop.id,action:'stop',status:'stopped'})).status,200);
 await reader.cancel();reader=null;await new Promise(r=>setTimeout(r,20));
 const reconnect=await fetch(base+'/signal-link/control/events',{headers:{...auth,'Last-Event-ID':c.id}});reader=reconnect.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/^: idle/);assert.equal((await(await fetch(base+'/signal-link/control/state')).json()).status,'idle');
 }finally{await reader?.cancel();link.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
