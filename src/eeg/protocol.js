export const BANDS=['delta','theta','alpha','beta','gamma'];
export function validateFrame(f){
 if(f?.type!=='eeg'||f.version!==1||!Number.isFinite(f.capturedAt)||!Number.isInteger(f.sequence)||!Number.isFinite(f.score)||f.score<0||f.score>1||!Array.isArray(f.channels)||!f.channels.length||f.channels.length>16) throw Error('Invalid EEG envelope');
 const ids=new Set();
 for(const c of f.channels){if(typeof c.id!=='string'||ids.has(c.id)||!['good','fair','poor'].includes(c.quality)||!BANDS.every(b=>Number.isFinite(c.bands?.[b])&&c.bands[b]>=0)||!Array.isArray(c.samples)||c.samples.length>512||!c.samples.every(Number.isFinite))throw Error('Invalid channel'); ids.add(c.id);}
 if(!Array.isArray(f.events)||!f.events.every(e=>['blink','clench'].includes(e.type)&&typeof e.id==='string'))throw Error('Invalid events');
 return f;
}
export function mockFrame(sequence,score=.5,event=null){return {type:'eeg',version:1,sequence,capturedAt:Date.now(),score,calibration:{state:'ready',progress:1},channels:['Fp1','Fp2','C3','C4'].map((id,i)=>({id,quality:i===3?'fair':'good',bands:Object.fromEntries(BANDS.map((b,j)=>[b,5+20*(.5+.5*Math.sin(sequence*.07+i+j))])),samples:Array.from({length:25},(_,j)=>25*Math.sin((sequence*25+j)*.09+i)+8*Math.sin((sequence*25+j)*.31))})),events:event?[{id:`${event}-${sequence}`,type:event}]:[]};}
