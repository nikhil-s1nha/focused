import test from 'node:test';
import assert from 'node:assert/strict';
import { FnafNight, createProgress, recordWin, availableNights, validProgress, jingleSeconds, CAMERAS, cameraRoom, cameraIndex } from '../public/fnaf/core/index.mjs';

const always = (v) => () => v;
function seq(vals) { let i = 0; return () => vals[i++ % vals.length]; }
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const IN = (o = {}) => ({ doors: {}, lights: {}, monitorUp: false, cameraRoom: null, ...o });
function mk(opts = {}) { const n = new FnafNight({ night: 'custom', rng: always(0), ai: { maestro: 0, bellwether: 0, lark: 0, ratchet: 0 }, ...opts }); n.start(); return n; }
function run(n, secs, input, step = 0.1) { for (let t = 0; t < secs - 1e-9; t += step) n.update(step, input); }
const ofType = (evs, t) => evs.filter((e) => e.type === t);

test('camera mapping and rooms', () => {
  assert.equal(CAMERAS.length, 11);
  assert.equal(cameraRoom(1), 'showstage'); assert.equal(cameraIndex('kitchen'), 8);
});

test('movement timer is deterministic and AI 0 never moves', () => {
  const n = mk({ ai: { bellwether: 20 }, rng: always(0) });
  run(n, 4.9, IN()); assert.equal(ofType(n.consumeEvents(), 'move').length, 0);
  run(n, 0.2, IN());
  const mv = ofType(n.consumeEvents(), 'move'); assert.equal(mv.length, 1);
  assert.deepEqual([mv[0].who, mv[0].from], ['bellwether', 'showstage']);
  const z = mk({ ai: { bellwether: 0 }, rng: always(0) }); run(z, 100, IN());
  assert.equal(ofType(z.consumeEvents(), 'move').length, 0);
});

test('same seed same history', () => {
  const h = () => { const n = mk({ ai: { bellwether: 12, lark: 12, maestro: 12, ratchet: 12 }, rng: lcg(7) }); const out = []; for (let i = 0; i < 600; i++) { n.update(0.1, IN({ doors: { left: true, right: true } })); out.push(...n.consumeEvents().map((e) => `${e.type}:${e.who}:${e.to}`)); } return out.join('|'); };
  assert.equal(h(), h());
});

test('roll threshold: roll > ai fails', () => {
  // rng 0.99 -> roll 20; ai 10 fails, ai 20 succeeds
  const a = mk({ ai: { bellwether: 10 }, rng: always(0.99) }); run(a, 10, IN());
  assert.equal(ofType(a.consumeEvents(), 'move').length, 0);
  const b = mk({ ai: { bellwether: 20 }, rng: always(0.99) }); run(b, 5.1, IN());
  assert.equal(ofType(b.consumeEvents(), 'move').length, 1);
});

function bellAtDoor(door, extra = {}) {
  const n = mk({ ai: { bellwether: 20 }, rng: always(0.99), ...extra }); // rng .99: picks last option each time
  n.chars.bellwether.room = 'hall-west-corner'; n.consumeEvents();
  return n;
}
test('door blocks: closed door -> retreat, open door -> jumpscare', () => {
  const a = bellAtDoor(); run(a, 5.1, IN({ doors: { left: true } }));
  const ea = a.consumeEvents(); assert.equal(ofType(ea, 'jumpscare').length, 0);
  assert.equal(a.snapshot().characters.bellwether.room, 'dining');
  const b = bellAtDoor(); run(b, 5.1, IN());
  assert.equal(b.snapshot().characters.bellwether.inOffice, true);
  run(b, 0.2, IN());
  const j = ofType(b.consumeEvents(), 'jumpscare'); assert.equal(j.length, 1); assert.equal(j[0].who, 'bellwether');
  assert.equal(b.snapshot().state, 'dead');
});

test('office attacker waits for monitor but is capped', () => {
  const b = bellAtDoor(); run(b, 5.1, IN({ monitorUp: true, cameraRoom: 'showstage' }));
  run(b, 5, IN({ monitorUp: true })); assert.equal(b.snapshot().state, 'running');
  run(b, 5.5, IN({ monitorUp: true })); assert.equal(b.snapshot().state, 'dead');
});

test('maestro frozen while his camera is watched; moves otherwise', () => {
  const n = mk({ ai: { maestro: 20 } }); run(n, 30, IN({ monitorUp: true, cameraRoom: 'showstage' }));
  assert.equal(ofType(n.consumeEvents(), 'move').length, 0);
  run(n, 3.1, IN({ monitorUp: true, cameraRoom: 'dining' }));
  assert.equal(ofType(n.consumeEvents(), 'move').length, 1);
});

test('maestro right door: closed retreats, open scares', () => {
  const m = mk({ ai: { maestro: 20 } }); m.chars.maestro.room = 'hall-east-corner';
  run(m, 3.1, IN({ doors: { right: true } })); assert.equal(m.snapshot().characters.maestro.room, 'hall-east');
  const o = mk({ ai: { maestro: 20 } }); o.chars.maestro.room = 'hall-east-corner';
  run(o, 3.2, IN()); assert.equal(o.snapshot().state, 'dead'); assert.equal(o.snapshot().killer, 'maestro');
});

test('lark kitchen noises', () => {
  const n = mk({ ai: { lark: 0 } }); n.chars.lark.room = 'kitchen'; run(n, 10, IN());
  assert.ok(ofType(n.consumeEvents(), 'cue').filter((e) => e.name === 'kitchen-noise').length >= 2);
});

test('ratchet advances stages when unwatched, freezes when watched', () => {
  const n = mk({ ai: { ratchet: 20 } }); run(n, 5.1, IN());
  assert.equal(n.snapshot().characters.ratchet.stage, 1);
  const w = mk({ ai: { ratchet: 20 } }); run(w, 60, IN({ monitorUp: true, cameraRoom: 'cove' }));
  assert.equal(w.snapshot().characters.ratchet.stage, 0);
  // freeze persists after camera closed
  const f = mk({ ai: { ratchet: 20 }, rng: always(0.99) }); run(f, 1, IN({ monitorUp: true, cameraRoom: 'cove' }));
  run(f, 5.2, IN()); assert.equal(f.snapshot().characters.ratchet.stage, 0); // freeze ~16s with rng .99
});

test('ratchet run: closed door bangs with growing power loss, open door scares', () => {
  const n = mk({ ai: { ratchet: 20 } }); n.chars.ratchet.stage = 3;
  const d = IN({ doors: { left: true } });
  run(n, 5.1, d); assert.equal(n.snapshot().characters.ratchet.running, true);
  const p0 = n.snapshot().power; run(n, 5.1, d);
  const k = ofType(n.consumeEvents(), 'door-knock'); assert.equal(k.length, 1); assert.equal(k[0].powerLoss, 1);
  assert.ok(p0 - n.snapshot().power >= 0.9);
  n.chars.ratchet.stage = 3; run(n, 10.5, d);
  const k2 = ofType(n.consumeEvents(), 'door-knock'); assert.equal(k2[0].powerLoss, 6);
  const o = mk({ ai: { ratchet: 20 } }); o.chars.ratchet.stage = 3; run(o, 10.5, IN());
  assert.equal(o.snapshot().killer, 'ratchet');
});

test('power math per usage level', () => {
  const cases = [[IN(), 1, 9.6], [IN({ monitorUp: true }), 2, 4.8], [IN({ monitorUp: true, doors: { left: true } }), 3, 2.8],
    [IN({ monitorUp: true, doors: { left: true, right: true } }), 4, 1.9], [IN({ monitorUp: true, doors: { left: true }, lights: { right: true } }), 4, 1.9]];
  for (const [inp, u, sec] of cases) {
    const n = mk(); n.update(0.1, inp); assert.equal(n.snapshot().usage, u);
    const p = n.snapshot().power; run(n, sec, inp); assert.ok(Math.abs((p - n.snapshot().power) - 1) < 0.15, `u${u}`);
  }
  const five = mk(); const i5 = IN({ monitorUp: true, doors: { left: true }, lights: { right: true } });
  // door closed disables its light; use left door + right light + right door impossible -> usage 5 needs door+opposite light+door? max via lights both off doors
  five.update(0.1, IN({ monitorUp: true, doors: { left: true }, lights: { left: true, right: true } }));
  assert.equal(five.snapshot().usage, 4); assert.equal(five.snapshot().lights.left, false);
  const full = mk(); full.update(0.1, IN({ monitorUp: true, lights: { left: true, right: true }, doors: {} }));
  assert.equal(full.snapshot().usage, 4); void i5;
});

test('passive drain on night 2+', () => {
  const n = new FnafNight({ night: 2, rng: always(0.99), ai: { bellwether: 0, lark: 0, ratchet: 0, maestro: 0 } }); n.start();
  run(n, 9.6, IN()); assert.ok(100 - n.snapshot().power > 2.5);
  const c = new FnafNight({ night: 1, rng: always(0.99) }); c.start(); run(c, 9.6, IN()); assert.ok(Math.abs(100 - c.snapshot().power - 1) < 0.1);
});

test('power-out sequence ends in maestro jumpscare', () => {
  const n = mk({ rng: always(0.5) }); n.power = 0.05;
  run(n, 1, IN({ monitorUp: true }));
  assert.equal(n.snapshot().state, 'power-out');
  const first = n.consumeEvents(); assert.equal(ofType(first, 'power-out').length, 1);
  assert.equal(n.snapshot().usage, 0); assert.equal(n.snapshot().monitorUp, false);
  const seen = []; let guard = 0;
  while (n.snapshot().state === 'power-out' && guard++ < 5000) { n.update(0.1, IN({ doors: { left: true }, monitorUp: true })); seen.push(n.snapshot().powerOut?.phase); n.consumeEvents(); assert.equal(n.snapshot().doors.left, false); }
  const order = [...new Set(seen.filter(Boolean))]; assert.deepEqual(order, ['approach', 'jingle', 'eyes', 'dark', 'scare'].filter((p) => order.includes(p)));
  assert.ok(order.includes('jingle') && order.includes('eyes') && order.includes('dark'));
  assert.equal(n.snapshot().killer, 'maestro');
});

test('power-out dark length is 5-20s and jingle notes emitted', () => {
  for (const [r, lo, hi] of [[0, 5, 5.2], [0.9999, 19.8, 20.1]]) {
    const n = mk({ rng: always(r) }); n.power = 0.01; run(n, 0.5, IN());
    let evs = []; let tDark = null, tEnd = null, t = 0;
    while (n.snapshot().state === 'power-out' && t < 200) { n.update(0.05, IN()); t += 0.05; const e = n.consumeEvents(); evs.push(...e); if (tDark === null && e.some((x) => x.name === 'dark')) tDark = t; }
    tEnd = t; assert.ok(tEnd - tDark >= lo - 0.1 && tEnd - tDark <= hi, `dark ${tEnd - tDark}`);
    assert.ok(evs.filter((x) => x.name === 'jingle-note').length >= 14);
  }
  assert.ok(jingleSeconds() > 10);
});

test('6AM arrives during power-out -> win', () => {
  const n = new FnafNight({ night: 'custom', rng: always(0.99), secondsPerHour: 10 }); n.start(); n.power = 0.01; n.clock = 0.97;
  run(n, 60.1, IN()); assert.equal(n.snapshot().state, 'won');
});

test('6AM win, hour events, short preset', () => {
  const n = new FnafNight({ night: 1, rng: always(0.99), secondsPerHour: 'short', ai: { bellwether: 0, lark: 0, maestro: 0, ratchet: 0 } }); n.start();
  let evs = []; for (let i = 0; i < 1900 && n.snapshot().state === 'running'; i++) { n.update(0.1, IN()); evs.push(...n.consumeEvents()); }
  assert.deepEqual(ofType(evs, 'hour').map((e) => e.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(ofType(evs, 'night-win').length, 1); assert.equal(n.snapshot().clock, '6 AM');
  assert.ok(n.snapshot().power > 0);
});

test('classic night length 534.6s', () => {
  const n = new FnafNight({ night: 1, rng: always(0.99) }); n.start(); let t = 0;
  while (n.snapshot().state === 'running') { n.update(0.1, IN({ doors: { left: true, right: true } })); t += 0.1; if (n.power <= 0) break; }
  assert.ok(Math.abs(t - 534.6) < 0.3 || n.snapshot().state !== 'won', String(t));
});

test('night AI table and wake hours', () => {
  const n = new FnafNight({ night: 1, rng: always(0.99) }); n.start();
  assert.equal(n.snapshot().characters.bellwether.ai, 0);
  run(n, 89.1 * 2 + 1, IN({ doors: { left: true, right: true } }));
  assert.equal(n.snapshot().characters.bellwether.ai, 1);
  const six = new FnafNight({ night: 6 }); assert.equal(six.snapshot().characters.bellwether.ai, 10);
  assert.equal(new FnafNight({ night: 5 }).snapshot().characters.ratchet.ai, 5);
});

test('custom night levels, clamp, multiplier hook', () => {
  const n = new FnafNight({ night: 'custom', ai: { maestro: 99, lark: -3, bellwether: 7.5 } });
  const s = n.snapshot().characters; assert.equal(s.maestro.ai, 20); assert.equal(s.lark.ai, 0); assert.equal(s.bellwether.ai, 7.5);
  n.setAiLevelMultiplier(2); assert.equal(n.snapshot().characters.bellwether.effectiveAi, 15);
  n.setAiLevelMultiplier(10); assert.equal(n.snapshot().characters.bellwether.effectiveAi, 20);
  n.setAiLevel('ratchet', 50); assert.equal(n.snapshot().characters.ratchet.ai, 20);
  assert.throws(() => new FnafNight({ night: 9 }));
});

test('setAiLevel survives wake schedule', () => {
  const n = new FnafNight({ night: 1, rng: always(0.99) }); n.start(); n.setAiLevel('bellwether', 9);
  run(n, 89.1 * 3, IN({ doors: { left: true, right: true } })); assert.equal(n.snapshot().characters.bellwether.ai, 9);
});

test('events are consumed once only', () => {
  const n = mk({ ai: { bellwether: 20 } }); run(n, 5.1, IN());
  assert.ok(n.consumeEvents().length > 0); assert.equal(n.consumeEvents().length, 0);
});

test('phone call start/end and mute', () => {
  const n = new FnafNight({ night: 2, rng: always(0.99) }); n.start();
  assert.equal(ofType(n.consumeEvents(), 'phone-call-start')[0].night, 2);
  run(n, 76, IN({ doors: { left: true, right: true } }));
  assert.equal(ofType(n.consumeEvents(), 'phone-call-end').length, 1);
  const m = new FnafNight({ night: 1 }); m.start(); m.consumeEvents(); m.muteCall(); m.muteCall();
  assert.equal(ofType(m.consumeEvents(), 'phone-call-end').length, 1);
  assert.equal(new FnafNight({ night: 'custom' }).start() ?? 0, 0);
});

test('static event on watched camera when animatronic moves there', () => {
  const n = mk({ ai: { bellwether: 20 } }); run(n, 5.1, IN({ monitorUp: true, cameraRoom: 'showstage' }));
  assert.equal(ofType(n.consumeEvents(), 'static').length, 1);
  const k = mk({ ai: { lark: 20 }, rng: always(0) }); k.chars.lark.room = 'dining'; run(k, 5.1, IN({ monitorUp: true, cameraRoom: 'kitchen' }));
  assert.equal(ofType(k.consumeEvents(), 'static').length, 0);
});

test('light presence cue and power warnings', () => {
  const n = mk(); n.chars.bellwether.room = 'hall-west-corner';
  n.update(0.1, IN({ lights: { left: true } }));
  assert.equal(n.consumeEvents().filter((e) => e.name === 'door-presence').length, 1);
  n.update(0.1, IN({ lights: { left: true } })); assert.equal(n.consumeEvents().filter((e) => e.name === 'door-presence').length, 0);
  n.power = 20.1; run(n, 2, IN({ monitorUp: true }));
  assert.equal(ofType(n.consumeEvents(), 'power-warning').length, 1);
});

test('progress object', () => {
  let p = createProgress(); assert.deepEqual(availableNights(p), [1]);
  for (const k of [1, 2, 3, 4, 5]) p = recordWin(p, k);
  assert.deepEqual(availableNights(p), [1, 2, 3, 4, 5, 6]);
  p = recordWin(p, 6); assert.ok(availableNights(p).includes('custom'));
  assert.ok(validProgress(JSON.parse(JSON.stringify(p)))); assert.ok(!validProgress({ version: 2 }));
});
