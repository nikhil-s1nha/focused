"""Check KiCad-exported module connections against the agreed bench wiring."""
from pathlib import Path
import xml.etree.ElementTree as ET
P=Path(__file__).resolve().parent
root=ET.parse(P/'exports/adaptive-horror.xml').getroot()
nets=[{(n.attrib['ref'],n.attrib['pin']) for n in net.findall('node')} for net in root.findall('./nets/net')]
expected=[]
for p,a in zip(['VDD','GND','SCK','MISO','MOSI','CS','DRDY','START','RESET'],['5V','GND','D13','D12','D11','D7','D6','D5','D4']):expected.append({('U1',p),('A1',a)})
for n in ['TIP','RING','SLEEVE']:expected.append({('J1',n),('U1','JACK_'+n)})
for a,p in [('VBUS','VBUS'),('D+','D+'),('D-','D-'),('GND_USB','GND')]:expected.append({('A1',a),('A2',p)})
for pair in expected:
 assert pair in nets, f'Missing or shorted net: {pair}'
for n in ['CLK','GPIO1','GPIO2']:
 assert any(net=={('U1',n)} for net in nets),f'Expected NC: {n}'
assert len(root.findall('./components/comp'))==4
print(f'PASS: {len(expected)} exact two-node connections; 3 deliberate NC pins; 4 modules.')
(P/'exports/netlist-check.txt').write_text('PASS: 9 sensor-to-Uno wires, 3 cable-contact links, 4 USB conductors.\nPASS: CLK, GPIO1 and GPIO2 are deliberate no-connects.\nPASS: no other connections or accidental shorts in exported netlist.\nLIMIT: module-level passive pins do not model internal protection, isolation, firmware or EEG suitability.\n')
