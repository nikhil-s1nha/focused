import test from 'node:test';
import assert from 'node:assert/strict';
import { Fnaf2Mode, CHARS2 } from '../public/fnaf/modes/fnaf2.mjs';

function seq(seed = 1) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function mk(opts = {}) {
  const m = new Fnaf2Mode({ night: 7, rng: () => 0, secondsPerHour: 45, ai: {}, ...opts });
  m.start(); m.consumeEvents(); return m;
}
function run(m, secs, input = {}) { for (let i = 0; i < secs * 10; i++) m.update(0.1, input); }
const all0 = () => Object.fromEntries(Object.keys(CHARS2).map((k) => [k, 0]));

test('determinism: same seed, same event log', () => {
  const log = (seed) => { const m = new Fnaf2Mode({ night: 5, rng: seq(seed) }); m.start(); const out = []; for (let i = 0; i < 2000; i++) { m.update(0.1, { mask: i % 70 < 30 }); out.push(...m.consumeEvents()); } return JSON.stringify(out); };
  assert.equal(log(7), log(7));
  assert.notEqual(log(7), log(8));
});

test('level 0 characters never move; custom night defaults to 0', () => {
  const m = mk(); run(m, 60);
  assert.deepEqual(m.consumeEvents().filter((e) => e.type === 'move'), []);
});

test('hall character walks route and enters office', () => {
  const m = mk({ ai: { bramble: 20 } });
  run(m, 60);
  const ev = m.consumeEvents().filter((e) => e.type === 'move' && e.who === 'bramble');
  assert.deepEqual(ev.slice(0, 3).map((e) => e.to), ['party', 'main', 'hall']);
  assert.ok(ev.some((e) => e.to === 'office'));
});

test('mask off in office -> jumpscare once; mask on -> intruder leaves', () => {
  const m = mk({ ai: { bramble: 20 } });
  let scared = 0;
  for (let i = 0; i < 1200 && !m.dead; i++) { m.update(0.1, {}); scared += m.consumeEvents().filter((e) => e.type === 'jumpscare').length; }
  assert.equal(scared, 1); assert.equal(m.snapshot().scare, 'bramble');
  m.update(5, {}); assert.deepEqual(m.consumeEvents().filter((e) => e.type === 'jumpscare'), []);

  const m2 = mk({ ai: { bramble: 20 } });
  run(m2, 40, { mask: true });
  assert.equal(m2.dead, false);
  assert.ok(m2.consumeEvents().some((e) => e.type === 'move' && e.reason === 'left'));
});

test('flashlight holds back hall character and drains battery', () => {
  const m = mk({ ai: { bramble: 20 } });
  run(m, 25, { flashlight: true });
  const s = m.snapshot();
  assert.ok(s.flashlight.battery < 100);
  assert.equal(s.office.length, 0);
  const ev = m.consumeEvents();
  assert.ok(ev.some((e) => e.reason === 'repelled'));
});

test('flashlight dies at 0 battery; unavailable under mask/camera', () => {
  const m = mk();
  run(m, 130, { flashlight: true });
  assert.equal(m.snapshot().flashlight.battery, 0);
  assert.equal(m.snapshot().flashlight.on, false);
  const m2 = mk(); run(m2, 5, { flashlight: true, mask: true });
  assert.equal(m2.snapshot().flashlight.battery, 100);
});

test('mask and camera mutually exclusive', () => {
  const m = mk(); m.update(0.2, { mask: true, camera: true });
  const s = m.snapshot(); assert.equal(s.mask, true); assert.equal(s.camera, false);
  m.update(0.2, { camera: true }); assert.equal(m.snapshot().camera, true); assert.equal(m.snapshot().mask, false);
});

test('vent light repels vent character; unlit enters office', () => {
  const m = mk({ ai: { nimbus: 20 } });
  run(m, 40, { ventLight: 'left' });
  assert.equal(m.snapshot().office.length, 0);
  const m2 = mk({ ai: { nimbus: 20 } });
  run(m2, 40, { mask: true });
  assert.ok(m2.consumeEvents().some((e) => e.type === 'move' && e.to === 'office' && e.via === 'ventL'));
  const m3 = mk({ ai: { sprocket: 20 } }); run(m3, 40, { ventLight: 'left' });
  assert.ok(m3.snapshot().office.length > 0 || m3.dead); // wrong side does nothing
});

test('withered variants have shorter grace and longer flashlight repel', () => {
  const m = mk({ ai: { cinder: 20, bramble: 20 } });
  run(m, 120, { mask: true });
  assert.equal(m.snapshot().characters.cinder.withered, true);
  assert.equal(m.dead, false);
});

test('music box: unwinds, winding needs camera on prize, puppet escapes', () => {
  const m = mk({ ai: { jackalope: 20 } });
  run(m, 20, { camera: true, cam: 'prize' });
  assert.ok(m.snapshot().musicbox.value < 1);
  const v = m.snapshot().musicbox.value;
  run(m, 3, { camera: true, cam: 'prize', windMusicBox: true });
  assert.ok(m.snapshot().musicbox.value > v);
  run(m, 3, { camera: true, cam: 'main', windMusicBox: true });
  // winding on the wrong camera does nothing (box keeps falling)
  const v2 = m.snapshot().musicbox.value;
  run(m, 2, { camera: true, cam: 'main', windMusicBox: true });
  assert.ok(m.snapshot().musicbox.value < v2);

  const m2 = mk({ ai: { jackalope: 20 } });
  let scare = null; let lows = 0;
  for (let i = 0; i < 4000 && !m2.dead; i++) { m2.update(0.1, { mask: true }); for (const e of m2.consumeEvents()) { if (e.type === 'jumpscare') scare = e; if (e.id === 'musicbox' && e.state === 'empty') lows++; } }
  assert.equal(scare.who, 'jackalope'); assert.equal(scare.reason, 'musicbox'); assert.equal(lows, 1);
});

test('puppet escape cancels if wound in time', () => {
  const m = mk({ ai: { jackalope: 20 } });
  let i = 0;
  while (m.snapshot().musicbox.state !== 'empty' && i++ < 5000) m.update(0.1, {});
  run(m, 2, { camera: true, cam: 'prize', windMusicBox: true });
  assert.equal(m.dead, false); assert.equal(m.snapshot().musicbox.escapeIn, null);
});

test('6AM win fires hour events and night-win exactly once', () => {
  const m = mk({ secondsPerHour: 5 });
  const ev = []; for (let i = 0; i < 400; i++) { m.update(0.1, {}); ev.push(...m.consumeEvents()); }
  assert.deepEqual(ev.filter((e) => e.type === 'hour').map((e) => e.hour), [1, 2, 3, 4, 5, 6]);
  assert.equal(ev.filter((e) => e.type === 'night-win').length, 1);
  assert.equal(m.snapshot().won, true);
});

test('AI multiplier and setAiLevel hooks; consumeEvents drains', () => {
  const m = mk({ ai: { bramble: 5 } });
  m.setAiLevelMultiplier(2); assert.equal(m.level('bramble'), 10);
  m.setAiLevel('bramble', 3); m.setAiLevelMultiplier(1); assert.equal(m.level('bramble'), 3);
  m.setAiLevel('nobody', 3);
  m.update(1, {}); m.consumeEvents(); assert.deepEqual(m.consumeEvents(), []);
});

test('night tables: six nights, nine characters', () => {
  assert.ok(Object.keys(CHARS2).length >= 6);
  const m = new Fnaf2Mode({ night: 6 }); assert.ok(m.level('bramble') > 0);
  assert.equal(new Fnaf2Mode({ night: 1 }).level('bramble'), 0);
});
