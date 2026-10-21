import test from 'node:test';import assert from 'node:assert/strict';
import {Lives} from '../public/simple/lives.mjs';
test('five missed attacks exhaust lives, watched and duplicate attacks do not',()=>{
 const l=new Lives();assert.equal(l.remaining,5);
 assert.equal(l.attack('watched',true),false);assert.equal(l.remaining,5);
 for(let i=0;i<5;i++){assert.equal(l.attack(i,false),true);assert.equal(l.attack(i,false),false);}
 assert.equal(l.remaining,0);assert.equal(l.attack('extra',false),false);
 l.reset();assert.equal(l.remaining,5);assert.equal(l.attack(0,false),true);
});
