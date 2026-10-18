import test from 'node:test';import assert from 'node:assert/strict';
import {SignalLinkAdapter} from '../public/signal-link/adapter.mjs';
import {EventDirector} from '../public/simple/event-director.mjs';
test('original hook passes adapter to scheduler, not an immediate fixed effect',()=>{
 let time=0,calls=0;const d=new EventDirector({now:()=>time,rng:()=>.2});d.start('session');time=8;d.tick();d.opening=false;d.finish();
 const a=new SignalLinkAdapter({onHook:m=>d.receiveHook(m),actions:{environment:()=>calls++}});a.enabled=true;
 const m={schema:'signal-scope.event.v1',id:'partner-id',event:'startle_flinch',source:'manual_marker',measurement:'operator_annotation',emotion:null,label:'Reaction',value:.7,created_at_ms:1,sent_at_ms:1,received_at_ms:2};
 assert.equal(a.receive(m),true);assert.equal(calls,0);assert.equal(d.tick(),null);
 assert.equal(a.receive(m),false);time=18;assert.ok(d.tick());assert.equal(a.snapshot().received,2);
});
