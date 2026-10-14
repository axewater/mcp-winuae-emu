import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GdbProtocol } from './gdb-protocol.js';
import { dwarfTool } from './dwarf.js';
import { capabilities, requireCommand } from './target-info.js';
import { listSymbols, readSymbol } from './symbols.js';
import { parseHunk, loadHunks } from './amiga-hunk.js';
import { boundedFile, integer } from './debug-validation.js';
import { readBitmap } from './bitmap.js';
import { searchMemory } from './memory-search.js';
import { captureSnapshot, postmortem } from './diagnostics.js';

const conditionRegisters = [...Array.from({length:8}, (_,i)=>`D${i}`), ...Array.from({length:8}, (_,i)=>`A${i}`), 'PC', 'USP', 'MSP', 'ISP', 'VBR', 'SR'];
const conditionOperators = ['eq', 'ne', 'le', 'ge', 'lt', 'gt'];
const dwarfProperties = {
  file: { type: 'string', description: 'Linked ELF32 m68k executable with DWARF; must match the guest program' },
  context: { type: 'string', enum: ['current', 'fault'], default: 'current' }, process: { type: ['string','integer'] },
  mappings: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'object', properties: {
    section: { type: ['string','integer'] }, segment: { type: 'integer', minimum: 0, maximum: 255 },
    address: { type: ['string','integer'] }, size: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }
  }, required: ['section'] }, description: 'Explicit section-to-segment mapping, or section address and size' }
};
export const debugTools: Tool[] = [
  { name: 'winuae_source', description: 'Resolve a runtime PC to source file/line and function using linked m68k DWARF and explicit runtime section mappings. Requires Python with pyelftools==0.32. Leaves execution paused.', inputSchema: { type: 'object', properties: { ...dwarfProperties, address: { type: ['string','integer'] } }, required: ['file','mappings'] } },
  { name: 'winuae_variable', description: 'Read a typed DWARF variable in the current or matching fault scope. Supports .member, ->member and bounded [index] selectors. Uses declared member offsets and element sizes. Unsupported locations, optimized-out variables and ambiguous names are errors; guest code is never executed. Requires Python with pyelftools==0.32 and MMU disabled.', inputSchema: { type: 'object', properties: { ...dwarfProperties, expression: { type: 'string', maxLength: 256 } }, required: ['file','mappings','expression'] } },
  { name: 'winuae_backtrace', description: 'Unwind up to 64 frames using m68k DWARF call-frame information and symbolize source locations. Stops explicitly on missing or unsupported unwind information; does not guess returns from stack contents. Requires Python with pyelftools==0.32 and MMU disabled.', inputSchema: { type: 'object', properties: { ...dwarfProperties, max_frames: { type: 'integer', minimum: 1, maximum: 64, default: 32 } }, required: ['file','mappings'] } },
  { name: 'winuae_tasks', description: 'Read bounded Exec current, ready and waiting task lists, names, saved stack pointers and stack bounds. Does not claim a suspended task has the current CPU registers.', inputSchema: { type: 'object', properties: {} } },
  { name: 'winuae_history', description: 'Read the existing debugger PC history, or enable/disable instruction recording for remote execution. Recording is opt-in and slows execution. Entries are chronological and adjacent identical PCs may be coalesced by the debugger.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['read','on','off'], default: 'read' }, count: { type: 'integer', minimum: 1, maximum: 128, default: 32 } } } },
  { name: 'winuae_step_over', description: 'Resume until the next sequential instruction address, using the existing debugger step-over machinery. Returns immediately; use wait_stop or pause. Branches that never reach that address require interruption.', inputSchema: { type: 'object', properties: {} } },
  { name: 'winuae_conditional_breakpoint', description: 'Manage remote-owned register conditions in the existing debugger breakpoint table. Conditions are checked on instruction boundaries, with optional signed comparison and mask. Use the ordinary breakpoint tool for PC addresses.', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['add','remove','list'] }, id: { type: 'integer', minimum: 0 },
    register: { type: 'string', enum: conditionRegisters.filter(r=>r!=='PC') }, operator: { type: 'string', enum: conditionOperators },
    value: { type: ['integer','string'] }, mask: { type: ['integer','string'], default: '0xffffffff' }, signed: { type: 'boolean', default: false }
  }, required: ['action'] } },
  { name: 'winuae_capabilities', description: 'Discover target commands, CPU/MMU models, execution controls and address semantics. Queries the current configuration; leaves execution paused.', inputSchema: { type: 'object', properties: {} } },
  { name: 'winuae_memory_map', description: 'Report the existing debugger memory map with RAM/ROM/I/O and chip-memory classification. A truncated map is explicitly marked. Map membership does not reserve guest memory.', inputSchema: { type: 'object', properties: {} } },
  { name: 'winuae_symbols', description: 'List bounded Hunk or ELF32 big-endian m68k symbols and section metadata from a host file. Includes a file hash; does not infer runtime relocation or C types.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, prefix: { type: 'string', maxLength: 1024 }, limit: { type: 'integer', minimum: 1, maximum: 1024 } }, required: ['file'] } },
  { name: 'winuae_symbol_read', description: 'Read an exact symbol using loaded DOS segments or explicit section mappings. Hunk indices map to segment indices; ELF requires explicit mappings. Format and offsets are caller-supplied, not DWARF-inferred. Bytes require length; scalars use count. Leaves execution paused.',
    inputSchema: { type: 'object', properties: {
      file: { type: 'string' }, symbol: { type: 'string', maxLength: 1024 }, section: { type: 'integer', description: 'Disambiguate duplicate names by section index' },
      process: { type: ['string', 'integer'] }, offset: { type: 'integer', minimum: 0 },
      format: { type: 'string', enum: ['bytes', 'u8', 's8', 'u16', 's16', 'u32', 's32'], default: 'bytes' },
      length: { type: 'integer', minimum: 1, maximum: 4096 }, count: { type: 'integer', minimum: 1, maximum: 256 },
      mappings: { type: 'array', maxItems: 256, items: { type: 'object', properties: {
        section: { type: ['integer', 'string'] }, segment: { type: 'integer', minimum: 0, maximum: 255 },
        address: { type: ['integer', 'string'] }, size: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }
      }, required: ['section'] }, description: 'Map section index/name to a loaded segment index plus optional offset, or explicit address and size' }
    }, required: ['file', 'symbol'] } },
  { name: 'winuae_hunk_inspect', description: 'Validate a Hunk executable and list its segments, memory requirements and first 1024 symbols. Does not load or execute the program. Rejects unsupported records and oversized allocations.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
  { name: 'winuae_hunk_load', description: 'Relocate CODE/DATA/BSS hunks into explicitly reserved guest RAM. Supply one placement per hunk with address, capacity and chip/fast memory kind. Initializes BSS and padding, verifies writes and attempts rollback on failure. Does not allocate AmigaDOS memory, create a process, set PC or run it. Caller must own the RAM and identify its kind correctly.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, placements: { type: 'array', minItems: 1, maxItems: 256, items: {
      type: 'object', properties: { address: { type: ['string', 'integer'] }, capacity: { type: 'integer', minimum: 0 }, memory: { type: 'string', enum: ['chip', 'fast'] } }, required: ['address', 'capacity', 'memory']
    } } }, required: ['file', 'placements'] } },
  { name: 'winuae_bitmap', description: 'Decode an indexed planar bitmap to a PNG image. Supply explicit plane addresses (least significant first), row stride and RGB palette. Supports separate or interleaved planes; HAM, EHB and display-mode inference are not supported. Maximum 262144 pixels and 2 MiB read. Leaves execution paused.',
    inputSchema: { type: 'object', properties: {
      width: { type: 'integer', minimum: 1, maximum: 2048 }, height: { type: 'integer', minimum: 1, maximum: 2048 },
      planes: { type: 'array', minItems: 1, maxItems: 8, items: { type: ['integer', 'string'] } },
      row_stride: { type: 'integer', minimum: 1, maximum: 65536, description: 'Bytes between rows of the same plane; defaults to word-aligned row width' },
      palette: { type: 'array', minItems: 2, maxItems: 256, items: { type: ['integer', 'string'] }, description: 'Exactly 2^planes RGB values, e.g. 0xff8800' }
    }, required: ['width', 'height', 'planes', 'palette'] } },
  { name: 'winuae_memory_search', description: 'Search an explicit memory range for exact hex bytes, including overlapping and chunk-boundary matches. Maximum 16 MiB scanned and 4096 results. Leaves the CPU paused. Alignment is relative to absolute addresses; next_address permits continuation after reaching the result limit.',
    inputSchema: { type: 'object', properties: {
      address: { type: ['string', 'integer'] }, length: { type: 'integer', minimum: 1, maximum: 16777216 },
      hex: { type: 'string', description: 'Even-length hexadecimal bytes, at most 4096 bytes' },
      max_matches: { type: 'integer', minimum: 1, maximum: 4096, default: 256 },
      alignment: { type: 'integer', minimum: 1, maximum: 4096, default: 1 }
    }, required: ['address', 'length', 'hex'] } },
  { name: 'winuae_snapshot', description: 'Capture registers, stop reason and up to 256 KiB of explicit memory ranges while stopped. Leaves execution paused. Returns the complete snapshot.',
    inputSchema: { type: 'object', properties: { ranges: { type: 'array', maxItems: 16, items: {
      type: 'object', properties: { address: { type: ['string', 'integer'] }, length: { type: 'integer', minimum: 1, maximum: 262144 } }, required: ['address', 'length']
    } } } } },
  { name: 'winuae_postmortem', description: 'Capture a bounded crash report: fault-time and current registers, instruction disassembly, stack bytes, loaded segments and guest output. Uses fault context only when it matches the current exception stop. Leaves execution paused; optional unavailable data is reported explicitly. Supply an ELF file and mappings to include a DWARF backtrace.',
    inputSchema: { type: 'object', properties: { ...dwarfProperties, max_frames: { type: 'integer', minimum: 1, maximum: 64, default: 32 } } } },
];
export async function handleDebugTool(name: string, args: Record<string, unknown>, gdb?: GdbProtocol): Promise<CallToolResult> {
  const target = () => {
    if (!gdb?.connected) throw new Error('Not connected to WinUAE');
    return gdb;
  };
  let result: unknown;
  switch (name) {
    case 'winuae_source': result = await dwarfTool(target(), 'source', args); break;
    case 'winuae_variable': result = await dwarfTool(target(), 'variable', args); break;
    case 'winuae_backtrace': result = await dwarfTool(target(), 'backtrace', args); break;
    case 'winuae_tasks': await requireCommand(target(), 'tasks'); result = JSON.parse(await target().sendMonitorCommand('tasks')); break;
    case 'winuae_history': {
      const action = args.action ?? 'read', count = integer(args.count ?? 32, 'count', 128, 1);
      if (!['read','on','off'].includes(action as string)) throw new Error('Unknown history action');
      await requireCommand(target(), 'history');
      if (action !== 'read') await target().sendMonitorCommand(`history ${action}`);
      result = JSON.parse(await target().sendMonitorCommand(`history read ${count.toString(16)}`)); break;
    }
    case 'winuae_step_over': await requireCommand(target(), 'step-over'); await target().stepOver(); result = { running: target().isRunning }; break;
    case 'winuae_conditional_breakpoint': {
      let command = 'condition list';
      if (args.action === 'add') {
        const reg = conditionRegisters.indexOf(args.register as string), op = conditionOperators.indexOf(args.operator as string);
        if (reg < 0 || reg === 16 || op < 0 || (args.signed !== undefined && typeof args.signed !== 'boolean')) throw new Error('Invalid register condition');
        command = `condition add ${[reg,op,integer(args.value,'value'),integer(args.mask ?? 0xffffffff,'mask'),args.signed ? 1 : 0].map(n=>n.toString(16)).join(' ')}`;
      } else if (args.action === 'remove') command = `condition remove ${integer(args.id,'id',255).toString(16)}`;
      else if (args.action !== 'list') throw new Error('Unknown condition action');
      await requireCommand(target(), 'condition');
      const reply = await target().sendMonitorCommand(command);
      result = reply === 'OK' ? { removed: args.id } : JSON.parse(reply); break;
    }
    case 'winuae_capabilities': result = await capabilities(target()); break;
    case 'winuae_memory_map': await requireCommand(target(), 'memory-map'); result = JSON.parse(await target().sendMonitorCommand('memory-map')); break;
    case 'winuae_symbols': result = await listSymbols(args); break;
    case 'winuae_symbol_read': result = await readSymbol(target(), args); break;
    case 'winuae_hunk_inspect': {
      const hunks = parseHunk(await boundedFile(args.file));
      const symbols = hunks.flatMap(h => h.symbols.map(s => ({ ...s, hunk: h.index })));
      result = { hunks: hunks.map(({ data, relocations, symbols, ...h }) => ({ ...h, payload_size: data.length, relocations: relocations.length, symbols: symbols.length })),
        symbols: symbols.slice(0, 1024), symbols_truncated: symbols.length > 1024 }; break;
    }
    case 'winuae_hunk_load': result = await loadHunks(target(), parseHunk(await boundedFile(args.file)), args.placements); break;
    case 'winuae_bitmap': {
      const bitmap = await readBitmap(target(), args);
      return { content: [{ type: 'text', text: JSON.stringify({ width: bitmap.width, height: bitmap.height }) },
        { type: 'image', mimeType: 'image/png', data: bitmap.png.toString('base64') }] };
    }
    case 'winuae_memory_search': result = await searchMemory(target(), args); break;
    case 'winuae_snapshot': result = await captureSnapshot(target(), args.ranges); break;
    case 'winuae_postmortem': {
      const report = await postmortem(target());
      if (args.file === undefined) { result = report; break; }
      let backtrace = null;
      try { backtrace = await dwarfTool(target(), 'backtrace', { ...args, context: report.diagnosis_context }); }
      catch (e) { report.errors.backtrace = e instanceof Error ? e.message : String(e); }
      result = { ...report, backtrace }; break;
    }
    default: throw new Error(`Unknown debug tool: ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
