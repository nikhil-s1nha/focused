import {validEvent} from '../signal-link/config.mjs';
import {validReaction} from '../signal-link/reaction-contract.mjs';
const TYPES=['crawl','creep','watcher','retreat','rush','feint','lighting','audio'];
const DOORS=['left','right','front','back'];
export class EventDirector {
 constructor({cadenceSeconds=null,rng=Math.random,now=()=>performance.now()/1000,emit=()=>{}}={}){this.cadenceSeconds=cadenceSeconds;this.rng=rng;this.now=now;this.emit=emit;this.seen=new Set();this.active=false;this.status='Ready';}
 start(id){this.session=id;this.active=true;this.current=null;this.pending=null;this.last=null;this.count=0;this.weights=Object.fromEntries(TYPES.map(t=>[t,1]));this.seen.clear();this.next=this.now()+4+this.rng()*3;this.opening=true;this.openingRemaining=3;this.openingKinds=new Set();this.status='Opening encounter pending';this.emit({event:'session_started',session_id:id});}
 stop(){if(this.active)this.emit({event:'session_ended',session_id:this.session});this.active=false;this.current=null;this.pending=null;this.status='Session ended';}
 receiveHook(m){
  if(!validEvent(m))return this.reject('Invalid partner hook');
  if(!this.active)return this.reject('Session inactive');
  if(this.seen.has(m.id))return this.reject('Duplicate event');
  this.seen.add(m.id);if(this.seen.size>512)this.seen.delete(this.seen.values().next().value);
  const encounter=this.current||this.last;
  if(!encounter)return this.reject('Waiting for first encounter');
  // Receipt-time association only: the partner's existing JSON has no encounter ID.
  // No invented classifier confidence, quality, or fear magnitude.
  this.pending={id:m.id,event:m.event,encounter_id:encounter.encounter_id,receipt:this.now(),reaction:m.schema==='signal-scope.event.v2'?'hook':['startle_flinch','reaction'].includes(m.event)?'startled':'hook',controlAmount:m.value,detector:m.detector?{...m.detector}:undefined,quality:m.detector?.quality};
  if(!this.current&&this.pending.reaction==='startled')this.next=Math.max(this.next,this.finishedAt+7+this.rng()*3);
  this.status='Partner hook accepted; waiting for encounter / cooldown';return true;
 }
 receive(m){
  if(!validReaction(m))return this.reject('Invalid reaction');
  if(!this.active||m.session_id!==this.session)return this.reject('Wrong or inactive session');
  if(this.seen.has(m.id))return this.reject('Duplicate event');
  this.seen.add(m.id);if(this.seen.size>512)this.seen.delete(this.seen.values().next().value);
  if(m.encounter_id!==(this.current||this.last)?.encounter_id)return this.reject('Unmatched encounter');
  if(m.reaction==='uncertain'||m.confidence<.6||m.signal_quality<.5){this.pending=null;return this.reject('Uncertain / low-quality observation: waiting');}
  this.pending={...m,receipt:this.now()};if(!this.current&&m.reaction==='startled')this.next=Math.max(this.next,(this.finishedAt??this.now())+7+this.rng()*3);this.status='Reaction received; waiting for encounter/cooldown';return true;
 }
 reject(reason){this.status=reason;return false;}
 tick(){
  const now=this.now();if(!this.active||this.current||now<this.next)return null;
  if(!this.opening&&!this.cadenceSeconds){if(!this.pending){this.status='Waiting for partner reaction';return null;}if(now-this.pending.receipt>15){this.pending=null;this.status='Reaction expired; waiting';return null;}}
  if(this.pending&&now-this.pending.receipt>15)this.pending=null;
  const reaction=this.pending;this.pending=null;
  if(reaction&&this.last){const t=this.last.kind;this.weights[t]=Math.max(.35,Math.min(2.5,this.weights[t]+(reaction.reaction==='startled'?.3:reaction.reaction==='no_detected_reaction'?-.3:0)));}
  let pool=TYPES.filter(t=>t!==this.last?.kind && (!this.opening || !this.openingKinds.has(t)));
  // Follow a strong scare with contrast, rather than another immediate heavy hit.
  if(!this.opening&&reaction?.reaction==='startled'&&(reaction.reaction_strength??.5)>.65)pool=['watcher','feint','lighting','audio'].filter(t=>t!==this.last?.kind);
  let pick=this.rng()*pool.reduce((n,t)=>n+this.weights[t],0),kind=pool.at(-1);
  for(const t of pool){pick-=this.weights[t];if(pick<=0){kind=t;break;}}
  const doors=DOORS.filter(d=>d!==this.last?.door);
  const e={opening_probe:this.opening,event:'encounter_started',session_id:this.session,encounter_id:`${this.session}-${++this.count}`,kind,door:doors[Math.floor(this.rng()*doors.length)],character:['bellwether','lark','ratchet','maestro','momo','pennywise'][Math.floor(this.rng()*6)]};
  if(this.opening){this.openingKinds.add(kind);this.openingRemaining--;this.opening=this.openingRemaining>0;}this.startedAt=now;this.current=e;this.status=`Playing ${kind}`;this.emit(e);return e;
 }
 finish(){if(!this.current)return;this.last=this.current;this.current=null;this.finishedAt=this.now();this.next=this.finishedAt+(this.last.opening_probe?5:this.pending?.reaction==='startled'?7+this.rng()*3:5);if(this.cadenceSeconds)this.next=Math.max(this.startedAt+this.cadenceSeconds,this.finishedAt+.5);this.emit({...this.last,event:'encounter_finished'});this.status='Waiting for partner reaction / cooldown';}
 disconnect(){this.pending=null;this.status='Partner stream disconnected; waiting';}
}
