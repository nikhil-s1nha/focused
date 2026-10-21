import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {sanitizeThreshold,THRESHOLD_CAPABILITY} from '../public/signal-link/threshold-contract.mjs';
import {createSignalLink} from '../signal-link/receiver.mjs';
import {EventDirector} from '../public/simple/event-director.mjs';
const frame=()=>({schema:'signal-scope.event.v2',id:'460595d4-7075-4183-bb05-023d3e2794d3',event:'reaction',label:'Reaction',value:1,source:'threshold_detector',measurement:'threshold_crossing',emotion:null,created_at_ms:1000,sent_at_ms:1050,detector:{preset:'more-sensitive-v1',threshold:.28,rearm_threshold:.22,score:.35,quality:'unverified',valid_measurement:false,reaction_validated:false}});
test('exact v2 provenance, crossing, UUID and time validation; strip unrelated fields',()=>{
 const m=frame();assert.deepEqual(sanitizeThreshold({...m,secret:'discard'}),m);
 for(const patch of [{id:'not-uuid'},{created_at_ms:1.5},{sent_at_ms:999},{sent_at_ms:3001},{emotion:'fear'},{value:2}])assert.equal(sanitizeThreshold({...m,...patch}),null);
 for(const patch of [{quality:'verified'},{reaction_validated:true},{valid_measurement:true},{score:.28},{rearm_threshold:.28},{extra:1}])assert.equal(sanitizeThreshold({...m,detector:{...m.detector,...patch}}),null);
});
test('v2 drives a hook without upgrading its unverified status',()=>{
 let time=0;const d=new EventDirector({now:()=>time,rng:()=>.2});d.start('s');time=8;d.tick();d.opening=false;d.finish();assert.equal(d.receiveHook({...frame(),received_at_ms:1060}),true);assert.equal(d.pending.quality,'unverified');assert.equal(d.pending.reaction,'hook');time=20;assert.ok(d.tick());
});
test('health advertises exact capability; duplicate suppressed for 60s',async()=>{
 let now=2000;const link=createSignalLink({signalToken:'test-token-at-least-24-characters',now:()=>now});const server=http.createServer((q,r)=>link.handle(q,r));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.deepEqual((await(await fetch(base+'/signal-link/health')).json()).capabilities.automatic_threshold_events,THRESHOLD_CAPABILITY);
 const post=()=>fetch(base+'/signal-link/event',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-token-at-least-24-characters'},body:JSON.stringify(frame())});
 assert.equal((await post()).status,202);assert.equal((await(await post()).json()).duplicate,true);now+=60001;assert.equal((await post()).status,202);
 }finally{link.close();await new Promise(r=>server.close(r));}
});
