import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createVrStart} from '../public/simple/vr-start.mjs';
test('VR start requires an aimed ray and disappears while hidden',()=>{
 const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera();camera.position.set(0,1.6,0);scene.add(camera);
 const ui=createVrStart(THREE,scene), hand=new THREE.Group();hand.position.set(0,1.48,0);scene.add(hand);
 ui.show(camera);assert.equal(ui.hit(hand),true);
 hand.rotation.y=Math.PI/2;assert.equal(ui.hit(hand),false);
 hand.rotation.y=0;ui.hide();assert.equal(ui.hit(hand),false);
 ui.show(camera,true);assert.equal(ui.hit(hand),true);ui.dispose();assert.ok(!scene.children.includes(ui.mesh));
});
