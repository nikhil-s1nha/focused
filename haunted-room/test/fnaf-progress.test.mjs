import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public/fnaf/progress.mjs';
import { PHONE_SCRIPTS, PhoneCall, getPhoneScript, PHONE_MODES } from '../public/fnaf/phone.mjs';

test('fresh progress serializes and round-trips', () => {
  const p = P.createProgress();
  assert.deepEqual(P.deserializeProgress(P.serializeProgress(p)), p);
  assert.ok(P.validProgress(p));
});

test('corrupt or hostile saves fall back safely', () => {
  for (const bad of ['', 'nope', '{"version":9}', 'null', '[]', '{"version":1}']) assert.deepEqual(P.deserializeProgress(bad), P.createProgress());
  const dirty = { version: 1, modes: { fnaf4: { nightsWon: [1, 1, 99, 'x', 3], stars: 99, attempts: -1, bestCustom: { total: 1e9 } } }, settings: { difficulty: 'bogus', adaptive: { enabled: 'yes', multiplier: 50 } } };
  const s = P.sanitizeProgress(dirty);
  assert.deepEqual(s.modes.fnaf4.nightsWon, [1, 3]);
  assert.equal(s.modes.fnaf4.stars, 3); assert.equal(s.modes.fnaf4.attempts, 0); assert.equal(s.modes.fnaf4.bestCustom, null);
  assert.equal(s.settings.difficulty, 'normal'); assert.equal(s.settings.adaptive.enabled, false); assert.equal(s.settings.adaptive.multiplier, 2);
});

test('night unlock chain, per mode, and custom after night 6', () => {
  let p = P.createProgress();
  assert.deepEqual(P.availableNights(p, 'fnaf4'), [1]);
  p = P.recordWin(p, 'fnaf4', 1);
  assert.deepEqual(P.availableNights(p, 'fnaf4'), [1, 2]);
  assert.deepEqual(P.availableNights(p, 'fnaf1'), [1]);
  for (const n of [2, 3, 4, 5]) p = P.recordWin(p, 'fnaf4', n);
  assert.deepEqual(P.availableNights(p, 'fnaf4'), [1, 2, 3, 4, 5, 6]);
  p = P.recordWin(p, 'fnaf4', 6);
  assert.deepEqual(P.availableNights(p, 'fnaf4'), [1, 2, 3, 4, 5, 6, 'custom']);
  assert.equal(P.starsFor(p, 'fnaf4'), 2);
});

test('recordWin/recordLoss are immutable and stars/custom bests work', () => {
  const p = P.createProgress();
  const q = P.recordLoss(p, 'fnaf2', 'door-open');
  assert.equal(p.modes.fnaf2.losses, 0); assert.equal(q.modes.fnaf2.losses, 1); assert.equal(q.modes.fnaf2.lastLoss, 'door-open');
  const all20 = { hollowjaw: 20, gristle: 20, marrow: 20, sable: 20, small: 20 };
  const w = P.recordWin(q, 'fnaf4', 'custom', { custom: all20 });
  assert.equal(P.starsFor(w, 'fnaf4'), 3); assert.equal(w.modes.fnaf4.bestCustom.total, 100);
  assert.equal(P.totalStars(w), 3);
  assert.throws(() => P.recordWin(p, 'fnaf9', 1)); assert.throws(() => P.recordWin(p, 'fnaf1', 7));
});

test('custom config validation 0-20', () => {
  const ok = P.validateCustomConfig('fnaf4', { hollowjaw: 20, gristle: 0 });
  assert.ok(ok.ok); assert.equal(ok.config.sable, 0);
  for (const bad of [{ hollowjaw: 21 }, { hollowjaw: -1 }, { hollowjaw: 1.5 }, { hollowjaw: '3' }, { hollowjaw: NaN }, { nobody: 3 }]) {
    const r = P.validateCustomConfig('fnaf4', bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(r.errors.length);
  }
  assert.equal(P.validateCustomConfig('fnaf4', null).ok, false);
  assert.equal(P.validateCustomConfig('fnaf4', []).ok, false);
  assert.equal(P.validateCustomConfig('nope', {}).ok, false);
  assert.ok(P.validateCustomConfig('fnaf3', { whatever_one: 7 }).ok);
  assert.equal(P.validateCustomConfig('fnaf3', { 'Bad Id': 7 }).ok, false);
  assert.ok(P.validateCustomConfig('fnaf1', { bellwether: 20 }, { roster: null }).ok);
});

test('difficulty presets and reserved adaptive multiplier', () => {
  let p = P.createProgress();
  assert.equal(P.aiMultiplier(p.settings), 1);
  assert.equal(P.aiMultiplier(P.setDifficulty(p, 'easy').settings), 0.6);
  p = P.setDifficulty(p, 'nightmare');
  assert.equal(P.aiMultiplier(p.settings), 1.5);
  p = P.setAdaptive(p, { multiplier: 0.5 });
  assert.equal(P.aiMultiplier(p.settings), 1.5, 'ignored while disabled');
  p = P.setAdaptive(p, { enabled: true });
  assert.equal(P.aiMultiplier(p.settings), 0.75);
  assert.equal(P.setAdaptive(p, { multiplier: 99 }).settings.adaptive.multiplier, 2);
  assert.throws(() => P.setDifficulty(p, 'x'));
  assert.equal(P.aiMultiplier(undefined), 1);
});

test('endings', () => {
  assert.equal(P.describeEnding('night-complete', { night: 6 }).title, 'Night 6 Complete');
  const g = P.describeEnding('game-over', { reason: 'released-early', who: 'gristle' });
  assert.match(g.text, /door/); assert.equal(P.describeEnding('game-over', { reason: 'weird' }).text, P.GAME_OVER_REASONS.unknown);
  assert.equal(P.endingFromSnapshot({ running: true }), null);
  assert.equal(P.endingFromSnapshot({ won: true, mode: 'fnaf4', night: 2 }).kind, 'night-complete');
  assert.equal(P.endingFromSnapshot({ dead: true, deathReason: 'swarm', scare: 'nib', mode: 'fnaf4', night: 1 }).reason, 'swarm');
  assert.throws(() => P.describeEnding('x'));
});

test('endingFromSnapshot works on a real fnaf4 death', async () => {
  const { Fnaf4Mode } = await import('../public/fnaf/modes/fnaf4.mjs');
  const m = new Fnaf4Mode({ night: 'custom', rng: () => 0, ai: { hollowjaw: 20 } }); m.start();
  for (let i = 0; i < 600 && !m.dead; i++) m.update(0.1, { facing: 'bed' });
  const e = P.endingFromSnapshot(m.snapshot());
  assert.equal(e.reason, 'door-open'); assert.equal(e.who, 'hollowjaw');
});

test('phone scripts exist for nights 1-6 in all four modes with sane timings', () => {
  for (const mode of PHONE_MODES) for (let n = 1; n <= 6; n++) {
    const s = getPhoneScript(mode, n);
    assert.ok(s && s.lines.length >= 1, `${mode} night ${n}`);
    let prevEnd = 0;
    for (const l of s.lines) { assert.ok(l.text.length > 10); assert.ok(l.at >= prevEnd); assert.ok(l.dur > 0); prevEnd = l.at + l.dur; }
    assert.ok(s.duration > prevEnd);
  }
  assert.equal(getPhoneScript('fnaf4', 7), null); assert.equal(getPhoneScript('nope', 1), null);
  assert.ok(Object.isFrozen(PHONE_SCRIPTS));
});

test('PhoneCall plays lines in order and finishes', () => {
  const c = new PhoneCall({ mode: 'fnaf4', night: 1 });
  assert.ok(c.start());
  const lines = [];
  let end = null;
  for (let i = 0; i < 4000 && !c.snapshot().ended; i++) {
    c.update(0.05);
    for (const e of c.consumeEvents()) { if (e.type === 'phone-line') lines.push(e.index); if (e.type === 'phone-call-end') end = e; }
  }
  assert.deepEqual(lines, [0, 1, 2, 3, 4]);
  assert.equal(end.reason, 'finished'); assert.equal(end.interrupted, false);
});

test('subtitles follow active line and clear between lines', () => {
  const c = new PhoneCall({ mode: 'fnaf1', night: 1 }); c.start();
  c.update(0.5); assert.equal(c.snapshot().subtitle, null);
  c.update(0.5); assert.equal(c.snapshot().subtitle, PHONE_SCRIPTS.fnaf1[1][0].text);
  const l0 = PHONE_SCRIPTS.fnaf1[1][0];
  c.update(l0.dur + 0.1); assert.equal(c.snapshot().subtitle, null);
});

test('skip, interrupt, mute and a big dt do not break the player', () => {
  const a = new PhoneCall({ mode: 'fnaf2', night: 2, muted: true }); a.start(); a.update(1);
  const ev = a.consumeEvents(); assert.equal(ev.find((e) => e.type === 'phone-line').muted, true);
  assert.ok(a.skip()); assert.equal(a.skip(), false);
  const endEv = a.consumeEvents(); assert.ok(endEv.some((e) => e.type === 'phone-line-end' && e.cut));
  assert.equal(endEv.at(-1).reason, 'skipped'); assert.equal(a.snapshot().subtitle, null);
  const b = new PhoneCall({ mode: 'fnaf3', night: 3 }); b.start(); b.update(2);
  b.setMuted(true); assert.ok(b.interrupt());
  const e2 = b.consumeEvents().at(-1); assert.equal(e2.interrupted, true); assert.equal(e2.reason, 'interrupted');
  const c = new PhoneCall({ mode: 'fnaf4', night: 6 }); c.start(); c.update(10000);
  const e3 = c.consumeEvents();
  assert.equal(e3.filter((e) => e.type === 'phone-line').length, PHONE_SCRIPTS.fnaf4[6].length);
  assert.equal(e3.at(-1).reason, 'finished'); c.update(1); assert.deepEqual(c.consumeEvents(), []);
});

test('PhoneCall without a script is inert; cannot double start', () => {
  const n = new PhoneCall({ mode: 'fnaf4', night: 9 }); assert.equal(n.start(), false); n.update(1); assert.equal(n.snapshot().active, false);
  const c = new PhoneCall({ mode: 'fnaf4', night: 1 }); assert.ok(c.start()); assert.equal(c.start(), false);
});
