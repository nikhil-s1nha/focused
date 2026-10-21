import {sanitizeThreshold} from './threshold-contract.mjs';
// Fixed allowlist: operator markers control existing effects; never remote function names.
export const EVENT_NAMES = Object.freeze(['blink','jaw_clench','startle_flinch','reaction']);
export const MAPPINGS = Object.freeze({
 blink: Object.freeze({action:'light',label:'Brief lamp flicker',cooldownMs:1800,minStrength:.2,maxStrength:.65,minSeconds:.3,maxSeconds:.85}),
 jaw_clench: Object.freeze({action:'ambient',label:'Ambient cue (sound opt-in required)',cooldownMs:3500,minStrength:.15,maxStrength:.45,minSeconds:.5,maxSeconds:1.2}),
 startle_flinch: Object.freeze({action:'environment',label:'Brief doorway/shadow movement',cooldownMs:4500,minStrength:.15,maxStrength:.45,minSeconds:1,maxSeconds:1.8}),
 reaction: Object.freeze({action:'reaction',label:'Short light sag',cooldownMs:3000,minStrength:.2,maxStrength:.6,minSeconds:.4,maxSeconds:1.2})
});
export const LINK_CONFIG = Object.freeze({streamUrl:'/signal-link/events',healthUrl:'/signal-link/health',maxSeenIds:512,globalCooldownMs:800});
export function validEvent(m){return (!!sanitizeThreshold(m)&&Number.isSafeInteger(m.received_at_ms)&&m.received_at_ms>=0)||!!m&&m.schema==='signal-scope.event.v1'&&typeof m.id==='string'&&m.id.length>0&&m.id.length<=128&&EVENT_NAMES.includes(m.event)&&['manual_test','manual_marker'].includes(m.source)&&['manual_test','operator_annotation'].includes(m.measurement)&&m.emotion===null&&typeof m.label==='string'&&m.label.length<=160&&Number.isFinite(m.value)&&m.value>=0&&m.value<=1&&[m.created_at_ms,m.sent_at_ms,m.received_at_ms].every(v=>Number.isSafeInteger(v)&&v>=0);}
export function mappedControl(event){const m=MAPPINGS[event.event];if(!m)return null;const amount=Math.max(0,Math.min(1,event.value));return {action:m.action,label:m.label,strength:m.minStrength+(m.maxStrength-m.minStrength)*amount,seconds:m.minSeconds+(m.maxSeconds-m.minSeconds)*amount,event:event.event};}
