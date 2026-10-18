"""Freeze finished recordings and emit an atomic analysis report."""
import argparse,json,os,sys
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
from .core import (REACTIONS,digest,freeze_finished,load_recording,samples_for_recording,
                   evaluate_fold,shifted_classification_controls,event_opportunity_controls)


def analyze(recordings,output):
    output.mkdir(parents=True,exist_ok=True)
    recipe_path=Path(__file__).with_name('recipe.json');recipe_bytes=recipe_path.read_bytes();recipe=json.loads(recipe_bytes)
    implementation={name:Path(__file__).with_name(name).read_bytes() for name in ('core.py','__main__.py','__init__.py','recipe.json')}
    implementation_hashes={name:digest(content) for name,content in implementation.items()}
    implementation_key=digest(json.dumps(implementation_hashes,sort_keys=True).encode())[:16]
    implementation_dir=output/'implementation'/implementation_key
    implementation_dir.mkdir(parents=True,exist_ok=True)
    for name,content in implementation.items():
        destination=implementation_dir/name
        if not destination.exists():destination.write_bytes(content)
    manifests=freeze_finished(recordings,output)
    captures=[load_recording(m) for m in manifests]
    dataset=[];summaries=[]
    for recording in captures:
        samples,excluded=samples_for_recording(recording);dataset.extend(samples)
        summaries.append({'run_id':recording.run_id,'quality':recording.quality,'marked_samples_retained':sum(s['origin']=='manual_marker' for s in samples),'unmarked_background_samples':sum(s['origin']!='manual_marker' for s in samples),'sample_labels':dict(Counter(s['label'] for s in samples)),'excluded_markers':excluded,'manifest':recording.manifest,'raw_event_check':event_opportunity_controls(recording)})
    report={'schema_version':1,'implementation_sha256':implementation_hashes,'implementation_snapshot':str(implementation_dir.resolve()),'recipe':recipe,'recipe_sha256':digest(recipe_bytes),'generated_at_utc':datetime.now(timezone.utc).isoformat(),'status':'insufficient_data','recording_count':len(captures),'total_frames':sum(r.quality['frames'] for r in captures),'recordings':summaries,'measurement_verdict':'unreliable','physiology_validated':False,'emotion_classification_enabled':False,'sample_count':len(dataset),'interpretation':'Experimental raw-count associations with manual action labels. Unmarked background is a pseudo-negative, not verified rest. Invalid bytes are never repaired, calibrated into microvolts, or classified as emotion.'}
    if len(captures)>=2:
        latest=captures[-1];full,_=evaluate_fold(dataset,latest.run_id,True);reaction,model=evaluate_fold(dataset,latest.run_id,False)
        report.update({'status':'analysis_complete_unverified_source','holdout_run':latest.run_id,'holdout_kind':'forward_outcome_check_locked_recipe' if latest.run_id>=recipe['locked_before_run_completion'] else 'retrospective_recording_holdout_not_pristine_validation','latest_recording_holdout_with_background':full,'latest_recording_holdout_reactions_only':reaction,'reaction_schedule_controls':shifted_classification_controls(latest,model,dataset,reaction),'leave_one_recording_out_retrospective':[evaluate_fold(dataset,r.run_id,True)[0] for r in captures]})
        outcome=f"Reaction-only latest holdout {reaction.get('correct',0)}/{reaction.get('n',0)}; background-inclusive {full.get('correct',0)}/{full.get('n',0)}."
    else:outcome='Need at least two finished recordings with usable marked windows.'
    report['summary']=outcome+' Measurement verdict remains unreliable; candidate labels are not verified actions or physiology.'
    # The next unseen run uses the identical saved recipe and earlier recordings.
    report['next_run_guidance']={'instruction':'Use the same existing nonhuman setup. Record one controlled session with shuffled action labels and explicitly marked No action trials. Keep the action procedure consistent across recordings. Do not change the recipe after seeing outcomes.','suggested_markers':{'Blink':6,'Jaw clench':6,'Startle / flinch':6,'No action':6},'spacing_seconds':6,'rest_at_start_end_seconds':5,'timing':'Mark at the action onset; reported plus/minus0.5s uncertainty is permitted. Do not rapid-click repeated markers for one action.','needed_for_validity':'Reliable hardware configuration/status first for physiological interpretation; raw classification can only assess repeatable source patterns.'}
    encoded=json.dumps(report,indent=2,allow_nan=False).encode()
    key=digest(json.dumps({'sources':[m['sha256'] for m in manifests],'recipe':report['recipe_sha256'],'implementation':implementation_hashes},sort_keys=True).encode())[:16]
    archive=output/f'analysis-{key}.json'
    if not archive.exists():archive.write_bytes(encoded)
    temp=output/f'.latest-{os.getpid()}.json';temp.write_bytes(encoded);os.replace(temp,output/'latest.json')
    lines=['# Raw reaction analysis',report['summary'],'','These are raw candidate labels only; all current captures have failed measurement validation.','']
    if len(captures)>=2:
        for name in ('latest_recording_holdout_reactions_only','latest_recording_holdout_with_background'):
            r=report[name];lines.extend([f'## {name.replace("_"," ")}',f"Correct: {r.get('correct',0)}/{r.get('n',0)}. Balanced accuracy: {r.get('balanced_accuracy')}. Majority accuracy: {r.get('majority_accuracy')}.",f"Class recall: {r.get('class_recall',{})}",''])
    lines.extend(['## Source and methodology',f"Recipe: {recipe['version']} ({report['recipe_sha256']})",f'Frozen recordings: {len(captures)}; frames: {report["total_frames"]}.','Whole recordings are held out. No random frame split. The 2-second window includes the claimed per-marker timing uncertainty without optimizing offsets against labels.','Unmarked windows receive the same feature extraction and gap checks. Circular timing controls use the same windows and opportunity to find a raw feature.','Protocol status and readback failures are retained, and every returned candidate has measurement_verdict=unreliable.','Results from the initial three recordings are retrospective. Later recordings assess the locked recipe, but order effects and the object test prevent physiological conclusions.'])
    (output/'README.md').write_text('\n'.join(lines)+'\n')
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--recordings',type=Path,default=Path('backend/results/bench-recordings'));p.add_argument('--output',type=Path,default=Path('backend/results/reaction-analysis'));args=p.parse_args()
    try:
        if not args.recordings.is_dir():raise ValueError('Recordings directory does not exist')
        result=analyze(args.recordings,args.output)
    except (ValueError,OSError,KeyError,json.JSONDecodeError) as exc:
        print(f'Offline analysis failed: {exc}',file=sys.stderr);return 2
    print(json.dumps({'status':result['status'],'report':str((args.output/'latest.json').resolve()),'recordings':result['recording_count'],'summary':result['summary']}));return 0

if __name__=='__main__':raise SystemExit(main())
