import assert from 'node:assert/strict';
import {initBenchPanel,alignedMarkerPoint,setBenchView} from './bench-panel.js';
function makeNode(){return {value:'',hidden:false,checked:false,disabled:false,dataset:{},clientWidth:0,clientHeight:0,listeners:{},children:[],classList:{toggle(){}},setAttribute(k,v){this[k]=v;},getAttribute(k){return this[k];},addEventListener(k,v){this.listeners[k]=v;},replaceChildren(...items){this.children=items;},append(...items){this.children.push(...items);}};}
const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,makeNode());return nodes.get(id);};
const documentListeners={};
globalThis.document={getElementById:el,querySelector:el,createElement:makeNode,addEventListener(type,fn){documentListeners[type]=fn;},activeElement:{tagName:'BODY'}};
globalThis.window={addEventListener(){}};
globalThis.location={href:'http://127.0.0.1:8767/?source=raw_diagnostic',search:'?source=raw_diagnostic'};
globalThis.history={replaceState(_a,_b,url){location.href=String(url);location.search=new URL(url).search;}};
globalThis.Option=class {constructor(label,value){this.text=label;this.value=value;}};
const scheduled=[];globalThis.setTimeout=fn=>{scheduled.push(fn);return 0;};
const requests=[];let releaseStart;
let recording={active:false,stage:'idle',run_id:null,markers:[]};
const capture={status:'completed_saved_capture',completed:true,phases:[],session:2,source:'untrusted_bench_log',units:'raw signed 24-bit counts',not_eeg:true,filtered:false,file_name:'capture.txt',clock_basis:'Uno read clock',malformed_rows:0,ignored_rows:0,sample_age_seconds:10,input_context:'nonhuman_object_surface'};
globalThis.fetch=async(path,options={})=>{
 requests.push({path,options});
 if(!options.method)return {ok:true,json:async()=>path==='/api/bench-state'?capture:recording};
 const body=JSON.parse(options.body);
 if(path.endsWith('/start')){if(['stop_requested','restoring_original_firmware'].includes(recording.stage))recording={...recording,start_queued:true};else{await new Promise(resolve=>{releaseStart=resolve;});recording={active:true,stage:'preparing',run_id:'test-run',started_at:Date.now()/1000,markers:[],message:'Preparing capture'};}}
 if(path.endsWith('/marker'))recording={...recording,markers:[{id:'m1',label:body.label,timestamp:Date.now()/1000,run_elapsed_seconds:1,nearest_sequence:null,nearest_read_micros:null,frame_age_seconds:null,alignment:'none'}]};
 if(path.endsWith('/marker/delete'))recording={...recording,markers:[]};
 if(path.endsWith('/stop'))recording=recording.start_queued?{...recording,start_queued:false}:{...recording,active:true,stage:'restoring_original_firmware'};
 return {ok:true,json:async()=>recording};
};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
initBenchPanel();await flush();
assert.equal(el('bench-record-start').disabled,false);
el('bench-record-start').listeners.click();el('bench-record-start').listeners.click();
assert.equal(requests.filter(r=>r.path.endsWith('/start')).length,1);
assert.deepEqual(JSON.parse(requests.at(-1).options.body),{nonhuman_surface_only:true});
assert.equal(el('bench-record-start').disabled,true);
releaseStart();await flush();
assert.equal(el('bench-record-stop').disabled,false);
assert.equal(el('bench-mark-reaction').disabled,true);
recording.stage='capturing_untrusted_bench_bytes';await scheduled.shift()();
assert.equal(el('bench-mark-reaction').disabled,false);
assert.match(el('bench-record-message').textContent,/No fresh frame/);
documentListeners.keydown({key:'s',repeat:false,preventDefault(){}});await flush();
assert.equal(requests.at(-1).path,'/api/bench-recording/marker');
assert.equal(JSON.parse(requests.at(-1).options.body).label,'Startle / flinch');
assert.match(el('bench-marker-log').children[0].children[2].textContent,/Unaligned/);
for(const [id,label] of [['bench-mark-blink','Blink'],['bench-mark-jaw','Jaw clench'],['bench-mark-reaction','Startle / flinch']]){
 assert.equal(el(id).disabled,false);
 el(id).listeners.click();await flush();
 assert.equal(requests.at(-1).path,'/api/bench-recording/marker');
 assert.equal(JSON.parse(requests.at(-1).options.body).label,label);
}
for(const [key,label] of [['b','Blink'],['J','Jaw clench'],['s','Startle / flinch']]){
 documentListeners.keydown({key,repeat:false,preventDefault(){}});await flush();
 assert.equal(JSON.parse(requests.at(-1).options.body).label,label);
}
for(const tag of ['INPUT','TEXTAREA','SELECT']){
 document.activeElement={tagName:tag};const count=requests.length;
 documentListeners.keydown({key:'b',repeat:false,preventDefault(){}});await flush();assert.equal(requests.length,count);
}
document.activeElement={tagName:'BODY'};
el('source-dialog').open=true;let count=requests.length;
documentListeners.keydown({key:'j',repeat:false,preventDefault(){}});await flush();assert.equal(requests.length,count);
el('source-dialog').open=false;
setBenchView(false);count=requests.length;documentListeners.keydown({key:'b',repeat:false,preventDefault(){}});await flush();assert.equal(requests.length,count);setBenchView(true);
recording.stage='restarting_stream';await scheduled.shift()();
for(const id of ['bench-mark-blink','bench-mark-jaw','bench-mark-reaction'])assert.equal(el(id).disabled,true);
count=requests.length;documentListeners.keydown({key:'s',repeat:false,preventDefault(){}});await flush();assert.equal(requests.length,count);
recording.stage='capturing_untrusted_bench_bytes';await scheduled.shift()();
count=requests.length;documentListeners.keydown({key:'s',repeat:true,preventDefault(){}});await flush();assert.equal(requests.length,count);

await el('bench-marker-log').children[0].children[3].listeners.click();await flush();
assert.equal(requests.at(-1).path,'/api/bench-recording/marker/delete');
recording.remote_status={restart_count:3,max_restarts:3,last_frame_age_seconds:12,frames_received_total:187,recovery_exhausted:true};
await scheduled.shift()();
assert.equal(el('bench-reception-pill').textContent,'No frames · 3 restarts tried');
assert.equal(el('bench-record-stop').disabled,false);
assert.equal(el('bench-mark-reaction').disabled,false);
assert.equal(el('bench-restart-count').textContent,'Automatic restarts: 3 / 3');
assert.ok(!el('bench-record-elapsed').textContent.includes('limit'));
el('bench-record-stop').listeners.click();await flush();
assert.match(el('bench-record-stage').textContent,/Stopping hardware/);
assert.equal(el('bench-record-start').disabled,false);
assert.equal(el('bench-record-start-label').textContent,'Start after stopping');
assert.equal(el('bench-mark-reaction').disabled,true);
el('bench-record-start').listeners.click();await flush();
assert.equal(el('bench-record-start-label').textContent,'Next recording queued');
assert.equal(el('bench-record-start').disabled,true);
assert.equal(el('bench-record-stop').disabled,false);
assert.equal(el('bench-record-stop').textContent,'Cancel queued start');
assert.match(el('bench-record-stage').textContent,/next recording starts when ready/);
el('bench-record-stop').listeners.click();await flush();
assert.equal(recording.start_queued,false);
assert.equal(el('bench-record-start').disabled,false);
recording.stage='stopped_original_restored';recording.active=false;capture.completed=false;capture.status='capturing_untrusted_bytes';
await scheduled.shift()();
assert.equal(el('bench-status').textContent,'Recording stopped · saved raw frames');
assert.match(el('bench-message').textContent,/No firmware completion footer/);
const point={sequence:9,read_micros:8000,elapsed_seconds:.008,counts:[5,6]};
const phase={id:'3:1',samples:[point]};const state={session:3};
const marker={nearest_phase_id:'3:1',capture_session:3,nearest_sequence:9,nearest_read_micros:8000,frame_age_seconds:1,alignment:'nearest_observed_frame_not_exact'};
assert.equal(alignedMarkerPoint(marker,phase,recording,state),point);
assert.equal(alignedMarkerPoint({...marker,frame_age_seconds:2.1},phase,recording,state),null);
assert.equal(alignedMarkerPoint({...marker,nearest_phase_id:'3:2'},phase,recording,state),null);
assert.equal(alignedMarkerPoint({...marker,capture_session:2},phase,recording,state),null);
assert.equal(alignedMarkerPoint({...marker,nearest_read_micros:9999},phase,recording,state),null);
assert.equal(alignedMarkerPoint({...marker,frame_age_seconds:null},phase,recording,state),null);
console.log('PASS: standing object scope, queued restart/cancel after Stop, start double-click protection, stop/restoring controls, exact B/J/S preset labels, input/dialog/repeat shortcut guards, marker deletion, and honest frame/phase/session alignment.');
