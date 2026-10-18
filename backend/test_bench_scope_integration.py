"""Signal Scope's diagnostic endpoints are file-only and preserve existing state."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock
from backend.bypass_viewer import BenchLog, HEADER, OBJECT_HEADER
from backend.viewer_server import ViewerEngine, make_handler, ui_version


class ScopeBenchTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory()
        self.path=Path(self.directory.name)/'capture.txt'
        self.engine=ViewerEngine()
        self.engine.set_recording(True)
        self.engine.mark('Keep this original marker')
        self.before=self.engine.export_json()
        self.log=BenchLog(self.path)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.engine,bench_log=self.log))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)
        self.engine.close();self.directory.cleanup()

    def get(self,path):
        connection=HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        connection.request('GET',path)
        response=connection.getresponse();result=(response.status,response.read(),dict(response.getheaders()))
        connection.close();return result

    def post(self,path,payload,headers=None):
        connection=HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        connection.request('POST',path,json.dumps(payload),
                           {'Content-Type':'application/json',**(headers or {})})
        response=connection.getresponse();result=response.status,json.loads(response.read())
        connection.close();return result

    def test_object_recording_requires_explicit_server_opt_in(self):
        with patch('backend.bench_recorder._ssh',side_effect=AssertionError('No remote access')) as remote:
            status,body=self.post('/api/bench-recording/start',{'nonhuman_surface_only':True})
            self.assertEqual(status,400)
            self.assertIn('disabled',body['error'])
            remote.assert_not_called()

    def test_ui_version_changes_for_assets_but_not_recorded_data(self):
        directory=Path(self.directory.name)
        first=ui_version(directory)
        (directory/'app.js').write_text('console.log("new UI")')
        second=ui_version(directory)
        self.assertNotEqual(first,second)
        (directory/'capture.txt').write_text('recorded bytes')
        self.assertEqual(second,ui_version(directory))
        status,body,_=self.get('/api/ui-version')
        self.assertEqual(status,200)
        self.assertEqual(len(json.loads(body)['version']),64)

    def test_recording_routes_preserve_original_markers_and_reject_cross_origin(self):
        recorder=Mock()
        recorder.state.return_value={'active':True,'markers':[],'not_eeg':True}
        recorder.start.return_value=recorder.state.return_value
        recorder.mark.return_value={'id':'new-marker','label':'Test click'}
        self.server.RequestHandlerClass=make_handler(self.engine,bench_log=self.log,bench_recorder=recorder)
        status,_=self.post('/api/bench-recording/start',{'nonhuman_surface_only':True})
        self.assertEqual(status,200)
        recorder.start.assert_called_once_with(nonhuman_surface_only=True)
        status,body=self.post('/api/bench-recording/marker',{'label':'Test click'})
        self.assertEqual(status,200)
        self.assertEqual(body['marker']['id'],'new-marker')
        status,_=self.post('/api/bench-recording/start',{'nonhuman_surface_only':True},
                           {'Origin':'http://unrelated.example'})
        self.assertEqual(status,403)
        status,_=self.post('/api/bench-recording/start',{'nonhuman_surface_only':True},
                           {'Host':'unrelated.example'})
        self.assertEqual(status,403)
        self.assertEqual(recorder.start.call_count,1)
        for key in ('samples','markers','recording'):
            self.assertEqual(self.engine.export_json()[key],self.before[key])

    def capture(self,header=HEADER):
        self.path.write_text(header+'\nBYPASS_PHASE,SPI_HZ,125000,MUX,SHORTED,READ_MODE,RDATAC\nUNTRUSTED_ID_READS,0x31\nID_GUARD_BYPASSED_FOR_BENCH_ONLY,0\nCONFIG_READBACK_MISMATCHES,3\nUNTRUSTED_BYPASS,0,8000,C00000000001FFFFFF\nBYPASS_COMPLETE\n')

    def test_file_state_preserves_recording_source_markers_and_never_opens_serial(self):
        self.capture()
        with patch('backend.viewer_server.SerialReader',side_effect=AssertionError('No USB access')) as reader:
            status,body,_=self.get('/api/bench-state')
            self.assertEqual(status,200)
            state=json.loads(body)
            self.assertEqual(state['status'],'completed_saved_capture')
            self.assertEqual(state['source'],'untrusted_bench_log')
            self.assertEqual(state['units'],'raw signed 24-bit counts')
            self.assertFalse(state['filtered']);self.assertTrue(state['not_eeg'])
            self.assertEqual(state['phases'][0]['samples'][0]['counts'],[1,-1])
            self.assertEqual(state['phases'][0]['config_mismatches'],3)
            reader.assert_not_called()
        after=self.engine.export_json()
        for key in ('samples','markers','recording'):
            self.assertEqual(after[key],self.before[key])
        self.assertEqual(self.engine.source,'synthetic')
        self.assertTrue(self.engine.recording)

    def test_raw_is_original_file_and_query_cannot_select_another_path(self):
        self.capture()
        status,body,headers=self.get('/api/bench-raw?path=/etc/passwd')
        self.assertEqual(status,200);self.assertEqual(body,self.path.read_bytes())
        self.assertIn('attachment',headers['Content-Disposition'])
        self.assertEqual(headers['Cache-Control'],'no-store')

    def test_missing_capture_does_not_fallback_to_generated_samples(self):
        status,body,_=self.get('/api/bench-state')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['status'],'waiting_for_file')
        self.assertEqual(json.loads(body)['phases'],[])
        self.assertEqual(self.get('/api/bench-raw')[0],404)

    def test_object_capture_retains_context_and_same_app_assets(self):
        self.capture(OBJECT_HEADER)
        state=json.loads(self.get('/api/bench-state')[1])
        self.assertEqual(state['input_context'],'nonhuman_object_surface')
        self.assertIn(b'id="bench-view"',self.get('/?view=bench')[1])
        self.assertIn(b'value="raw_diagnostic"',self.get('/')[1])
        self.assertIn(b'nonhuman_object_surface',self.get('/bench-panel.js')[1])

if __name__=='__main__': unittest.main()
