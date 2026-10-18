import {TraceBuffer, PresentationClock, paintBenchTrace, TRACE_WINDOW_SECONDS} from './bench-trace.js';
// Signal Scope raw counts and explicit continuous nonhuman-object recording controls.
let benchView = false;
let changeActiveView = () => {};
let connection = {label:'Loading diagnostic capture', online:false};
export const benchConnection = () => connection;
export const setBenchView = (enabled) => changeActiveView(enabled ? 'bench' : 'waveform');
export const isBenchView = () => benchView;
export function captureStatus(data) {
  const labels = {
    waiting_for_file:'Waiting for diagnostic capture file',
    waiting_for_fresh_header:'Waiting for fresh diagnostic header',
    completed_saved_capture:'Completed · saved diagnostic capture',
    no_frames_in_current_phase:'No frames in current phase',
    stale_capture_incomplete:'STALE · incomplete diagnostic capture',
    capturing_untrusted_bytes:'Receiving untrusted diagnostic bytes'
  };
  return labels[data?.status] || 'Diagnostic capture unavailable';
}

export function benchReception(recording, capture, {recordingAvailable=true, captureUnavailable=false}={}) {
  const remote=recording?.remote_status || {};
  const restartCount=Number.isFinite(remote.restart_count)?Math.max(0,remote.restart_count):0;
  const maxRestarts=Number.isFinite(remote.max_restarts)?Math.max(0,remote.max_restarts):3;
  const base={restartCount,maxRestarts,fresh:false};
  if(!recordingAvailable)return {...base,state:'no_frames',text:'No frames · controller unavailable'};
  if(!recording?.active)return {...base,state:'stopped',text:'Stopped'};
  const feedAge=capture?.sample_age_seconds;
  const remoteAge=remote.last_frame_age_seconds;
  const feedCount=capture?.phases?.at(-1)?.frame_count || 0;
  const count=Number.isFinite(remote.frames_received_total)?remote.frames_received_total:feedCount;
  const feedFresh=Number.isFinite(feedAge) && feedAge>=0 && feedAge<=2;
  const remoteFresh=remoteAge===undefined || (Number.isFinite(remoteAge) && remoteAge>=0 && remoteAge<=2);
  const framesFresh=!captureUnavailable && !capture?.completed && count>0 && feedCount>0 && feedFresh && remoteFresh;
  const fresh=framesFresh && recording.stage==='capturing_untrusted_bench_bytes';
  if(fresh)return {...base,state:'receiving',text:'Receiving',fresh:true};
  if(remote.recovery_exhausted && !framesFresh)return {...base,state:'no_frames',text:'No frames · '+restartCount+' restarts tried'};
  if(recording.stage==='restarting_stream' || remote.stage==='restarting_stream')return {...base,state:'restarting',text:'Restarting'};
  return {...base,state:'no_frames',text:remote.recovery_exhausted?'No frames · '+restartCount+' restarts tried':'No frames'};
}

export function alignedMarkerPoint(marker, phase, recording, capture) {
  if (!phase || !Number.isFinite(marker.frame_age_seconds) || marker.frame_age_seconds < 0 || marker.frame_age_seconds > 2) return null;
  if (marker.nearest_phase_id !== phase.id || marker.capture_session !== capture?.session) return null;
  if (marker.run_id && marker.run_id !== recording?.run_id) return null;
  if (marker.alignment !== 'nearest_observed_frame_not_exact') return null;
  return phase.samples.find(point => point.sequence === marker.nearest_sequence && point.read_micros === marker.nearest_read_micros) || null;
}

export function initBenchPanel(onViewChange = () => {}) {
  const el = (id) => document.getElementById(id);
  let data = null, selected = null, knownSession = null, unavailable = false;
  const currentPhase = () => data?.phases.find((p) => p.id === selected);
  let recording = {active:false,stage:'idle',markers:[]}, recordingAvailable=false;
  let pendingAction=null, controlError='', lastMarkersKey='';
  const markers=()=>Array.isArray(recording.markers)?recording.markers:[];
  const traceBuffer = new TraceBuffer(), presentation = new PresentationClock();
  let traceDirty = true, lastPaintCursor = null, traceMarkerKey = '', traceMarkerPoints = [];
  const now = () => performance.now();
  function syncTrace() {
    const phase = currentPhase();
    const key = [recording.run_id || '', data?.session, phase?.id || ''].join(':');
    const update = traceBuffer.ingest(key, phase?.samples || [], (data?.gap_break_threshold_us || 24000)/1e6);
    const live = recording.active && !unavailable && !data?.completed && el('bench-follow').checked &&
      phase?.id === data?.phases.at(-1)?.id && ['capturing_untrusted_bench_bytes','restarting_stream'].includes(recording.stage);
    presentation.observe(traceBuffer.latest?.elapsed_seconds, now(), {reset:update.reset, live});
    const markerKey = JSON.stringify([key, markers(), phase?.frame_count]);
    if (traceMarkerKey !== markerKey) {
      traceMarkerKey = markerKey;
      traceMarkerPoints = markers().map(marker => ({marker, point:alignedMarkerPoint(marker,phase,recording,data)})).filter(entry => entry.point);
      traceDirty = true;
    }
    traceDirty ||= update.reset || update.added > 0;
  }
  function animateTrace(time) {
    // RAF frequency concerns display only. No hardware rate or sample changes.
    if (benchView && data && !document.hidden) {
      const cursor = presentation.tick(time);
      if (traceDirty || cursor !== lastPaintCursor) {
        const playhead = cursor ?? 0;
        const start = Math.max(0, playhead-TRACE_WINDOW_SECONDS);
        const frame = {key:traceBuffer.key, now:time, start, duration:TRACE_WINDOW_SECONDS,
          playhead, points:traceBuffer.window(start,playhead), markers:traceMarkerPoints};
        for (let channel=0; channel<2; channel++) {
          paintBenchTrace(el('bench-canvas-'+(channel+1)), frame, channel);
          el('bench-range-'+(channel+1)).textContent=traceBuffer.size ?
            TRACE_WINDOW_SECONDS+' s · '+presentation.lag.toFixed(2)+' s behind received · counts' : 'No data';
        }
        traceDirty=false;lastPaintCursor=cursor;
      }
    }
    globalThis.requestAnimationFrame?.(animateTrace);
  }


  function renderRecording() {
    const stage=recording.stage || 'idle';
    const restoring=stage.includes('restor') && recording.active===true;
    const busyStage=['preparing','starting','uploading_bench_diagnostic','stopping','stop_requested'].includes(stage) || restoring;
    const active=recording.active===true;
    const closing=['stop_requested','restoring_original_firmware','stopping','restoring'].includes(stage);
    const queued=recording.start_queued===true;
    const reception=benchReception(recording,data,{recordingAvailable,captureUnavailable:unavailable});
    el('bench-reception-pill').textContent=reception.text;
    el('bench-reception-pill').dataset.state=reception.state;
    el('bench-restart-count').textContent='Automatic restarts: '+reception.restartCount+' / '+reception.maxRestarts;
    el('bench-record-start').disabled=!recordingAvailable || recording.enabled===false || stage==='restore_failed' || !!pendingAction || queued || ((active || busyStage) && !closing);
    el('bench-record-start-label').textContent=queued?'Next recording queued':closing?'Start after stopping':'Start recording';
    el('bench-record-stop').textContent=queued?'Cancel queued start':'■ Stop';
    el('bench-record-start').classList.toggle('recording',active);
    el('bench-record-stop').disabled=!recordingAvailable || !!pendingAction || (!active && !queued) || (closing && !queued);
    const canMark=recordingAvailable && !pendingAction && active && stage==='capturing_untrusted_bench_bytes';
    for(const id of ['bench-mark-blink','bench-mark-jaw','bench-mark-reaction'])el(id).disabled=!canMark;
    el('bench-mark-custom').disabled=!canMark;
    el('bench-custom-marker').disabled=!canMark;
    const labels={restarting_stream:'Restarting sensor stream…',uploading_bench_diagnostic:'Preparing diagnostic firmware…',capturing_untrusted_bench_bytes:'Recording',restoring_original_firmware:'Restoring original bench firmware…',complete:'Recording complete · original firmware restored',stopped_original_restored:'Recording stopped · original firmware restored',capture_failed_original_restored:'Capture failed · original firmware restored',restore_failed:'Restoration failed · hardware state unconfirmed',reconnecting:'Connection interrupted · checking capture status',stop_requested:'Stop requested · awaiting firmware restoration',idle:'Ready to record',preparing:'Preparing recorder…',starting:'Preparing recorder…',recording:'Recording',stale:'Recording · waiting for fresh frames',stopping:'Stopping recording…',restoring:'Restoring original bench firmware…',stopped:'Recording stopped',completed:'Recording complete',error:'Recording error',failed:'Recording error'};
    el('bench-record-stage').textContent=pendingAction==='start'?'Requesting recording…':pendingAction==='stop'?'Requesting stop…':!recordingAvailable?'Recording controls unavailable':labels[stage] || stage.replaceAll('_',' ');
    if(recordingAvailable && !pendingAction && closing)el('bench-record-stage').textContent=queued?'Stopping hardware… next recording starts when ready':'Stopping hardware…';
    el('bench-record-stage').dataset.stage=stage;
    if(recordingAvailable && !pendingAction && stage==='capturing_untrusted_bench_bytes' && !reception.fresh)el('bench-record-stage').textContent='Recording · waiting for fresh frames';
    let message=recording.enabled===false?'Recording is disabled in this server session; the operator must enable the object recorder when starting the server.':recording.message || 'Ready.';
    if(!recordingAvailable)message='Recording controller unavailable; its current hardware state cannot be confirmed here.';
    if(recordingAvailable && active && !reception.fresh)message+=' No fresh frame currently available; markers may remain unaligned.';
    if(active && recording.remote_status?.recovery_exhausted && !reception.fresh)message+=' Automatic recovery exhausted; Stop remains available.';
    if(recordingAvailable && queued)message='Next recording is queued and will start after stopping finishes.';
    el('bench-record-message').textContent=message;
    el('bench-record-error').textContent=controlError || (recording.error?String(recording.error.message || recording.error):'');
    const started=Number(recording.started_at),finished=Number(recording.finished_at);
    const elapsed=recording.started_at && Number.isFinite(started)?Math.max(0,(recording.finished_at && Number.isFinite(finished)?finished:Date.now()/1000)-started):0;
    el('bench-record-elapsed').textContent=recording.run_id?String(Math.floor(elapsed/60)).padStart(2,'0')+':'+String(Math.floor(elapsed%60)).padStart(2,'0')+' elapsed':'';
    for(const id of ['bench-export-csv','bench-export-json'])el(id).setAttribute('aria-disabled',String(!recordingAvailable || !recording.run_id));
    const key=JSON.stringify([recording.run_id,markers(),!!pendingAction,data?.session,selected]);
    if(key!==lastMarkersKey){
      lastMarkersKey=key;const log=el('bench-marker-log');log.replaceChildren();
      if(!markers().length){const empty=document.createElement('span');empty.className='empty-log';empty.textContent='No markers in this object recording.';log.append(empty);}
      for(const marker of [...markers()].reverse()){
        const row=document.createElement('div');row.className='bench-marker-row';
        const time=document.createElement('time');
        const seconds=Number(marker.run_elapsed_seconds);
        time.textContent=Number.isFinite(seconds)?'+'+seconds.toFixed(2)+' s':'Time unavailable';
        const label=document.createElement('span');label.className='marker-label';label.textContent=String(marker.label || 'Self-reported event');
        const context=document.createElement('span');context.className='marker-context';
        const sample=alignedMarkerPoint(marker,currentPhase(),recording,data);
        context.textContent=sample?'Nearest observed frame '+sample.sequence+' · approximate alignment':'Unaligned in selected phase · no fresh matching frame';
        const remove=document.createElement('button');remove.className='button secondary';remove.type='button';remove.textContent='Delete';remove.disabled=!!pendingAction || !recordingAvailable;
        remove.setAttribute('aria-label','Delete object-test marker '+marker.label);
        remove.addEventListener('click',()=>recordAction('marker/delete',{id:marker.id}));
        row.append(time,label,context,remove);log.append(row);
      }
    }
  }

  async function recordAction(action,body={}) {
    if(pendingAction || !recordingAvailable)return;
    const closing=['stop_requested','restoring_original_firmware','stopping','restoring'].includes(recording.stage);
    if(action==='start' && (recording.enabled===false || recording.start_queued || recording.stage==='restore_failed' || (recording.active && !closing) || (!closing && ['preparing','starting','uploading_bench_diagnostic'].includes(recording.stage))))return;
    if(action==='stop' && ((!recording.active && !recording.start_queued) || (closing && !recording.start_queued)))return;
    if(action==='marker' && (!recording.active || recording.stage!=='capturing_untrusted_bench_bytes'))return;
    pendingAction=action;controlError='';renderRecording();
    try {
      const response=await fetch('/api/bench-recording/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok)throw Error(result.error?.message || result.error || result.message || 'Recording request failed');
      recording=result.recording || result;recordingAvailable=true;
      if(action==='marker')el('bench-custom-marker').value='';
    }catch(error){controlError=error.message;}
    finally{pendingAction=null;renderRecording();if(data)render();}
  }


  function setView(next) {
    benchView = next === 'bench';
    el('processed-view').hidden = benchView;
    el('bench-view').hidden = !benchView;
    document.querySelector('.connection').hidden = false;
    el('source-open').hidden = false;
    const url = new URL(location.href);
    url.searchParams.delete('view');
    if (benchView) url.searchParams.set('source', 'raw_diagnostic');
    else {
      const normalSources=['synthetic','internal_test','shorted_input'];
      const chosen=el('source-select').value;
      url.searchParams.set('source',normalSources.includes(chosen)?chosen:normalSources.includes(url.searchParams.get('source'))?url.searchParams.get('source'):'synthetic');
    }
    history.replaceState(null, '', url);
    if (benchView && data) render();
    onViewChange();
  }

  function render() {
    if (!data) return;
    const phases=data.phases || [];
    if(knownSession!==data.session){selected=null;knownSession=data.session;el('bench-follow').checked=true;}
    if(el('bench-follow').checked || !phases.some((p)=>p.id===selected))selected=phases.at(-1)?.id || null;
    const select=el('bench-phase');
    const options=phases.map((p,i)=>({id:p.id,label:'Phase '+(i+1)+': '+p.spi_hz_requested.toLocaleString()+' Hz SPI · '+p.mux_requested+' · '+p.read_mode}));
    const key=JSON.stringify(options);
    if(select.dataset.options!==key){select.replaceChildren(...options.map((p)=>new Option(p.label,p.id)));select.dataset.options=key;}
    select.value=selected || ''; select.disabled=!phases.length;
    const phase=currentPhase();
    syncTrace();
    const stoppedCapture=recording.run_id && data.input_context==='nonhuman_object_surface' && ['complete','stopped_original_restored','capture_failed_original_restored','restore_failed'].includes(recording.stage);
    const stoppedLabel=recording.stage==='restore_failed'?'Recording ended · restoration unconfirmed':recording.stage==='capture_failed_original_restored'?'Capture failed · saved raw frames':recording.stage==='complete'?'Recording complete · saved raw frames':'Recording stopped · saved raw frames';
    const reception=benchReception(recording,data,{recordingAvailable,captureUnavailable:unavailable});
    connection={label:reception.text,online:reception.fresh};
    el('bench-status').textContent=unavailable?'Capture service unavailable · retained display only':stoppedCapture?stoppedLabel:recording.active?reception.text+' · unverified raw counts':captureStatus(data);
    el('bench-message').textContent=unavailable?'The capture file cannot currently be refreshed. Any traces below are retained, not live.':stoppedCapture?'The recording has ended; traces are saved and are not live.'+(!data.completed?' No firmware completion footer was received; see controller restoration status above.':''):data.completed?
      'Capture ended. Showing saved raw frames; these traces are not live.':data.sample_age_seconds==null?
      'No diagnostic frames received. No generated or fallback points.':
      'Last newly read frame '+data.sample_age_seconds.toFixed(1)+' seconds ago. No generated or fallback points.';
    el('bench-frames').textContent=(phase?.frame_count || 0).toLocaleString();
    el('bench-invalid').textContent=phase?.invalid_status_count ?? '—';
    el('bench-mismatches').textContent=phase?.config_mismatches ?? 'not reported';
    el('bench-gaps').textContent=phase?.gap_count ?? 0;
    el('bench-details').textContent=[
      'Source: '+data.source+' · file: '+data.file_name+' · session: '+data.session,
      'Raw units: '+data.units+' · filtered: '+data.filtered+' · not EEG: '+data.not_eeg,
      'Input context: '+(data.input_context || 'unknown'),
      'Selected phase: '+(phase?.id || 'none')+' · requested mux: '+(phase?.mux_requested || 'unknown')+' · read mode: '+(phase?.read_mode || 'unknown'),
      'ID reads: '+(phase?.id_reads?.join(', ') || 'none')+' · valid 0x73 reads: '+(phase?.valid_id_reads ?? 'unknown'),
      'Clock: '+data.clock_basis+' · status: '+data.status,
      'Malformed rows: '+data.malformed_rows+' · ignored rows: '+data.ignored_rows,
      'Raw transaction probes: '+JSON.stringify(phase?.transaction_probes || []),
      phase?.summary?'Firmware phase summary: '+JSON.stringify(phase.summary):'No firmware phase summary yet.'
    ].join('\n');
    renderRecording();
    if(benchView){traceDirty=true;onViewChange();}
  }

  changeActiveView=setView;
  el('bench-phase').addEventListener('change',()=>{selected=el('bench-phase').value;el('bench-follow').checked=false;render();});
  el('bench-follow').addEventListener('change',render);
  window.addEventListener('resize',()=>{traceDirty=true;});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){syncTrace();traceDirty=true;}});
  el('bench-record-start').addEventListener('click',()=>recordAction('start',{nonhuman_surface_only:true}));
  el('bench-record-stop').addEventListener('click',()=>recordAction('stop'));
  for(const [id,label] of [['bench-mark-blink','Blink'],['bench-mark-jaw','Jaw clench'],['bench-mark-reaction','Startle / flinch']])el(id).addEventListener('click',()=>recordAction('marker',{label}));
  el('bench-custom-marker-form').addEventListener('submit',event=>{event.preventDefault();const label=el('bench-custom-marker').value.trim();if(label)recordAction('marker',{label});});
  for(const id of ['bench-export-csv','bench-export-json'])el(id).addEventListener('click',event=>{if(el(id).getAttribute('aria-disabled')==='true')event.preventDefault();});
  document.addEventListener('keydown',event=>{
    if(!benchView || event.repeat || event.ctrlKey || event.metaKey || event.altKey || el('source-dialog').open || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;
    const label={b:'Blink',j:'Jaw clench',s:'Startle / flinch'}[event.key.toLowerCase()];
    if(label){event.preventDefault();recordAction('marker',{label});}
  });
  async function readJson(path){const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);return response.json();}
  async function poll(){
    const results=await Promise.allSettled([readJson('/api/bench-state'),readJson('/api/bench-recording')]);
    if(results[0].status==='fulfilled'){data=results[0].value;unavailable=false;}
    else{unavailable=true;connection={label:'Capture unavailable',online:false};}
    if(results[1].status==='fulfilled' && typeof results[1].value.active==='boolean'){recording=results[1].value;recordingAvailable=true;}
    else{recordingAvailable=false;}
    renderRecording();
    if(data)render();else if(unavailable){el('bench-status').textContent='Capture service unavailable';el('bench-message').textContent='No generated fallback.';if(benchView)onViewChange();}
    setTimeout(poll,benchView?250:1500);
  }
  const params=new URLSearchParams(location.search);
  const processedSources=['synthetic','internal_test','shorted_input'];
  setView(processedSources.includes(params.get('source'))?'waveform':'bench');
  globalThis.requestAnimationFrame?.(animateTrace);
  poll();
}
