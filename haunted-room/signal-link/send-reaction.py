#!/usr/bin/env python3
"""Send a partner reaction. Does not acquire EEG or classify anything."""
import argparse,json,os,time,uuid,urllib.request
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--origin',default=os.environ.get('GAME_ORIGIN','http://127.0.0.1:48080'))
p.add_argument('--reaction',required=True,choices=['startled','no_detected_reaction','uncertain'])
p.add_argument('--confidence',type=float,required=True)
p.add_argument('--quality',type=float,required=True)
p.add_argument('--strength',type=float)
p.add_argument('--classifier-version',required=True)
p.add_argument('--session-id');p.add_argument('--encounter-id')
a=p.parse_args();token=os.environ.get('SIGNAL_TOKEN','')
if len(token)<24:p.error('Set SIGNAL_TOKEN privately')
for v in [a.confidence,a.quality,a.strength]:
 if v is not None and not 0<=v<=1:p.error('Confidence, quality and strength must be 0..1')
headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
try:
 if not (a.session_id and a.encounter_id):
  with urllib.request.urlopen(urllib.request.Request(a.origin+'/signal-link/game-state',headers=headers),timeout=5) as r: state=json.load(r)['current']
  if not state or state['event'] not in ['encounter_started','encounter_finished']:p.error('Start a round and wait for an encounter first')
  a.session_id=state['session_id'];a.encounter_id=state['encounter_id']
 m=dict(schema='horror.reaction.v1',id=str(uuid.uuid4()),session_id=a.session_id,encounter_id=a.encounter_id,event='reaction_update',reaction=a.reaction,confidence=a.confidence,signal_quality=a.quality,created_at_ms=int(time.time()*1000),window_ms=5000,classifier_version=a.classifier_version)
 if a.strength is not None:m['reaction_strength']=a.strength
 with urllib.request.urlopen(urllib.request.Request(a.origin+'/signal-link/event',data=json.dumps(m).encode(),headers=headers,method='POST'),timeout=5) as r: print(json.dumps(json.load(r)))
except Exception as e:
 print('Delivery failed:',str(e));raise SystemExit(1)
