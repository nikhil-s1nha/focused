const $=id=>document.getElementById(id);
const samples=[
  {kind:'Exclamation',text:'“Whoa — that got me!”',encounter:'Left door · rush',audio:false},
  {kind:'Laughter',text:'[laughter after the encounter]',encounter:'Front door · feint',audio:true},
  {kind:'Spoken feedback',text:'“I saw that coming. The footsteps gave it away.”',encounter:'Right door · creep',audio:false},
  {kind:'Gasp',text:'[gasp — illustrative annotation]',encounter:'Back door · watcher',audio:true},
  {kind:'Spoken feedback',text:'“Wait… did something move behind me?”',encounter:'Rear corridor · audio',audio:false},
  {kind:'Exclamation',text:'“Okay, I was not ready for that one.”',encounter:'Floor · crawl',audio:false}
];
let elapsed=120,running=true,nextEvent=126,activeUntil=0,events=[],sequence=0,last=performance.now(),raf=0;
const fmt=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
function makeEvent(sample,at){return {...sample,id:`demo-${++sequence}`,at,simulated:true,source:'demo_generator',emotion:null};}
function seed(){sequence=0;events=[makeEvent(samples[3],74),makeEvent(samples[1],88),makeEvent(samples[2],103),makeEvent(samples[0],117)];}
function renderEvents(){
  $('count').textContent=String(events.length);
  $('eventRows').textContent=[...events].reverse().slice(0,5).map(e=>`${fmt(e.at)}  ${e.kind.toLowerCase()}  /  ${e.encounter.toLowerCase()}`).join('\n');
}
function addEvent(index){const e=makeEvent(samples[index],elapsed);events.push(e);if(events.length>200)events.shift();activeUntil=elapsed+3;$('reactionTitle').textContent=e.kind;renderEvents();}
function toggleRun(){running=!running;last=performance.now();updateState();}
function updateState(){$('pause').textContent=running?'pause':'resume';$('runState').textContent=running?'running':'paused';}
$('pause').onclick=toggleRun;
$('reset').onclick=()=>{elapsed=120;nextEvent=126;activeUntil=0;seed();renderEvents();running=true;last=performance.now();updateState();};
const canvas=$('wave'),ctx=canvas.getContext('2d');let width=0,height=0;
const observer=new ResizeObserver(()=>{const rect=canvas.getBoundingClientRect(),scale=Math.min(devicePixelRatio||1,2);width=rect.width;height=rect.height;canvas.width=width*scale;canvas.height=height*scale;ctx.setTransform(scale,0,0,scale,0,0);});observer.observe(canvas);
function draw(){ctx.clearRect(0,0,width,height);const count=Math.max(1,Math.floor(width/5));for(let i=0;i<count;i++){
  const age=(1-i/count)*30,t=elapsed-age;let envelope=.08+.05*(1+Math.sin(t*.61));let reaction=false;
  for(const e of events){const offset=t-e.at;if(offset>=-.4&&offset<2.8){envelope=Math.max(envelope,.75*Math.exp(-Math.max(offset,0)/1.1));reaction=true;}}
  const mod=.25+.75*Math.abs(Math.sin(t*31.2)*Math.cos(t*18.4));const bar=Math.max(3,envelope*mod*height*.92);
  ctx.fillStyle=reaction?'#e8b882':'#a5d9bd';ctx.globalAlpha=.35+.6*i/count;ctx.fillRect(i*width/count,(height-bar)/2,2,bar);
}ctx.globalAlpha=1;}
function frame(now){const dt=Math.min((now-last)/1000,.25);last=now;if(running){elapsed+=dt;if(elapsed>=nextEvent){addEvent(sequence%samples.length);nextEvent=elapsed+7+(sequence%4);}}
  $('elapsed').textContent=fmt(elapsed);
  const active=elapsed<activeUntil;$('reactionDisplay').classList.toggle('active',active);if(!active){$('reactionTitle').textContent=running?'waiting':'paused';}
  draw();raf=requestAnimationFrame(frame);
}
seed();renderEvents();updateState();raf=requestAnimationFrame(frame);
addEventListener('pagehide',()=>{cancelAnimationFrame(raf);observer.disconnect();});
