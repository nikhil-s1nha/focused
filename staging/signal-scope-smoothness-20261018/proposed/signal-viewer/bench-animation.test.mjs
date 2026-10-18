import assert from 'node:assert/strict';
import {initBenchPanel,setBenchView} from './bench-panel.js';
let now=0, paints=0;
Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
const nodes=new Map(), timers=[], animation=[];
function node(){return {value:'',hidden:false,checked:false,disabled:false,dataset:{},clientWidth:0,clientHeight:0,listeners:{},children:[],classList:{toggle(){}},setAttribute(k,v){this[k]=v;},getAttribute(k){return this[k];},addEventListener(k,v){this.listeners[k]=v;},replaceChildren(...items){this.children=items;},append(...items){this.children.push(...items);}};}
const context={setTransform(){},clearRect(){paints++;},beginPath(){},moveTo(){},lineTo(){},stroke(){},fillText(){},save(){},rect(){},clip(){},restore(){},setLineDash(){},arc(){},fill(){}};
const el=id=>{if(!nodes.has(id)){const item=node();if(id.startsWith('bench-canvas-'))Object.assign(item,{clientWidth:1000,clientHeight:220,width:0,height:0,getContext:()=>context});nodes.set(id,item);}return nodes.get(id);};
const docEvents={};
globalThis.document={hidden:false,getElementById:el,querySelector:el,createElement:node,addEventListener(type,fn){docEvents[type]=fn;},activeElement:{tagName:'BODY'}};
globalThis.window={addEventListener(){}};
globalThis.location={href:'http://127.0.0.1:8767/?source=raw_diagnostic',search:'?source=raw_diagnostic'};
globalThis.history={replaceState(_a,_b,url){location.href=String(url);}};
globalThis.Option=class {constructor(label,value){this.text=label;this.value=value;}};
globalThis.setTimeout=fn=>{timers.push(fn);return 0;};
globalThis.requestAnimationFrame=fn=>{animation.push(fn);return animation.length;};
const points=Array.from({length:1500},(_,i)=>({sequence:i,read_micros:i*8000,elapsed_seconds:i*.008,counts:[i,2*i],break_before:i===0,status_checks_pass:false}));
const phase={id:'1:1',samples:points,frame_count:1500,invalid_status_count:1500,config_mismatches:7,spi_hz_requested:125000,mux_requested:'EXTERNAL_OBJECT',read_mode:'RDATA'};
const capture={status:'capturing_untrusted_bytes',completed:false,phases:[phase],session:1,source:'untrusted_bench_log',units:'raw signed 24-bit counts',not_eeg:true,filtered:false,file_name:'fixture.txt',clock_basis:'Uno read clock',malformed_rows:0,ignored_rows:0,sample_age_seconds:.2,input_context:'nonhuman_object_surface'};
let recording={active:true,stage:'capturing_untrusted_bench_bytes',run_id:'fixture',markers:[]};
const requests=[];
globalThis.fetch=async(path,options={})=>{requests.push({path,options});return {ok:true,json:async()=>path==='/api/bench-state'?capture:recording};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function frame(time){now=time;animation.shift()(time);}
initBenchPanel();await flush();
frame(0);
assert.match(el('bench-range-1').textContent,/0\.75 s behind received/);
const firstPaint=paints;
for(let i=1;i<=30;i++)frame(i*1000/60);
assert.equal(requests.length,2); // paints continue between network responses, not 4Hz-only
assert.equal(paints-firstPaint,60); // two traces for every RAF frame
assert.match(el('bench-range-1').textContent,/0\.25 s behind received/);
frame(1000);const frozenPaint=paints;frame(2000);frame(3000);
assert.equal(paints,frozenPaint); // stale data never advances beyond final measured point
assert.match(el('bench-range-1').textContent,/0\.00 s behind received/);
assert.equal(el('bench-invalid').textContent,1500); // quality diagnostics unchanged
document.hidden=true;frame(4000);assert.equal(paints,frozenPaint);
document.hidden=false;docEvents.visibilitychange();frame(4016);assert.ok(paints>frozenPaint);
setBenchView(false);const hiddenPaint=paints;frame(4032);assert.equal(paints,hiddenPaint);
setBenchView(true);
recording={...recording,active:false,stage:'stopped_original_restored'};
await timers.shift()();frame(5000);const stoppedPaint=paints;frame(6000);assert.equal(paints,stoppedPaint);
assert.equal(el('bench-record-start').disabled,false);
assert.equal(el('bench-record-stop').disabled,true);
assert.equal(requests.some(request=>request.options.method),false); // test never starts, stops or marks hardware
console.log('PASS: raw traces repaint at RAF cadence between polls, stop at real samples, expose display lag, retain quality flags, and suspend when hidden/stopped.');
