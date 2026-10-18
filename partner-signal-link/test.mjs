import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {AUTOMATIC_CAPABILITY,createSignalReceiver,validateEvent} from './receiver.mjs';
import {randomUUID} from 'node:crypto';
const token='test-only-token-abcdefghijklmnopqrstuvwxyz';
const packet={schema:'signal-scope.event.v1',id:'test-1',event:'blink',source:'manual_marker',measurement:'operator_annotation',emotion:null,label:'Blink',sent_at_ms:Date.now(),created_at_ms:Date.now(),value:1};
test('contract rejects emotion claims, bad values, and strips extra raw data',()=>{
  for(const change of [{emotion:'fear'},{source:'eeg'},{value:NaN},{value:2},{id:''},{event:'fear'}])assert.throws(()=>validateEvent({...packet,...change}));
  assert.equal(validateEvent({...packet,raw_samples:[1,2]}).raw_samples,undefined);
});
test('HTTP sender → authenticated receiver → live browser SSE; dedup and malformed input',async t=>{
  const events=[];const receiver=createSignalReceiver({token,onEvent:e=>events.push(e)});
  const server=http.createServer(receiver.handle);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const controller=new AbortController();
  t.after(()=>{controller.abort();receiver.close();server.closeAllConnections();server.close();});
  const response=await fetch(base+'/signal-link/events',{signal:controller.signal});
  const reader=response.body.getReader();await reader.read();
  const post=(data,auth=token)=>fetch(base+'/signal-link/event',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(data)});
  assert.equal((await post(packet,'wrong')).status,401);
  assert.equal((await post({...packet,event:'fear'})).status,400);
  assert.equal((await post({...packet,label:'x'.repeat(5000)})).status,413);
  const result=await post(packet);assert.equal(result.status,202);assert.equal((await result.json()).subscribers,1);
  const text=new TextDecoder().decode((await reader.read()).value);assert.match(text,/"event":"blink"/);
  assert.equal((await (await post(packet)).json()).duplicate,true);assert.equal(events.length,1);
  const child=spawn('python3',['send.py','--target',base,'--event','startle_flinch'],{cwd:new URL('.',import.meta.url),env:{...process.env,SIGNAL_TOKEN:token}});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  const [code]=await once(child,'close');assert.equal(code,0,output);assert.equal(events.length,2);assert.equal(events[1].source,'manual_test');
  const health=await (await fetch(base+'/signal-link/health')).json();assert.equal(health.received,2);
});

const thresholdPacket=(updates={})=>({...packet,schema:'signal-scope.event.v2',id:randomUUID(),event:'reaction',
  label:'Reaction',source:'threshold_detector',measurement:'threshold_crossing',
  detector:{preset:'more-sensitive-v1',threshold:.28153449356783367,rearm_threshold:.22522759485426695,
    score:.35,quality:'unverified',valid_measurement:false,reaction_validated:false},...updates});
test('v1 and v2 require integer, ordered, nonnegative Unix millisecond timestamps',()=>{
  for(const sample of [packet,thresholdPacket()]) {
    for(const changes of [{sent_at_ms:1.5},{created_at_ms:NaN},{sent_at_ms:true},{created_at_ms:-1},
      {sent_at_ms:Number.MAX_SAFE_INTEGER+1},{created_at_ms:sample.sent_at_ms+1}])
      assert.throws(()=>validateEvent({...sample,...changes}));
  }
  assert.throws(()=>validateEvent(thresholdPacket({created_at_ms:packet.sent_at_ms-2001})));
});
test('v2 requires exact unverified provenance and valid detector metadata',()=>{
  const original=thresholdPacket();assert.deepEqual(validateEvent(original),original);
  for(const changes of [{source:'manual_marker'},{measurement:'operator_annotation'},{emotion:'fear'},
    {event:'blink'},{id:'not-a-uuid'},{value:true},{value:Infinity}])
    assert.throws(()=>validateEvent({...original,...changes}));
  for(const changes of [{quality:'verified'},{valid_measurement:true},{reaction_validated:true},
    {score:NaN},{score:original.detector.threshold},{threshold:0},{rearm_threshold:-1},
    {score:true},{preset:''},{preset:'x\n'},{extra:'anything'}])
    assert.throws(()=>validateEvent({...original,detector:{...original.detector,...changes}}));
  for(const field of Object.keys(original.detector)) {
    const detector={...original.detector};delete detector[field];
    assert.throws(()=>validateEvent({...original,detector}));
  }
  const sanitized=validateEvent({...original,raw_samples:[1,2],token:'secret',session:'local-session'});
  assert.equal(sanitized.raw_samples,undefined);assert.equal(sanitized.token,undefined);assert.equal(sanitized.session,undefined);
});
test('health advertises exact v2 capability; v1 and v2 coexist and duplicate v2 never dispatches twice',async t=>{
  const events=[];const receiver=createSignalReceiver({token,onEvent:e=>events.push(e)});
  const server=http.createServer(receiver.handle);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>{receiver.close();server.closeAllConnections();server.close();});
  const health=await(await fetch(base+'/signal-link/health')).json();
  assert.deepEqual(health.capabilities.automatic_threshold_events,AUTOMATIC_CAPABILITY);
  assert.equal(JSON.stringify(health).includes(token),false);
  const post=data=>fetch(base+'/signal-link/event',{method:'POST',headers:{'Content-Type':'application/json',
    Authorization:'Bearer '+token},body:JSON.stringify(data)});
  assert.equal((await post(packet)).status,202);
  const automatic=thresholdPacket();
  assert.equal((await post(automatic)).status,202);
  const duplicate=await post(automatic);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);
  assert.equal(events.length,2);assert.equal(events[1].source,'threshold_detector');assert.equal(events[1].emotion,null);
  assert.equal(events[1].detector.quality,'unverified');assert.equal(events[1].detector.valid_measurement,false);
  assert.equal((await post({...automatic,id:randomUUID(),detector:{...automatic.detector,quality:'verified'}})).status,400);
});
