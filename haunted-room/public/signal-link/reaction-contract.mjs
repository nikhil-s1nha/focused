const text=(v)=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\x00-\x1f\x7f]/.test(v);
const unit=v=>Number.isFinite(v)&&v>=0&&v<=1;
export function validReaction(m){
 const keys=['schema','id','session_id','encounter_id','event','reaction','confidence','reaction_strength','signal_quality','created_at_ms','window_ms','classifier_version','received_at_ms'];
 return !!m&&Object.keys(m).every(k=>keys.includes(k))&&m.schema==='horror.reaction.v1'&&m.event==='reaction_update'&&['id','session_id','encounter_id','classifier_version'].every(k=>text(m[k]))&&['startled','no_detected_reaction','uncertain'].includes(m.reaction)&&unit(m.confidence)&&unit(m.signal_quality)&&(m.reaction_strength===undefined||unit(m.reaction_strength))&&Number.isSafeInteger(m.created_at_ms)&&m.created_at_ms>=0&&Number.isSafeInteger(m.window_ms)&&m.window_ms>0&&m.window_ms<=30000;
}
