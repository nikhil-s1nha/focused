"""Read and summarize INTERNAL_TEST frames; no third-party Python dependencies."""
import argparse
import json
import os
import select
import statistics
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('--port', default='/dev/ttyACM0')
parser.add_argument('--seconds', type=float, default=10)
parser.add_argument('--source', choices=['internal_test', 'shorted_input'], default='internal_test')
parser.add_argument('--discard-samples', type=int, default=0)
parser.add_argument('--gain', type=float, default=1)
parser.add_argument('--vref', type=float, default=2.42)
args = parser.parse_args()
if args.gain <= 0 or args.vref <= 0 or args.discard_samples < 0:
    parser.error('gain/reference must be positive and discard must be nonnegative')
fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
settings = termios.tcgetattr(fd)
settings[0] = 0
settings[1] = 0
settings[2] = termios.CLOCAL | termios.CREAD | termios.CS8
settings[3] = 0
settings[4] = termios.B115200
settings[5] = termios.B115200
settings[6][termios.VMIN] = 0
settings[6][termios.VTIME] = 0
termios.tcsetattr(fd, termios.TCSANOW, settings)
termios.tcflush(fd, termios.TCIFLUSH)
frames = []
discarded = 0
messages = []
buffer = b''
deadline = time.monotonic() + args.seconds
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(.5, max(0, deadline - time.monotonic())))
        if not ready:
            continue
        buffer += os.read(fd, 8192)
        while b'\n' in buffer:
            raw, buffer = buffer.split(b'\n', 1)
            line = raw.decode(errors='replace').strip()
            if line.startswith(args.source.upper() + ','):
                try:
                    values = list(map(int, line.split(',')[1:]))
                    if len(values) == 4:
                        if discarded < args.discard_samples:
                            discarded += 1
                        else:
                            frames.append(values)
                except ValueError:
                    pass
            elif line.startswith(('BENCH_TEST_ONLY,', 'BENCH_NOISE_ONLY,', 'DEVICE_ID,', 'source,', 'ERROR,', 'REGISTER,', 'CONFIG,', 'CONVERSION,', 'NOTE,')):
                messages.append(line)
                print(line, flush=True)
finally:
    os.close(fd)
summary = {'source': args.source, 'samples': len(frames), 'discarded_samples':discarded,
           'gain':args.gain,'nominal_reference_volts':args.vref,'messages': messages[-15:]}
if len(frames) > 1:
    deltas = [(b[1] - a[1]) % (2 ** 32) for a, b in zip(frames, frames[1:])]
    summary['sample_rate_hz'] = round(1e6 / statistics.median(deltas), 2) if min(deltas) > 0 else None
    summary['sequence_gaps'] = sum(max(0, b[0] - a[0] - 1) for a, b in zip(frames, frames[1:]))
    for channel, index in [('ch1', 2), ('ch2', 3)]:
        values = [frame[index] for frame in frames]
        summary[channel] = {'min_counts': min(values), 'max_counts': max(values),
                            'peak_to_peak_counts': max(values) - min(values)}
        if args.source == 'shorted_input':
            scale = args.vref * 1e6 / args.gain / (2 ** 23)
            summary[channel].update({'mean_counts':statistics.mean(values),
                                     'rms_noise_counts':statistics.pstdev(values),
                                     'nominal_rms_noise_uv':statistics.pstdev(values) * scale})
    summary['stream_received'] = len(frames) >= 250
else:
    summary['stream_received'] = False
print(json.dumps(summary, indent=2))
raise SystemExit(0 if summary['stream_received'] else 1)
