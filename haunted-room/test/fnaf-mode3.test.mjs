import test from 'node:test';
import assert from 'node:assert/strict';
import { Fnaf3Mode, C3 } from '../public/fnaf/modes/fnaf3.mjs';

function seq(seed = 1) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function mk(opts = {}) { const m = new Fnaf3Mode({ night: 7, rng: () => 0, secondsPerHour: 45, ...opts }); m.start(); m.consumeEvents(); return m; }
function run(m, secs, input = {}) { for (let i = 0; i < secs * 10; i++) m.update(0.1, input); }
const evs = (m, f) => m.consumeEvents().filter(f);
function force(m, pos) { m.pos = pos; }

test('determinism', () => {
  const log = (seed) => { const m = new Fnaf3Mode({ night: 4, rng: seq(seed) }); m.start(); const o = []; for (let i = 0; i < 2500; i++) { m.update(0.1, { camera: i % 50 < 10 }); o.push(...m.consumeEvents()); } return JSON.stringify(o); };
  assert.equal(log(3), log(3)); assert.notEqual(log(3), log(4));
});

test('stalker at level 0 never moves; with level it hunts and scares via vent', () => {
  const m = mk(); run(m, 60); assert.equal(m.snapshot().stalker.room, 'cellar');
  const h = mk({ ai: { stalker: 20 } });
  let sc = null; for (let i = 0; i < 6000 && !h.dead; i++) { h.update(0.1, {}); for (const e of h.consumeEvents()) if (e.type === 'jumpscare') sc = e; }
  assert.equal(sc.reason, 'vent'); assert.match(h.snapshot().stalker.room, /-near$/);
});

test('seal traps stalker in section and releases him to lobby with pause', () => {
  const m = mk({ ai: { stalker: 20 } }); force(m, 'ventB-far');
  m.update(0.1, { seal: 'B' });
  assert.equal(m.snapshot().stalker.trapped, true);
  run(m, 6, {}); assert.equal(m.dead, false);
  run(m, 3, {});
  const s = m.snapshot(); assert.equal(s.stalker.trapped, false); assert.equal(s.stalker.room, 'lobby'); assert.equal(s.stalker.paused, true);
  // cooldown: cannot reseal immediately
  m.update(0.1, { seal: 'B' });
  assert.ok(m.consumeEvents().some((e) => e.id === 'seal-unavailable'));
});

test('seal saves from near-vent scare', () => {
  const m = mk({ ai: { stalker: 20 } }); force(m, 'ventA-near');
  m.update(0.1, { seal: 'A' }); run(m, 7); assert.equal(m.dead, false);
});

test('audio lure draws stalker toward chosen room; lure requires audio', () => {
  const m = mk({ ai: { stalker: 20 } }); force(m, 'lobby');
  m.update(0.1, { lure: 'cellar' });
  run(m, 9);
  const moves = evs(m, (e) => e.type === 'move');
  assert.ok(moves.length >= 1 && moves.every((e) => e.lured));
  assert.notEqual(m.snapshot().stalker.room, 'lobby');
  const f = mk({ ai: { stalker: 20 } }); f.setFault('audio'); f.consumeEvents();
  f.update(0.1, { lure: 'cellar' });
  assert.ok(f.consumeEvents().some((e) => e.id === 'lure-failed')); assert.equal(f.snapshot().lure, null);
});

test('lure cooldown', () => {
  const m = mk(); m.update(0.1, { lure: 'hall1' }); m.update(0.1, {}); m.consumeEvents();
  run(m, 11); m.update(0.1, { lure: 'arcade' });
  assert.ok(m.consumeEvents().some((e) => e.id === 'lure-cooldown'));
});

test('reboot takes time and blocks other reboots', () => {
  const m = mk(); m.setFault('camera'); m.setFault('audio'); m.consumeEvents();
  m.update(0.1, { reboot: 'camera' });
  m.update(0.1, { reboot: 'audio' });
  assert.ok(m.consumeEvents().some((e) => e.id === 'reboot-blocked'));
  assert.equal(m.snapshot().reboot.system, 'camera');
  run(m, 7.2, {}); assert.equal(m.snapshot().systems.camera.fault, false);
  assert.equal(m.snapshot().systems.audio.fault, true);
  m.update(0.1, {}); m.update(0.1, { reboot: 'audio' }); run(m, 5.2);
  assert.equal(m.snapshot().systems.audio.fault, false);
});

test('ventilation fault blurs, recovers on reboot, forces jumpscare if ignored', () => {
  const m = mk(); m.setFault('vent'); run(m, 15);
  assert.ok(m.snapshot().blur > 0.4 && m.snapshot().blur < 0.6);
  m.update(0.1, { reboot: 'vent' }); run(m, 8.5);
  assert.equal(m.snapshot().systems.vent.fault, false); run(m, 5); assert.ok(m.snapshot().blur < 0.5);

  const n = mk(); n.setFault('vent'); let sc = []; for (let i = 0; i < 400; i++) { n.update(0.1, {}); sc.push(...n.consumeEvents().filter((e) => e.type === 'jumpscare')); }
  assert.equal(sc.length, 1); assert.equal(sc[0].reason, 'ventilation');
});

test('camera fault hides stalker from monitor', () => {
  const m = mk(); force(m, 'lobby'); m.update(0.1, { camera: true, cam: 'lobby' });
  assert.equal(m.snapshot().cameraView.length, 1);
  m.setFault('camera'); m.update(0.1, { camera: true, cam: 'lobby' });
  assert.equal(m.snapshot().cameraView.length, 0);
});

test('random faults appear for faults level only', () => {
  const m = mk(); run(m, 100); assert.equal(m.snapshot().systems.audio.fault || m.snapshot().systems.camera.fault || m.snapshot().systems.vent.fault, false);
  const f = mk({ ai: { faults: 20 } }); run(f, 15);
  assert.ok(Object.values(f.snapshot().systems).some((s) => s.fault));
});

test('phantoms: appear, dismissal rules, camera expiry -> temp fault', () => {
  const m = mk({ ai: { phantoms: 20 } });
  run(m, 40);
  const ev = m.consumeEvents().filter((e) => e.type === 'phantom');
  assert.ok(ev.some((e) => e.action === 'appear'));
  const m2 = mk(); m2.phantoms.push({ id: 'mothlady', location: 'arcade', t: 8 });
  m2.update(0.1, { dismiss: 'mothlady' });  // not looking
  assert.equal(m2.snapshot().phantoms.length, 1);
  m2.update(0.1, {}); m2.update(0.1, { camera: true, cam: 'arcade', dismiss: 'mothlady' });
  assert.equal(m2.snapshot().phantoms.length, 0);
  const m3 = mk(); m3.phantoms.push({ id: 'cinderling', location: 'cellar', t: 1 });
  run(m3, 2);
  assert.ok(Object.values(m3.snapshot().systems).some((s) => s.fault));
});

test('office phantom dismissed with camera down; ignored 3x -> jumpscare', () => {
  const m = mk(); m.phantoms.push({ id: 'marrowbird', location: 'office', t: 6 });
  m.update(0.1, { camera: true, dismiss: 'marrowbird' }); assert.equal(m.snapshot().phantoms.length, 1);
  m.update(0.1, {}); m.update(0.1, { dismiss: 'marrowbird' }); assert.equal(m.snapshot().phantoms.length, 0);
  const n = mk(); let sc = [];
  for (const id of ['cinderling', 'lanternhead', 'mothlady']) { n.phantoms.push({ id, location: 'office', t: 0.2 }); for (let i = 0; i < 5; i++) { n.update(0.1, {}); sc.push(...n.consumeEvents().filter((e) => e.type === 'jumpscare')); } }
  assert.equal(sc.length, 1); assert.equal(sc[0].reason, 'phantom'); assert.equal(n.dead, true);
});

test('6AM win once, hours emitted once, no events after death', () => {
  const m = mk({ secondsPerHour: 5 }); const ev = [];
  for (let i = 0; i < 400; i++) { m.update(0.1, {}); ev.push(...m.consumeEvents()); }
  assert.deepEqual(ev.filter((e) => e.type === 'hour').map((e) => e.hour), [1, 2, 3, 4, 5, 6]);
  assert.equal(ev.filter((e) => e.type === 'night-win').length, 1);
  const d = mk(); d.jumpscare('x', 'test'); d.jumpscare('x', 'test'); d.update(5, {});
  assert.equal(d.consumeEvents().filter((e) => e.type === 'jumpscare').length, 1);
});

test('hooks and night tables', () => {
  const m = new Fnaf3Mode({ night: 3 }); const b = m.level('stalker');
  m.setAiLevelMultiplier(2); assert.ok(m.level('stalker') > b); m.setAiLevel('stalker', 1); m.setAiLevelMultiplier(1); assert.equal(m.level('stalker'), 1);
  assert.ok(new Fnaf3Mode({ night: 5 }).level('stalker') > new Fnaf3Mode({ night: 1 }).level('stalker'));
  assert.ok(C3.REBOOT.vent > 0);
});
