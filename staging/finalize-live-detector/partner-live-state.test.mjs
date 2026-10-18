import test from 'node:test';
import assert from 'node:assert/strict';
import {liveView, connectionPayload, startPayload, forwardingMessage, remoteControlView, automaticCapabilityLabel} from './partner-live-state.js';

test('Start stays available for local monitoring when receiver protocol blocks forwarding', () => {
  const view = liveView({active:false,forwarding:{allowed:false,reason:'Receiver does not support v2'}});
  assert.equal(view.startDisabled,false);
  assert.equal(view.forwardingAllowed,false);
  assert.match(view.blockedReason,/v2/);
});

test('disabled live service cannot be started even when its state route responds', () => {
  const view = liveView({enabled:false,active:false,error:'Live detection is not enabled'});
  assert.equal(view.startDisabled,true);
  assert.equal(view.stopDisabled,true);
  assert.match(view.error,/not enabled/);
});

test('Stop to stopped transition enables Start again, including prior errors', () => {
  assert.equal(liveView({active:true,stopping:true}).startDisabled,true);
  const stopped = liveView({active:false,stopping:false,error:'Previous request failed'});
  assert.equal(stopped.startDisabled,false);
  assert.equal(stopped.stopDisabled,true);
});

test('busy serializes actions and timeout recovery restores buttons', () => {
  assert.equal(liveView({active:false},{busy:true}).startDisabled,true);
  assert.equal(liveView({active:true},{busy:true}).stopDisabled,true);
  assert.equal(liveView({active:true},{busy:false,error:'Timeout'}).stopDisabled,false);
});

test('a pending backend start blocks duplicate starts and allows cancellation', () => {
  const view = liveView({active:false,phase:'starting'});
  assert.equal(view.startDisabled,true);
  assert.equal(view.stopDisabled,false);
  assert.equal(view.settingsDisabled,true);
});

test('lost state service disables Start but keeps Stop for a last-known active session', () => {
  assert.equal(liveView(null,{available:false}).startDisabled,true);
  const active = liveView({active:true},{available:false});
  assert.equal(active.stopDisabled,false);
  assert.equal(active.status,'Service unavailable');
});

test('unavailable score is not displayed as zero and states stay distinct', () => {
  const view = liveView({active:true,acquisition:{state:'stale'},detector:{state:'cooldown',score:null,cooldown_remaining:3}});
  assert.equal(view.score,null);
  assert.equal(view.acquisition,'stale');
  assert.equal(view.detector,'cooldown');
  assert.equal(view.cooldown,3);
});

test('blank connection token preserves in-memory authentication', () => {
  assert.deepEqual(connectionPayload(' http://127.0.0.1:48080 ','  '),{target:'http://127.0.0.1:48080'});
  assert.deepEqual(connectionPayload('http://127.0.0.1:48080','example-test-credential-long'),{target:'http://127.0.0.1:48080',token:'example-test-credential-long'});
});

test('Start distinguishes monitoring from saved recording and validates strength', () => {
  assert.deepEqual(startPayload('1',false),{nonhuman_surface_only:true,record_to_disk:false,value:1});
  assert.equal(startPayload('.4',true).record_to_disk,true);
  for (const value of [-1,1.1,NaN,Infinity,'',null]) assert.throws(() => startPayload(value,false));
});

test('normal stopped state is idle rather than a misleading protocol failure', () => {
  const view = liveView({active:false,forwarding:{allowed:false,reason:'Stopped.'}});
  assert.equal(forwardingMessage(view),'Live detection stopped. No automatic events sent.');
  const blocked = liveView({active:true,forwarding:{allowed:false,reason:'Receiver lacks v2.'}});
  assert.match(forwardingMessage(blocked),/blocked: Receiver lacks v2\. Local/);
  assert.equal(forwardingMessage(blocked).includes('..'),false);
});

test('remote controls remain unavailable on an older sender without breaking manual controls', () => {
  const view = remoteControlView({configured:true});
  assert.equal(view.disabled,true);
  assert.equal(view.supported,false);
  assert.equal(view.enabled,false);
});

test('remote enablement reflects server state, connection loss is visible, and busy blocks repeated changes', () => {
  const sender = {configured:true,remote_control:{enabled:true,connected:false,state:'reconnecting',owned:true,last_command:{id:'command-1',action:'start'},last_ack:{command_id:'command-1',status:'accepted'}}};
  const view = remoteControlView(sender);
  assert.equal(view.enabled,true);
  assert.equal(view.disabled,false);
  assert.equal(view.status,'Waiting for game controls');
  assert.equal(view.command,'start');
  assert.equal(view.ack,'accepted');
  assert.equal(view.owned,true);
  assert.equal(remoteControlView(sender,{busy:true}).disabled,true);
  sender.remote_control.connected = true;
  assert.equal(remoteControlView(sender).status,'Game controls connected');
});

test('automatic receiver capability is distinct from remote game controls enabled state', () => {
  const sender = {automatic:{capable:true},remote_control:{enabled:false}};
  assert.equal(automaticCapabilityLabel(sender),'Automatic events: ready');
  assert.equal(remoteControlView(sender).status,'Game controls off');
});
