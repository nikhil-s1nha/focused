"""Generate the native module-level KiCad wiring reference (no PCB layout)."""
from pathlib import Path
import json, uuid
P=Path(__file__).resolve().parent
q=lambda s:json.dumps(str(s))
u=lambda s:str(uuid.uuid5(uuid.NAMESPACE_URL,'adaptive-horror:'+s))
root=u('root')
def prop(name,value,x,y,size=1.27,hide=False):
 return f'(property {q(name)} {q(value)} (at {x} {y} 0) (effects (font (size {size} {size}))'+(' (hide yes)' if hide else '')+'))'
def pin(num,name,x,y,angle,kind='passive'):
 x=round(x,3); y=round(y,3)
 return f'(pin {kind} line (at {x} {y} {angle}) (length 5.08) (name {q(name)} (effects (font (size 1.05 1.05)))) (number {q(num)} (effects (font (size 0.8 0.8)))))'
# Pin identifiers are silkscreen names, not invented physical header numbers.
proto=[]
for i,n in enumerate(['VDD','GND','SCK','MISO','MOSI','CS','DRDY','START','RESET']): proto.append((n,n,20.32,25.4-i*5.08,180,'passive'))
for i,n in enumerate(['CLK','GPIO1','GPIO2']): proto.append((n,n,20.32,-25.4-i*5.08,180,'passive'))
for i,n in enumerate(['TIP','RING','SLEEVE']): proto.append(('JACK_'+n,'Jack '+n,-20.32,10.16-i*10.16,0,'passive'))
uno=[]
for i,n in enumerate(['5V','GND','D13','D12','D11','D7','D6','D5','D4']):uno.append((n,n,-20.32,25.4-i*5.08,0,'passive'))
for i,n in enumerate(['VBUS','D+','D-','GND_USB']):uno.append((n,n.replace('_USB',''),20.32,10.16-i*7.62,180,'passive'))
pi=[(n,n,-20.32,10.16-i*7.62,0,'passive') for i,n in enumerate(['VBUS','D+','D-','GND'])]
elect=[(n,n,15.24,10.16-i*10.16,180,'passive') for i,n in enumerate(['TIP','RING','SLEEVE'])]
models=[('WetLead','J1','3 wet electrodes / TRS cable',elect,10.16,17.78),('ProtoCentral','U1','ADS1292R legacy breakout',proto,15.24,43.18),('UnoR3','A1','Arduino Uno R3 (5 V)',uno,15.24,35.56),('OrangePi','A2','Orange Pi 5 Pro',pi,15.24,25.4)]
def libsymbol(m,with_prefix=True):
 name,ref,value,pins,w,h=m
 return f'(symbol {q(("AdaptiveHorror:" if with_prefix else "")+name)} (pin_names (offset 0.7)) (exclude_from_sim yes) (in_bom yes) (on_board yes) '+prop('Reference',ref,0,h+5.08)+prop('Value',value,0,h+2.54)+f'(symbol {q(name+"_0_1")} (rectangle (start {-w} {h}) (end {w} {-h}) (stroke (width 0.254) (type default)) (fill (type background)))) (symbol {q(name+"_1_1")} '+''.join(pin(*p) for p in pins)+'))'
parts=['(kicad_sch (version 20250114) (generator "adaptive_horror_reference")',f'(uuid {q(root)}) (paper "A3")','(title_block (title "Adaptive Horror | Biosignal Bench Wiring") (date "2026-10-17") (rev "B") (company "MOLTEN hackathon prototype") (comment 1 "Module wiring reference; not a medical device or body-use approval"))','(lib_symbols '+''.join(libsymbol(m) for m in models)+')']
positions={'WetLead':(35.56,91.44),'ProtoCentral':(106.68,91.44),'UnoR3':(208.28,91.44),'OrangePi':(314.96,91.44)}
coords={}
for m in models:
 name,ref,value,pins,w,h=m;x,y=positions[name];sid=u(ref)
 parts.append(f'(symbol (lib_id {q("AdaptiveHorror:"+name)}) (at {x} {y} 0) (unit 1) (exclude_from_sim yes) (in_bom yes) (on_board yes) (dnp no) (uuid {q(sid)}) '+prop('Reference',ref,x,y-h-7.62)+prop('Value',value,x,y-h-5.08,size=1.1)+f'(instances (project "adaptive-horror" (path {q("/"+root)} (reference {q(ref)}) (unit 1)))))')
 for num,pn,px,py,a,k in pins:coords[(ref,num)]=(round(x+px,3),round(y-py,3))
def wire(a,b,key):
 parts.append(f'(wire (pts (xy {a[0]} {a[1]}) (xy {b[0]} {b[1]})) (stroke (width 0) (type default)) (uuid {q(u("wire"+key))}))')
def text(s,x,y,size=1.27):
 parts.append(f'(text {q(s)} (at {x} {y} 0) (effects (font (size {size} {size})) (justify left)) (uuid {q(u("text"+s))}))')
for pn,un in zip(['VDD','GND','SCK','MISO','MOSI','CS','DRDY','START','RESET'],['5V','GND','D13','D12','D11','D7','D6','D5','D4']):wire(coords['U1',pn],coords['A1',un],pn)
for n in ['TIP','RING','SLEEVE']:wire(coords['J1',n],coords['U1','JACK_'+n],'elect'+n)
for n,pi_n in [('VBUS','VBUS'),('D+','D+'),('D-','D-'),('GND_USB','GND')]:wire(coords['A1',n],coords['A2',pi_n],'usb'+n)
for n in ['CLK','GPIO1','GPIO2']:
 x,y=coords['U1',n];parts.append(f'(no_connect (at {x} {y}) (uuid {q(u("nc"+n))}))')
text('3.5 mm TRS cable',53.34,73.66,1.0)
text('9 jumper wires / breadboard',132.08,58.42,1.0)
text('USB-B on Uno -> USB-A on Pi',233.68,68.58,1.0)
text('USB data + 5 V power',238.76,114.3,1.0)
text('PI GPIO HEADER: NO CONNECTIONS',269.24,127,1.27)
text('OPTION: replace A2 with battery-only laptop; same USB cable.',238.76,137.16,1.05)
text('Never both hosts. Physical move / power review still PENDING.',238.76,142.24,1.05)
text('Laptop charger, docks, displays and powered peripherals unplugged.',238.76,147.32,1.05)
text('JP3 board side: TIP -> R20 (0R) -> ADS IN2N',20.32,137.16,1.05)
text('RING -> R22 (0R) -> IN2P',20.32,142.24,1.05)
text('SLEEVE -> R24 (100k) -> R23 (0R) -> RLDOUT / bias',20.32,147.32,1.05)
text('BENCH CONFIGURATION ONLY',20.32,22.86,2.4)
text('Existing LOGIC_SEL = 5 V (continuity checked). Uno R3 uses 5 V logic.',20.32,33.02,1.5)
text('ELECTRODES: LEAVE DISCONNECTED during USB/mains bench tests.',20.32,154.94,1.7)
text('Board-side jack mapping sourced from official v3 schematic. Cable colors / placement UNVERIFIED.',20.32,165.1,1.27)
text('The ADS1292R board is sold for ECG/respiration; EEG suitability is not yet validated.',20.32,172.72,1.27)
text('Before body use: power isolation, peripheral connections and electrode setup still need review.',20.32,180.34,1.27)
text('Do not treat a battery-powered Pi connected to mains USB/HDMI peripherals as isolated.',20.32,187.96,1.27)
text('No extra Uno barrel-jack / VIN supply in this USB-powered bench configuration.',20.32,198.12,1.27)
text('CHECK BEFORE POWER: each header pin has its own breadboard strip; no adjacent-pin shorts.',20.32,210.82,1.27)
text('Firmware: CS=D7, DRDY=D6, START=D5, RESET=D4. Keep Uno D10 configured as OUTPUT for SPI master.',20.32,218.44,1.27)
text('PENDING: battery-only laptop move, body-use power review, electrode placement, EEG validation.',20.32,228.6,1.27)
text('No robot arm or heart-rate hardware in this MVP. Quest/WebXR receives the network intensity stream.',20.32,236.22,1.27)
text('Source: Protocentral/ADS1292rShield_Breakout, hardware/breakout/pc_ads1292r_brk_v3.sch (JP3 / R20 / R22 / R23 / R24).',20.32,246.38,1.0)
parts.append(')')
(P/'adaptive-horror.kicad_sch').write_text('\n'.join(parts))
(P/'AdaptiveHorror.kicad_sym').write_text('(kicad_symbol_lib (version 20241209) (generator "adaptive_horror_reference")\n'+ '\n'.join(libsymbol(m,False) for m in models)+'\n)')
(P/'sym-lib-table').write_text('(sym_lib_table (version 7) (lib (name "AdaptiveHorror") (type "KiCad") (uri "${KIPRJMOD}/AdaptiveHorror.kicad_sym") (options "") (descr "Functional module symbols; no internal circuit claims")))\n')
(P/'adaptive-horror.kicad_pro').write_text(json.dumps({'meta':{'filename':'adaptive-horror.kicad_pro','version':1},'schematic':{'drawing':{}},'text_variables':{}},indent=2)+'\n')
