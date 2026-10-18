"""Watch only the Mac's dedicated Pi Ethernet link, without changing settings."""
import concurrent.futures
import datetime
import re
import socket
import subprocess
import time

def command(args):
    try:
        return subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return ''

def report(message):
    print(datetime.datetime.now().strftime('%H:%M:%S'), message, flush=True)

def probe(host):
    try:
        with socket.create_connection((host, 22), timeout=.7) as sock:
            sock.settimeout(.7)
            banner = sock.recv(120).decode(errors='replace').strip()
            if banner.startswith('SSH-'):
                return host, banner
    except OSError:
        pass
    return None

last = None
last_report = 0
scans = 0
while True:
    adapters = command(['networksetup', '-listallhardwareports'])
    interfaces = re.findall(r'Hardware Port: USB 10/100/1000 LAN\nDevice: (\S+)', adapters)
    if not interfaces:
        state = 'USB Ethernet adapter not detected'
    else:
        details = [(interface, command(['ifconfig', interface])) for interface in interfaces]
        active = [interface for interface, text in details if 'status: active' in text]
        state = 'Ethernet link ACTIVE: ' + ', '.join(active) if active else 'Ethernet cable link INACTIVE (adapter detected)'
        if active:
            bridge = command(['ifconfig', 'bridge100'])
            if 'inet 192.168.2.1 ' not in bridge:
                state += '; Internet Sharing address not ready'
            else:
                neighbors = command(['arp', '-a', '-i', 'bridge100'])
                hosts = set(re.findall(r'\((192\.168\.2\.\d+)\) at (?!\(incomplete\))', neighbors))
                hosts.discard('192.168.2.1')
                # Dedicated, directly attached Pi subnet only; no venue Wi-Fi scanning.
                hosts.update('192.168.2.' + str(n) for n in range(2, 11))
                with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                    found = [result for result in pool.map(probe, sorted(hosts)) if result]
                if found:
                    state = '; '.join('SSH reachable: ' + host + ' | ' + banner for host, banner in found)
                else:
                    scans += 1
                    state += '; awaiting Pi DHCP/SSH'
    if state != last or time.monotonic() - last_report >= 30:
        report(state)
        last = state
        last_report = time.monotonic()
    time.sleep(2)
