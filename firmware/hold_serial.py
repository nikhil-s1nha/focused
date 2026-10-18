"""Interactive, exclusive transport for MisoHoldDiagnostic ONLY; electrodes off.

Allowed commands: h, l, x, q. Writes no command until bench header is received.
This is a manually controlled electronic bench test, not an acquisition daemon.
"""
import argparse
import datetime
import fcntl
import os
from pathlib import Path
import select
import struct
import sys
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', required=True)
parser.add_argument('--duration', type=float, default=900)
args = parser.parse_args()
if not 1 <= args.duration <= 900:
    parser.error('duration must be 1–900 seconds')

stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
log_path = Path(__file__).resolve().parent / 'results' / f'miso-hold-{stamp}.txt'
fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
verified = False
buffer = b''
last_line = ''
deadline = time.monotonic() + args.duration
header_deadline = time.monotonic() + 20
try:
    fcntl.ioctl(fd, termios.TIOCEXCL)
    settings = termios.tcgetattr(fd)
    settings[:4] = [0, 0, termios.CLOCAL | termios.CREAD | termios.CS8, 0]
    settings[4:6] = [termios.B115200, termios.B115200]
    settings[6][termios.VMIN] = settings[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, settings)
    termios.tcflush(fd, termios.TCIFLUSH)
    # Deliberately reset this Uno once to receive a fresh identifying header.
    # Closing another reader may have left DTR asserted, so open alone is not
    # sufficient. This does not upload firmware or change ADC registers.
    fcntl.ioctl(fd, termios.TIOCMBIC, struct.pack('I', termios.TIOCM_DTR))
    time.sleep(.1)
    fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack('I', termios.TIOCM_DTR))
    print('Bench-only serial controller; electrodes must remain disconnected.', flush=True)
    print('Log:', log_path, flush=True)
    with log_path.open('w') as log:
        while time.monotonic() < deadline:
            if not verified and time.monotonic() > header_deadline:
                raise RuntimeError('Expected hold-diagnostic firmware header not received; no commands sent')
            ready, _, _ = select.select([fd, sys.stdin], [], [], .25)
            if fd in ready:
                data = os.read(fd, 16384)
                if not data:
                    raise RuntimeError('Serial device disconnected')
                buffer += data
                while b'\n' in buffer:
                    raw, buffer = buffer.split(b'\n', 1)
                    line = raw.decode(errors='replace').strip()
                    log.write(line + '\n'); log.flush()
                    # A port opened after upload may contain a boot-time prefix
                    # from its previous baud state before the exact signature.
                    if 'BENCH_HOLD_ONLY,ELECTRODES_DISCONNECTED,NO_WREG_NO_START_NO_SAMPLES' in line:
                        verified = True
                    if line != last_line:
                        print(line, flush=True)
                    last_line = line
            if sys.stdin in ready:
                command = sys.stdin.readline().strip()
                if command in ('q', ''):
                    break
                if command not in ('h', 'l', 'x'):
                    print('Allowed commands: h, l, x, q', flush=True)
                elif not verified:
                    print('Not sent: bench firmware has not identified itself', flush=True)
                else:
                    os.write(fd, command.encode('ascii'))
                    log.write('HOST_COMMAND,' + command + '\n'); log.flush()
except KeyboardInterrupt:
    pass
finally:
    if verified:
        try:
            os.write(fd, b'x')  # Release CS; leave START low, no acquisition.
            termios.tcdrain(fd)
        except OSError:
            pass
    os.close(fd)
    print('Controller closed; temporary diagnostic firmware still installed.', flush=True)
