import {WebSocketServer} from 'ws';
import {mockFrame} from './src/eeg/protocol.js';
const server=new WebSocketServer({port:8765,host:'127.0.0.1'});
server.on('connection',ws=>{let n=0;ws.on('message',raw=>{try{const m=JSON.parse(raw);if(m.type==='ping')ws.send(JSON.stringify({type:'pong',clientSentAt:m.clientSentAt,serverAt:Date.now()}));}catch{}});const timer=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify(mockFrame(n++,.5+.4*Math.sin(n*.03),n%80===0?'blink':null)));},100);ws.on('close',()=>clearInterval(timer));});
console.log('Mock EEG listening on 127.0.0.1:8765; viewer proxies /eeg');
