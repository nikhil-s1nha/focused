import {Director, validSignal} from './director.mjs';
const $ = id => document.getElementById(id);
let director = new Director(), latest = null, receivedAt = -Infinity, socketState = 'connecting';
let audio, oscillator, gain, panner, enabled = false;
function toggleSound() {
  if (!audio) {
    audio = new AudioContext(); oscillator = audio.createOscillator(); gain = audio.createGain(); panner = audio.createPanner();
    oscillator.frequency.value = 55; gain.gain.value = 0; panner.positionZ.value = -3;
    oscillator.connect(gain).connect(panner).connect(audio.destination); oscillator.start();
  }
  audio.resume(); enabled = !enabled;
  $('sound').textContent = enabled ? 'Mute sound' : 'Enable sound';
}
$('sound').onclick = toggleSound;
$('right-hand').addEventListener('triggerdown', toggleSound);
$('reset').onclick = () => { director = new Director(); };
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signals`);
  ws.onopen = () => { socketState = 'connected'; };
  ws.onmessage = event => {
    try { const value = JSON.parse(event.data); if (validSignal(value)) { latest = value; receivedAt = performance.now(); } } catch {}
  };
  ws.onclose = () => { socketState = 'disconnected'; setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
}
connect();
let previous = performance.now(), lastUi = 0;
function update(now) {
  const dt = (now - previous) / 1000; previous = now;
  const manual = $('mode').value === 'manual';
  const signal = manual ? {type:'signal',source:'manual',timestamp:Date.now()/1000,
    intensity:Number($('intensity').value),signal_quality:$('quality').checked ? 1 : 0} : latest;
  const result = director.update(signal, manual ? now : receivedAt, now, dt);
  const {tension, state, intensity} = result;
  const scene = document.querySelector('a-scene');
  if (scene.hasLoaded) {
    const flicker = tension > .45 ? Math.max(.3, 1 - tension * .5 * (1 + Math.sin(now * .013))) : 1;
    $('lamp').setAttribute('light', 'intensity', (.3 + (1 - tension) * .8) * flicker);
    scene.setAttribute('fog','density',.018 + tension * .07);
    $('shadow').setAttribute('visible',tension > .5);
    $('shadow').setAttribute('position',`${2 - tension} 0 ${-5 + tension * 2}`);
    if (audio) {
      const camera = scene.camera;
      camera.updateWorldMatrix(true, false);
      const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
      camera.getWorldPosition(position); camera.getWorldQuaternion(quaternion);
      const forward = new THREE.Vector3(0,0,-1).applyQuaternion(quaternion), up = new THREE.Vector3(0,1,0).applyQuaternion(quaternion);
      const listener = audio.listener;
      if (listener.positionX) {
        [listener.positionX.value,listener.positionY.value,listener.positionZ.value]=position.toArray();
        [listener.forwardX.value,listener.forwardY.value,listener.forwardZ.value]=forward.toArray();
        [listener.upX.value,listener.upY.value,listener.upZ.value]=up.toArray();
      }
      gain.gain.setTargetAtTime(enabled ? .015 + tension * .045 : 0,audio.currentTime,.1);
      oscillator.frequency.setTargetAtTime(45 + tension * 35,audio.currentTime,.2);
      panner.positionX.value = Math.sin(now / 1800) * 2;
    }
    if (now - lastUi > 150) {
      const calibration = signal?.calibrated === false ? ` | CALIBRATING ${Math.round((signal.baseline_progress || 0) * 100)}%` : '';
      const label = `${manual ? 'MANUAL DEMO' : latest?.source?.toUpperCase() || 'NO SIGNAL'} | ${state}${calibration}\nInput ${intensity.toFixed(2)} | tension ${tension.toFixed(2)}\nQuality ${signal?.signal_quality ?? 0} | relay ${socketState}`;
      $('status').innerText = label; $('hud').setAttribute('value',label); lastUi = now;
    }
  }
}
AFRAME.registerComponent('adaptive-director', {tick(time, delta) { update(performance.now()); }});
document.querySelector('a-scene').setAttribute('adaptive-director','');
