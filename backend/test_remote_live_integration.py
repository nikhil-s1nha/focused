"""Game command → real local service/sender contract; simulated acquisition only."""
import copy
import unittest
import uuid
from backend.live_link import LiveModeService
from backend.live_detector import PRESET, THRESHOLD, REARM_THRESHOLD
from backend.partner_sender import PartnerSender, AUTOMATIC_CAPABILITY, CONTROL_CAPABILITY
from backend.remote_game_control import RemoteGameControl
from backend.test_partner_sender import FakeLink
from backend.test_live_link import FakeController


class Controller(FakeController):
    def start(self, **kwargs):
        result=super().start(**kwargs)
        self.current.update(run_id=str(uuid.uuid4()), acquisition={'receiving':True}, stopping=False)
        return self.state()


class RemoteLiveIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.link=FakeLink(); self.acks=[]
        self.link.automatic_capability=copy.deepcopy(AUTOMATIC_CAPABILITY)
        def remote(url,payload=None,token=None):
            if url.endswith('/signal-link/control/ack'):
                self.acks.append(copy.deepcopy(payload));return {'ok':True}
            result=self.link.request(url,payload,token)
            if url.endswith('/signal-link/health'):
                result['capabilities']['acquisition_control']=copy.deepcopy(CONTROL_CAPABILITY)
            return result
        self.sender=PartnerSender(request=remote,clock=self.link.clock)
        self.sender.configure('http://192.168.1.20:48080',self.link.secret);self.sender.check()
        def transport(path,payload=None):
            if path=='/state':return self.sender.state()
            if path=='/automatic/start':return self.sender.automatic_start(payload)
            if path=='/automatic/stop':return self.sender.automatic_stop()
            if path=='/threshold':return self.sender.threshold(payload)
            raise AssertionError(path)
        self.service=LiveModeService(None,None,request=transport,controller_factory=Controller)
        def local(path,payload=None):
            if path=='/api/live-detection':return self.service.state()
            if path=='/api/live-detection/start':return self.service.start(**payload)
            if path=='/api/live-detection/stop':return self.service.stop(**(payload or {}))
            raise AssertionError(path)
        self.manager=RemoteGameControl(self.sender.remote_control_config,local,remote,
            clock=self.link.clock,monotonic=self.link.clock,background=False)
        self.sender.remote_control=self.manager
        self.manager.enable(True); self.manager._connection_ready(self.manager._config())
        self.round=str(uuid.uuid4())

    def tearDown(self):self.manager.close()

    def command(self,action):
        return {'schema':'signal-scope.control.v1','id':str(uuid.uuid4()),'action':action,
                'round_id':self.round,'created_at_ms':int(self.link.now*1000)}

    def event(self):
        s=self.service.state()
        return {'id':str(uuid.uuid4()),'created_at_ms':int(self.link.now*1000),
                'generation':s['generation'],'session_id':s['session_id'],
                'preset':PRESET,'threshold':THRESHOLD,'rearm_threshold':REARM_THRESHOLD,'score':.4}

    def test_game_start_threshold_event_game_stop_no_replay(self):
        start=self.command('start'); self.manager.accept(start); self.manager.tick()
        self.assertTrue(self.service.state()['active'])
        self.assertEqual(self.service.state()['owner_id'],start['id'])
        self.assertEqual(self.acks[-1]['status'],'running')
        event=self.event(); self.assertEqual(self.service.on_event(event)['status'],'accepted')
        self.assertEqual(self.link.posts[-1]['schema'],'signal-scope.event.v2')
        self.assertIsNone(self.link.posts[-1]['emotion'])
        self.manager.accept(self.command('stop')); self.manager.tick()
        self.assertFalse(self.service.state()['active'])
        self.assertEqual(self.acks[-1]['status'],'stopped')
        self.assertEqual(self.service.on_event(event)['status'],'not_sent')
        self.assertEqual(len(self.link.posts),1)

    def test_control_disconnect_stops_owned_acquisition(self):
        self.manager.accept(self.command('start')); self.manager.tick()
        self.manager.disconnect(); self.manager.tick()
        self.assertFalse(self.service.state()['active'])
        self.assertFalse(self.sender.state()['automatic']['active'])
        self.manager._connection_ready(self.manager._config());self.manager.tick()
        self.assertFalse(self.service.state()['active'])

if __name__=='__main__':unittest.main()
