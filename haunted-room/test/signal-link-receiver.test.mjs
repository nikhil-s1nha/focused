import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneServer } from '../server.mjs';
import { sanitizeEvent, createSignalLink } from '../signal-link/receiver.mjs';
import { EventEmitter } from 'node:events';
const token = 'unit-test-only-token-123456789';
const frame = (id='event-1') => ({schema:'signal-scope.event.v1',id,event:'blink',source:'manual_test',measurement:'manual_test',emotion:null,label:'Manual blink',value:0.7,created_at_ms:1792278000000,sent_at_ms:1792278000100});
async function setup(t,signalToken=token) {
  const app = createSceneServer({signalToken});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { app.signalLink.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  return {origin, post:(body=frame(),auth=token) => fetch(origin+'/signal-link/event',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${auth}`}:{})},body:JSON.stringify(body)})};
}
test('event contract rejects unsupported inputs and arbitrary fields',() => {
  assert.deepEqual(sanitizeEvent(frame()),frame());
  for (const change of [{event:'fear'},{source:'eeg'},{emotion:'fear'},{measurement:'eeg'},{value:1.1},{value:NaN},{created_at_ms:1.5},{id:''},{label:'bad\nlabel'},{command:'run'}]) assert.equal(sanitizeEvent({...frame(),...change}),null);
});
test('same origin health and mandatory authentication preserve ordinary game routes',async t => {
  const {origin,post} = await setup(t);
  assert.equal((await fetch(origin+'/')).status,200);
  assert.equal((await fetch(origin+'/healthz')).status,200);
  assert.equal((await fetch(origin+'/signal-link/health')).status,200);
  assert.equal((await post(frame(),null)).status,401);
  assert.equal((await post(frame(),'wrong')).status,401);
  assert.equal((await post({...frame(),event:'unknown'})).status,400);
  assert.equal((await post({...frame(),label:'x'.repeat(9000)})).status,413);
  const accepted = await post(); assert.equal(accepted.status,202);
  const body = await accepted.json(); assert.equal(body.id,'event-1'); assert.ok(Number.isSafeInteger(body.received_at_ms));
  assert.equal((await post()).status,200);
  const health = await (await fetch(origin+'/signal-link/health')).json();
  assert.equal(health.accepted,1); assert.equal(health.duplicates,1); assert.equal(JSON.stringify(health).includes(token),false);
});
test('no configured token disables ingress but leaves game and health available',async t => {
  const {origin,post} = await setup(t,'');
  assert.equal((await post()).status,503);
  const health = await (await fetch(origin+'/signal-link/health')).json();
  assert.equal(health.enabled,false); assert.match(health.status,/SIGNAL_TOKEN/);
  assert.equal((await fetch(origin+'/')).status,200);
});
test('SSE streams immediately, deduplicates IDs, and never replays after reconnect',async t => {
  const {origin,post} = await setup(t);
  const controller = new AbortController();
  const response = await fetch(origin+'/signal-link/events',{signal:controller.signal});
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value),/: connected/);
  await post();
  const wire = decoder.decode((await reader.read()).value);
  assert.match(wire,/data: /); assert.doesNotMatch(wire,/^id:/m);
  const delivered = JSON.parse(wire.slice(wire.indexOf('data: ')+6).trim());
  assert.equal(delivered.id,'event-1'); assert.equal(delivered.emotion,null); assert.ok(delivered.received_at_ms);
  await post();
  controller.abort(); await reader.cancel().catch(()=>{});
  const reconnect = new AbortController();
  const next = await fetch(origin+'/signal-link/events',{signal:reconnect.signal});
  const nextReader = next.body.getReader();
  assert.equal(decoder.decode((await nextReader.read()).value),': connected\n\n');
  await post(frame('event-2'));
  const nextWire = decoder.decode((await nextReader.read()).value);
  assert.match(nextWire,/event-2/); assert.doesNotMatch(nextWire,/event-1/);
  reconnect.abort(); await nextReader.cancel().catch(()=>{});
});

test('mounted receiver broadcasts sanitized frames and closes streams without sockets',() => {
  const link = createSignalLink({signalToken:token,now:()=>1792278000200});
  function response() { const res = new EventEmitter(); Object.assign(res,{writableLength:0,body:'',flushHeaders(){},writeHead(status,headers){this.status=status;this.headers=headers;return this;},write(chunk){this.body+=chunk;return true;},end(chunk=''){this.body+=chunk;this.writableEnded=true;this.emit('close');},destroy(){this.emit('close');}}); return res; }
  const stream = response();
  link.handle({method:'GET',url:'/signal-link/events'},stream);
  assert.equal(stream.body,': connected\n\n');
  const req = new EventEmitter(); Object.assign(req,{method:'POST',url:'/signal-link/event',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}});
  const res = response(); link.handle(req,res); req.emit('data',Buffer.from(JSON.stringify(frame()))); req.emit('end');
  assert.equal(res.status,202); assert.match(stream.body,/received_at_ms/); assert.equal(JSON.parse(res.body).received_at_ms,1792278000200);
  const before = stream.body;
  const duplicate = new EventEmitter(); Object.assign(duplicate,{method:'POST',url:'/signal-link/event',headers:req.headers});
  const dupRes = response(); link.handle(duplicate,dupRes); duplicate.emit('data',Buffer.from(JSON.stringify(frame()))); duplicate.emit('end');
  assert.equal(dupRes.status,200); assert.equal(stream.body,before);
  link.close(); assert.equal(stream.writableEnded,true);
});
