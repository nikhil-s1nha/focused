export const THRESHOLD_CAPABILITY=Object.freeze({schema:'signal-scope.event.v2',source:'threshold_detector',measurement:'threshold_crossing',event:'reaction',emotion:null,quality:'unverified',detector_version:1});
const unit=v=>Number.isFinite(v)&&v>=0&&v<=1;
const stamp=v=>Number.isSafeInteger(v)&&v>=0;
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v);
export function sanitizeThreshold(m){
 if(!m||m.schema!=='signal-scope.event.v2'||m.source!=='threshold_detector'||m.measurement!=='threshold_crossing'||m.event!=='reaction'||m.emotion!==null||!unit(m.value))return null;
 if(typeof m.id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.id)||!text(m.label,160))return null;
 if(!stamp(m.created_at_ms)||!stamp(m.sent_at_ms)||m.sent_at_ms<m.created_at_ms||m.sent_at_ms-m.created_at_ms>2000)return null;
 const d=m.detector,keys=['preset','threshold','rearm_threshold','score','quality','valid_measurement','reaction_validated'];
 if(!d||Object.keys(d).length!==7||Object.keys(d).some(k=>!keys.includes(k))||!text(d.preset,128)||![d.threshold,d.rearm_threshold,d.score].every(unit)||d.rearm_threshold>=d.threshold||d.score<=d.threshold||d.quality!=='unverified'||d.valid_measurement!==false||d.reaction_validated!==false)return null;
 return {schema:m.schema,id:m.id,event:m.event,label:m.label,value:m.value,source:m.source,measurement:m.measurement,emotion:null,created_at_ms:m.created_at_ms,sent_at_ms:m.sent_at_ms,detector:Object.fromEntries(keys.map(k=>[k,d[k]]))};
}
