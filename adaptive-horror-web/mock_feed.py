"""Standard-library integration feed. SYNTHETIC test data, not BrainFlow or EEG."""
import argparse
import json
import math
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:8080/api/signal')
parser.add_argument('--seconds', type=float, default=120)
args = parser.parse_args()
start = time.monotonic()
try:
    while time.monotonic() - start < args.seconds:
        elapsed = time.monotonic() - start
        data = {'type': 'signal', 'source': 'synthetic',
                'intensity': 0.5 + 0.48 * math.sin(elapsed / 6),
                'signal_quality': 1, 'timestamp': time.time()}
        request = urllib.request.Request(args.url, data=json.dumps(data).encode(),
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=2) as response:
            response.read()
        print('SYNTHETIC intensity={:.2f}'.format(data['intensity']), flush=True)
        time.sleep(0.1)
except KeyboardInterrupt:
    pass
