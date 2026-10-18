import assert from 'node:assert/strict';
import {test} from 'node:test';
import {performance} from 'node:perf_hooks';
import {TraceBuffer, PresentationClock, peakPreservingPoints, paintBenchTrace, MAX_TRACE_SAMPLES} from './bench-trace.js';

const sample = (sequence, extra={}) => ({sequence, read_micros:sequence*8000,
  elapsed_seconds:sequence/125, counts:[sequence%31, -(sequence%17)],
  status_checks_pass:false, break_before:sequence===0, ...extra});

test('ring remains bounded through a long run, skips overlapping snapshots, preserves counts and invalid status', () => {
  const buffer = new TraceBuffer();
  for(let end=0; end<25000; end+=64) {
    const points=Array.from({length:Math.min(1500,end+64)},(_,i)=>sample(Math.max(0,end+64-1500)+i));
    buffer.ingest('run:session:phase',points);
    assert.ok(buffer.size<=MAX_TRACE_SAMPLES);
  }
  const latest=buffer.latest,version=buffer.version;
  assert.equal(buffer.ingest('run:session:phase',[latest]).added,0);
  assert.equal(buffer.version,version);
  assert.equal(latest.status_checks_pass,false);
  assert.deepEqual(latest.counts,sample(latest.sequence).counts);
  assert.equal(buffer.storage.length,MAX_TRACE_SAMPLES);
});

test('reset/session boundary discards old samples and actual gaps stay disconnected', () => {
  const buffer=new TraceBuffer(5);
  buffer.ingest('one',[sample(0),sample(1),sample(9)]);
  assert.equal(buffer.at(2).break_before,true);
  buffer.ingest('one',[sample(9),sample(10),sample(11,{break_before:true})]);
  assert.equal(buffer.at(4).break_before,true);
  const result=buffer.ingest('two',[sample(0),sample(1)]);
  assert.equal(result.reset,true);assert.equal(buffer.size,2);
  assert.equal(buffer.at(0).break_before,true);
  buffer.ingest('two',[sample(1),sample(2,{elapsed_seconds:.008,read_micros:8000})]);
  assert.equal(buffer.size,3);assert.equal(buffer.latest.break_before,true); // repeated clock is retained as a gap
});

test('visible window excludes future samples and invalid values; retains a real edge predecessor', () => {
  const buffer=new TraceBuffer();
  buffer.ingest('one',[sample(0),sample(1),sample(2),sample(3,{counts:[NaN,0]}),sample(4)]);
  const visible=buffer.window(.009,.02);
  assert.deepEqual(visible.map(x=>x.sequence),[1,2]);
  assert.ok(visible.every(x=>x.elapsed_seconds<=.02));
  assert.deepEqual(buffer.window(10,20),[]);
  assert.equal(buffer.latest.break_before,true); // invalid sample creates a real missing-sequence gap
});

test('presentation moves between delivery polls, cannot advance beyond received data, stops at real endpoint', () => {
  const clock=new PresentationClock(.75);
  clock.observe(10,0,{reset:true,live:true});
  assert.equal(clock.cursor,9.25);
  assert.equal(clock.tick(250),9.5);
  assert.equal(clock.tick(500),9.75);
  clock.observe(10.5,500,{live:true});
  assert.equal(clock.tick(750),10);
  assert.equal(clock.tick(2000),10.5);
  assert.equal(clock.tick(6000),10.5); // no generated continuation during a stall
  assert.equal(clock.lag,0);
  clock.observe(16.5,6000,{live:true});
  assert.equal(clock.cursor,15.75); // skip replay backlog without changing sample timestamps
  clock.observe(16.75,6100,{live:false});
  assert.equal(clock.cursor,16.75);
  assert.equal(clock.tick(10000),16.75); // stopped recordings are frozen at received endpoint
  clock.observe(.032,11000,{reset:true,live:true});
  assert.equal(clock.cursor,0);
});

test('pixel reduction retains exact peaks, original timestamps and each discontinuity', () => {
  const points=Array.from({length:1000},(_,i)=>sample(i,{elapsed_seconds:i/1000}));
  points[250]={...points[250],counts:[10000,0]};
  points[251]={...points[251],counts:[-10000,0]};
  points[500]={...points[500],break_before:true};
  const reduced=peakPreservingPoints(points,0,0,1,10);
  assert.ok(reduced.includes(points[250]));assert.ok(reduced.includes(points[251]));
  assert.ok(reduced.includes(points[500]));
  assert.ok(reduced.every(point=>points.includes(point))); // no synthetic/interpolated samples
  assert.ok(reduced.length<=44);
  for(let i=1;i<reduced.length;i++)assert.ok(reduced[i].elapsed_seconds>reduced[i-1].elapsed_seconds);
});

function fakeCanvas(width=1000,height=220) {
  const calls={resizes:0,lines:0,moves:0,arcs:0};
  let bitmapWidth=0,bitmapHeight=0;
  const ctx={setTransform(){},clearRect(){},beginPath(){},moveTo(){calls.moves++;},lineTo(){calls.lines++;},stroke(){},fillText(){},save(){},rect(){},clip(){},restore(){},setLineDash(){},arc(){calls.arcs++;},fill(){}};
  return {calls,canvas:{clientWidth:width,clientHeight:height,
    get width(){return bitmapWidth;},set width(value){bitmapWidth=value;calls.resizes++;},
    get height(){return bitmapHeight;},set height(value){bitmapHeight=value;calls.resizes++;},
    getContext(){return ctx;}}};
}

test('canvas bitmaps resize only on size changes; isolated measured points remain dots', () => {
  const {canvas,calls}=fakeCanvas();
  const point=sample(0);
  const frame={key:'one',now:0,start:0,duration:10,playhead:0,points:[point],markers:[]};
  paintBenchTrace(canvas,frame,0);paintBenchTrace(canvas,{...frame,now:16},0);
  assert.equal(calls.resizes,2);assert.equal(calls.arcs,2);
  canvas.clientWidth=800;paintBenchTrace(canvas,{...frame,now:32},0);
  assert.equal(calls.resizes,4);
});

test('two-trace render workload stays bounded; report JavaScript preparation timing separately from browser rasterization', () => {
  const points=Array.from({length:MAX_TRACE_SAMPLES},(_,i)=>sample(i,{elapsed_seconds:i/500}));
  const a=fakeCanvas(800),b=fakeCanvas(800);
  const frame={key:'bench',now:0,start:0,duration:10,playhead:10,points,markers:[]};
  const timings=[];
  for(let i=0;i<600;i++) {
    const started=performance.now();
    paintBenchTrace(a.canvas,{...frame,now:i*1000/60},0);
    paintBenchTrace(b.canvas,{...frame,now:i*1000/60},1);
    timings.push(performance.now()-started);
  }
  timings.sort((a,b)=>a-b);
  assert.equal(a.calls.resizes,2);assert.equal(b.calls.resizes,2);
  assert.ok(a.calls.lines<=600*(MAX_TRACE_SAMPLES+10));
  console.log(`DISPLAY BENCH: 600 dual-trace frames; JS p50=${timings[300].toFixed(3)} ms, p95=${timings[570].toFixed(3)} ms; canvas rasterization not measured.`);
});
