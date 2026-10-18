"""Analyze each replacement-sensor recording independently, without cross-run fitting.

No device/UI/network operations. Source isolation is enforced before archive reads.
"""
from __future__ import annotations
import argparse,fcntl,hashlib,json,os,re,sys
from datetime import datetime,timezone
from pathlib import Path
import numpy as np
from .core import Recording,REACTIONS,TERMINAL,load_recording,marker_center,detect_events,match_count
from .binary_threshold import one_second_window,training_scales,build_windows,evaluate
from .raw_spike_detector import RawSpikeConfig

METHOD={
 'version':'independent-capture-v1','pooling':'none: each recording fits its own calibration only',
 'labels':'All recognized action labels pooled as Reaction; no emotion classification',
 'timing':'Each marker anchor+local parse age; independently varying plus/minus0.5s allowance; not physical synchronization',
 'window_seconds':1.0,'coverage':'At least100rows,25msedgecoverage,bracketing samples,consecutive sequences,no>24ms gaps including boundary-straddling gaps',
 'events':'Persegment/channel99thpercentile absolute firstdifference; strongest-first250ms then100ms pooled suppression;one-to-onematchingwithin0.5s',
 'controls':'100 deterministic common-fraction circular schedule shifts; each complete shifted schedule must pass identical coverage',
 'chronology':'Acquisition-order midpoint by frame count; device timestamp resets never compared acrosssegments. Splitsegment leaves1sunscoredgap(plus/minus0.5s);1-secondwindowcenters mustbe>=1sfromsplit.',
 'scales':'99thpercentile absolute firstdifference perchannel,calibrationframesonly;floor1count;also exclude0.5sbufferfromscaleestimation',
 'thresholds':['90thpercentile calibrationbackgroundscore (approx10%backgroundtarget)','largest calibrationcutoff retaining>=90%markedactionwindowhits'],
 'score':'Largest channel-normalized absolute step in each one-second window',
 'caveat':'Within-recording chronological check is not independent-session validation; background may be unmarked rather than confirmed no-action.'}


def json_ready(value):
 if isinstance(value,dict):return {k:json_ready(v) for k,v in value.items()}
 if isinstance(value,(list,tuple)):return [json_ready(v) for v in value]
 if isinstance(value,np.generic):return value.item()
 return value


def atomic_json(path,value):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_name(f'.{path.name}.{os.getpid()}.tmp');temporary.write_text(json.dumps(json_ready(value),indent=2,allow_nan=False)+'\n');os.replace(temporary,path)


def valid_run_id(value):return bool(re.fullmatch(r'object-ui-[A-Za-z0-9-]+',value))


def candidate_paths(recordings,first_run,run_id=None):
 if not valid_run_id(first_run):raise ValueError('Invalid first-run identifier')
 if run_id is not None:
  if not valid_run_id(run_id) or run_id<first_run:raise ValueError('run-id must be a valid identifier at or after first-run')
  p=recordings/run_id
  if not p.is_dir():raise ValueError('Requested recording does not exist')
  return [p]
 return sorted(p for p in recordings.glob('object-ui-*') if p.is_dir() and p.name>=first_run)


def freeze_one(directory,output,first_run):
 if directory.name<first_run:raise ValueError('Pre-boundary recording prohibited')
 names=('raw.txt','markers.json','status.json','metadata.json')
 if not all((directory/n).is_file() for n in names):return None
 before={n:(directory/n).stat().st_mtime_ns for n in names};blobs={n:(directory/n).read_bytes() for n in names};after={n:(directory/n).stat().st_mtime_ns for n in names}
 if before!=after:return None
 status=json.loads(blobs['status.json']);meta=json.loads(blobs['metadata.json'])
 if meta.get('active') or status.get('stage') not in TERMINAL:return None
 # Intentionally retain marker-free finished captures: they produce insufficiency.
 hashes={n:hashlib.sha256(b).hexdigest() for n,b in blobs.items()};key=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()[:16]
 target=output/'snapshots'/directory.name/key;target.mkdir(parents=True,exist_ok=True)
 for n,b in blobs.items():
  if (target/n).exists():
   if hashlib.sha256((target/n).read_bytes()).hexdigest()!=hashes[n]:raise ValueError('Frozen source checksum mismatch')
  else:(target/n).write_bytes(b)
 manifest={'run_id':directory.name,'source':str(directory.resolve()),'snapshot':str(target.resolve()),'sha256':hashes,'first_run_boundary':first_run}
 atomic_json(target/'manifest.json',manifest);return manifest


def chronological_split(record):
 total=sum(len(a) for a in record.segments.values())
 if total<2:return None
 halfway=total//2;seen=0
 for segment,a in sorted(record.segments.items()):
  if seen+len(a)>halfway:
   cutoff=float(a[halfway-seen,1]/1e6)
   return {'frame_index_zero_based':halfway,'segment':segment,'device_time_seconds':cutoff,'total_frames':total,'basis':'frame-order midpoint; no device-clock comparisons across resets','unscored_gap_seconds':1.0}
  seen+=len(a)
 raise ValueError('No chronological split found')


def calibration_record(record,split):
 arrays={}
 for segment,a in record.segments.items():
  if segment<split['segment']:arrays[segment]=a
  elif segment==split['segment']:
   selected=a[a[:,1]/1e6<=split['device_time_seconds']-.5]
   if len(selected):arrays[segment]=selected
 return Recording(record.run_id,arrays,[],record.quality,record.manifest)


def partition_windows(windows,split):
 calibration={'actions':[],'background':[]};check={'actions':[],'background':[]};buffered=[]
 for kind in ('actions','background'):
  for w in windows[kind]:
   s=w['segment'];c=w['center'];mid=split['device_time_seconds'];cs=split['segment']
   if s<cs or (s==cs and c<=mid-1):calibration[kind].append(w)
   elif s>cs or (s==cs and c>=mid+1):check[kind].append(w)
   else:buffered.append({'kind':kind,'segment':s,'center':c,'marker_id':w['marker_id']})
 return calibration,check,buffered


def nearby_analysis(record,count=100):
 peaks,thresholds=detect_events(record);eligible=[];excluded=[]
 for marker in record.markers:
  if marker.get('label') not in REACTIONS:continue
  center,error=marker_center(record,marker)
  if error is None:_,error=one_second_window(record.segments[marker['capture_segment']],center,[1.,1.])
  if error:excluded.append({'marker_id':marker['id'],'reason':error});continue
  eligible.append({'marker_id':marker['id'],'segment':marker['capture_segment'],'center':center})
 def matches(items):return sum(match_count([e['center'] for e in items if e['segment']==s],[p['time'] for p in peaks if p['segment']==s]) for s in record.segments)
 actual=matches(eligible);controls=[];attempts=0;rng=np.random.default_rng(20261017)
 while eligible and len(controls)<count and attempts<count*30:
  attempts+=1;fraction=float(rng.uniform(.02,.98));shifted=[];bad=False
  for event in eligible:
   a=record.segments[event['segment']];lo=a[0,1]/1e6+.525;hi=a[-1,1]/1e6-.525;period=hi-lo
   if period<=1:bad=True;break
   center=lo+(event['center']-lo+fraction*period)%period
   if one_second_window(a,center,[1.,1.])[1] is not None:bad=True;break
   shifted.append({**event,'center':center})
  if bad:continue
  controls.append(matches(shifted))
 return {'raw_event_count':len(peaks),'thresholds':thresholds,'eligible_markers':len(eligible),'excluded_markers':excluded,'possible_one_to_one_matches':actual,'controls_accepted':len(controls),'control_attempts':attempts,'control_counts':controls,'control_median_matches':float(np.median(controls)) if controls else None,'control_percentile_5_95':np.percentile(controls,[5,95]).tolist() if controls else None,'control_fraction_at_least_observed':float(np.mean(np.array(controls)>=actual)) if controls else None,'meaning':'Possible raw temporal coincidences only; common-shift controls are descriptive, not p-values.'}


def capture_analysis(manifest):
 record=load_recording(manifest);split=chronological_split(record)
 result={'schema_version':1,'run_id':record.run_id,'source_manifest':manifest,'method':METHOD,'analysis_scope':'This recording only; no earlier sensor/capture/model/scales/thresholds used','generated_at_utc':datetime.now(timezone.utc).isoformat(),'status':'insufficient_data','quality':record.quality,'marker_count':len([m for m in record.markers if m.get('label') in REACTIONS]),'nearby':nearby_analysis(record),'split':split,'measurement_verdict':'unverified','reaction_validated':False,'fear_classification':False,'can_claim_90pct_reliability':False}
 if split is None:return result
 cal_record=calibration_record(record,split)
 try:scales=training_scales([cal_record])
 except ValueError:return result
 windows=build_windows(record,scales);calibration,check,buffered=partition_windows(windows,split)
 specs=[];missing=[]
 if calibration['background']:
  specs.append({'name':'calibration_background_trigger_target_10pct','cutoff':float(np.quantile([w['score'] for w in calibration['background']],.9))})
 else:missing.append('No usable calibration background windows')
 if calibration['actions']:
  scores=np.array([w['score'] for w in calibration['actions']]);options=np.unique(np.r_[0.,scores]);retained=[x for x in options if np.mean(scores>x)>=.9]
  if retained:specs.append({'name':'calibration_sensitivity_at_least_90pct','cutoff':float(max(retained))})
  else:missing.append('No threshold reaches90%calibration hits withstrictgreater-than rule')
 else:missing.append('No usable calibration action markers')
 table=[{**spec,'calibration':evaluate(calibration,spec['cutoff']),'chronological_check':evaluate(check,spec['cutoff'])} for spec in specs]
 result.update({'status':'descriptive_only_small_within_recording_check' if check['actions'] and check['background'] and table else 'insufficient_labelled_check_windows','scales_from_this_recording_calibration_only':scales.tolist(),'calibration_frame_count':sum(len(a) for a in cal_record.segments.values()),'calibration_windows':{k:len(v) for k,v in calibration.items()},'chronological_check_windows':{k:len(v) for k,v in check.items()},'buffered_windows':buffered,'excluded_markers':windows['excluded'],'overlapping_action_windows':windows['overlapping_action_windows'],'threshold_table':table,'missing_requirements':missing,'limitation':'Same-recording time split is not independent-session validation. Small trial counts and unmarked pseudo-negatives prevent a reliability claim. Every source quality flag is retained.'})
 return json_ready(result)


def frozen_config_check(record,config,config_hash,split):
 if record.run_id<config['source_run']:
  return {'status':'not_applicable_before_configuration_selection','source_run':config['source_run'],'config_sha256':config_hash}
 checked=RawSpikeConfig(tuple(config['channel_scales']),float(config['threshold']),config['threshold_name'],config.get('version','replacement-demo-v1'),float(config.get('max_gap_seconds',.024)))
 windows=build_windows(record,checked.channel_scales)
 result={'status':'descriptive_unverified','evaluation_kind':'posthoc_selection_recording_not_validation' if record.run_id==config['source_run'] else 'new_recording_frozen_config_check','source_run':config['source_run'],'config_sha256':config_hash,'threshold':checked.threshold,'threshold_name':checked.threshold_name,'channel_scales':list(checked.channel_scales),'refitted':False,'config_modified':False,'all_recording_windows':evaluate(windows,checked.threshold),'excluded_markers':windows['excluded'],'quality':'unverified','valid_measurement':False,'reaction_validated':False}
 if record.run_id==config['source_run'] and split is not None:
  _,later,_=partition_windows(windows,split)
  result['posthoc_selected_later_subset']=evaluate(later,checked.threshold)
 return json_ready(result)


def execute(recordings,first_run,output,run_id=None,detector_config=None):
 if not recordings.is_dir():raise ValueError('Recording directory does not exist')
 config=None;config_hash=None
 if detector_config is not None:
  config_bytes=Path(detector_config).read_bytes();config=json.loads(config_bytes);config_hash=hashlib.sha256(config_bytes).hexdigest()
  if config.get('cohort_first_run')!=first_run or config.get('source_run','')<first_run:raise ValueError('Frozen configuration belongs to a different sensor boundary')
  RawSpikeConfig(tuple(config['channel_scales']),float(config['threshold']),config['threshold_name'])
 paths=candidate_paths(recordings,first_run,run_id);output.mkdir(parents=True,exist_ok=True)
 implementation={n:Path(__file__).with_name(n).read_bytes() for n in ('independent_capture.py','core.py','binary_threshold.py','raw_spike_detector.py')};hashes={n:hashlib.sha256(b).hexdigest() for n,b in implementation.items()};bundle_key=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()[:16];bundle=output/'implementation'/bundle_key;bundle.mkdir(parents=True,exist_ok=True)
 for n,b in implementation.items():
  if not (bundle/n).exists():(bundle/n).write_bytes(b)
 processed=[]
 with (output/'.analysis.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  index_path=output/'index.json';index=json.loads(index_path.read_text()) if index_path.exists() else {'schema_version':1,'first_run_boundary':first_run,'analysis_policy':'Each recording separately; no pooling or prior fitted values','runs':{}}
  if index.get('first_run_boundary')!=first_run:raise ValueError('Output directory belongs to a different sensor boundary')
  for directory in paths:
   manifest=freeze_one(directory,output,first_run)
   if manifest is None:continue
   key=hashlib.sha256(json.dumps({'source':manifest['sha256'],'method':METHOD,'implementation':hashes,'frozen_config_sha256':config_hash},sort_keys=True).encode()).hexdigest()[:16];path=output/'runs'/directory.name/f'independent-{key}.json'
   if path.exists():report=json.loads(path.read_text())
   else:
    report=capture_analysis(manifest)
    if config is not None:
     report['frozen_detector_evaluation']=frozen_config_check(load_recording(manifest),config,config_hash,report['split'])
     report['analysis_scope']='Independent per-recording calibration plus separately labelled user-authorized frozen-demo-config check; no cross-recording pooling or refitting.'
    report['implementation_sha256']=hashes;report['implementation_snapshot']=str(bundle.resolve());atomic_json(path,report)
   index['runs'][directory.name]={'report':str(path.resolve()),'source_sha256':manifest['sha256'],'status':report['status']};processed.append({'run_id':directory.name,'report':str(path.resolve()),'status':report['status']})
  index['updated_at_utc']=datetime.now(timezone.utc).isoformat();atomic_json(index_path,index)
  if index['runs']:
   latest_id=max(index['runs']);latest=json.loads(Path(index['runs'][latest_id]['report']).read_text());latest['cohort_first_run_boundary']=first_run;atomic_json(output/'latest.json',latest)
  atomic_json(output/'independent-method.json',METHOD)
 return {'processed':processed,'first_run_boundary':first_run,'latest':str((output/'latest.json').resolve()) if (output/'latest.json').exists() else None}


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--recordings',type=Path,required=True);p.add_argument('--first-run',required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--run-id');p.add_argument('--detector-config',type=Path,help='Optional user-frozen demo configuration; evaluated separately without refitting or changing the file');args=p.parse_args()
 try:result=execute(args.recordings,args.first_run,args.output,args.run_id,args.detector_config)
 except (ValueError,OSError,KeyError,json.JSONDecodeError) as exc:print(f'Independent capture analysis failed: {exc}',file=sys.stderr);return 2
 print(json.dumps(result));return 0

if __name__=='__main__':raise SystemExit(main())
