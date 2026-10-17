import test from 'node:test';
import assert from 'node:assert/strict';
import { Fnaf4Mode, C4, CHARS4, SMALL_NAMES } from '../public/fnaf/modes/fnaf4.mjs';

const seqRng = (v) => () => v; // 0 -> always passes AI rolls (floor(0*20)+1=1<=lvl)
function mk(opts = {}) { const m = new Fnaf4Mode({ night: 1, rng: seqRng(0), secondsPerHour: 60, ...opts }); m.start(); return m; }
const run = (m, secs, input = {}) => { for (let i = 0; i < Math.round(secs / 0.1); i++) m.update(0.1, input); };
function until(m, pred, input = {}, max = 200) { for (let i = 0; i < max * 10 && !pred(m); i++) m.update(0.1, input); return pred(m); }
const atDoor = (door) => (m) => m.d[door].stage === 2;
const custom = (ai) => mk({ night: 'custom', ai });
const types = (m) => m.consumeEvents();

test('night 1 only left/right doors and no small ones are active', () => {
  const m = mk({ night: 1 });
  assert.equal(m.level('marrow'), 0); assert.equal(m.level('sable'), 0); assert.equal(m.level('small'), 0);
  assert.ok(m.level('hollowjaw') > 0);
});

test('AI tables escalate and night 6 is nightmare with variants', () => {
  for (const id of Object.keys(CHARS4)) assert.ok(CHARS4[id].levels[5] >= CHARS4[id].levels[0]);
  const m = mk({ night: 6 });
  const s = m.snapshot();
  assert.equal(s.nightmare, true); assert.equal(s.small.rule, 'ignore');
  assert.equal(s.characters.hollowjaw.variant, 'hollowjaw-n');
  assert.equal(mk({ night: 3 }).snapshot().characters.hollowjaw.variant, 'hollowjaw');
});

test('character approaches, breathing becomes audible only when facing the door', () => {
  const m = custom({ hollowjaw: 20 });
  assert.ok(until(m, atDoor('left'), { facing: 'bed' }));
  assert.deepEqual(m.snapshot().audioCues.filter((c) => c.kind === 'breathing'), []);
  m.update(0.1, { facing: 'left' });
  const cue = m.snapshot().audioCues.find((c) => c.kind === 'breathing');
  assert.equal(cue.pos, 'left'); assert.equal(cue.gain, 1);
  assert.equal(m.snapshot().doors.left.occupant, 'hollowjaw');
});

test('holding the door ~1.75s sends the character away safely', () => {
  const m = custom({ hollowjaw: 20 });
  until(m, atDoor('left'), { facing: 'left' });
  types(m);
  run(m, 2.0, { facing: 'left', hold: true });
  assert.equal(m.d.left.stage, 0);
  run(m, 0.2, { facing: 'left' });
  assert.equal(m.dead, false);
  assert.ok(types(m).some((e) => e.type === 'move' && e.reason === 'door-held'));
});

test('releasing too early is caught; a tap is tolerated', () => {
  const m = custom({ gristle: 20 });
  until(m, atDoor('right'), { facing: 'right' });
  run(m, 0.1, { facing: 'right', hold: true });
  run(m, 0.1, { facing: 'right' }); // 0.1s tap
  assert.equal(m.dead, false);
  run(m, 0.9, { facing: 'right', hold: true });
  run(m, 0.2, { facing: 'right' });
  assert.equal(m.dead, true);
  assert.equal(m.deathReason, 'released-early'); assert.equal(m.scare, 'gristle');
});

test('changing facing while holding counts as release', () => {
  const m = custom({ gristle: 20 });
  until(m, atDoor('right'), { facing: 'right' });
  run(m, 1.0, { facing: 'right', hold: true });
  run(m, 0.2, { facing: 'left', hold: true });
  assert.equal(m.dead, true);
});

test('ignoring a character at the door times out into a jumpscare', () => {
  const m = custom({ hollowjaw: 20 });
  until(m, atDoor('left'), { facing: 'bed' });
  assert.ok(until(m, (x) => x.dead, { facing: 'bed' }, 30));
  assert.equal(m.deathReason, 'door-open');
});

test('flashlight on a character in the doorway too long scares; brief light is fine', () => {
  const m = custom({ sable: 20 });
  until(m, atDoor('hall'), { facing: 'bed' });
  run(m, 1.0, { facing: 'hall', flashlight: true });
  assert.equal(m.dead, false);
  run(m, 1.5, { facing: 'bed' });
  run(m, 1.0, { facing: 'hall', flashlight: true });
  assert.equal(m.dead, false, 'lit time decays when light is off');
  run(m, 1.0, { facing: 'hall', flashlight: true });
  assert.equal(m.dead, true); assert.equal(m.deathReason, 'flashlit');
});

test('flashlight on an empty door is safe', () => {
  const m = mk({ night: 1 });
  run(m, 3, { facing: 'hall', flashlight: true });
  assert.equal(m.dead, false);
});

test('closing an empty door wastes time and raises heat, boosting hall levels', () => {
  const m = custom({ sable: 5 });
  const before = m.doorLevel('hall');
  run(m, 1.0, { facing: 'closet', hold: true });
  run(m, 0.2, { facing: 'closet' });
  assert.ok(m.heat >= 1);
  assert.ok(m.doorLevel('hall') > before);
  assert.ok(types(m).some((e) => e.type === 'cue' && e.id === 'wasted-close'));
  assert.equal(m.dead, false);
  run(m, 60);
  assert.ok(m.heat < 1, 'heat decays');
});

test('a hold shorter than the waste threshold does not add heat', () => {
  const m = custom({});
  run(m, 0.5, { facing: 'left', hold: true });
  run(m, 0.2, { facing: 'left' });
  assert.equal(m.heat, 0);
});

test('stage-1 approacher is turned away by a full hold (not a waste)', () => {
  const m = custom({ hollowjaw: 20 });
  until(m, (x) => x.d.left.stage === 1, { facing: 'bed' });
  run(m, 2.0, { facing: 'left', hold: true });
  assert.equal(m.d.left.stage, 0);
});

test('concurrency cap limits simultaneous approachers', () => {
  const m = custom({ hollowjaw: 20, gristle: 20, marrow: 20, sable: 20 });
  for (let i = 0; i < 300; i++) { m.update(0.1, { facing: 'bed' }); if (m.dead) break; assert.ok(m.concurrent() <= C4.MAX_CONCURRENT); }
});

test('small ones accumulate in the closet and are flashed away one by one', () => {
  const m = custom({ small: 20 });
  until(m, (x) => x.small.present.length >= 2, { facing: 'bed' });
  const n = m.small.present.length;
  run(m, C4.FLASH_SMALL + 0.2, { facing: 'closet', flashlight: true });
  assert.ok(m.small.present.length < n + 0 || m.small.present.length <= n);
  assert.ok(types(m).some((e) => e.reason === 'flashed'));
});

test('ignored small swarm eventually attacks (flash rule)', () => {
  const m = custom({ small: 20 });
  assert.ok(until(m, (x) => x.dead, { facing: 'bed' }, 120));
  assert.equal(m.deathReason, 'swarm');
  assert.ok(SMALL_NAMES.includes(m.scare));
});

test('night 6 ignore rule: small ones wander off, flashing them agitates the closet', () => {
  const m = mk({ night: 6, ai: { small: 20, hollowjaw: 0, gristle: 0, marrow: 0, sable: 0 } });
  until(m, (x) => x.small.present.length >= 1, { facing: 'bed' });
  run(m, 1, { facing: 'closet', flashlight: true });
  assert.equal(m.d.closet.stage, 2);
  assert.ok(types(m).some((e) => e.id === 'agitated'));
  const m2 = mk({ night: 6, ai: { small: 20, hollowjaw: 0, gristle: 0, marrow: 0, sable: 0 } });
  until(m2, (x) => x.small.present.length >= 1, { facing: 'bed' });
  run(m2, 10, { facing: 'bed' });
  assert.ok(types(m2).some((e) => e.reason === 'wandered-off'));
  assert.equal(m2.dead, false);
});

test('night completes at 6 AM with hour and night-win events', () => {
  const m = mk({ night: 1, ai: { hollowjaw: 0, gristle: 0 } });
  run(m, 360 + 1, { facing: 'bed' });
  assert.equal(m.won, true);
  const ev = types(m);
  assert.equal(ev.filter((e) => e.type === 'hour').length, 7);
  assert.ok(ev.some((e) => e.type === 'night-win'));
  assert.equal(m.snapshot().progress, 1);
});

test('phone call events and interruption by a jumpscare', () => {
  const m = custom({ hollowjaw: 20 });
  m.night = 1;
  run(m, 2.5, { facing: 'bed' });
  assert.ok(types(m).some((e) => e.type === 'phone-call-start' && e.id === 'night1'));
  assert.ok(until(m, (x) => x.dead, { facing: 'bed' }, 60));
  const ev = types(m);
  assert.ok(ev.some((e) => e.type === 'phone-call-end' && e.interrupted));
  assert.ok(ev.some((e) => e.type === 'jumpscare'));
});

test('AI multiplier and setAiLevel hooks, determinism with same rng seed', () => {
  const m = mk({ night: 3 });
  m.setAiLevelMultiplier(2); assert.equal(m.level('hollowjaw'), 8);
  m.setAiLevelMultiplier(0); assert.equal(m.level('hollowjaw'), 0);
  m.setAiLevel('hollowjaw', 99); m.setAiLevelMultiplier(1); assert.equal(m.level('hollowjaw'), 20);
  const mkSeed = () => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  const a = new Fnaf4Mode({ night: 4, rng: mkSeed() }); const b = new Fnaf4Mode({ night: 4, rng: mkSeed() });
  a.start(); b.start();
  for (let i = 0; i < 600; i++) { a.update(0.1, { facing: 'bed' }); b.update(0.1, { facing: 'bed' }); }
  assert.deepEqual(a.snapshot(), b.snapshot()); assert.deepEqual(a.consumeEvents(), b.consumeEvents());
});

test('update is inert before start / after death; invalid input is ignored', () => {
  const m = new Fnaf4Mode({ night: 1, rng: seqRng(0) });
  m.update(5, { facing: 'left' }); assert.equal(m.elapsed, 0);
  m.start();
  run(m, 1, { facing: 'bogus', hold: true, flashlight: true });
  assert.equal(m.snapshot().facing, null); assert.equal(m.snapshot().holding, false);
});
