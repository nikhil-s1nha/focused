import json,tempfile,unittest
from pathlib import Path
import numpy as np
from .core import Recording
from .independent_capture import candidate_paths,freeze_one,chronological_split,calibration_record,partition_windows,capture_analysis,execute,frozen_config_check

FIRST='object-ui-20261018T002800Z-aaa'

def raw_array(n,start=0):
 a=np.zeros((n,5),dtype=np.int64);a[:,0]=np.arange(n);a[:,1]=start+np.arange(n)*8000;a[:,3]=np.arange(n)%3;return a

def fixture(root,name,active=False):
 p=root/name;p.mkdir(parents=True);a=raw_array(600,3162000)
 lines=['FRAME_FORMAT_OBJECT_BENCH_ONLY,NONHUMAN_SURFACE_ONLY,NOT_EEG','CONFIG_READBACK_MISMATCHES,7']
 for row in a:
  raw='000000'+int(row[3]).to_bytes(3,'big',signed=True).hex()+'000000';lines.append(f'UNTRUSTED_BYPASS,{row[0]},{row[1]},{raw}')
 (p/'raw.txt').write_text('\n'.join(lines));(p/'markers.json').write_text('[]');(p/'metadata.json').write_text(json.dumps({'active':active}));(p/'status.json').write_text(json.dumps({'stage':'stopped_original_restored' if not active else 'capturing_untrusted_bench_bytes'}));return p

class IndependentTests(unittest.TestCase):
 def test_boundary_excludes_old_data_before_reading(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);old=root/'object-ui-20261017T000000Z-older';old.mkdir();(old/'status.json').write_text('MALFORMED:must never read')
   new=fixture(root,FIRST)
   self.assertEqual(candidate_paths(root,FIRST),[new])
   with self.assertRaises(ValueError):candidate_paths(root,FIRST,old.name)
 def test_marker_free_capture_is_frozen_and_reports_insufficiency(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);source=fixture(root/'source',FIRST);manifest=freeze_one(source,root/'output',FIRST)
   report=capture_analysis(manifest);self.assertEqual(report['marker_count'],0);self.assertEqual(report['status'],'insufficient_labelled_check_windows');self.assertEqual(report['nearby']['eligible_markers'],0)
 def test_active_capture_not_frozen(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);self.assertIsNone(freeze_one(fixture(root/'source',FIRST,True),root/'out',FIRST))
 def test_reset_clocks_cannot_mix_chronology(self):
  r=Recording('x',{1:raw_array(100,9000000),2:raw_array(500,1000000)},[],{},{});split=chronological_split(r)
  self.assertEqual(split['segment'],2);self.assertEqual(split['frame_index_zero_based'],300);self.assertAlmostEqual(split['device_time_seconds'],2.6)
  cal=calibration_record(r,split);self.assertEqual(len(cal.segments[1]),100);self.assertLessEqual(cal.segments[2][-1,1]/1e6,2.1)
  w={'actions':[{'segment':1,'center':9.4,'marker_id':'before'},{'segment':2,'center':2.6,'marker_id':'buffer'},{'segment':2,'center':4.,'marker_id':'after'}],'background':[]}
  earlier,later,buffer=partition_windows(w,split);self.assertEqual([x['marker_id'] for x in earlier['actions']],['before']);self.assertEqual([x['marker_id'] for x in later['actions']],['after']);self.assertEqual(buffer[0]['marker_id'],'buffer')
 def test_frozen_config_is_not_refitted_or_modified(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);fixture(root/'source',FIRST);cfg={'cohort_first_run':FIRST,'source_run':FIRST,'channel_scales':[3.,4.],'threshold':1.2,'threshold_name':'frozen','version':'demo'};path=root/'config.json';path.write_text(json.dumps(cfg));before=path.read_bytes()
   execute(root/'source',FIRST,root/'out',FIRST,path);report=json.loads((root/'out'/'latest.json').read_text())
   self.assertEqual(path.read_bytes(),before);ev=report['frozen_detector_evaluation'];self.assertEqual(ev['channel_scales'],[3.,4.]);self.assertEqual(ev['threshold'],1.2);self.assertFalse(ev['refitted']);self.assertEqual(ev['evaluation_kind'],'posthoc_selection_recording_not_validation')
 def test_latest_remains_newest_when_older_run_reprocessed(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);newer='object-ui-20261018T003000Z-bbb';fixture(root/'source',FIRST);fixture(root/'source',newer)
   execute(root/'source',FIRST,root/'out',newer);execute(root/'source',FIRST,root/'out',FIRST)
   self.assertEqual(json.loads((root/'out'/'latest.json').read_text())['run_id'],newer)
 def test_other_sensor_config_is_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);fixture(root/'source',FIRST);p=root/'bad.json';p.write_text(json.dumps({'cohort_first_run':'old','source_run':'old','channel_scales':[1.,1.],'threshold':1.,'threshold_name':'bad'}))
   with self.assertRaises(ValueError):execute(root/'source',FIRST,root/'out',FIRST,p)

if __name__=='__main__':unittest.main()
