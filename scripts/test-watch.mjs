import assert from 'node:assert/strict';
import {watchCommand} from '../dist/watch-tools.js';
assert.equal(watchCommand({action:'add',address:0x10000,size:2,access:'write',value:0x1100,mask:0xff00,change_only:true}), 'watch add 10000 2 2 6 1 1100 ff00 1 0');
for(const args of [
 {address:1,size:2,access:'write'}, {address:0,size:3,access:'write'},
 {address:0,size:1,access:'write',value:256}, {address:0,size:1,access:'read',change_only:true},
 {address:0,size:1,access:'write',sources:['__proto__']}, {address:0,size:1,access:'write',log_only:'false'},
 {address:0,size:1,access:'write',mask:1}
]) assert.throws(()=>watchCommand({action:'add',...args}));
console.log('Watchpoint validation and CPU data-source selection passed');
