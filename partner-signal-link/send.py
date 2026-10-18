#!/usr/bin/env python3
"""Send manual events or follow NEW Signal Scope markers. Does not access hardware."""
import argparse
import json
import os
import time
import uuid
import urllib.request
import urllib.error

NAMES = {'Blink':'blink','Jaw clench':'jaw_clench','Startle / flinch':'startle_flinch'}

def event(name, label, value=1, event_id=None, created=None, source='manual_test'):
    now = int(time.time()*1000)
    return dict(schema='signal-scope.event.v1', id=event_id or str(uuid.uuid4()),
                event=name, label=label, value=value, source=source,
                measurement='operator_annotation', emotion=None,
                created_at_ms=int(created) if created is not None else now, sent_at_ms=now)

def send(target, token, payload):
    req=urllib.request.Request(target.rstrip('/')+'/signal-link/event',
        data=json.dumps(payload).encode(),headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})
    with urllib.request.urlopen(req,timeout=2) as response:
        return json.load(response)

def read_scope(url):
    with urllib.request.urlopen(url.rstrip('/')+'/api/bench-recording',timeout=2) as response:
        return json.load(response)

def follow(target, token, scope):
    # At startup/reconnection skip existing markers; never play a backlog of scares.
    seen=set(); initialized=False; previous_run=None
    print('Following NEW markers; existing/stale markers are skipped.',flush=True)
    while True:
        try:
            state=read_scope(scope);run=state.get('run_id');markers=state.get('markers',[])
            if run != previous_run: seen.clear();previous_run=run
            for marker in markers:
                key=str(marker['id'])
                if key in seen:continue
                seen.add(key)
                age=time.time()-float(marker.get('timestamp',0))
                if not initialized or not 0 <= age <= 3:continue
                payload=event(NAMES.get(marker['label'],'reaction'),marker['label'],
                    event_id=str(uuid.uuid5(uuid.NAMESPACE_URL,str(run)+':'+key)),
                    created=float(marker['timestamp'])*1000,source='manual_marker')
                try:
                    result=send(target,token,payload)
                    print('Accepted:',payload['event'],'game subscribers:',result.get('subscribers'),flush=True)
                except (OSError,ValueError):
                    print('Delivery failed; event dropped (no delayed replay).',flush=True)
            initialized=True
        except (OSError,ValueError,KeyError):
            if initialized:print('Signal Scope unavailable; waiting. Reconnection skips backlog.',flush=True)
            initialized=False
        time.sleep(.2)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',required=True,help='http://PARTNER_LAN_IP:48081')
    parser.add_argument('--event',choices=['blink','jaw_clench','startle_flinch','reaction'],default='startle_flinch')
    parser.add_argument('--value',type=float,default=1)
    parser.add_argument('--follow',action='store_true')
    parser.add_argument('--scope',default='http://127.0.0.1:8767')
    args=parser.parse_args();token=os.environ.get('SIGNAL_TOKEN','')
    if token and len(token)<24:parser.error('SIGNAL_TOKEN must be 24+ characters or unset for no-auth demo')
    if not 0<=args.value<=1:parser.error('--value must be 0..1')
    try:
        if args.follow:follow(args.target,token,args.scope)
        else:print(json.dumps(send(args.target,token,event(args.event,args.event,args.value)),indent=2))
    except KeyboardInterrupt:pass
    except (OSError,ValueError):parser.exit(1,'Receiver unreachable or rejected event; check target, token, server and firewall.\n')

if __name__=='__main__':main()
