import assert from 'node:assert/strict';
import {buildSequence, inputEvent, handleInputTool} from '../dist/input-tools.js';
assert.deepEqual(inputEvent({action:'mouse',axis:'y',delta:-127}),[1,0,1,0xffffff81]);
assert.deepEqual(buildSequence('winuae_key_tap',{codes:[0x60,0x20]}),[
 [0,0,0,0x60,1],[0,0,0,0x20,1],[3,0,0,0x20,0],[0,0,0,0x60,0],[3,3,0,0,0]
]);
const text=buildSequence('winuae_type_text',{layout:'us',text:'A\n'});
assert.equal(text[1][3],0x20);assert.equal(text[5][3],0x44);
for (const args of [{layout:'us',text:'ok😀'},{layout:'de',text:'abc'},{layout:'us',text:'a'.repeat(61)}])
 assert.throws(()=>buildSequence('winuae_type_text',args));
assert.throws(()=>buildSequence('winuae_input_sequence',{steps:[{action:'wait',after_frames:3600},{action:'wait',after_frames:1}]}));
assert.throws(()=>buildSequence('winuae_key_tap',{codes:[1,1]}));
let commands=[];
const gdb={connected:true,sendMonitorCommand:async(cmd,live)=>{assert(live);commands.push(cmd);return cmd==='capabilities'?JSON.stringify({protocol:1,commands:['input','input-sequence']}):'{}';},continue:async()=>commands.push('continue')};
await assert.rejects(handleInputTool('winuae_type_text',{layout:'us',text:'ok😀'},gdb));
assert.deepEqual(commands,[]);
await handleInputTool('winuae_key_tap',{codes:[0x44],resume:true},gdb);
assert.deepEqual(commands,['capabilities','input sequence 0 0 0 44 1;3 0 0 44 0;3 3 0 0 0','continue']);
console.log('Input validation, layout, timing and atomic submission tests passed');
