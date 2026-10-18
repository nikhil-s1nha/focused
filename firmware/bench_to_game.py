"""Forward internal-test frames to the game. Not an EEG/intensity algorithm."""
import argparse
import collections
import json
import os
import select
import termios
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--port', default='/dev/ttyACM0')
parser.add_argument('--url', required=True, help='Scene server /api/signal URL')
parser.add_argument('--seconds', type=float, default=120)
args = parser.parse_args()
fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
settings = termios.tcgetattr(fd)
settings[0] = settings[1] = settings[3] = 0
settings[2] = termios.CLOCAL | termios.CREAD | termios.CS8
settings[4] = settings[5] = termios.B115200
settings[6][termios.VMIN] = settings[6][termios.VTIME] = 0
termios.tcsetattr(fd, termios.TCSANOW, settings)
termios.tcflush(fd, termios.TCIFLUSH)
values = collections.deque(maxlen=500)
buffer = b''
last_sample = -1e9
last_publish = last_print = 0
last_value = .5
published = received = failures = 0
deadline = time.monotonic() + args.seconds
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], .02)
        if ready:
            buffer += os.read(fd, 8192)
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if not line.startswith(b'INTERNAL_TEST,'):
                    continue
                try:
                    sequence, timestamp, ch1, ch2 = map(int, line.strip().split(b',')[1:])
                except ValueError:
                    continue
                values.append(ch2)
                received += 1
                last_sample = time.monotonic()
        now = time.monotonic()
        if now - last_publish < .1:
            continue
        last_publish = now
        quality = 0
        if len(values) >= 250 and now - last_sample < .5:
            low, high = min(values), max(values)
            if high - low > 100:
                # Arbitrary normalization of a known square wave for transport testing.
                # This value is NOT calculated from electrodes or used as proof of fear.
                last_value = max(0, min(1, (values[-1] - low) / (high - low)))
                quality = 1
        payload = {'type':'signal','source':'internal_test',
                   'timestamp':time.time(),'intensity':last_value,'signal_quality':quality}
        request = urllib.request.Request(args.url, data=json.dumps(payload).encode(),
                                         headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=.5) as response:
                response.read()
            published += 1
        except (urllib.error.URLError, OSError):
            failures += 1
        if now - last_print >= 2:
            print('INTERNAL_TEST samples={} published={} failed={} value={:.2f} quality={}'.format(
                received,published,failures,last_value,quality),flush=True)
            last_print = now
except KeyboardInterrupt:
    pass
finally:
    os.close(fd)
print(json.dumps({'source':'internal_test','samples':received,'published':published,'failed':failures}))
