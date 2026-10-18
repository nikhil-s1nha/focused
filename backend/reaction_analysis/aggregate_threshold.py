"""Offline all-recording threshold study. Never changes acquisition or live config.

The user explicitly requested pooling across the replacement boundary. Sensor
cohorts remain labelled; unmarked diagnostic runs do not become known negatives.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .core import REACTIONS, load_recording
from .independent_capture import atomic_json, freeze_one, json_ready
from .binary_threshold import training_scales, build_windows, evaluate

REPLACEMENT = 'object-ui-20261018T002800Z-053a830ab45f4c4fb8f909f68b8f09ed'


def sweep(windows):
    """Exact empirical cut points, strict > rule; ties prefer fewer triggers."""
    scores = [w['score'] for run in windows for kind in ('actions', 'background') for w in run[kind]]
    candidates = np.unique([0., *scores])
    rows = []
    for cutoff in candidates:
        per_run = []
        hits = alarms = positives = negatives = 0
        for run in windows:
            a = [w['score'] for w in run['actions']]
            b = [w['score'] for w in run['background']]
            h = sum(v > cutoff for v in a)
            f = sum(v > cutoff for v in b)
            hits += h; alarms += f; positives += len(a); negatives += len(b)
            if a and b:
                per_run.append(.5 * (h / len(a) + 1 - f / len(b)))
        rows.append({'cutoff': float(cutoff), 'reaction_hits': hits, 'reaction_windows': positives,
                     'background_triggers': alarms, 'background_windows': negatives,
                     'sensitivity': hits / positives, 'background_trigger_fraction': alarms / negatives,
                     'micro_balanced_accuracy': .5 * (hits / positives + 1 - alarms / negatives),
                     'macro_balanced_accuracy': float(np.mean(per_run))})
    return rows


def choose(rows, objective='macro_balanced_accuracy'):
    return max(rows, key=lambda r: (r[objective], r['cutoff']))


def summarize(results):
    h = sum(r['reaction_hits'] for r in results); n = sum(r['reaction_windows'] for r in results)
    f = sum(r['background_false_alarm_windows'] for r in results); b = sum(r['background_windows'] for r in results)
    return {'reaction_hits': h, 'reaction_windows': n, 'background_triggers': f, 'background_windows': b,
            'sensitivity': h / n if n else None, 'background_trigger_fraction': f / b if b else None,
            'micro_balanced_accuracy': .5 * (h / n + 1 - f / b) if n and b else None,
            'macro_balanced_accuracy': float(np.mean([r['balanced_accuracy'] for r in results])) if results else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recordings', type=Path, default=Path('backend/results/bench-recordings'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    inventory = []; records = []; manifests = []
    for directory in sorted(args.recordings.glob('object-ui-*')):
        manifest = freeze_one(directory, args.output, 'object-ui-20261017T000000Z-all')
        if manifest is None:
            inventory.append({'run_id': directory.name, 'eligibility': 'active_or_incomplete_not_analysed'})
            continue
        record = load_recording(manifest); records.append(record); manifests.append(manifest)
        inventory.append({'run_id': record.run_id, 'frames': record.quality['frames'],
                          'recognized_markers': sum(m.get('label') in REACTIONS for m in record.markers),
                          'cohort': 'replacement' if record.run_id >= REPLACEMENT else 'earlier',
                          'quality': record.quality})
    labelled = [r for r in records if any(m.get('label') in REACTIONS for m in r.markers)]
    # Eligibility uses temporal coverage, independent of fitted scales or cutoff.
    labelled = [r for r in labelled if all(build_windows(r, [1., 1.])[k] for k in ('actions', 'background'))]
    if len(labelled) < 3:
        raise ValueError('Need at least three completed recordings with usable action and background windows')
    scales = training_scales(labelled); windows = [build_windows(r, scales) for r in labelled]
    rows = sweep(windows); best = choose(rows)
    selected = [('balanced', best), ('pooled_balance_alternative', choose(rows, 'micro_balanced_accuracy'))]
    for target in (.8, .9):
        retained = [r for r in rows if r['sensitivity'] >= target]
        if retained: selected.append((f'sensitivity_{int(target*100)}pct', max(retained, key=lambda r: r['cutoff'])))
    low_alarm = [r for r in rows if r['background_trigger_fraction'] <= .1]
    selected.append(('background_at_most_10pct', max(low_alarm, key=lambda r: (r['sensitivity'], r['cutoff']))))
    per_run = []
    for record, w in zip(labelled, windows):
        per_run.append({'run_id': record.run_id, 'cohort': 'replacement' if record.run_id >= REPLACEMENT else 'earlier',
                        'eligible_actions': len(w['actions']), 'eligible_background': len(w['background']),
                        'excluded_markers': w['excluded'], 'selected_threshold_result': evaluate(w, best['cutoff'])})
    folds = []
    for held_out in labelled:
        training = [r for r in labelled if r.run_id != held_out.run_id]
        fold_scales = training_scales(training)
        train_windows = [build_windows(r, fold_scales) for r in training]
        selected_fold = choose(sweep(train_windows))
        outcome = evaluate(build_windows(held_out, fold_scales), selected_fold['cutoff'])
        folds.append({'held_out_run': held_out.run_id, 'training_runs': [r.run_id for r in training],
                      'cohort': 'replacement' if held_out.run_id >= REPLACEMENT else 'earlier',
                      'scales_fit_on_training_only': fold_scales.tolist(), 'cutoff_fit_on_training_only': selected_fold['cutoff'],
                      'training_selection': selected_fold, 'held_out': outcome})
    cv = summarize([f['held_out'] for f in folds])
    fold_values = np.array([f['held_out']['balanced_accuracy'] for f in folds])
    rng = np.random.default_rng(20261018)
    boot = rng.choice(fold_values, size=(10000, len(fold_values)), replace=True).mean(axis=1)
    cv['run_resampling_percentile_95_interval_macro'] = np.percentile(boot, [2.5, 97.5]).tolist()
    cv['interval_caveat'] = 'Descriptive six-run resampling interval; overlapping training folds and small run count limit inference.'
    for entry in inventory:
        if entry['run_id'] not in {r.run_id for r in labelled} and 'frames' in entry:
            entry['eligibility'] = 'diagnostic_only_no_usable_reaction_labels'
        elif entry['run_id'] in {r.run_id for r in labelled}:
            entry['eligibility'] = 'threshold_fit_and_recording_holdout'
    unlabelled = [r for r in records if r.run_id not in {x.run_id for x in labelled}]
    report = {'schema_version': 1, 'generated_at_utc': datetime.now(timezone.utc).isoformat(),
              'source_manifests': manifests, 'inventory': inventory, 'channel_scales': scales.tolist(),
              'objective': 'Maximize mean per-recording balanced accuracy; equal weight to recordings and the two window classes. Strict > cutoff; ties choose higher cutoff.',
              'feature': 'Largest channel-normalized absolute adjacent raw-count step within each fully covered one-second window.',
              'timing': 'Marker anchor plus parse age, ±0.5s; same coverage checks for actions and unmarked background. No interpolation across gaps.',
              'scope': 'User-authorized aggregation of all completed recordings; labelled old and replacement cohorts pooled for fitting, reported separately. Unlabelled diagnostic runs are not treated as confirmed negatives.',
              'threshold_options': [{'name': name, **row} for name, row in selected],
              'per_run': per_run, 'leave_one_recording_out': {'summary': cv, 'folds': folds,
                  'caveat': 'Retrospective validation of the threshold-fitting procedure with a different training-only cutoff per fold; not validation of the final all-data-fit cutoff and not a pristine prospective study.'},
              'cohort_results_at_all_data_selected_cutoff': {
                  cohort: summarize([r['selected_threshold_result'] for r in per_run if r['cohort'] == cohort])
                  for cohort in ('earlier', 'replacement')},
              'unlabelled_diagnostic_only': [{'run_id': r.run_id, 'result': evaluate(build_windows(r, scales), best['cutoff'])} for r in unlabelled],
              'interpretation': 'Posthoc raw-signal threshold optimization only; background is unmarked rather than verified no-action. Configuration/status failures prevent validated EEG or fear interpretation.',
              'live_configuration_changed': False, 'reaction_validated': False, 'valid_measurement': False}
    implementation_names = ('aggregate_threshold.py', 'core.py', 'binary_threshold.py', 'independent_capture.py')
    implementation = {n: Path(__file__).with_name(n).read_bytes() for n in implementation_names}
    report['implementation_sha256'] = {n: hashlib.sha256(b).hexdigest() for n, b in implementation.items()}
    key = hashlib.sha256(json.dumps({'sources': [m['sha256'] for m in manifests], 'code': report['implementation_sha256']}, sort_keys=True).encode()).hexdigest()[:16]
    bundle = args.output/'implementation'/key; bundle.mkdir(parents=True, exist_ok=True)
    for n, b in implementation.items(): (bundle/n).write_bytes(b)
    report['implementation_snapshot'] = str(bundle.resolve())
    atomic_json(args.output/f'aggregate-{key}.json', report); atomic_json(args.output/'latest.json', report)
    with (args.output/'threshold-sweep.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    atomic_json(args.output/'candidate-detector-config.json', {
        'version': 'aggregate-raw-step-candidate-v1', 'channel_scales': scales.tolist(),
        'threshold': best['cutoff'], 'threshold_name': 'all_recordings_macro_balanced',
        'max_gap_seconds': .024, 'quality': 'unverified', 'valid_measurement': False,
        'reaction_validated': False, 'applied_to_live_capture': False,
        'fitted_runs': [r.run_id for r in labelled], 'meaning': 'raw threshold crossing; not fear or verified physiology',
        'result_file': f'aggregate-{key}.json'})
    print(json.dumps(json_ready({'report': str(args.output/'latest.json'), 'threshold_options': report['threshold_options'], 'held_out_summary': cv, 'cohorts': report['cohort_results_at_all_data_selected_cutoff']}), indent=2))


if __name__ == '__main__':
    main()
