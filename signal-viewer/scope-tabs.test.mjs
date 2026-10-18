import test from 'node:test';
import assert from 'node:assert/strict';
import {readTabState,scopeTabTransition} from './scope-tabs.js';

test('Record is default and only tab preference plus remote edge flag are retained', () => {
  assert.deepEqual(readTabState(null),{tab:'record',lastRemoteActive:false});
  assert.deepEqual(readTabState('{broken'),{tab:'record',lastRemoteActive:false});
  assert.deepEqual(readTabState('{"tab":"live","lastRemoteActive":true,"token":"not-kept"}'),{tab:'live',lastRemoteActive:true});
});

test('remote Start switches to Live once; polling never steals a manual Record selection', () => {
  let state = readTabState(null);
  state = scopeTabTransition(state,{type:'remote',active:true,owned:true});
  assert.equal(state.tab,'live');
  state = scopeTabTransition(state,{type:'select',tab:'record'});
  state = scopeTabTransition(state,{type:'remote',active:true,owned:true});
  assert.equal(state.tab,'record');
  state = scopeTabTransition(state,{type:'remote',active:false,owned:false});
  state = scopeTabTransition(state,{type:'remote',active:true,owned:true});
  assert.equal(state.tab,'live');
});

test('auto refresh retains selected tab while remote session remains active', () => {
  const saved = JSON.stringify({tab:'record',lastRemoteActive:true});
  const restored = scopeTabTransition(readTabState(saved),{type:'remote',active:true,owned:true});
  assert.equal(restored.tab,'record');
});

test('ordinary local acquisition does not force Live or count as a remote edge', () => {
  const state = scopeTabTransition(readTabState(null),{type:'remote',active:true,owned:false});
  assert.deepEqual(state,{tab:'record',lastRemoteActive:false});
});
