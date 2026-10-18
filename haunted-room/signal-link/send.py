#!/usr/bin/env python3
"""Send one manual control event. Python standard library only; no classifier."""
import argparse
import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=os.environ.get('SIGNAL_URL'))
    parser.add_argument('--event', choices=['blink','jaw_clench','startle_flinch','reaction'], default='blink')
    parser.add_argument('--value', type=float, default=0.7)
    parser.add_argument('--source', choices=['manual_test','manual_marker'], default='manual_test')
    parser.add_argument('--label', default='Manual test')
    args = parser.parse_args()
    token = os.environ.get('SIGNAL_TOKEN','')
    if len(token) < 24: parser.error('Set SIGNAL_TOKEN privately (at least 24 characters)')
    if not args.url: parser.error('Pass --url or set SIGNAL_URL')
    if not 0 <= args.value <= 1: parser.error('--value must be between 0 and 1')
    stamp = int(time.time()*1000)
    frame = dict(schema='signal-scope.event.v1', id=str(uuid.uuid4()), event=args.event, source=args.source, measurement='operator_annotation' if args.source == 'manual_marker' else 'manual_test', emotion=None, label=args.label, value=args.value, created_at_ms=stamp, sent_at_ms=stamp)
    request = urllib.request.Request(args.url, data=json.dumps(frame).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+token}, method='POST')
    try:
        with urllib.request.urlopen(request,timeout=5) as response:
            print('Receiver accepted event '+frame['id']+' ('+str(response.status)+'); check the game panel and visible effect.')
    except urllib.error.HTTPError as error:
        print('Receiver rejected event: HTTP '+str(error.code)+'. Check token, URL and payload.',file=sys.stderr)
        return 1
    except (urllib.error.URLError, ValueError):
        print('Delivery failed. Check URL, game server, LAN and firewall. Event will not be replayed.',file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__': sys.exit(main())
