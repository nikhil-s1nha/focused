"""Local-only event sender with optional authenticated game acquisition controls.

Serial and hardware work remain owned by Signal Scope's acquisition service.
"""
import argparse
import ipaddress
import json
import math
import threading
import time
import uuid
import urllib.request
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAMES={'Blink':'blink','Jaw clench':'jaw_clench','Startle / flinch':'startle_flinch'}
EVENTS={'blink','jaw_clench','startle_flinch','reaction'}
AUTOMATIC_CAPABILITY = dict(schema='signal-scope.event.v2', source='threshold_detector',
    measurement='threshold_crossing', event='reaction', emotion=None, quality='unverified', detector_version=1)
CONTROL_CAPABILITY = dict(schema='signal-scope.control.v1', transport='sse',
    stream='/signal-link/control/events', ack='/signal-link/control/ack', actions=['start','stop'])
MAX_EVENT_AGE_MS = 2000
HEALTH_MAX_AGE_SECONDS = 10

def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)

def unix_ms(value):
    return type(value) is int and 0 <= value <= 9007199254740991

def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value and uuid.UUID(value).version == 4
    except (ValueError, AttributeError):
        return False

def capability_supported(value):
    return isinstance(value, dict) and all(k in value and type(value.get(k)) is type(v) and value.get(k) == v
        for k, v in AUTOMATIC_CAPABILITY.items())

def control_capability_supported(value):
    return isinstance(value, dict) and all(k in value and type(value.get(k)) is type(v) and value.get(k) == v
        for k, v in CONTROL_CAPABILITY.items())

def public_count(value):
    return value if type(value) is int and 0 <= value <= 9007199254740991 else None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def request_json(url,payload=None,token=None):
    headers={}
    if token:headers['Authorization']='Bearer '+token
    if payload is not None:headers['Content-Type']='application/json'
    req=urllib.request.Request(url,data=None if payload is None else json.dumps(payload,allow_nan=False).encode(),headers=headers)
    with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(req,timeout=2) as res:
        result=json.loads(res.read(65536))
        if isinstance(result,dict):result['_http_status']=res.status
        return result

class PartnerSender:
    def __init__(self,scope='http://127.0.0.1:8767',request=request_json,clock=time.time,allowed_hosts=()):
        self.allowed_hosts=set(allowed_hosts)
        self.lock=threading.RLock();self.request=request;self.clock=clock;self.scope=scope
        self.target='';self.token='';self.following=False;self.follow_generation=0;self.initialized=False;self.seen=set();self.run=None
        self.sent=0;self.dropped=0;self.history=[];self.remote=None;self.last_check=0;self.error='';self.scope_error=''
        self.automatic_generation=0;self.automatic_active=False;self.automatic_session=''
        self.automatic_reason='Not started';self.automatic_settings=None;self.automatic_seen=set()
        self.automatic_last_event=None;self.automatic_dropped=0;self.automatic_inflight=False
        self.automatic_send_lock=threading.Lock()
        self.remote_control=None
    def state(self):
        with self.lock:
            state=dict(configured=bool(self.target),authentication="token" if self.token else "none",target=self.target,following=self.following,
                sent=self.sent,dropped=self.dropped,history=list(self.history),remote=self.remote,
                last_check=self.last_check,error=self.error,scope_error=self.scope_error,
                source='manual_annotations_and_optional_threshold_events',
                automatic=dict(active=self.automatic_active,generation=self.automatic_generation,
                    reason=self.automatic_reason,capable=bool(self.remote and self.remote.get('automatic_threshold_events')),
                    settings=self.automatic_settings,inflight=self.automatic_inflight,
                    dropped=self.automatic_dropped))
        if self.remote_control is not None:
            state['remote_control']=self.remote_control.state()
        return state

    def remote_control_config(self):
        # Private snapshot for the worker. Never returned by an HTTP route.
        with self.lock:
            supported = bool(self.remote and self.remote.get('acquisition_control') and
                             self.remote.get('automatic_threshold_events') and
                             0 <= self.clock()-self.last_check <= HEALTH_MAX_AGE_SECONDS)
            return dict(target=self.target, token=self.token,
                        capabilities={'acquisition_control': dict(CONTROL_CAPABILITY)} if supported else {})
    def configure(self,target,token=None):
        p=urlsplit(target)
        try:address=ipaddress.ip_address(p.hostname or '')
        except ValueError:raise ValueError('Use the partner LAN IP address, e.g. http://192.168.1.20:48081')
        if p.scheme not in ('http','https') or p.username or p.password or p.path not in ('','/') or p.query or p.fragment or not (address.is_private or address.is_loopback or str(address) in self.allowed_hosts) or address.is_unspecified or address.is_multicast:
            raise ValueError('Use an HTTP(S) private LAN IP and port, without a path or credentials')
        if p.port is not None and not 1<=p.port<=65535:raise ValueError('Invalid port')
        if token is not None and (not isinstance(token,str) or (token and not 24<=len(token)<=512)):raise ValueError('Leave token blank, or use 24–512 characters')
        if self.remote_control is not None:
            self.remote_control.enable(False)
        with self.lock:
            self.target=target.rstrip('/');self.token=self.token if token is None else token;self.following=False;self.follow_generation+=1;self.initialized=False
            self.seen.clear();self.remote=None;self.error='';self.last_check=0
            self._stop_automatic('Connection changed')
        return self.state()
    def check(self):
        # Never hold the state lock during network I/O: Stop must remain responsive.
        with self.lock:
            target=self.target
            if not target:return
            checked_at=self.clock()
        try:
            result=self.request(target+'/signal-link/health')
            if not isinstance(result,dict) or not (result.get('ok') is True or result.get('enabled') is True):raise ValueError()
            last=result.get('last_event');last=last if isinstance(last,dict) else {}
            capabilities=result.get('capabilities');capabilities=capabilities if isinstance(capabilities,dict) else {}
            remote=dict(ok=True,received=public_count(result.get('received',result.get('accepted'))),
                subscribers=public_count(result.get('subscribers',result.get('clients'))),
                last_received_at_ms=public_count(result.get('last_received_at_ms',last.get('received_at_ms'))),
                automatic_threshold_events=capability_supported(capabilities.get('automatic_threshold_events')),
                acquisition_control=control_capability_supported(capabilities.get('acquisition_control')))
            error=''
        except (OSError,ValueError,TypeError):
            remote=None;error='Receiver unavailable; check IP, server and network.'
        with self.lock:
            if target!=self.target:return
            self.remote=remote;self.last_check=checked_at
            if error:self.error=error
            elif self.error=='Receiver unavailable; check IP, server and network.':self.error=''
            if self.automatic_active and not (remote and remote['automatic_threshold_events']):
                self._stop_automatic('Receiver unavailable or automatic capability missing')

    def _stop_automatic(self,reason):
        self.automatic_generation+=1;self.automatic_active=False;self.automatic_session=''
        self.automatic_reason=reason

    def automatic_stop(self,suspend=False):
        with self.lock:
            self._stop_automatic('Suspended' if suspend else 'Stopped')
        return self.state()

    def automatic_start(self,data):
        if not isinstance(data,dict):raise ValueError('Expected automatic settings')
        preset=data.get('preset');threshold=data.get('threshold');rearm=data.get('rearm_threshold')
        value=data.get('value',1.0);cooldown=data.get('cooldown_ms',1000)
        if not isinstance(preset,str) or not 1<=len(preset)<=80 or any(ord(c)<32 for c in preset):raise ValueError('Invalid preset')
        if not finite_number(threshold) or not finite_number(rearm) or not 0<=rearm<threshold:raise ValueError('Invalid thresholds')
        if not finite_number(value) or not 0<=value<=1:raise ValueError('Invalid control value')
        if type(cooldown) is not int or not 100<=cooldown<=60000:raise ValueError('Invalid cooldown')
        with self.lock:
            if not self.target:raise ValueError('Save partner settings first')
            if not self.token:raise ValueError('Automatic v2 requires the partner authentication token')
            generation=self.automatic_generation;target=self.target
        self.check()
        with self.lock:
            if generation!=self.automatic_generation or target!=self.target:raise ValueError('Start cancelled; retry explicitly')
            if not self.remote or self.remote.get('automatic_threshold_events') is not True:raise ValueError('Receiver does not advertise automatic v2 capability')
            self.automatic_generation+=1;self.automatic_active=True;self.automatic_session=str(uuid.uuid4())
            self.automatic_reason='Running';self.automatic_seen.clear();self.automatic_last_event=None
            self.automatic_settings=dict(preset=preset,threshold=threshold,rearm_threshold=rearm,value=value,cooldown_ms=cooldown)
            automatic=dict(active=self.automatic_active,generation=self.automatic_generation,
                reason=self.automatic_reason,capable=bool(self.remote and self.remote.get('automatic_threshold_events')),
                settings=dict(self.automatic_settings),inflight=self.automatic_inflight,dropped=self.automatic_dropped)
            return dict(automatic=automatic,session=self.automatic_session,generation=self.automatic_generation)

    def _automatic_drop(self,reason):
        self.automatic_dropped+=1
        return dict(status='skipped',reason=reason)

    def threshold(self,data):
        if not isinstance(data,dict):raise ValueError('Expected threshold event')
        ident=data.get('id');created=data.get('created_at_ms');detector=data.get('detector')
        if not valid_uuid(ident) or not unix_ms(created) or not isinstance(detector,dict):raise ValueError('Invalid event identity or timestamp')
        required={'preset','threshold','rearm_threshold','score','quality','valid_measurement','reaction_validated'}
        if set(detector)!=required or detector.get('quality')!='unverified' or detector.get('valid_measurement') is not False or detector.get('reaction_validated') is not False:raise ValueError('Invalid detector provenance')
        if not finite_number(detector.get('score')):raise ValueError('Invalid detector score')
        with self.lock:
            if not self.automatic_active:return self._automatic_drop('inactive')
            if type(data.get('generation')) is not int or data.get('generation')!=self.automatic_generation or data.get('session')!=self.automatic_session:
                return self._automatic_drop('stale_session')
            settings=self.automatic_settings
            if any(type(detector.get(k)) is bool or detector.get(k)!=settings[k] for k in ('preset','threshold','rearm_threshold')):raise ValueError('Detector configuration differs from active session')
            if detector['score']<=settings['threshold']:raise ValueError('Not a threshold crossing')
            now=int(self.clock()*1000)
            if not 0<=now-created<=MAX_EVENT_AGE_MS:return self._automatic_drop('stale_event')
            if ident in self.automatic_seen:return self._automatic_drop('duplicate')
            # Consume IDs even when cooldown, unavailable network, or failed delivery drops them.
            self.automatic_seen.add(ident)
            if len(self.automatic_seen)>4096:
                self._stop_automatic('Session event limit reached');return self._automatic_drop('session_limit')
            if not self.remote or not self.remote.get('automatic_threshold_events') or not 0<=self.clock()-self.last_check<=HEALTH_MAX_AGE_SECONDS:
                self._stop_automatic('Receiver health is stale; start again after checking connection')
                return self._automatic_drop('receiver_unavailable')
            if self.automatic_last_event is not None and now-self.automatic_last_event<settings['cooldown_ms']:
                return self._automatic_drop('cooldown')
            if not self.automatic_send_lock.acquire(blocking=False):return self._automatic_drop('busy')
            self.automatic_last_event=now;self.automatic_inflight=True
            target=self.target;token=self.token
            packet=dict(schema='signal-scope.event.v2',id=ident,event='reaction',label='Reaction',value=settings['value'],
                source='threshold_detector',measurement='threshold_crossing',emotion=None,created_at_ms=created,sent_at_ms=now,
                detector=dict(detector))
            # This is the dispatch commit point. Stop invalidates queued/new calls; an
            # already committed HTTP request cannot be recalled. Nothing is queued.
        try:return self._deliver_packet(packet,target,token)
        finally:
            with self.lock:self.automatic_inflight=False
            self.automatic_send_lock.release()

    def _deliver_packet(self,packet,target,token):
        ident=packet['id'];row=dict(id=ident,event=packet['event'],source=packet['source'],at=self.clock(),status='failed')
        error=''
        try:
            result=self.request(target+'/signal-link/event',packet,token)
            if not isinstance(result,dict):raise ValueError()
            code=result.get('_http_status')
            if result.get('id') not in (None,ident) or result.get('accepted') is False:raise ValueError()
            accepted=code==202 or (code==200 and result.get('duplicate') is True) or (result.get('accepted') is True and result.get('id')==ident)
            if not accepted:raise ValueError()
            row.update(status='accepted',duplicate=bool(result.get('duplicate')),subscribers=public_count(result.get('subscribers',result.get('clients'))))
        except urllib.error.HTTPError as exc:
            row['http_status']=exc.code
            error={401:'Partner receiver still requires authentication. Disable it on the partner server or enter its token.',400:'Receiver rejected the event format.',503:'Receiver token is not configured.'}.get(exc.code,'Receiver rejected event (HTTP '+str(exc.code)+').')
        except (OSError,ValueError,TypeError):error='Event delivery failed; not queued or replayed.'
        with self.lock:
            if row['status']=='accepted':self.sent+=1
            else:self.dropped+=1
            self.error=error;self.history.insert(0,row);del self.history[20:]
        return row

    def emit(self,name,label,value=1,marker=None):
        with self.lock:
            if not self.target:raise ValueError('Save partner connection settings first')
            if name not in EVENTS or isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=1:raise ValueError('Event/value invalid')
            now=int(self.clock()*1000)
            ident=str(uuid.uuid5(uuid.NAMESPACE_URL,str(self.run)+':'+str(marker['id']))) if marker else str(uuid.uuid4())
            packet=dict(schema='signal-scope.event.v1',id=ident,event=name,label=''.join(c for c in label if ord(c)>=32 and ord(c)!=127)[:120] or name,value=value,
                source='manual_marker' if marker else 'manual_test',measurement='operator_annotation',emotion=None,
                created_at_ms=int(float(marker['timestamp'])*1000) if marker else now,sent_at_ms=now)
            target=self.target;token=self.token
        return self._deliver_packet(packet,target,token)
    def follow(self,enabled):
        if not isinstance(enabled,bool):raise ValueError('enabled must be true or false')
        with self.lock:
            if enabled and not self.target:raise ValueError('Save partner settings first')
            generation=self.follow_generation
        # Baseline before Start succeeds, without blocking Stop on network I/O.
        if enabled:
            try:
                state=self.request(self.scope+'/api/bench-recording')
                if not isinstance(state,dict) or not isinstance(state.get('markers',[]),list):raise ValueError()
                seen={str(m['id']) for m in state.get('markers',[]) if isinstance(m,dict)}
            except (OSError,ValueError,KeyError):raise ValueError('Signal Scope unavailable')
        with self.lock:
            if generation!=self.follow_generation:raise ValueError('Start cancelled')
            if enabled:self.run=state.get('run_id');self.seen=seen
            self.following=enabled;self.follow_generation+=1;self.initialized=enabled;self.scope_error=''
        return self.state()

    def tick(self):
        with self.lock:
            following=self.following;generation=self.follow_generation
        if following:
            try:
                state=self.request(self.scope+'/api/bench-recording')
                if not isinstance(state,dict) or not isinstance(state.get('markers',[]),list):raise ValueError()
                pending=[]
                with self.lock:
                    if self.following and generation==self.follow_generation:
                        markers=state.get('markers',[])
                        if state.get('run_id')!=self.run:self.run=state.get('run_id');self.seen.clear()
                        for marker in markers:
                            if not isinstance(marker,dict):continue
                            key=str(marker['id'])
                            if key in self.seen:continue
                            self.seen.add(key)
                            age=self.clock()-float(marker.get('timestamp',0))
                            if not self.initialized or not 0<=age<=3:continue
                            pending.append(marker)
                        self.initialized=True;self.scope_error=''
                for marker in pending:
                    with self.lock:
                        if not self.following or generation!=self.follow_generation:break
                    self.emit(NAMES.get(marker['label'],'reaction'),marker['label'],marker=marker)
            except (OSError,ValueError,KeyError,TypeError):
                with self.lock:
                    if generation==self.follow_generation:
                        self.initialized=False;self.scope_error='Signal Scope unavailable; waiting. Old events will be skipped.'
        with self.lock:should_check=bool(self.target and self.clock()-self.last_check>=3)
        if should_check:self.check()

def handler_for(sender,port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def allowed(self):
            return self.headers.get('Host') in (f'127.0.0.1:{port}',f'localhost:{port}') and self.headers.get('Origin') in (None,'http://127.0.0.1:8767','http://localhost:8767')
        def reply(self,data,status=200):
            body=json.dumps(data,allow_nan=False).encode();self.send_response(status)
            origin=self.headers.get('Origin')
            if origin in ('http://127.0.0.1:8767','http://localhost:8767'):
                self.send_header('Access-Control-Allow-Origin',origin);self.send_header('Vary','Origin')
            self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
        def do_OPTIONS(self):
            if not self.allowed():return self.reply({'error':'Forbidden'},403)
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','http://127.0.0.1:8767'))
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type');self.end_headers()
        def do_GET(self):
            if not self.allowed():return self.reply({'error':'Forbidden'},403)
            if self.path!='/state':return self.reply({'error':'Not found'},404)
            self.reply(sender.state())
        def do_POST(self):
            if not self.allowed():return self.reply({'error':'Forbidden'},403)
            try:
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=4096 or self.headers.get_content_type()!='application/json':raise ValueError('Expected JSON')
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict):raise ValueError('Expected object')
                if self.path=='/configure':result=sender.configure(data.get('target',''),data.get('token'))
                elif self.path=='/follow':result=sender.follow(data.get('enabled'))
                elif self.path=='/test':result=sender.emit(data.get('event'),str(data.get('event')),data.get('value',1))
                elif self.path=='/automatic/start':result=sender.automatic_start(data)
                elif self.path=='/automatic/stop':result=sender.automatic_stop()
                elif self.path=='/automatic/suspend':result=sender.automatic_stop(suspend=True)
                elif self.path=='/threshold':result=sender.threshold(data)
                elif self.path=='/remote-control':
                    if sender.remote_control is None:raise ValueError('Remote controls unavailable')
                    sender.remote_control.enable(data.get('enabled'))
                    result=sender.state()
                else:return self.reply({'error':'Not found'},404)
                self.reply(result)
            except (ValueError,TypeError):self.reply({'error':'Invalid settings or unavailable service; check address, token and Signal Scope.'},400)
    return Handler

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,default=8769);parser.add_argument('--allow-host',action='append',default=[],help='Explicit non-private LAN address approved for this partner');args=parser.parse_args()
    sender=PartnerSender(allowed_hosts=args.allow_host);stop=threading.Event()
    from .remote_game_control import RemoteGameControl
    def scope_request(path,payload=None):
        req=urllib.request.Request(sender.scope+path,
            data=None if payload is None else json.dumps(payload,allow_nan=False).encode(),
            headers={} if payload is None else {'Content-Type':'application/json'})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(req,timeout=5) as response:
            return json.load(response)
    sender.remote_control=RemoteGameControl(config_provider=sender.remote_control_config,
        local_request=scope_request,remote_request=request_json)
    def work():
        while not stop.wait(.2):sender.tick()
    threading.Thread(target=work,daemon=True).start()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),handler_for(sender,args.port))
    print(f'Partner sender API ready on 127.0.0.1:{args.port}; controls in Signal Scope :8767.',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        stop.set();sender.remote_control.close();server.server_close()
if __name__=='__main__':main()
