import {validateFrame} from './protocol.js';
export class EEGClient extends EventTarget{
 constructor({socketFactory=url=>new WebSocket(url),now=()=>Date.now()}={}){super();this.factory=socketFactory;this.now=now;this.status='disconnected';this.offset=null;this.rtt=null;this.invalid=0;this.seen=new Set();this.arrivals=[];this.generation=0;}
 emit(type,detail){const event=new Event(type);event.detail=detail;this.dispatchEvent(event);}
 state(status){this.status=status;this.emit('status',status);}
 connect(url){this.disconnect();this.url=url;this.retry=500;const gen=this.generation;this.open(gen);}
 open(gen){if(gen!==this.generation)return;this.state('connecting');let ws;try{ws=this.factory(this.url);}catch(e){this.state('disconnected');this.timer=setTimeout(()=>this.open(gen),this.retry);return;}this.ws=ws;
 ws.onopen=()=>{if(gen!==this.generation)return;this.state('waiting');this.retry=500;this.sync();this.pinger=setInterval(()=>this.sync(),3000);this.watch=setInterval(()=>{if(this.lastAt&&this.now()-this.lastAt>2000)this.state('stale');},500);};
 ws.onmessage=e=>{if(gen!==this.generation)return;try{this.ingest(JSON.parse(e.data));}catch(err){this.invalid++;this.emit('error',err.message);}};
 ws.onerror=()=>ws.close();ws.onclose=()=>{if(gen!==this.generation)return;clearInterval(this.pinger);clearInterval(this.watch);this.state('disconnected');this.timer=setTimeout(()=>this.open(gen),this.retry);this.retry=Math.min(this.retry*2,10000);};}
 sync(){if(this.ws?.readyState===1){this.pingAt=this.now();this.ws.send(JSON.stringify({type:'ping',clientSentAt:this.pingAt}));}}
 ingest(f){const now=this.now();if(f.type==='pong'){if(f.clientSentAt!==this.pingAt||!Number.isFinite(f.serverAt))return;const rtt=now-f.clientSentAt;if(this.rtt===null||rtt<=this.rtt*1.5){this.rtt=rtt;this.offset=f.serverAt-(f.clientSentAt+now)/2;}return;}
 validateFrame(f);this.frame=f;this.lastAt=now;this.state('live');this.arrivals=this.arrivals.filter(t=>now-t<2000);this.arrivals.push(now);this.emit('frame',f);this.emit('score',f.score);this.emit('bandPower',f.channels);this.emit('qualityChange',f.channels.map(c=>({id:c.id,quality:c.quality})));for(const e of f.events)if(!this.seen.has(e.id)){this.seen.add(e.id);this.emit(e.type,e);}if(this.seen.size>1000)this.seen=new Set([...this.seen].slice(-500));}
 latency(){return this.frame&&this.offset!==null?Math.max(0,this.now()+this.offset-this.frame.capturedAt):null;}
 rate(){if(this.arrivals.length<2)return 0;return (this.arrivals.length-1)*1000/(this.arrivals.at(-1)-this.arrivals[0]||1);}
 disconnect(){this.generation++;clearTimeout(this.timer);clearInterval(this.pinger);clearInterval(this.watch);if(this.ws){this.ws.onclose=null;this.ws.close();}this.ws=null;this.frame=null;this.lastAt=null;this.offset=null;this.rtt=null;this.arrivals=[];this.seen.clear();this.state('disconnected');}
}
