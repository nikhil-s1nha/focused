import json,tempfile,unittest
from pathlib import Path
import numpy as np
from .core import Recording,marker_center,window_features,CentroidMatcher,evaluate_fold,match_count,freeze_finished


def array(n=500):
    a=np.zeros((n,5),dtype=np.int64);a[:,0]=np.arange(n);a[:,1]=np.arange(n)*8000;a[:,2]=0;a[:,3]=np.arange(n)%21;a[:,4]=np.arange(n)%7;return a

class AnalysisTests(unittest.TestCase):
    def test_exact_anchor_and_independent_marker_age(self):
        a=array();r=Recording('r',{1:a},[],{},{});base={'capture_segment':1,'nearest_sequence':125,'nearest_read_micros':1000000,'frame_age_seconds':.4,'phase_id':'1:1','nearest_phase_id':'1:1'}
        self.assertEqual(marker_center(r,base),(1.4,None))
        self.assertEqual(marker_center(r,{**base,'frame_age_seconds':.1}),(1.1,None))
        self.assertEqual(marker_center(r,{**base,'nearest_read_micros':1000001})[1],'nonunique_or_missing_anchor')
        self.assertEqual(marker_center(r,{**base,'nearest_phase_id':'2:1'})[1],'phase_mismatch')
    def test_independent_half_second_offsets_inside_same_envelope(self):
        outputs=[]
        for offset in (-.49,.0,.49):
            a=array();a[:,3:]=0;a[int((2+offset)/.008),3]=1000
            features,error=window_features(a,2.0);self.assertIsNone(error);outputs.append(features)
        np.testing.assert_allclose(outputs[0],outputs[1]);np.testing.assert_allclose(outputs[1],outputs[2])
    def test_constant_features_decline_distinction(self):
        samples=[{'run_id':'a','label':'Blink','features':[1.,0.]},{'run_id':'a','label':'Jaw clench','features':[1.,0.]}]
        self.assertEqual(CentroidMatcher().fit(samples).predict(samples),['Unknown','Unknown'])
    def test_gap_window_rejected_not_interpolated(self):
        a=array();features,error=window_features(a,2.0);self.assertIsNone(error);self.assertEqual(len(features),8)
        a[250:,1]+=32000
        self.assertEqual(window_features(a,2.0)[1],'gap_or_discontinuity')
    def test_sequence_gap_rejected(self):
        a=array();a[250:,0]+=1;self.assertEqual(window_features(a,2.0)[1],'gap_or_discontinuity')
    def test_complete_uncertain_window_required(self):
        self.assertEqual(window_features(array(),.2)[1],'too_few_frames')
    def test_no_frame_split_or_holdout_normalization(self):
        samples=[{'run_id':'earlier','label':'Blink','features':[0.],'origin':'manual_marker','marker_id':'a'}, {'run_id':'earlier','label':'Jaw clench','features':[2.],'origin':'manual_marker','marker_id':'b'}, {'run_id':'later','label':'Blink','features':[1000.],'origin':'manual_marker','marker_id':'c'}]
        result,model=evaluate_fold(samples,'later',False)
        self.assertEqual(model.training_runs,['earlier']);self.assertEqual(model.mean.tolist(),[1.]);self.assertEqual(result['n'],1)
        self.assertEqual(result['predictions'][0]['measurement_verdict'],'unreliable')
    def test_no_peak_double_count(self):
        self.assertEqual(match_count([1.,1.1],[1.05]),1)
        self.assertEqual(match_count([1.,1.8],[.6,1.4]),2)
        self.assertEqual(match_count([1.],[1.50001]),0)
    def test_active_recording_never_frozen(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);run=root/'inputs'/'object-ui-example';run.mkdir(parents=True)
            (run/'raw.txt').write_text('anything')
            (run/'markers.json').write_text(json.dumps([{'label':'Blink'}]))
            (run/'status.json').write_text(json.dumps({'stage':'capturing_untrusted_bench_bytes'}))
            (run/'metadata.json').write_text(json.dumps({'active':True}))
            self.assertEqual(freeze_finished(root/'inputs',root/'output'),[])
            (run/'status.json').write_text(json.dumps({'stage':'stopped_original_restored'}));(run/'metadata.json').write_text(json.dumps({'active':False}))
            frozen=freeze_finished(root/'inputs',root/'output');self.assertEqual(len(frozen),1)
            original=Path(frozen[0]['snapshot'])/'raw.txt';(run/'raw.txt').write_text('changed')
            self.assertEqual(original.read_text(),'anything')
            self.assertNotEqual(freeze_finished(root/'inputs',root/'output')[0]['snapshot'],frozen[0]['snapshot'])

if __name__=='__main__':unittest.main()
