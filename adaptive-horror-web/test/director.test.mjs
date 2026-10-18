import test from 'node:test';
import assert from 'node:assert/strict';
import {Director, validSignal} from '../public/director.mjs';
const sample = (intensity, quality = 1) => ({type:'signal',source:'synthetic',intensity,signal_quality:quality,timestamp:1});
function run(d, intensity, seconds, quality = 1) {
  let result;
  for (let i=0;i<seconds*10;i++) result=d.update(sample(intensity,quality),i*100,i*100,.1);
  return result;
}
test('rejects invalid and unlabelled data', () => {
  assert.ok(validSignal(sample(.5)));
  assert.ok(validSignal({...sample(.5),source:'internal_test'}));
  for (const s of [sample(NaN),sample(2),{...sample(.5),source:'fear'},sample(.5,-1)]) assert.ok(!validSignal(s));
});
test('brief spikes do not trigger relief; sustained high input does', () => {
  const d = new Director();
  assert.notEqual(run(d,1,1).state,'RELIEF');
  assert.equal(run(d,1,8).state,'RELIEF');
});
test('bad or stale signal eases off rather than escalating', () => {
  const d = new Director(); run(d,0,25);
  const previous = d.tension;
  assert.equal(run(d,0,2,0).state,'WAIT'); assert.ok(d.tension < previous);
  assert.equal(d.update(sample(0),0,5000,.1).state,'WAIT');
});
test('low input builds tension within cap; middle band holds', () => {
  const d = new Director(); assert.ok(run(d,0,50).tension <= .85);
  const stable = new Director(); const before=stable.tension;
  assert.equal(run(stable,.5,10).tension,before);
});
test('incomplete calibration cannot be interpreted as calm', () => {
  const d = new Director();
  let result;
  for (let i=0;i<300;i++) result=d.update({...sample(0),calibrated:false},i*100,i*100,.1);
  assert.equal(result.state,'WAIT'); assert.ok(result.tension <= .25);
});
