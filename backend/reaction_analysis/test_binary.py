import unittest
import numpy as np
from .binary_threshold import one_second_window,training_scales,fit_thresholds,schedule_controls,build_windows
from .raw_spike_detector import RawSpikeConfig,RawSpikeDetector
from .core import Recording


def frames(n=700):
 a=np.zeros((n,5),dtype=np.int64);a[:,0]=np.arange(n);a[:,1]=np.arange(n)*8000;return a

def encoded(a,b):return '000000'+int(a).to_bytes(3,'big',signed=True).hex()+int(b).to_bytes(3,'big',signed=True).hex()

class BinaryTests(unittest.TestCase):
 def test_same_full_neighborhood_for_positive_and_negative(self):
  a=frames();a[250,3]=100
  first,error=one_second_window(a,2.,[1.,1.]);self.assertIsNone(error)
  second,error=one_second_window(a,2.,[1.,1.]);self.assertEqual(first,second)
  a[250:,1]+=32000
  self.assertEqual(one_second_window(a,2.,[1.,1.])[1],'gap_or_discontinuity')
 def test_gap_crossing_window_boundary_rejected(self):
  a=frames();a[188:,1]+=32000
  # Gap1.496..1.536straddleswindow's1.52secondleftedge; nointernalgap.
  self.assertEqual(one_second_window(a,2.02,[1.,1.])[1],'gap_or_discontinuity')
 def test_per_marker_half_second_uncertainty(self):
  for offset in (-.48,0.,.48):
   a=frames();a[round((2+offset)/.008),3]=100
   window,error=one_second_window(a,2.,[1.,1.]);self.assertIsNone(error);self.assertEqual(window['score'],100.)
 def test_scales_use_training_only(self):
  a=frames();a[:,3]=np.arange(len(a))%2;a[:,4]=np.arange(len(a))%3
  b=a.copy();b[:,3:]*=1000000
  train=Recording('train',{1:a},[],{},{});test=Recording('test',{1:b},[],{},{} )
  scales=training_scales([train]);self.assertLess(max(scales),3)
  self.assertGreater(max(training_scales([train,test])),10000)
 def test_threshold_selection_does_not_take_test_windows(self):
  train=[{'actions':[{'score':1.},{'score':2.},{'score':3.}], 'background':[{'score':.1},{'score':.2},{'score':.3}]}]
  before=fit_thresholds(train)
  test={'actions':[{'score':999999.}],'background':[{'score':999999.}]}
  self.assertEqual(before,fit_thresholds(train));self.assertTrue(test)
 def test_null_is_distinct_from_below_threshold(self):
  d=RawSpikeDetector(RawSpikeConfig((10.,10.),2.,'example'))
  self.assertIsNone(d.update(raw_hex=encoded(0,0),sequence=0,read_micros=0)['spike'])
  below=d.update(raw_hex=encoded(10,0),sequence=1,read_micros=8000);self.assertFalse(below['spike']);self.assertEqual(below['quality'],'unverified')
  above=d.update(raw_hex=encoded(100,0),sequence=2,read_micros=16000);self.assertTrue(above['spike']);self.assertFalse(above['quality_flags']['configuration_verified'])
  late=d.update(raw_hex=encoded(1000,0),sequence=3,read_micros=56000);self.assertIsNone(late['spike'])
 def test_recording_reset_does_not_invent_a_spike(self):
  d=RawSpikeDetector(RawSpikeConfig((1.,1.),1.,'example'));d.update(raw_hex=encoded(0,0),sequence=0,read_micros=100)
  out=d.update(raw_hex=encoded(100,0),sequence=1,read_micros=8100,segment=2);self.assertIsNone(out['spike'])
 def test_explicit_no_action_is_a_negative_not_a_reaction(self):
  a=frames();marker={'id':'rest','label':'No action','capture_segment':1,'nearest_sequence':250,'nearest_read_micros':2000000,'frame_age_seconds':0.,'phase_id':'1:1','nearest_phase_id':'1:1'}
  result=build_windows(Recording('r',{1:a},[marker],{},{}),[1.,1.])
  self.assertEqual(len(result['actions']),0)
  marked=[w for w in result['background'] if w['origin']=='explicit_no_action_marker']
  self.assertEqual(len(marked),1);self.assertEqual(marked[0]['marker_id'],'rest')
  self.assertTrue(all(abs(w['center']-2.)>=1.5 for w in result['background'] if w['origin'].startswith('unmarked_')))
 def test_shifted_controls_reject_same_gaps(self):
  a=frames();a[350:,1]+=32000;r=Recording('test',{1:a},[],{},{});actions=[{'center':2.,'segment':1,'score':0.}]
  report=schedule_controls(r,[1.,1.],actions,[{'name':'a','cutoff':1.}],count=10)
  self.assertEqual(report['accepted'],10);self.assertGreaterEqual(report['attempts'],10);self.assertEqual(report['same_event_count'],1)

if __name__=='__main__':unittest.main()
