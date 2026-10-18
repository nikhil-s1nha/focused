"""Separate exploratory pooled-reaction threshold study; no hardware/UI access.

Earlier recordings calibrate score scales and thresholds. The latest whole recording
is held out. Because that recording was viewed before this question, this is not a
pristine prospective validation. Unmarked background is not verified no-action.
"""
from __future__ import annotations
import argparse,hashlib,json,os,sys
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
import numpy as np
from .core import REACTIONS,freeze_finished,load_recording,marker_center,normalize_label


def eligible_differences(a):
    time=a[:,1]/1e6
    return (np.diff(time)>0)&(np.diff(time)<=.024)&(np.diff(a[:,0])==1)


def training_scales(recordings):
    """One fixed 99th-percentile step scale per channel, training recordings only."""
    values=[]
    for record in recordings:
        for a in record.segments.values():
            valid=eligible_differences(a)
            if valid.any():values.append(np.abs(np.diff(a[:,3:5].astype(float),axis=0))[valid])
    if not values:raise ValueError('No eligible training differences')
    return np.maximum(np.percentile(np.concatenate(values),99,axis=0),1.)


def one_second_window(a,center,scales):
    """Same full one-second opportunity for action and unmarked-background windows."""
    t=a[:,1]/1e6;left=np.searchsorted(t,center-.5,'left');right=np.searchsorted(t,center+.5,'right');w=a[left:right];wt=t[left:right]
    if len(w)<100:return None,'too_few_frames'
    if wt[0]>center-.5+.025 or wt[-1]<center+.5-.025:return None,'incomplete_window'
    # Include bracketing samples: a gap crossing a window boundary must not be
    # hidden merely because its earlier endpoint was outside the scoring interval.
    if left==0 or right==len(a):return None,'unbracketed_window'
    context=a[left-1:right+1];context_t=context[:,1]/1e6
    if np.any(np.diff(context_t)>.024) or np.any(np.diff(context_t)<=0) or np.any(np.diff(context[:,0])!=1):return None,'gap_or_discontinuity'
    steps=np.max(np.abs(np.diff(w[:,3:5].astype(float),axis=0))/scales,axis=1)
    return {'score':float(np.max(steps)),'center':float(center),'actual_exposure_seconds':float(wt[-1]-wt[0]),'step_times':wt[1:].tolist(),'step_scores':steps.tolist(),'first_sequence':int(w[0,0]),'last_sequence':int(w[-1,0])},None


def build_windows(record,scales):
    actions=[];background=[];excluded=[];centers={s:[] for s in record.segments}
    for marker in record.markers:
        label=normalize_label(marker.get('label'))
        if label is None:continue
        center,error=marker_center(record,marker)
        if center is not None:centers[marker['capture_segment']].append(center)
        window=None
        if error is None:window,error=one_second_window(record.segments[marker['capture_segment']],center,scales)
        if error:excluded.append({'id':marker['id'],'label':marker['label'],'reason':error});continue
        if label in REACTIONS:
            actions.append({**window,'marker_id':marker['id'],'action_label':label,'segment':marker['capture_segment'],'origin':'manual_action_marker','binary_label':'Reaction'})
        else:
            background.append({**window,'marker_id':marker['id'],'segment':marker['capture_segment'],'origin':'explicit_no_action_marker','binary_label':'Background'})
    for segment,a in record.segments.items():
        t=a[:,1]/1e6
        for center in np.arange(t[0]+.525,t[-1]-.5,1.):
            # The control interval must also be separated from the uncertain action interval.
            if any(abs(center-c)<1.5 for c in centers[segment]):continue
            window,error=one_second_window(a,center,scales)
            if error is None:background.append({**window,'marker_id':None,'segment':segment,'origin':'unmarked_pseudo_negative_not_verified_no_action','binary_label':'Background'})
    overlaps=sum(abs(a['center']-b['center'])<1 for i,a in enumerate(actions) for b in actions[i+1:] if a['segment']==b['segment'])
    return {'run_id':record.run_id,'actions':actions,'background':background,'excluded':excluded,'overlapping_action_windows':overlaps,'quality':record.quality}


def fit_thresholds(training):
    action=np.array([w['score'] for r in training for w in r['actions']]);background=np.array([w['score'] for r in training for w in r['background']])
    if not len(action) or not len(background):raise ValueError('Need both marked actions and unmarked-background training windows')
    candidates=np.unique(np.r_[0.,action,background]);
    best=max(candidates,key=lambda cutoff:(.5*(np.mean(action>cutoff)+np.mean(background<=cutoff)),cutoff))
    recall_candidates=[c for c in candidates if np.mean(action>c)>=.9]
    thresholds=[{'name':f'train_background_false_alarm_target_{int(rate*100)}pct','cutoff':float(np.quantile(background,1-rate))} for rate in (.05,.10,.20)]
    thresholds.append({'name':'best_training_balanced_accuracy','cutoff':float(best)})
    thresholds.append({'name':'training_sensitivity_at_least_90pct','cutoff':float(max(recall_candidates)) if recall_candidates else 0.})
    thresholds.append({'name':'any_nonzero_change','cutoff':0.})
    return thresholds


def false_events(windows,cutoff):
    # Suppress repeated threshold crossings from the same burst; aggregate across
    # disjoint one-second controls before suppression so boundary events are not doubled.
    events={};exposure=0.
    for w in windows:
        exposure+=w['actual_exposure_seconds'];events.setdefault(w['segment'],{})
        for t,s in zip(w['step_times'],w['step_scores']):
            if s>cutoff:events[w['segment']][t]=max(s,events[w['segment']].get(t,0))
    count=0
    for candidates in events.values():
        kept=[]
        for time,score in sorted(candidates.items(),key=lambda x:(-x[1],x[0])):
            if all(abs(time-k)>.25 for k in kept):kept.append(time)
        count+=len(kept)
    return count,exposure


def evaluate(windows,cutoff):
    actions=windows['actions'];background=windows['background']
    hits=sum(w['score']>cutoff for w in actions);false=sum(w['score']>cutoff for w in background)
    pseudo=[w for w in background if w['origin'].startswith('unmarked_')]
    explicit=[w for w in background if w['origin']=='explicit_no_action_marker']
    events,seconds=false_events(background,cutoff)
    sensitivity=hits/len(actions) if actions else None;fpr=false/len(background) if background else None
    per_action={label:{'hits':sum(w['score']>cutoff for w in actions if w['action_label']==label),'n':sum(w['action_label']==label for w in actions)} for label in REACTIONS}
    return {'reaction_hits':hits,'reaction_windows':len(actions),'sensitivity':sensitivity,'background_false_alarm_windows':false,'background_windows':len(background),'unmarked_background_false_alarm_windows':sum(w['score']>cutoff for w in pseudo),'unmarked_background_windows':len(pseudo),'explicit_no_action_false_alarm_windows':sum(w['score']>cutoff for w in explicit),'explicit_no_action_windows':len(explicit),'background_false_alarm_fraction':fpr,'background_false_events':events,'background_exposure_seconds':seconds,'background_false_events_per_minute':events/(seconds/60) if seconds else None,'balanced_accuracy':.5*(sensitivity+1-fpr) if sensitivity is not None and fpr is not None else None,'per_action_descriptive':per_action,'physiological_precision':None,'precision_note':'Not estimated: background is unmarked rather than verified no-action and the sampled action prevalence is artificial.','measurement_verdict':'unreliable'}


def combine(windows):
    # Avoid merging simultaneous device timestamps from separate recordings.
    combined={'actions':[],'background':[]}
    for run in windows:
        for name in ('actions','background'):
            combined[name].extend({**w,'segment':f"{run['run_id']}:{w['segment']}"} for w in run[name])
    return combined


def schedule_controls(record,scales,eligible_actions,thresholds,count=100):
    """Identical +/-0.5s neighborhoods and gap coverage, per requested audit."""
    rng=np.random.default_rng(20261017);rows=[];attempts=0
    while len(rows)<count and attempts<count*30:
        attempts+=1;fraction=float(rng.uniform(.02,.98));shifted=[];failure=False
        for action in eligible_actions:
            a=record.segments[action['segment']];lo=a[0,1]/1e6+.525;hi=a[-1,1]/1e6-.525;period=hi-lo
            if period<=1:failure=True;break
            center=lo+(action['center']-lo+fraction*period)%period
            window,error=one_second_window(a,center,scales)
            if error:failure=True;break
            shifted.append(window)
        if failure:continue
        rows.append([sum(w['score']>spec['cutoff'] for w in shifted) for spec in thresholds])
    matrix=np.array(rows)
    results=[]
    for j,spec in enumerate(thresholds):
        actual=sum(w['score']>spec['cutoff'] for w in eligible_actions)
        col=matrix[:,j] if len(rows) else np.array([])
        results.append({'name':spec['name'],'observed_hits':actual,'shift_median_hits':float(np.median(col)) if len(col) else None,'shift_percentile_5_95':np.percentile(col,[5,95]).tolist() if len(col) else None,'fraction_shifts_at_least_observed':float(np.mean(col>=actual)) if len(col) else None})
    return {'accepted':len(rows),'attempts':attempts,'same_event_count':len(eligible_actions),'thresholds':results,'caveat':'Every shifted one-second neighborhood passes exactly the same sample-count/edge/gap rule. Whole-schedule shifts preserve ordering except wrap, but not stationarity. Fractions are descriptive benchmarks, not p-values.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--recordings',type=Path,default=Path('backend/results/bench-recordings'));parser.add_argument('--output',type=Path,default=Path('backend/results/reaction-binary-review'));args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    manifests=freeze_finished(args.recordings,args.output);records=[load_recording(m) for m in manifests]
    if len(records)<2:raise ValueError('Need at least two finished recordings')
    training=records[:-1];heldout=records[-1];scales=training_scales(training);train_windows=[build_windows(r,scales) for r in training];test_windows=build_windows(heldout,scales)
    pooled=combine(train_windows);thresholds=fit_thresholds(train_windows)
    table=[{**spec,'training':evaluate(pooled,spec['cutoff']),'heldout':evaluate(test_windows,spec['cutoff'])} for spec in thresholds]
    result={'schema_version':1,'generated_at_utc':datetime.now(timezone.utc).isoformat(),'task':'Pooled Reaction versus unmarked background; never fear','assessment_type':'Exploratory whole-recording holdout already observed before binary question; not pristine prospective validation','training_runs':[r.run_id for r in training],'holdout_run':heldout.run_id,'scales_trained_only_on_earlier_recordings':scales.tolist(),'score':'Maximum over both channel-normalized absolute firstdifferences inside full1-secondwindow centered atanchor+parse_age. Fixedindependentplus/minus0.5s timing opportunity; strict>cutoff. Training99thpercentilestep scales, floors1count.','threshold_selection':'All cutoffs selected using only earlier recordings; heldout never selects a cutoff. Anychange is a nonvalidated sensitivity ceiling.','quality':[{'run_id':r.run_id,**r.quality} for r in records],'source_manifests':manifests,'window_counts':{'training':[{'run_id':r['run_id'],'actions':len(r['actions']),'background':len(r['background']),'excluded':r['excluded'],'overlapping_action_windows':r['overlapping_action_windows']} for r in train_windows],'heldout':{'actions':len(test_windows['actions']),'background':len(test_windows['background']),'excluded':test_windows['excluded'],'overlapping_action_windows':test_windows['overlapping_action_windows']}},'threshold_table':table,'equal_opportunity_shift_controls':schedule_controls(heldout,scales,test_windows['actions'],thresholds),'can_claim_90pct_reliability':False,'measurement_verdict':'unreliable','limitations':['All recordings retain failedhardwarestatus/configuration; neither reaction nor fear is biologicallyvalidated.','Unmarked background is not confirmednoaction; falsealarms are proxyestimates on thosewindows.','Per-markerparseage is not physicalonsetsynchronization; claimed±0.5s actionerror is an assumption.','A high sensitivity alone is not90% reliability; specificity,falsealarms,independentvalidation,andtrueprevalence matter.','Eventrate uses strongest-first250ms suppression on backgroundthresholdcrossings divided by actual analyzedbackgroundseconds.','The initial testrecordingwas alreadyviewed; tuneontrainingonly does not make thisa newblindvalidation.']}
    retrospective=[]
    for index,record in enumerate(records):
        fold_training=[r for j,r in enumerate(records) if j!=index]
        fold_scales=training_scales(fold_training)
        fold_train_windows=[build_windows(r,fold_scales) for r in fold_training]
        fold_test=build_windows(record,fold_scales)
        fold_thresholds=fit_thresholds(fold_train_windows)
        retrospective.append({'heldout_run':record.run_id,'training_runs':[r.run_id for r in fold_training],'scales':fold_scales.tolist(),'thresholds':[{**spec,**evaluate(fold_test,spec['cutoff'])} for spec in fold_thresholds]})
    result['leave_one_recording_out_retrospective']=retrospective
    result['detector_configs']=[{'version':'pooled-raw-step-v1','channel_scales':scales.tolist(),'threshold':spec['cutoff'],'threshold_name':spec['name'],'max_gap_seconds':.024,'valid_measurement':False,'reaction_validated':False,'quality':'unverified'} for spec in thresholds]
    source=Path(__file__).read_bytes();result['analysis_source_sha256']=hashlib.sha256(source).hexdigest();(args.output/'binary_threshold.py').write_bytes(source)
    implementation={name:Path(__file__).with_name(name).read_bytes() for name in ('binary_threshold.py','raw_spike_detector.py','core.py')}
    result['implementation_sha256']={name:hashlib.sha256(content).hexdigest() for name,content in implementation.items()}
    implementation_key=hashlib.sha256(json.dumps(result['implementation_sha256'],sort_keys=True).encode()).hexdigest()[:16]
    bundle=args.output/'implementation'/implementation_key;bundle.mkdir(parents=True,exist_ok=True)
    for name,content in implementation.items():
        if not (bundle/name).exists():(bundle/name).write_bytes(content)
    result['implementation_snapshot']=str(bundle.resolve())
    encoded=json.dumps(result,indent=2,allow_nan=False).encode()
    archive_key=hashlib.sha256(json.dumps({'inputs':manifests,'implementation':result['implementation_sha256']},sort_keys=True).encode()).hexdigest()[:16]
    archive=args.output/f'binary-analysis-{archive_key}.json'
    if not archive.exists():archive.write_bytes(encoded)
    temp=args.output/f'.latest-{os.getpid()}.json';temp.write_bytes(encoded);os.replace(temp,args.output/'latest.json')
    for row in table:
        t=row['training'];v=row['heldout'];print(f"{row['name']}: cutoff={row['cutoff']:.6g}; trainhit={t['reaction_hits']}/{t['reaction_windows']}, trainfalse={t['background_false_alarm_windows']}/{t['background_windows']}; TEST hit={v['reaction_hits']}/{v['reaction_windows']}, false={v['background_false_alarm_windows']}/{v['background_windows']}, falseevents/min={v['background_false_events_per_minute']:.2f}")
    print('Heldout:',heldout.run_id,'; source/report:',args.output/'latest.json')

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,json.JSONDecodeError) as exc:
        print(f'Offline binary analysis failed: {exc}',file=sys.stderr);raise SystemExit(2)
