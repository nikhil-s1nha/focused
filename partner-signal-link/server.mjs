import http from 'node:http';
import {createSignalReceiver} from './receiver.mjs';
const receiver=createSignalReceiver({token:process.env.SIGNAL_TOKEN,onEvent:e=>console.log(JSON.stringify({id:e.id,event:e.event,source:e.source,value:e.value}))});
const server=http.createServer(receiver.handle);
server.requestTimeout=5000;
server.listen(Number(process.env.SIGNAL_PORT || 48081),'0.0.0.0',()=>console.log('Signal receiver listening on port '+(process.env.SIGNAL_PORT || 48081)));
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{receiver.close();server.close();});
