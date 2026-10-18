"""Fixed nonhuman-surface recorder. Stop by stop.request; renew lease.touch.

Owns one serial descriptor, preserves every received byte, reports gaps and at
most three DTR resets. A lost controller lease stops acquisition and restores
the original firmware. This is never a human EEG acquisition path.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import termios
import time

DIAGNOSTIC_SHA = 'cb87f4dfac305d4a51f07fbf34b4fd305ecc958f8fd227d830e648232ee0381c'
ORIGINAL_SHA = '763cbcfb69ca864be27617c677a6cb4d4c8fabd210d447239e3239eb115f238a'


@dataclass
class RecoveryPolicy:
    reset_at: float
    last_frame_at: float | None = None
    restart_count: int = 0
    max_restarts: int = 3
    stale_after: float = 5.0
    reset_grace: float = 10.0

    def needs_restart(self, now):
        age = now - (self.last_frame_at if self.last_frame_at is not None else self.reset_at)
        return (age >= self.stale_after and now-self.reset_at >= self.reset_grace
                and self.restart_count < self.max_restarts)

    def restarted(self, now):
        self.restart_count += 1
        self.reset_at, self.last_frame_at = now, None

    def exhausted(self, now):
        age = now - (self.last_frame_at if self.last_frame_at is not None else self.reset_at)
        return (self.restart_count >= self.max_restarts and age >= self.stale_after
                and now-self.reset_at >= self.reset_grace)


def requested_stop_reason(run, lease, now=None):
    """Explicit Stop takes priority even when the controller lease also expired."""
    if (run/'stop.request').exists():
        return 'user_stop'
    if (time.time() if now is None else now)-lease.stat().st_mtime > 30:
        return 'controller_lease_expired'
    return None


def is_frame_line(line):
    fields = line.strip().split(b',')
    try:
        if len(fields)!=4 or fields[0]!=b'UNTRUSTED_BYPASS' or len(fields[3])!=18:
            return False
        return (0 <= int(fields[1]) < 2**32 and 0 <= int(fields[2]) < 2**32
                and len(bytes.fromhex(fields[3].decode('ascii')))==9)
    except (ValueError, UnicodeDecodeError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nonhuman-surface-only', action='store_true', required=True)
    parser.add_argument('--run-name', required=True)
    args = parser.parse_args()
    if not args.run_name.replace('-', '').isalnum():
        parser.error('Invalid generated run name')
    root = Path('/root/adaptive-horror')
    base = root/'firmware/id-bypass-diagnostic'
    lock = (base/'object-monitor.lock').open('a')
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    run = base/args.run_name
    run.mkdir(exist_ok=False)
    capture = run/'capture.txt'
    capture.touch()
    lease = run/'lease.touch'
    lease.touch()
    diagnostic = base/'ObjectSurfaceContinuous.ino.hex'
    original = base/'uno-original-app.hex'
    for path, expected in ((diagnostic, DIAGNOSTIC_SHA), (original, ORIGINAL_SHA)):
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Firmware checksum mismatch; no firmware changed')
    if subprocess.run(['fuser','/dev/ttyACM0'],capture_output=True).returncode == 0:
        raise RuntimeError('Serial port already owned; no firmware changed')
    status = {'started_at':time.time(), 'source':'untrusted_bench_bytes',
              'nonhuman_surface_only_confirmed':True, 'body_acquisition_enabled':False,
              'continuous':True, 'upload_exit':None, 'capture_exit':None,
              'restore_exit':None, 'restart_count':0, 'max_restarts':3,
              'frames_received_total':0, 'last_frame_age_seconds':None,
              'recovery_exhausted':False}

    def save(stage):
        status['stage'] = stage
        temporary = run/'status.tmp'
        temporary.write_text(json.dumps(status,indent=2)+'\n')
        temporary.replace(run/'status.json')

    def upload(path, name):
        command = [str(root/'tools/arduino-cli'),'upload','--fqbn','arduino:avr:uno',
                   '--port','/dev/ttyACM0','--input-file',str(path),'--verify',
                   '--config-file',str(root/'arduino-cli.yaml')]
        with (run/name).open('wb') as output:
            return subprocess.run(command,stdout=output,stderr=subprocess.STDOUT,timeout=70).returncode

    fd = None
    try:
        save('uploading_bench_diagnostic')
        status['upload_exit'] = upload(diagnostic,'upload.log')
        if status['upload_exit'] != 0:
            raise RuntimeError('Diagnostic upload failed')
        fd = os.open('/dev/ttyACM0',os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        fcntl.ioctl(fd,termios.TIOCEXCL)
        settings = termios.tcgetattr(fd)
        settings[:4] = [0,0,termios.CLOCAL|termios.CREAD|termios.CS8,0]
        settings[4:6] = [termios.B115200,termios.B115200]
        settings[6][termios.VMIN] = settings[6][termios.VTIME] = 0
        termios.tcsetattr(fd,termios.TCSANOW,settings)
        termios.tcflush(fd,termios.TCIFLUSH)

        def reset_uno():
            fcntl.ioctl(fd,termios.TIOCMBIC,struct.pack('I',termios.TIOCM_DTR))
            time.sleep(.1)
            fcntl.ioctl(fd,termios.TIOCMBIS,struct.pack('I',termios.TIOCM_DTR))

        reset_uno()
        policy = RecoveryPolicy(time.monotonic())
        partial = b''
        footer = False
        last_save = 0
        stage = 'capturing_untrusted_bench_bytes'
        with capture.open('ab',buffering=0) as output:
            def read_available(timeout=.1):
                nonlocal partial, footer, stage
                if not select.select([fd],[],[],timeout)[0]:
                    return
                chunk = os.read(fd,16384)
                if not chunk:
                    raise RuntimeError('USB serial disconnected')
                output.write(chunk)
                lines = (partial+chunk).split(b'\n')
                partial = lines.pop()
                if len(partial)>65536:
                    partial=b''
                for line in lines:
                    if is_frame_line(line):
                        policy.last_frame_at=time.monotonic()
                        status['frames_received_total']+=1
                        stage='capturing_untrusted_bench_bytes'
                    elif line.startswith(b'BYPASS_COMPLETE'):
                        footer=True

            while True:
                now=time.monotonic()
                reason=requested_stop_reason(run,lease)
                if reason:
                    status['stop_reason']=reason
                    break
                read_available()
                now=time.monotonic()
                # A Stop arriving during the serial wait wins over a reset.
                reason=requested_stop_reason(run,lease)
                if reason:
                    status['stop_reason']=reason
                    break
                if footer:
                    status['stop_reason']='firmware_stopped'
                    break
                if policy.needs_restart(now):
                    policy.restarted(now)
                    status['restart_count']=policy.restart_count
                    stage='restarting_stream'
                    save(stage)
                    output.write(('\nHOST_EVENT,RESTART,'+str(policy.restart_count)+
                                  ',NO_FRAMES,HOST_UNIX,'+str(time.time())+'\n').encode())
                    partial=b''
                    reset_uno()
                status['last_frame_age_seconds']=(None if policy.last_frame_at is None
                                                  else max(0,now-policy.last_frame_at))
                status['recovery_exhausted']=policy.exhausted(now)
                if now-last_save>=.5:
                    save(stage)
                    last_save=now
            # Give the explicit Stop command time to park ADC pins and report a
            # footer before closing serial and restoring the verified app.
            os.write(fd,b'S')
            stop_deadline=time.monotonic()+2
            while not footer and time.monotonic()<stop_deadline:
                read_available()
            status['stop_footer_received']=footer
            status['capture_exit']=0
    except Exception as error:
        status['error']=str(error)
    finally:
        if fd is not None:
            os.close(fd)
        save('restoring_original_firmware')
        try:
            status['restore_exit']=upload(original,'restore.log')
        except Exception as error:
            status['restore_error']=str(error)
        status['finished_at']=time.time()
        # Terminal status is the controller's ready-for-next-run handshake.
        # All serial/upload work is finished before releasing the owner lock.
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        save('restore_failed' if status['restore_exit']!=0 else
             'stopped_original_restored' if status['capture_exit']==0 else
             'capture_failed_original_restored')


if __name__=='__main__':
    main()
