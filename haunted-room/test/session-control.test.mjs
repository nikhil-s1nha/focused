import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createSignalLink} from '../signal-link/receiver.mjs';
test('start, encounters and stop expose authenticated sender control state',async()=>{
 const token='test-token-at-least-24-characters',link=createSignalLink({signalToken:token});
 const server=http.createServer((q,r)=>link.handle(q,r));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const state=async()=> (await(await fetch(base+'/signal-link/game-state',{headers:{Authorization:`Bearer ${token}`}})).json()).current;
 const post=async(event,session_id='round')=>assert.equal((await fetch(base+'/signal-link/game',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({event,session_id})})).status,202);
 try{
 assert.equal((await fetch(base+'/signal-link/game-state')).status,401);
 assert.equal(await state(),null);
 await post('session_started');assert.equal((await state()).packet_sending,true);
 await post('encounter_finished');assert.equal((await state()).packet_sending,true);
 await post('session_ended','old-round');assert.equal((await state()).packet_sending,true);
 await post('session_ended');assert.equal((await state()).packet_sending,false);
 await post('session_started','new-round');assert.equal((await state()).active_session_id,'new-round');
 }finally{link.close();await new Promise(r=>server.close(r));}
});
