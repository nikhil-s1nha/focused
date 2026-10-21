import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveProfile, responseMetric, CONFIG, BEAT_GROUPS } from '../public/simple/calibration.mjs';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Simulate at 10 Hz. signal(t, lunges) -> {intensity, quality, fresh}.
// Lunge happens 1.7 s after each requested scare. Returns log of directives.
function run(profile, signal, seconds, { realScareEvery = 0 } = {}) {
  const lunges = [];
  const triggers = [];
  const queued = [];
  let nextReal = realScareEvery || Infinity;
  let last = null;
  for (let i = 0; i <= seconds * 10; i += 1) {
    const t = i / 10;
    while (queued.length && queued[0] <= t + 1e-9) {
      queued.shift();
      lunges.push(t);
      profile.scareLunge(t, 'left');
    }
    profile.sample(t, signal(t, lunges));
    last = profile.update(0.1, t);
    if (last.trigger) {
      triggers.push(t);
      queued.push(t + 1.7);
    }
    if (profile.phase === 'adapting' && t >= nextReal) {
      queued.push(t + 1.7);
      nextReal = t + realScareEvery;
    }
  }
  return { last, lunges, triggers };
}

const spike = (amp) => (t, lunges) => {
  let v = 0.5 + 0.01 * Math.sin(t * 7);
  for (const l of lunges) if (t >= l + 0.3 && t <= l + 1.5) v += amp;
  return { intensity: Math.min(1, v), quality: 0.9, fresh: true };
};
const flat = () => ({ intensity: 0.5, quality: 0.9, fresh: true });

test('a clear spike after the lunge gives high z and calibrates', () => {
  const p = new AdaptiveProfile({ rng: seeded(1) });
  p.start();
  const { last } = run(p, spike(0.3), 60);
  assert.equal(last.phase, 'adapting');
  const prof = p.profile();
  assert.ok(prof.reactivity > 5, `reactivity ${prof.reactivity}`);
  assert.equal(prof.neutral, false);
  assert.ok(prof.confidence > 0.6);
  assert.ok(Math.abs(prof.baseline.mean - 0.5) < 0.05);
});

test('flat signal gives low reactivity and adaptation pushes intensity up', () => {
  const p = new AdaptiveProfile({ rng: seeded(2) });
  p.start();
  run(p, flat, 45);
  assert.ok(p.profile().reactivity < 1);
  const { last } = run(p, flat, 0); // no-op; take directives now
  const d = p.update(0.1, 45.1);
  assert.ok(d.intensityScale > 1);
  assert.ok(d.gapScale < 1);
  assert.ok(d.beatWeights.fake > 1 && d.beatWeights.visual > 1);
  assert.ok(last === null || last);
});

test('real scares with weak responses keep nudging, within clamps', () => {
  const p = new AdaptiveProfile({ rng: seeded(3) });
  p.start();
  // spike during calibration only, then flat
  const sig = (t, lunges) => (lunges.length > 3 ? flat() : spike(0.3)(t, lunges));
  const { last } = run(p, sig, 160, { realScareEvery: 8 });
  const e = p.export();
  assert.ok(e.adaptation.scares >= 4);
  assert.ok(e.adaptation.drive > 0);
  assert.ok(last.intensityScale <= CONFIG.maxIntensityScale);
  assert.ok(e.decisions.some((x) => x.kind === 'adapt'));
});

test('strong responses soften: longer gaps, more sound/light, lower intensity', () => {
  const p = new AdaptiveProfile({ rng: seeded(4) });
  p.start();
  // modest calibration response, then huge responses
  const sig = (t, lunges) => (lunges.length > 3 ? spike(0.5)(t, lunges) : spike(0.06)(t, lunges));
  const { last } = run(p, sig, 160, { realScareEvery: 8 });
  assert.ok(last.gapScale > 1, `gap ${last.gapScale}`);
  assert.ok(last.intensityScale < 1);
  assert.ok(last.beatWeights.sound > last.beatWeights.fake);
});

test('noisy low-quality signal triggers neutral fallback without throwing', () => {
  const p = new AdaptiveProfile({ rng: seeded(5) });
  p.start();
  const rng = seeded(99);
  const bad = () => ({ intensity: rng(), quality: 0.2, fresh: true });
  const { last } = run(p, bad, 50);
  assert.equal(last.phase, 'adapting');
  assert.equal(p.profile().neutral, true);
  assert.ok(last.notes.some((n) => /neutral defaults/.test(n)));
  assert.equal(last.intensityScale, 1);
  assert.equal(last.gapScale, 1);
});

test('stale samples are discarded too', () => {
  const p = new AdaptiveProfile({ rng: seeded(6) });
  p.start();
  const { last } = run(p, (t, l) => ({ ...spike(0.3)(t, l), fresh: false }), 50);
  assert.equal(p.profile().neutral, true);
  assert.equal(last.phase, 'adapting');
});

test('habituation across decreasing responses is detected', () => {
  const p = new AdaptiveProfile({ rng: seeded(7) });
  p.start();
  const sig = (t, lunges) => {
    const amps = [0.4, 0.2, 0.08];
    let v = 0.5 + 0.01 * Math.sin(t * 7);
    lunges.forEach((l, i) => {
      if (t >= l + 0.3 && t <= l + 1.5) v += amps[i] ?? 0;
    });
    return { intensity: v, quality: 0.9, fresh: true };
  };
  run(p, sig, 50);
  const prof = p.profile();
  assert.ok(prof.habituation < -0.5, `habituation ${prof.habituation}`);
  const d = p.update(0.1, 51);
  assert.ok(d.beatWeights.visual > 1 && d.beatWeights.fake > 1);
  assert.ok(d.notes.some((n) => /variety/.test(n)));
});

test('responseMetric direction option works', () => {
  const pre = [0.5, 0.52, 0.48, 0.5, 0.51, 0.49];
  const up = [0.5, 0.8, 0.6];
  const down = [0.5, 0.2, 0.4];
  assert.ok(responseMetric({ pre, post: up, direction: 'up' }) > 5);
  assert.equal(responseMetric({ pre, post: down, direction: 'up' }), 0);
  assert.ok(responseMetric({ pre, post: down, direction: 'down' }) > 5);
  assert.equal(responseMetric({ pre, post: up, direction: 'down' }), 0);
  assert.ok(responseMetric({ pre, post: down }) > 5);
  assert.ok(responseMetric({ pre, post: up }) > 5);
  assert.equal(responseMetric({ pre: [], post: up }), 0);
  assert.equal(responseMetric({ pre, post: [NaN] }), 0);
  assert.equal(responseMetric(), 0);
});

test('adversarial input never yields NaN or out-of-range outputs', () => {
  const p = new AdaptiveProfile({ rng: seeded(8) });
  p.start();
  const junk = [NaN, Infinity, -Infinity, 1e9, -1e9, undefined, null, 0.5];
  const check = (d) => {
    assert.ok(d.effectiveTension >= 0 && d.effectiveTension <= 1);
    assert.ok(d.gapScale >= 0.6 && d.gapScale <= 1.6);
    assert.ok(d.intensityScale >= 0.7 && d.intensityScale <= 1.3);
    for (const g of BEAT_GROUPS) {
      assert.ok(d.beatWeights[g] >= 0.5 && d.beatWeights[g] <= 2);
    }
  };
  let queued = [];
  for (let i = 0; i < 1500; i += 1) {
    const t = i / 10;
    p.sample(t, { intensity: junk[i % junk.length], quality: junk[(i * 3) % junk.length], fresh: i % 5 !== 0 });
    p.sample(NaN, { intensity: 1 });
    const d = p.update(0.1, t, { tension: junk[i % junk.length] });
    check(d);
    if (d.trigger) queued.push(t + 1.7);
    if (queued[0] <= t) {
      queued.shift();
      p.scareLunge(t);
      p.scareLunge(NaN);
    }
    if (i % 40 === 0 && p.phase === 'adapting') p.scareLunge(t);
  }
  const e = JSON.stringify(p.export());
  assert.ok(!/NaN|Infinity/.test(e));
});

test('calibration scheduling: first at firstScareAt, spacing, exact count', () => {
  const p = new AdaptiveProfile({ rng: seeded(9) });
  p.start();
  const { triggers } = run(p, spike(0.3), 80);
  assert.equal(triggers.length, CONFIG.calibrationScares);
  assert.ok(Math.abs(triggers[0] - CONFIG.firstScareAt) < 0.11);
  assert.ok(Math.abs(triggers[1] - triggers[0] - CONFIG.calibrationGap) < 0.11);
  assert.ok(Math.abs(triggers[2] - triggers[1] - CONFIG.calibrationGap) < 0.11);
  // during calibration everything else is suppressed
  const q = new AdaptiveProfile({ rng: seeded(9) });
  q.start();
  q.sample(0, flat());
  const d = q.update(0.1, 0);
  assert.equal(d.phase, 'calibrating');
  assert.equal(d.suppressOthers, true);
  assert.equal(d.trigger, null);
});

test('calibration waits for a missing lunge and then times out', () => {
  const p = new AdaptiveProfile({ rng: seeded(10) });
  p.start();
  let n = 0;
  for (let i = 0; i < 600; i += 1) {
    const t = i / 10;
    p.sample(t, flat());
    if (p.update(0.1, t).trigger) n += 1; // lunges are never reported
  }
  assert.equal(n, 3);
  assert.equal(p.profile().neutral, true);
});

test('determinism with a seeded rng', () => {
  const go = () => {
    const p = new AdaptiveProfile({ rng: seeded(42), config: { calibrationJitter: 2 } });
    p.start();
    const r = run(p, spike(0.2), 80, { realScareEvery: 9 });
    return JSON.stringify({ t: r.triggers, e: p.export(), d: r.last });
  };
  assert.equal(go(), go());
});

test('reset returns to idle and clears state', () => {
  const p = new AdaptiveProfile({ rng: seeded(11) });
  p.start();
  run(p, spike(0.3), 50);
  assert.equal(p.phase, 'adapting');
  p.reset();
  assert.equal(p.phase, 'idle');
  assert.equal(p.profile(), null);
  const d = p.update(0.1, 100);
  assert.equal(d.trigger, null);
  p.start();
  const { triggers } = run(p, spike(0.3), 30);
  assert.ok(triggers.length >= 1);
});

test('export has derived values only, no raw sample arrays', () => {
  const p = new AdaptiveProfile({ rng: seeded(12) });
  p.start();
  run(p, spike(0.3), 100, { realScareEvery: 8 });
  const e = p.export();
  const json = JSON.stringify(e);
  assert.ok(!('samples' in e));
  assert.ok(e.calibration.length === 3);
  assert.ok(json.length < 4000, `export size ${json.length}`);
  for (const key of Object.keys(e)) assert.ok(!/raw|samples/i.test(key));
  assert.equal(e.phase, 'adapting');
  assert.ok(typeof e.baseline.mean === 'number');
  assert.match(e.disclaimer, /not fear or emotion/);
});

test('minGap directive enforces the scare-rate cap', () => {
  const p = new AdaptiveProfile({ rng: seeded(13) });
  p.start();
  const d = p.update(0.1, 0);
  assert.ok(d.minGap >= 3.5);
});
