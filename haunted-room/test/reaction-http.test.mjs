import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {createSignalLink} from '../signal-link/receiver.mjs';
test('reaction ingress and authenticated encounter feedback',async()=>{
 const token='test-token-only-at-least-24-characters';const link=createSignalLink({signalToken:token});
 const server=http.createServer((q,r)=>link.handle(q,r));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
 const m={schema:'horror.reaction.v1',id:'r',session_id:'s',encounter_id:'e',event:'reaction_update',reaction:'startled',confidence:.9,signal_quality:.9,created_at_ms:Date.now(),window_ms:5000,classifier_version:'test'};
 const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post('/signal-link/event',m)).status,401);
 assert.equal((await post('/signal-link/event',m,{Authorization:'Bearer '+token})).status,202);
 assert.equal((await (await post('/signal-link/event',m,{Authorization:'Bearer '+token})).json()).duplicate,true);
 assert.equal((await post('/signal-link/event',{...m,id:'stale',created_at_ms:0},{Authorization:'Bearer '+token})).status,400);
 assert.equal((await post('/signal-link/game',{event:'session_started',session_id:'s'})).status,401);
 assert.equal((await post('/signal-link/game',{event:'session_started',session_id:'s'},{Origin:base})).status,202);
 assert.equal((await fetch(base+'/signal-link/game-state')).status,401);
 const state=await(await fetch(base+'/signal-link/game-state',{headers:{Authorization:'Bearer '+token}})).json();assert.equal(state.current.session_id,'s');
 }finally{link.close();await new Promise(r=>server.close(r));}
});
