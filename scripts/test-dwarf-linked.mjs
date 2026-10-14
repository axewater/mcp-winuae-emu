import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parseSymbols} from '../dist/symbols.js';
import {dwarfTool} from '../dist/dwarf.js';
const file=process.argv[2];assert(file,'Supply the linked m68k ELF fixture built with --emit-relocs');
const bytes=fs.readFileSync(file), parsed=parseSymbols(bytes);
const shoff=bytes.readUInt32BE(32), shsize=bytes.readUInt16BE(46), shnum=bytes.readUInt16BE(48);
assert(Array.from({length:shnum},(_,i)=>bytes.readUInt32BE(shoff+i*shsize+4)).some(t=>t===4||t===9),'Fixture must retain relocation sections');
const text=parsed.sections.find(s=>s.name==='.text');assert(text);
const registers={PC:bytes.readUInt32BE(24)-text.address+0x40000,SR:0x2700};
for(let i=0;i<8;i++){registers['D'+i]=0;registers['A'+i]=0;}
const gdb={readRegisters:async()=>({...registers}),sendMonitorCommand:async cmd=>{
 assert.equal(cmd,'capabilities');return JSON.stringify({protocol:1,commands:[],mmu_model:0});
}};
const source=await dwarfTool(gdb,'source',{file,mappings:[{section:'.text',address:0x40000,size:text.size}]});
assert.equal(source.linked_address,bytes.readUInt32BE(24));assert(source.functions.includes('_start'));
assert(source.locations.some(location=>location.line>0));
console.log('Linked ELF with retained relocations resolves runtime source correctly');
