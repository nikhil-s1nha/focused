import test from 'node:test';import assert from 'node:assert/strict';
import {EventDirector} from '../public/simple/event-director.mjs';
const packet=(e,id='r1',extra={})=>({schema:'horror.reaction.v1',id,session_id:'s',encounter_id:e.encounter_id,event:'reaction_update',reaction:'no_detected_reaction',confidence:.9,signal_quality:.9,created_at_ms:Date.now(),window_ms:5000,classifier_version:'test',...extra});
test('three opening probes; valid hooks gate later encounters and cooldown',()=>{
 let time=0;const log=[];const d=new EventDirector({now:()=>time,rng:()=>.2,emit:e=>log.push(e)});d.start('s');assert.equal(d.tick(),null);time=8;const e=d.tick();assert.ok(e);assert.equal(d.tick(),null);d.finish();time=30;let opening2=d.tick();assert.ok(opening2);d.finish();time=40;let opening3=d.tick();assert.ok(opening3);d.finish();time=50;assert.equal(d.tick(),null);
 assert.equal(d.receive(packet(opening3)),true);const next=d.tick();assert.ok(next);assert.notEqual(next.kind,opening3.kind);assert.notEqual(next.door,opening3.door);d.finish();assert.equal(d.tick(),null);d.stop();time=100;assert.equal(d.tick(),null);assert.equal(log.at(-1).event,'session_ended');
});
test('reject duplicate, wrong session/encounter, poor quality; expire and clear pending on disconnect',()=>{
 let time=0;const d=new EventDirector({now:()=>time,rng:()=>.2});d.start('s');time=8;const e=d.tick();d.opening=false;
 assert.equal(d.receive(packet(e,'bad',{session_id:'other'})),false);
 assert.equal(d.receive(packet(e,'bad2',{signal_quality:.1})),false);
 assert.equal(d.receive(packet(e)),true);assert.equal(d.receive(packet(e)),false);
 d.finish();time=40;assert.equal(d.tick(),null);
 d.receive(packet(e,'r2'));d.disconnect();assert.equal(d.tick(),null);
});
test('strong reactions require longer recovery and choose contrast',()=>{
 let time=0;const d=new EventDirector({now:()=>time,rng:()=>.2});d.start('s');time=8;const e=d.tick();d.opening=false;e.opening_probe=false;d.receive(packet(e,'strong',{reaction:'startled',reaction_strength:.9}));d.finish();time=14;assert.equal(d.tick(),null);time=18;const next=d.tick();assert.ok(['watcher','feint','lighting','audio'].includes(next.kind));
});

test('opening samples three distinct types with five-second attribution gaps',()=>{
 let time=0;const d=new EventDirector({now:()=>time,rng:()=>.2});d.start('s');time=8;const kinds=[];
 for(let i=0;i<3;i++){const e=d.tick();assert.ok(e);kinds.push(e.kind);d.finish();time+=4;assert.equal(d.tick(),null);time+=1;}
 assert.equal(new Set(kinds).size,3);time+=30;assert.equal(d.tick(),null);
});

test('unchanged partner JSON drives the director without new IDs or classifier fields',()=>{
 let time=0;const d=new EventDirector({now:()=>time,rng:()=>.2});d.start('s');time=8;d.tick();d.opening=false;d.finish();
 const m={schema:'signal-scope.event.v1',id:'existing-event',event:'startle_flinch',source:'manual_marker',measurement:'operator_annotation',emotion:null,label:'Startle / flinch',value:.7,created_at_ms:1,sent_at_ms:1,received_at_ms:2};
 assert.equal(d.receiveHook(m),true);assert.equal(d.receiveHook(m),false);
 time=14;assert.equal(d.tick(),null);time=18;assert.ok(d.tick());d.finish();time=50;assert.equal(d.tick(),null);
});

 test('five-second cadence continues without packets and never overlaps',()=>{
 let time=0;const d=new EventDirector({cadenceSeconds:5,now:()=>time,rng:()=>.2});d.start('s');
 time=8;for(let i=0;i<7;i++){assert.ok(d.tick());time+=2;assert.equal(d.tick(),null);d.finish();time+=2.9;assert.equal(d.tick(),null);time+=.1;}
 d.stop();time+=20;assert.equal(d.tick(),null);
 });
