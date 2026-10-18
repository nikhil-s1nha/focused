"""Offline raw-count association analysis. No device, network or UI access.

The output never converts invalid hardware bytes into EEG, physiology or emotions.
"""
from __future__ import annotations
import hashlib, json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
import numpy as np

LABELS=('Blink','Jaw clench','Startle / flinch','Background')
REACTIONS=LABELS[:3]
ALIASES={'No action':'Background','Background':'Background'}
TERMINAL={'stopped_original_restored','capture_failed_original_restored'}


def normalize_label(value):
    return value if value in REACTIONS else ALIASES.get(value)


def digest(data): return hashlib.sha256(data).hexdigest()


def freeze_finished(recordings: Path, output: Path):
    """Freeze a consistent finished archive, never read the live serial device."""
    frozen=[]
    for directory in sorted(recordings.glob('object-ui-*')):
        names=('raw.txt','markers.json','status.json','metadata.json')
        if not all((directory/n).is_file() for n in names):continue
        before={n:(directory/n).stat().st_mtime_ns for n in names}
        blobs={n:(directory/n).read_bytes() for n in names}
        after={n:(directory/n).stat().st_mtime_ns for n in names}
        if before!=after:continue
        status=json.loads(blobs['status.json']); metadata=json.loads(blobs['metadata.json']); markers=json.loads(blobs['markers.json'])
        if metadata.get('active') or status.get('stage') not in TERMINAL:continue
        if not any(normalize_label(m.get('label')) for m in markers):continue
        hashes={n:digest(b) for n,b in blobs.items()}
        version=digest(json.dumps(hashes,sort_keys=True).encode())[:16]
        target=output/'snapshots'/directory.name/version
        target.mkdir(parents=True,exist_ok=True)
        for name,content in blobs.items():
            destination=target/name
            if destination.exists():
                if digest(destination.read_bytes())!=hashes[name]:raise ValueError(f'Frozen source checksum mismatch: {destination}')
            else:destination.write_bytes(content)
        manifest={'run_id':directory.name,'source':str(directory.resolve()),'snapshot':str(target.resolve()),'sha256':hashes}
        (target/'manifest.json').write_text(json.dumps(manifest,indent=2))
        frozen.append(manifest)
    return frozen


@dataclass
class Recording:
    run_id: str
    segments: dict
    markers: list
    quality: dict
    manifest: dict


def load_recording(manifest):
    p=Path(manifest['snapshot']); segment=0; segments={};configs=[];bad_lines=0
    for line in (p/'raw.txt').read_text().splitlines():
        fields=line.split(',')
        if fields[0]=='FRAME_FORMAT_OBJECT_BENCH_ONLY':segment+=1;segments[segment]=[]
        elif fields[0]=='CONFIG_READBACK_MISMATCHES':configs.append(int(fields[1]))
        elif fields[0]=='UNTRUSTED_BYPASS':
            try:
                if len(fields)!=4 or len(fields[3])!=18 or segment==0:raise ValueError('Malformed frame')
                b=bytes.fromhex(fields[3]);segments[segment].append((int(fields[1]),int(fields[2]),int.from_bytes(b[:3],'big'),int.from_bytes(b[3:6],'big',signed=True),int.from_bytes(b[6:],'big',signed=True)))
            except ValueError:bad_lines+=1
    arrays={s:np.asarray(rows,dtype=np.int64) for s,rows in segments.items() if rows}
    total=sum(len(a) for a in arrays.values())
    valid=sum(int(np.sum((a[:,2]&0xF01FFF)==0xC00000)) for a in arrays.values())
    quality={'frames':total,'valid_status_frames':valid,'invalid_status_frames':total-valid,'config_readback_mismatches':configs,'malformed_frame_lines':bad_lines,'physiology_verified':False,'measurement_verdict':'unreliable','reason':'Bench/raw provenance is not verified human physiology; protocol failures additionally invalidate measurement settings.'}
    return Recording(manifest['run_id'],arrays,json.loads((p/'markers.json').read_text()),quality,manifest)


def marker_center(recording, marker):
    a=recording.segments.get(marker.get('capture_segment'))
    if a is None:return None,'missing_segment'
    mask=(a[:,0]==marker.get('nearest_sequence'))&(a[:,1]==marker.get('nearest_read_micros'))
    if int(np.sum(mask))!=1:return None,'nonunique_or_missing_anchor'
    if marker.get('phase_id')!=marker.get('nearest_phase_id'):return None,'phase_mismatch'
    age=marker.get('frame_age_seconds')
    if not isinstance(age,(int,float)) or not np.isfinite(age) or age<0 or age>2:return None,'invalid_or_stale_frame_age'
    return marker['nearest_read_micros']/1e6+age,None


def window_features(array,center,half_width=1.0):
    """Symmetric envelope covers independently varying +/-0.5s marker error.

    Nominal half-second event context is expanded by half-second timing tolerance.
    No label-dependent offset search, interpolation, sign masking or filtering.
    """
    t=array[:,1]/1e6
    left=np.searchsorted(t,center-half_width,side='left');right=np.searchsorted(t,center+half_width,side='left')
    w=array[left:right];wt=t[left:right]
    if len(w)<200:return None,'too_few_frames'
    if wt[0]>center-half_width+.025 or wt[-1]<center+half_width-.025:return None,'incomplete_window'
    if np.any(np.diff(wt)>.024) or np.any(np.diff(wt)<=0) or np.any(np.diff(w[:,0])!=1):return None,'gap_or_discontinuity'
    x=w[:,3:5].astype(float)
    values=[]
    for ch in range(2):
        z=x[:,ch]
        values.extend([float(np.log1p(np.std(z))),float(np.log1p(np.mean(np.abs(np.diff(z))))),float(np.mean(z<0)),float(np.mean(z==0))])
    return values,None


def samples_for_recording(recording):
    samples=[];excluded=[];all_centers={s:[] for s in recording.segments}
    for marker in recording.markers:
        label=normalize_label(marker.get('label'))
        if label is None:continue
        center,error=marker_center(recording,marker)
        if center is not None:all_centers[marker['capture_segment']].append(center)
        values=None
        if error is None:values,error=window_features(recording.segments[marker['capture_segment']],center)
        if error:excluded.append({'marker_id':marker['id'],'label':label,'reason':error});continue
        samples.append({'run_id':recording.run_id,'segment':marker['capture_segment'],'center':center,'label':label,'origin':'manual_marker','marker_id':marker['id'],'features':values,'measurement_verdict':'unreliable'})
    candidates=[]
    for segment,a in recording.segments.items():
        t=a[:,1]/1e6
        for center in np.arange(t[0]+1.025,t[-1]-1,2.0):
            if any(abs(center-m)<2.0 for m in all_centers[segment]):continue
            values,error=window_features(a,center)
            if error is None:candidates.append({'run_id':recording.run_id,'segment':segment,'center':float(center),'label':'Background','origin':'unmarked_pseudo_negative_not_confirmed_rest','marker_id':None,'features':values,'measurement_verdict':'unreliable'})
    cap=sum(normalize_label(m.get('label')) in REACTIONS for m in recording.markers)
    if len(candidates)>cap:candidates=[candidates[i] for i in np.linspace(0,len(candidates)-1,cap,dtype=int)]
    return samples+candidates,excluded


class CentroidMatcher:
    """A descriptive raw-count matcher. No class probabilities or calibrated confidence."""
    def fit(self,samples):
        if not samples:raise ValueError('No training samples')
        self.classes=[c for c in LABELS if any(s['label']==c for s in samples)]
        self.training_runs=sorted(set(s['run_id'] for s in samples))
        X=np.array([s['features'] for s in samples]);self.mean=X.mean(axis=0);self.scale=X.std(axis=0);self.keep=self.scale>1e-12
        Z=(X[:,self.keep]-self.mean[self.keep])/self.scale[self.keep]
        self.centers=np.stack([Z[np.array([s['label']==c for s in samples])].mean(axis=0) for c in self.classes])
        return self
    def predict(self,samples):
        if not samples:return []
        if not np.any(self.keep):return ['Unknown' for _ in samples]
        X=np.array([s['features'] for s in samples]);Z=(X[:,self.keep]-self.mean[self.keep])/self.scale[self.keep]
        d=((Z[:,None,:]-self.centers[None,:,:])**2).sum(axis=2)
        return [self.classes[int(i)] for i in d.argmin(axis=1)]


def metrics(samples,predictions,classes):
    truth=[s['label'] for s in samples];n=len(truth);counts=Counter(truth)
    classes=tuple(classes)+(('Unknown',) if 'Unknown' in predictions and 'Unknown' not in classes else ())
    present=[c for c in classes if counts[c]]
    recall={c:sum(t==c and p==c for t,p in zip(truth,predictions))/counts[c] for c in present}
    return {'n':n,'correct':sum(t==p for t,p in zip(truth,predictions)),'accuracy':sum(t==p for t,p in zip(truth,predictions))/n if n else None,'balanced_accuracy':float(np.mean(list(recall.values()))) if recall else None,'majority_accuracy':max(counts.values())/n if n else None,'balanced_chance':1/len(present) if present else None,'class_counts':dict(counts),'class_recall':recall,'confusion_rows_truth_columns_prediction':[[sum(t==a and p==b for t,p in zip(truth,predictions)) for b in classes] for a in classes],'class_order':list(classes)}


def evaluate_fold(samples,holdout_run,include_background=True):
    selected=[s for s in samples if include_background or s['label'] in REACTIONS]
    train=[s for s in selected if s['run_id']!=holdout_run];test=[s for s in selected if s['run_id']==holdout_run]
    if not train or not test:return {'status':'insufficient_data','test_run':holdout_run},None
    model=CentroidMatcher().fit(train)
    assert holdout_run not in model.training_runs
    predictions=model.predict(test);result=metrics(test,predictions,LABELS if include_background else REACTIONS)
    training_label_counts=Counter(s['label'] for s in train)
    training_majority=max(model.classes,key=lambda c:training_label_counts[c])
    result.update({'training_majority_label':training_majority,'training_majority_accuracy_on_holdout':sum(s['label']==training_majority for s in test)/len(test),'majority_baseline_note':'majority_accuracy is the best constant label on the held-out labels, an oracle descriptive baseline; training_majority_accuracy_on_holdout uses only training data to select its label.','status':'exploratory_only','test_run':holdout_run,'training_runs':model.training_runs,'training_n':len(train),'predictions':[{'marker_id':s['marker_id'],'origin':s['origin'],'truth':s['label'],'candidate_label':p,'measurement_verdict':'unreliable'} for s,p in zip(test,predictions)]})
    return result,model


def shifted_classification_controls(recording,model,samples,observed,count=100):
    """Same uncertain window and marker schedule: no wider search for real events."""
    original=[s for s in samples if s['run_id']==recording.run_id and s['origin']=='manual_marker' and s['label'] in REACTIONS]
    if not original or model is None:return {'status':'insufficient_data'}
    rng=np.random.default_rng(20261017);scores=[];attempts=0
    while len(scores)<count and attempts<count*30:
        attempts+=1;shifted=[];failure=False
        # One random common shift fraction per recording preserves schedule ordering.
        fraction=float(rng.uniform(.02,.98))
        for s in original:
            a=recording.segments[s['segment']];lo=a[0,1]/1e6+1.025;hi=a[-1,1]/1e6-1.025;period=hi-lo
            if period<=2:failure=True;break
            center=lo+(s['center']-lo+fraction*period)%period
            values,error=window_features(a,center)
            if error:failure=True;break
            shifted.append({**s,'center':center,'features':values})
        if failure:continue
        score=metrics(shifted,model.predict(shifted),REACTIONS)
        scores.append(score['balanced_accuracy'])
    return {'status':'descriptive_control_not_p_value','accepted_shifts':len(scores),'attempts':attempts,'same_event_count_each_shift':len(original),'balanced_accuracy_scores':scores,'median_balanced_accuracy':float(np.median(scores)) if scores else None,'percentile_5_95':np.percentile(scores,[5,95]).tolist() if scores else None,'fraction_at_least_observed':float(np.mean(np.array(scores)>=observed['balanced_accuracy']-1e-12)) if scores and observed.get('balanced_accuracy') is not None else None,'caveat':'Circular shifts preserve label order except wrap, not stationarity; all windows must pass the identical gap rule. No statistical significance or physiological claim.'}


def detect_events(recording):
    events=[];thresholds=[]
    for segment,a in recording.segments.items():
        t=a[:,1]/1e6;valid=(np.diff(t)>0)&(np.diff(t)<=.024)&(np.diff(a[:,0])==1)
        if not valid.any():continue
        candidates=[]
        for col,ch in [(3,'ch1'),(4,'ch2')]:
            steps=np.abs(np.diff(a[:,col].astype(float)));cutoff=float(np.percentile(steps[valid],99));crossings=np.flatnonzero(valid&(steps>cutoff))+1;kept=[]
            for i in sorted(crossings,key=lambda i:(-steps[i-1],t[i])):
                if all(abs(t[i]-t[j])>.25 for j in kept):kept.append(i)
            thresholds.append({'segment':segment,'channel':ch,'cutoff':cutoff,'crossings':len(crossings),'retained':len(kept)})
            for i in kept:candidates.append({'segment':segment,'time':float(t[i]),'sequence':int(a[i,0]),'channel':ch,'step':float(steps[i-1]),'normalized_step':float(steps[i-1]/cutoff) if cutoff else float(steps[i-1])})
        pooled=[]
        for candidate in sorted(candidates,key=lambda e:(-e['normalized_step'],e['time'])):
            if all(abs(candidate['time']-p['time'])>.1 for p in pooled):pooled.append(candidate)
        events.extend(sorted(pooled,key=lambda p:p['time']))
    return events,thresholds


def match_count(markers,events,tolerance=.5):
    """Maximum cardinality for sorted time points with equal interval tolerance."""
    m=sorted(markers);e=sorted(events);i=j=total=0
    while i<len(m) and j<len(e):
        if e[j]<m[i]-tolerance:j+=1
        elif e[j]>m[i]+tolerance:i+=1
        else:total+=1;i+=1;j+=1
    return total


def event_opportunity_controls(recording,count=100):
    events,thresholds=detect_events(recording);observed=0;centers={};times={};rng=np.random.default_rng(20261017)
    for segment,a in recording.segments.items():
        centers[segment]=[];times[segment]=[e['time'] for e in events if e['segment']==segment]
        for m in recording.markers:
            if m.get('capture_segment')!=segment or normalize_label(m.get('label')) not in REACTIONS:continue
            center,error=marker_center(recording,m)
            if error is None and a[0,1]/1e6+.5<=center<=a[-1,1]/1e6-.5:centers[segment].append(center)
        observed+=match_count(centers[segment],times[segment])
    controls=[]
    for _ in range(count):
        fraction=float(rng.uniform(.02,.98));total=0
        for segment,a in recording.segments.items():
            lo=a[0,1]/1e6+.5;hi=a[-1,1]/1e6-.5;period=hi-lo
            if period<=0:continue
            shifted=[lo+(v-lo+fraction*period)%period for v in centers[segment]]
            total+=match_count(shifted,times[segment])
        controls.append(total)
    return {'event_count':len(events),'eligible_markers':sum(map(len,centers.values())),'possible_temporal_matches':observed,'thresholds':thresholds,'shift_control_count':len(controls),'shift_control_median_matches':float(np.median(controls)),'shift_control_percentile_5_95':np.percentile(controls,[5,95]).tolist(),'shift_control_fraction_at_least_observed':float(np.mean(np.array(controls)>=observed)),'classification':'temporal_coincidence_only','caveat':'Same plus/minus0.5 second opportunity and one-to-one constraint for real and shifted schedules; no physiological interpretation. Controls are descriptive, not a p-value.'}
