"""115200-baud bench transport; stdout is raw serial bytes, no serial commands.

Optional --reset deliberately pulses the Uno's normal USB reset before reading.
"""
import argparse
import fcntl
import math
import os
import select
import struct
import sys
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', default='/dev/ttyACM0')
parser.add_argument('--seconds', type=float, default=0, help='0 runs until interrupted')
parser.add_argument('--reset', action='store_true', help='Pulse Uno USB DTR to capture fresh startup')
args = parser.parse_args()
if not math.isfinite(args.seconds) or args.seconds < 0:
    parser.error('seconds must be finite and nonnegative')
fd = os.open(args.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
try:
    settings = termios.tcgetattr(fd)
    settings[:4] = [0, 0, termios.CLOCAL | termios.CREAD | termios.CS8, 0]
    settings[4:6] = [termios.B115200, termios.B115200]
    settings[6][termios.VMIN] = settings[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, settings)
    termios.tcflush(fd, termios.TCIFLUSH)
    fcntl.ioctl(fd, termios.TIOCEXCL)
    if args.reset:
        fcntl.ioctl(fd, termios.TIOCMBIC, struct.pack('I', termios.TIOCM_DTR))
        time.sleep(.1)
        fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack('I', termios.TIOCM_DTR))
    deadline = time.monotonic() + args.seconds if args.seconds else float('inf')
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(.25, max(0, deadline - time.monotonic())))
        if ready:
            chunk = os.read(fd, 16384)
            if not chunk:
                raise RuntimeError('serial device disconnected')
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
except KeyboardInterrupt:
    pass
finally:
    os.close(fd)
