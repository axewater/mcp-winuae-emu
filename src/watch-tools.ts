import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GdbProtocol } from './gdb-protocol.js';
import { integer } from './debug-validation.js';
import { requireCommand } from './target-info.js';
const sources: Record<string, number> = { cpu:6, blitter:0x1f8, copper:0x200, disk:0x400, audio:0x7800, bitplane:0x7f8000, sprite:0x7f800000 };
export const watchTools: Tool[] = [
  { name: 'winuae_watch', description: 'Manage remote-owned exact-access watchpoints using existing WinUAE memwatch. Match aligned address and width (1/2/4 bytes), optional value/mask and RAM write changes. A 68000 long write may be two word accesses. CPU and DMA sources can be selected. log_only captures without stopping into a 64-event ring; dropped counts expose eviction. last/events also include standard remote CPU/DMA hits. Commands pause execution; remove accepts only extended remote IDs.', inputSchema: { type: 'object', properties: {
    action: { type:'string', enum:['add','remove','list','last','events','clear-events'] },
    id: { type:'integer', minimum:0, maximum:19 }, address:{type:['integer','string']},
    size: {type:'integer',enum:[1,2,4]}, access:{type:'string',enum:['read','write','access']},
    sources:{type:'array',minItems:1,maxItems:7,items:{type:'string',enum:Object.keys(sources)}},
    value:{type:['integer','string']}, mask:{type:['integer','string']},
    change_only:{type:'boolean',default:false}, log_only:{type:'boolean',default:false}
  },required:['action'] } }
];
export function watchCommand(args: Record<string,unknown>): string {
  if (['list','last','events','clear-events'].includes(args.action as string)) return `watch ${args.action}`;
  if (args.action === 'remove') return `watch remove ${integer(args.id,'id',19).toString(16)}`;
  if (args.action !== 'add') throw new Error('Invalid watch action');
  const address=integer(args.address,'address',0x7ffeffff), size=integer(args.size,'size',4,1);
  const access={read:1,write:2,access:3}[args.access as string];
  if (![1,2,4].includes(size) || address % size || address+size>0x7fff0000 || !access) throw new Error('Supply aligned address, size 1/2/4 and access');
  const names=args.sources ?? ['cpu'];
  if (!Array.isArray(names) || !names.length || names.length>7 || names.some(n=>typeof n!=='string'||!Object.hasOwn(sources,n))) throw new Error('Invalid source groups');
  let source=0;for (const name of names) source|=sources[name];
  for (const key of ['change_only','log_only']) if (args[key]!==undefined && typeof args[key]!=='boolean') throw new Error(`${key} must be boolean`);
  if (args.change_only && access!==2) throw new Error('change_only requires write access to RAM');
  const max=size===4?0xffffffff:2**(size*8)-1;
  if (args.mask!==undefined && args.value===undefined) throw new Error('mask requires value');
  return 'watch add '+[address,size,access,source,args.value===undefined?0:1,integer(args.value??0,'value',max),
    integer(args.mask??max,'mask',max),args.change_only?1:0,args.log_only?1:0].map(n=>n.toString(16)).join(' ');
}
export async function handleWatchTool(args: Record<string,unknown>, gdb?: GdbProtocol): Promise<CallToolResult> {
  const command=watchCommand(args);
  if (!gdb?.connected) throw new Error('Not connected to WinUAE');
  await requireCommand(gdb,'watch');
  const reply=await gdb.sendMonitorCommand(command);
  return {content:[{type:'text',text:reply==='OK'?JSON.stringify({removed:args.id}):reply}]};
}
