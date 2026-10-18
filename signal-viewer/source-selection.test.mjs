// Exercise the actual registered source-form/calibration handlers with inert DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./app.js',import.meta.url),'utf8');
const nodes=new Map();
function node(id){if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,checked:false,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},close(){this.closed=true;}});return nodes.get(id);}
const requests=[];let active=false,clears=0,ingests=0;
const elements=new Proxy({}, {get(_target,id){return node(id);}});
const context=vm.createContext({$:node,elements,isBenchView:()=>active,setBenchView:value=>{active=value;},toast(){},clearView(){clears++;},ingestState(){ingests++;},api:async(path,body)=>{requests.push({path,body});return {};}});
const updateForm=source.slice(source.indexOf('function updateSourceForm()'),source.indexOf("$('source-open').addEventListener"));
const sourceForm=source.slice(source.indexOf("$('source-form').addEventListener"),source.indexOf("elements['pause-button'].addEventListener"));
vm.runInContext(updateForm+sourceForm,context);
node('source-select').value='raw_diagnostic';
vm.runInContext('updateSourceForm()',context);
assert.equal(node('calibrate-button').disabled,true);
await node('source-form').listeners.submit({preventDefault(){}});
assert.equal(active,true);
assert.equal(node('source-dialog').closed,true);
assert.equal(requests.length,0);assert.equal(clears,0);assert.equal(ingests,0);
await node('calibrate-button').listeners.click();
assert.equal(requests.length,0);
node('source-select').value='synthetic';
vm.runInContext('updateSourceForm()',context);
assert.equal(node('calibrate-button').disabled,true); // Still viewing raw until Apply.
await node('calibrate-button').listeners.click();
assert.equal(requests.length,0);
active=false;
vm.runInContext('updateSourceForm()',context);
assert.equal(node('calibrate-button').disabled,false);
await node('calibrate-button').listeners.click();
assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/calibrate');
console.log('PASS: diagnostic source selection does not POST, reset view data, or calibrate; normal calibration still works.');
