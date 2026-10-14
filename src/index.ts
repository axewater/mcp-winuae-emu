#!/usr/bin/env node

/**
 * MCP WinUAE Emulator Server
 * Provides Amiga 68k debugging tools via GDB RSP protocol through MCP
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { WinUAEConnection, WinUAEConfig } from './winuae-connection.js';
import { M68kRegisters, WatchpointType } from './gdb-protocol.js';
import * as path from 'path';
import { watchTools, handleWatchTool } from './watch-tools.js';
import { inputTools, handleInputTool } from './input-tools.js';
import { debugTools, handleDebugTool } from './debug-tools.js';

// ─── Configuration from environment ──────────────────────────────────

const config: WinUAEConfig = {
  winuaePath: process.env.WINUAE_PATH || 'C:\\apps\\winuae',
  configFile: process.env.WINUAE_CONFIG || path.join(
    process.env.WINUAE_PATH || 'C:\\apps\\winuae',
    'Configurations',
    'A500-Dev.uae'
  ),
  gdbPort: parseInt(process.env.WINUAE_GDB_PORT || '2345', 10),
};

// Global connection instance
let connection: WinUAEConnection | null = null;

// ─── Amiga Custom Register Name Table ────────────────────────────────

const CUSTOM_REGS: Record<number, string> = {
  0x000: 'BLTDDAT', 0x002: 'DMACONR', 0x004: 'VPOSR', 0x006: 'VHPOSR',
  0x008: 'DSKDATR', 0x00A: 'JOY0DAT', 0x00C: 'JOY1DAT', 0x00E: 'CLXDAT',
  0x010: 'ADKCONR', 0x012: 'POT0DAT', 0x014: 'POT1DAT', 0x016: 'POTGOR',
  0x018: 'SERDATR', 0x01A: 'DSKBYTR', 0x01C: 'INTENAR', 0x01E: 'INTREQR',
  0x020: 'DSKPTH', 0x022: 'DSKPTL', 0x024: 'DSKLEN', 0x026: 'DSKDAT',
  0x028: 'REFPTR', 0x02A: 'VPOSW', 0x02C: 'VHPOSW', 0x02E: 'COPCON',
  0x030: 'SERDAT', 0x032: 'SERPER', 0x034: 'POTGO', 0x036: 'JOYTEST',
  0x038: 'STREQU', 0x03A: 'STRVBL', 0x03C: 'STRHOR', 0x03E: 'STRLONG',
  0x040: 'BLTCON0', 0x042: 'BLTCON1', 0x044: 'BLTAFWM', 0x046: 'BLTALWM',
  0x048: 'BLTCPTH', 0x04A: 'BLTCPTL', 0x04C: 'BLTBPTH', 0x04E: 'BLTBPTL',
  0x050: 'BLTAPTH', 0x052: 'BLTAPTL', 0x054: 'BLTDPTH', 0x056: 'BLTDPTL',
  0x058: 'BLTSIZE', 0x05A: 'BLTCON0L', 0x05C: 'BLTSIZV', 0x05E: 'BLTSIZH',
  0x060: 'BLTCMOD', 0x062: 'BLTBMOD', 0x064: 'BLTAMOD', 0x066: 'BLTDMOD',
  0x070: 'BLTCDAT', 0x072: 'BLTBDAT', 0x074: 'BLTADAT',
  0x078: 'SPRHDAT', 0x07C: 'DENISEID',
  0x07E: 'DSKSYNC',
  0x080: 'COP1LCH', 0x082: 'COP1LCL', 0x084: 'COP2LCH', 0x086: 'COP2LCL',
  0x088: 'COPJMP1', 0x08A: 'COPJMP2', 0x08C: 'COPINS',
  0x08E: 'DIWSTRT', 0x090: 'DIWSTOP', 0x092: 'DDFSTRT', 0x094: 'DDFSTOP',
  0x096: 'DMACON', 0x098: 'CLXCON', 0x09A: 'INTENA', 0x09C: 'INTREQ',
  0x09E: 'ADKCON',
  0x0A0: 'AUD0LCH', 0x0A2: 'AUD0LCL', 0x0A4: 'AUD0LEN', 0x0A6: 'AUD0PER',
  0x0A8: 'AUD0VOL', 0x0AA: 'AUD0DAT',
  0x0B0: 'AUD1LCH', 0x0B2: 'AUD1LCL', 0x0B4: 'AUD1LEN', 0x0B6: 'AUD1PER',
  0x0B8: 'AUD1VOL', 0x0BA: 'AUD1DAT',
  0x0C0: 'AUD2LCH', 0x0C2: 'AUD2LCL', 0x0C4: 'AUD2LEN', 0x0C6: 'AUD2PER',
  0x0C8: 'AUD2VOL', 0x0CA: 'AUD2DAT',
  0x0D0: 'AUD3LCH', 0x0D2: 'AUD3LCL', 0x0D4: 'AUD3LEN', 0x0D6: 'AUD3PER',
  0x0D8: 'AUD3VOL', 0x0DA: 'AUD3DAT',
  0x0E0: 'BPL1PTH', 0x0E2: 'BPL1PTL', 0x0E4: 'BPL2PTH', 0x0E6: 'BPL2PTL',
  0x0E8: 'BPL3PTH', 0x0EA: 'BPL3PTL', 0x0EC: 'BPL4PTH', 0x0EE: 'BPL4PTL',
  0x0F0: 'BPL5PTH', 0x0F2: 'BPL5PTL', 0x0F4: 'BPL6PTH', 0x0F6: 'BPL6PTL',
  0x100: 'BPLCON0', 0x102: 'BPLCON1', 0x104: 'BPLCON2', 0x106: 'BPLCON3',
  0x108: 'BPL1MOD', 0x10A: 'BPL2MOD',
  0x110: 'BPL1DAT', 0x112: 'BPL2DAT', 0x114: 'BPL3DAT', 0x116: 'BPL4DAT',
  0x118: 'BPL5DAT', 0x11A: 'BPL6DAT',
  0x120: 'SPR0PTH', 0x122: 'SPR0PTL', 0x124: 'SPR1PTH', 0x126: 'SPR1PTL',
  0x128: 'SPR2PTH', 0x12A: 'SPR2PTL', 0x12C: 'SPR3PTH', 0x12E: 'SPR3PTL',
  0x130: 'SPR4PTH', 0x132: 'SPR4PTL', 0x134: 'SPR5PTH', 0x136: 'SPR5PTL',
  0x138: 'SPR6PTH', 0x13A: 'SPR6PTL', 0x13C: 'SPR7PTH', 0x13E: 'SPR7PTL',
  0x140: 'SPR0POS', 0x142: 'SPR0CTL', 0x144: 'SPR0DATA', 0x146: 'SPR0DATB',
  0x148: 'SPR1POS', 0x14A: 'SPR1CTL', 0x14C: 'SPR1DATA', 0x14E: 'SPR1DATB',
  0x150: 'SPR2POS', 0x152: 'SPR2CTL', 0x154: 'SPR2DATA', 0x156: 'SPR2DATB',
  0x158: 'SPR3POS', 0x15A: 'SPR3CTL', 0x15C: 'SPR3DATA', 0x15E: 'SPR3DATB',
  0x160: 'SPR4POS', 0x162: 'SPR4CTL', 0x164: 'SPR4DATA', 0x166: 'SPR4DATB',
  0x168: 'SPR5POS', 0x16A: 'SPR5CTL', 0x16C: 'SPR5DATA', 0x16E: 'SPR5DATB',
  0x170: 'SPR6POS', 0x172: 'SPR6CTL', 0x174: 'SPR6DATA', 0x176: 'SPR6DATB',
  0x178: 'SPR7POS', 0x17A: 'SPR7CTL', 0x17C: 'SPR7DATA', 0x17E: 'SPR7DATB',
  0x180: 'COLOR00', 0x182: 'COLOR01', 0x184: 'COLOR02', 0x186: 'COLOR03',
  0x188: 'COLOR04', 0x18A: 'COLOR05', 0x18C: 'COLOR06', 0x18E: 'COLOR07',
  0x190: 'COLOR08', 0x192: 'COLOR09', 0x194: 'COLOR10', 0x196: 'COLOR11',
  0x198: 'COLOR12', 0x19A: 'COLOR13', 0x19C: 'COLOR14', 0x19E: 'COLOR15',
  0x1A0: 'COLOR16', 0x1A2: 'COLOR17', 0x1A4: 'COLOR18', 0x1A6: 'COLOR19',
  0x1A8: 'COLOR20', 0x1AA: 'COLOR21', 0x1AC: 'COLOR22', 0x1AE: 'COLOR23',
  0x1B0: 'COLOR24', 0x1B2: 'COLOR25', 0x1B4: 'COLOR26', 0x1B6: 'COLOR27',
  0x1B8: 'COLOR28', 0x1BA: 'COLOR29', 0x1BC: 'COLOR30', 0x1BE: 'COLOR31',
  0x1C0: 'HTOTAL', 0x1C2: 'HSSTOP', 0x1C4: 'HBSTRT', 0x1C6: 'HBSTOP',
  0x1C8: 'VTOTAL', 0x1CA: 'VSSTOP', 0x1CC: 'VBSTRT', 0x1CE: 'VBSTOP',
  0x1DC: 'BEAMCON0', 0x1DE: 'HSSTRT', 0x1E0: 'VSSTRT', 0x1E2: 'HCENTER',
  0x1E4: 'DIWHIGH', 0x1FE: 'NO-OP',
};

// m68k opcode table (first word) for basic disassembly
const M68K_OPCODES: Record<number, string> = {
  0x4E75: 'RTS', 0x4E73: 'RTE', 0x4E71: 'NOP', 0x4E72: 'STOP',
  0x4E70: 'RESET', 0x4AFC: 'ILLEGAL', 0x4E77: 'RTR',
};

// ─── Helper Functions ────────────────────────────────────────────────

function parseHexOrDecimal(value: string | number): number {
  if (typeof value === 'number') return value;
  const s = value.trim();
  let result: number;
  if (s.startsWith('$')) result = parseInt(s.slice(1), 16);
  else if (s.startsWith('0x') || s.startsWith('0X')) result = parseInt(s.slice(2), 16);
  else result = parseInt(s, 10);
  if (isNaN(result)) throw new Error(`Invalid address/value: "${value}"`);
  return result;
}

function hex32(v: number): string {
  return '$' + (v >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function hex16(v: number): string {
  return '$' + (v & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();
}

function hex8(v: number): string {
  return '$' + (v & 0xFF).toString(16).padStart(2, '0').toUpperCase();
}

function hexDump(data: Buffer, startAddr: number, bytesPerLine: number = 16): string {
  let result = '';
  for (let i = 0; i < data.length; i += bytesPerLine) {
    const addr = startAddr + i;
    const line = data.subarray(i, Math.min(i + bytesPerLine, data.length));

    result += `$${(addr >>> 0).toString(16).padStart(8, '0').toUpperCase()}  `;

    const hexPart = Array.from(line)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    result += hexPart.padEnd(bytesPerLine * 3, ' ');

    result += ' |';
    for (const byte of line) {
      result += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
    }
    result += '|\n';
  }
  return result;
}

function formatRegisters(regs: M68kRegisters): string {
  const lines: string[] = [];

  // Data registers
  const dRegs = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'] as const;
  lines.push(dRegs.map(r => `${r}=${hex32(regs[r])}`).join(' '));

  // Address registers
  const aRegs = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const;
  lines.push(aRegs.map(r => `${r}=${hex32(regs[r])}`).join(' '));

  // SR and PC
  const sr = regs.SR;
  const srFlags = [
    (sr & 0x8000) ? 'T1' : '',
    (sr & 0x4000) ? 'T0' : '',
    (sr & 0x2000) ? 'S' : '',
    (sr & 0x1000) ? 'M' : '',
    `IPL=${(sr >> 8) & 7}`,
    (sr & 0x10) ? 'X' : 'x',
    (sr & 0x08) ? 'N' : 'n',
    (sr & 0x04) ? 'Z' : 'z',
    (sr & 0x02) ? 'V' : 'v',
    (sr & 0x01) ? 'C' : 'c',
  ].filter(s => s).join(' ');

  lines.push(`PC=${hex32(regs.PC)} SR=${hex16(regs.SR)} [${srFlags}]`);

  return lines.join('\n');
}

/**
 * Decode Copper list from raw memory
 */
function decodeCopperList(data: Buffer, baseAddr: number): string {
  const lines: string[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const addr = baseAddr + i;
    const word1 = data.readUInt16BE(i);
    const word2 = data.readUInt16BE(i + 2);

    const addrStr = `$${(addr >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;

    if (word1 === 0xFFFF && word2 === 0xFFFE) {
      lines.push(`${addrStr}  END`);
      break;
    }

    if (word1 & 1) {
      // WAIT or SKIP instruction
      const vp = (word1 >> 8) & 0xFF;
      const hp = word1 & 0xFE;
      const ve = (word2 >> 8) & 0x7F;
      const he = word2 & 0xFE;
      const bfd = (word2 & 0x8000) ? '' : ' (BFD=0, blitter finish disable)';

      if (word2 & 1) {
        lines.push(`${addrStr}  SKIP  VP>=${hex8(vp)} HP>=${hex8(hp)} VE=${hex8(ve)} HE=${hex8(he)}${bfd}`);
      } else {
        lines.push(`${addrStr}  WAIT  VP>=${hex8(vp)} HP>=${hex8(hp)} VE=${hex8(ve)} HE=${hex8(he)}${bfd}`);
      }
    } else {
      // MOVE instruction
      const regOffset = word1 & 0x1FE;
      const regName = CUSTOM_REGS[regOffset] || `REG_${regOffset.toString(16).padStart(3, '0')}`;
      lines.push(`${addrStr}  MOVE  ${regName} (#${hex16(word2)})`);
    }
  }
  return lines.join('\n');
}

/**
 * Simple m68k disassembly (opcode word only — shows hex for unknown)
 */
function disassembleM68k(data: Buffer, baseAddr: number, count: number): string {
  const lines: string[] = [];
  let offset = 0;
  for (let i = 0; i < count && offset + 1 < data.length; i++) {
    const addr = baseAddr + offset;
    const word = data.readUInt16BE(offset);
    const addrStr = `$${(addr >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
    const wordHex = word.toString(16).padStart(4, '0').toUpperCase();

    const known = M68K_OPCODES[word];
    if (known) {
      lines.push(`${addrStr}  ${wordHex}        ${known}`);
      offset += 2;
    } else {
      // Show raw word — proper disassembly would need a full decoder
      lines.push(`${addrStr}  ${wordHex}        DC.W $${wordHex}`);
      offset += 2;
    }
  }
  return lines.join('\n');
}

// ─── Disk Image Detection ────────────────────────────────────────────

const DISK_IMAGE_EXTENSIONS = new Set(['.adf', '.adz', '.dms', '.ipf', '.fdi', '.scp']);

function isDiskImage(filePath: string): boolean {
  return DISK_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ─── Tool Definitions ────────────────────────────────────────────────

const tools: Tool[] = [
  ...debugTools,
  ...inputTools,
  ...watchTools,
  ...[
    ['winuae_attach','Attach to the configured existing GDB server. Never launch a process. Connecting stops the guest, as with ordinary GDB attach.'],
    ['winuae_launch','Launch and own a new emulator using configured paths. Fail if already connected, owning a process, or the port is occupied.'],
    ['winuae_detach','Detach, clear remote controls and debugger state, resume guest execution and leave the emulator running. Relinquish process ownership so MCP exit will not terminate it. Host UI pause remains unchanged.'],
    ['winuae_shutdown','Stop only an emulator launched and still owned by this MCP server. Refuse attached or detached instances.']
  ].map(([name,description])=>({name,description,inputSchema:{type:'object' as const,properties:{}}})),
  {
    name: 'winuae_wait_stop',
    description: 'Wait for a stop without interrupting execution. Pause and disconnect remain available. Timeout leaves the CPU running.',
    inputSchema: { type: 'object', properties: {
      timeout_ms: { type: 'integer', minimum: 1, maximum: 60000, default: 30000 }
    } }
  },
  {
    name: 'winuae_process_breakpoint',
    description: 'Arm a one-shot stop at an AmigaDOS program entry, or inspect/clear it. Does not launch the program. Names match case-insensitively; bare names match the basename. Continue execution after arming.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'status', 'clear'] },
        name: { type: 'string', description: 'ASCII process or CLI command name' },
        address: { type: ['string', 'number'], description: 'AmigaDOS Process address; alternative to name' },
      },
      required: ['action'],
    },
  },
  {
    name: 'winuae_loaded_segments',
    description: 'Inspect loaded AmigaDOS segments for the current or selected Process. Returns load-order indexes, guest payload addresses and allocated sizes for relocating host hunk symbols. Corrupt or unavailable process metadata reports an error.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: ['string', 'number'], description: 'Optional Process address; defaults to the current task' } },
    },
  },
  {
    name: 'winuae_exceptions',
    description: 'Select CPU exception stops and inspect the last fault snapshot. Set vectors such as 2=bus error, 3=address error, 4=illegal instruction, 5=divide by zero. Current registers are after exception-frame construction; the snapshot preserves pre-frame D0-D7,A0-A7,SR,PC and instruction_pc.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'status', 'clear'] },
        vectors: { type: 'array', items: { type: 'integer', minimum: 2, maximum: 63 }, description: 'Complete replacement set of exception vectors' },
      },
      required: ['action'],
    },
  },
  {
    name: 'winuae_range_step',
    description: 'Execute at least one instruction and stop when PC leaves [start,end), or another stop fires. Starts asynchronously; use pause to inspect the stop. Equal bounds single-step.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: ['string', 'number'], description: 'Inclusive range start' },
        end: { type: ['string', 'number'], description: 'Exclusive range end' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'winuae_dma_watchpoint',
    description: 'Add, list or remove remotely owned DMA watchpoints. Filter accesses by hardware source; CPU accesses do not match. Stop replies identify the actual source and custom register.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        address: { type: ['string', 'number'] },
        length: { type: 'integer', minimum: 1, maximum: 65536 },
        mode: { type: 'string', enum: ['read', 'write', 'access'] },
        sources: { type: 'array', items: { type: 'string', enum: ['blitter', 'copper', 'disk', 'audio', 'bitplane', 'sprite'] } },
        id: { type: 'integer', minimum: 0, maximum: 19, description: 'ID returned by add, required for remove' },
      },
      required: ['action'],
    },
  },
  {
    name: 'winuae_guest_output',
    description: 'Enable, disable, read or clear bounded guest diagnostics from uaelib function 86. Reads preserve records and include IDs, truncation and eviction counts. This channel does not capture AmigaDOS console or serial output.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['on', 'off', 'read', 'clear'] } },
      required: ['action'],
    },
  },
  {
    name: 'winuae_checkpoint',
    description: 'Save or restore a WinUAE debugging checkpoint at a host path. State files are only valid at frame start, so save resumes the CPU, saves at the next frame start and stops again: the CPU ends up to one frame past the original stop. Any other stop first, such as a breakpoint, cancels the save with an error. Restore retains the connection and leaves the CPU stopped, but clears remote breakpoints, watchpoints, exception selection and captured output. External disk/file writes are not rolled back; normal WinUAE savestate limitations apply.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'restore'] },
        file: { type: 'string', description: 'Host path to a WinUAE state file; save replaces an existing file' },
      },
      required: ['action', 'file'],
    },
  },
  // Connection tools
  {
    name: 'winuae_connect',
    description: 'Launch WinUAE and connect to GDB RSP server. Must be called before any other WinUAE commands. Set WINUAE_PATH env var to override default path.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_disconnect',
    description: 'Disconnect from WinUAE and stop the emulator process',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_status',
    description: 'Check if WinUAE is running and GDB connection is active',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Load/Reset
  {
    name: 'winuae_load',
    description: 'Load an Amiga executable into memory by writing it via GDB. Provide the host path to the compiled binary. For disk images (.adf etc.), inserts into DF0: and restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to Amiga executable on host filesystem',
        },
        address: {
          type: ['string', 'number'],
          description: 'Load address in Amiga memory (default: $4000). Use $ prefix for hex.',
          default: 0x4000,
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'winuae_reset',
    description: 'Reset the Amiga by restarting WinUAE with current configuration (hard reset). Reconnects GDB automatically.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Disk tools
  {
    name: 'winuae_insert_disk',
    description: 'Insert a floppy disk image (ADF, ADZ, DMS, IPF) into a drive. Restarts WinUAE to apply. Use drive 0 for DF0: (boot drive).',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to disk image file (.adf, .adz, .dms, .ipf)',
        },
        drive: {
          type: 'number',
          description: 'Drive number 0-3 (default: 0 = DF0:)',
          default: 0,
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'winuae_eject_disk',
    description: 'Eject floppy disk from a drive. Restarts WinUAE to apply.',
    inputSchema: {
      type: 'object',
      properties: {
        drive: {
          type: 'number',
          description: 'Drive number 0-3 (default: 0 = DF0:)',
          default: 0,
        },
      },
    },
  },

  // Memory tools
  {
    name: 'winuae_memory_read',
    description: 'Read memory bytes. Returns hex string. Address can use $ prefix for hex (e.g., $DFF000).',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address (use $ for hex, e.g., $DFF000)',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to read',
        },
      },
      required: ['address', 'length'],
    },
  },
  {
    name: 'winuae_memory_write',
    description: 'Write bytes to memory. Provide data as hex string (e.g., "48E7FFFE" or "48 E7 FF FE").',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address',
        },
        data: {
          type: 'string',
          description: 'Hex data to write',
        },
      },
      required: ['address', 'data'],
    },
  },
  {
    name: 'winuae_memory_dump',
    description: 'Dump memory as formatted hex + ASCII (like a hex editor). Great for inspecting chip registers, copper lists, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to dump',
        },
        bytesPerLine: {
          type: 'number',
          description: 'Bytes per line (default: 16)',
          default: 16,
        },
      },
      required: ['address', 'length'],
    },
  },

  // Register tools
  {
    name: 'winuae_registers_get',
    description: 'Get all m68k CPU registers: D0-D7, A0-A7, SR, PC',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_registers_set',
    description: 'Set m68k CPU registers. Provide any subset of D0-D7, A0-A7, SR, PC.',
    inputSchema: {
      type: 'object',
      properties: {
        D0: { type: ['string', 'number'], description: 'D0 register' },
        D1: { type: ['string', 'number'], description: 'D1 register' },
        D2: { type: ['string', 'number'], description: 'D2 register' },
        D3: { type: ['string', 'number'], description: 'D3 register' },
        D4: { type: ['string', 'number'], description: 'D4 register' },
        D5: { type: ['string', 'number'], description: 'D5 register' },
        D6: { type: ['string', 'number'], description: 'D6 register' },
        D7: { type: ['string', 'number'], description: 'D7 register' },
        A0: { type: ['string', 'number'], description: 'A0 register' },
        A1: { type: ['string', 'number'], description: 'A1 register' },
        A2: { type: ['string', 'number'], description: 'A2 register' },
        A3: { type: ['string', 'number'], description: 'A3 register' },
        A4: { type: ['string', 'number'], description: 'A4 register' },
        A5: { type: ['string', 'number'], description: 'A5 register' },
        A6: { type: ['string', 'number'], description: 'A6 register' },
        A7: { type: ['string', 'number'], description: 'A7 register (SP)' },
        SR: { type: ['string', 'number'], description: 'Status Register' },
        PC: { type: ['string', 'number'], description: 'Program Counter' },
      },
    },
  },

  // Breakpoints
  {
    name: 'winuae_breakpoint_set',
    description: 'Set a software breakpoint at address. Execution stops when PC reaches this address.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Address to break at',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_breakpoint_clear',
    description: 'Remove a breakpoint at address',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Address of breakpoint to remove',
        },
      },
      required: ['address'],
    },
  },

  // Watchpoints
  {
    name: 'winuae_watchpoint_set',
    description: 'Set a watchpoint to break on memory read/write/access.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address of watched range',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to watch',
        },
        type: {
          type: 'string',
          enum: ['read', 'write', 'access'],
          description: 'Type of access to watch for',
        },
      },
      required: ['address', 'length', 'type'],
    },
  },
  {
    name: 'winuae_watchpoint_clear',
    description: 'Remove a watchpoint',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address of watchpoint to remove',
        },
        length: {
          type: 'number',
          description: 'Length of watchpoint to remove',
        },
        type: {
          type: 'string',
          enum: ['read', 'write', 'access'],
          description: 'Type of watchpoint to remove',
        },
      },
      required: ['address', 'length', 'type'],
    },
  },

  // Execution control
  {
    name: 'winuae_step',
    description: 'Single-step N instructions. Returns registers after stepping.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of instructions to step (default: 1)',
          default: 1,
        },
      },
    },
  },
  {
    name: 'winuae_continue',
    description: 'Resume execution. Will stop at next breakpoint/watchpoint.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_pause',
    description: 'Pause/break execution (send interrupt to CPU)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Amiga hardware tools
  {
    name: 'winuae_custom_registers',
    description: 'Read and decode Amiga custom chip registers ($DFF000-$DFF1FE). Shows register names and values.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'winuae_copper_disassemble',
    description: 'Disassemble a Copper list at given address. Decodes WAIT, MOVE, SKIP, and END instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address of copper list',
        },
        length: {
          type: 'number',
          description: 'Number of bytes to read (default: 256)',
          default: 256,
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_disassemble',
    description: 'Disassemble 68k machine code at given address using WinUAE\'s built-in disassembler. Shows address, hex bytes, and full mnemonic with operands.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: ['string', 'number'],
          description: 'Start address',
        },
        count: {
          type: 'number',
          description: 'Number of words to show (default: 20)',
          default: 20,
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'winuae_screenshot',
    description: 'Capture current screen buffer and save as PNG file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Output filename (default: winuae-screen-{timestamp}.png)',
        },
      },
    },
  },
];

// ─── Tool Implementations ────────────────────────────────────────────

async function handleToolCall(name: string, args: any): Promise<CallToolResult> {
  try {
    if (name === 'winuae_watch') return await handleWatchTool(args, connection?.connected ? connection.getProtocol() : undefined);
    if (inputTools.some(tool => tool.name === name))
      return await handleInputTool(name, args, connection?.connected ? connection.getProtocol() : undefined);
    if (debugTools.some(tool => tool.name === name)) {
      return await handleDebugTool(name, args, connection?.connected ? connection.getProtocol() : undefined);
    }
    switch (name) {
      case 'winuae_wait_stop': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        return { content: [{ type: 'text', text: await connection.getProtocol().waitForStop(args.timeout_ms ?? 30000) }] };
      }
      case 'winuae_process_breakpoint': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        if (args.action === 'set') {
          if ((args.name !== undefined) === (args.address !== undefined)) {
            throw new Error('Supply exactly one of name or address');
          }
          if (args.name !== undefined) {
            if (typeof args.name !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(args.name)) {
              throw new Error('Name must contain 1-255 printable ASCII characters');
            }
            await protocol.sendMonitorCommand(`process-break name ${args.name}`);
          } else {
            const address = parseHexOrDecimal(args.address);
            if (!Number.isInteger(address) || address <= 0 || address > 0xffffffff || address % 4) {
              throw new Error('Process address must be a nonzero aligned 32-bit address');
            }
            await protocol.sendMonitorCommand(`process-break address ${address.toString(16)}`);
          }
        } else if (args.action === 'clear') {
          await protocol.sendMonitorCommand('process-break clear');
        } else if (args.action !== 'status') {
          throw new Error('Action must be set, status or clear');
        }
        return { content: [{ type: 'text', text: await protocol.sendMonitorCommand('process-break status') }] };
      }
      case 'winuae_loaded_segments': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        let command = 'segments';
        if (args.address !== undefined) {
          const address = parseHexOrDecimal(args.address);
          if (!Number.isInteger(address) || address <= 0 || address > 0xffffffff || address % 4) {
            throw new Error('Process address must be a nonzero aligned 32-bit address');
          }
          command += ` ${address.toString(16)}`;
        }
        return { content: [{ type: 'text', text: await connection.getProtocol().sendMonitorCommand(command) }] };
      }
      case 'winuae_exceptions': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        if (args.action === 'set') {
          if (!Array.isArray(args.vectors) || args.vectors.length > 62 ||
              args.vectors.some((v: unknown) => typeof v !== 'number' || !Number.isInteger(v) || v < 2 || v > 63)) {
            throw new Error('Vectors must be an array of integers from 2 to 63');
          }
          let mask = 0n;
          for (const vector of args.vectors) mask |= 1n << BigInt(vector);
          await protocol.sendMonitorCommand(`exception-mask ${mask.toString(16)}`);
        } else if (args.action === 'clear') {
          await protocol.sendMonitorCommand('exception-mask 0');
        } else if (args.action !== 'status') {
          throw new Error('Action must be set, status or clear');
        }
        return { content: [{ type: 'text', text: await protocol.sendMonitorCommand('exception') }] };
      }
      case 'winuae_range_step': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        await connection.getProtocol().rangeStep(parseHexOrDecimal(args.start), parseHexOrDecimal(args.end));
        return { content: [{ type: 'text', text: 'Range stepping started. Use pause to inspect the stop.' }] };
      }
      case 'winuae_dma_watchpoint': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        if (args.action === 'add') {
          const address = parseHexOrDecimal(args.address);
          const length = args.length;
          const modes: Record<string, number> = { read: 1, write: 2, access: 3 };
          const sources: Record<string, number> = { blitter: 0x1f8, copper: 0x200, disk: 0x400, audio: 0x7800, bitplane: 0x7f8000, sprite: 0x7f800000 };
          if (!Number.isInteger(address) || address < 0 || !Number.isInteger(length) || length < 1 ||
              length > 65536 || address + length > 0x7fff0000 || !Object.hasOwn(modes, args.mode) ||
              !Array.isArray(args.sources) || !args.sources.length || args.sources.length > 6 ||
              args.sources.some((source: unknown) => typeof source !== 'string' || !Object.hasOwn(sources, source))) {
            throw new Error('Supply a valid range, access mode and one or more DMA source groups');
          }
          let mask = 0;
          for (const source of args.sources) mask |= sources[source];
          const id = await protocol.sendMonitorCommand(`dma-watch add ${address.toString(16)} ${length.toString(16)} ${modes[args.mode]} ${mask.toString(16)}`);
          return { content: [{ type: 'text', text: JSON.stringify({id:Number(id)}) }] };
        }
        if (args.action === 'remove') {
          if (!Number.isInteger(args.id) || args.id < 0 || args.id >= 20) throw new Error('Invalid DMA watchpoint ID');
          await protocol.sendMonitorCommand(`dma-watch remove ${args.id.toString(16)}`);
        } else if (args.action !== 'list') {
          throw new Error('Action must be add, list or remove');
        }
        return { content: [{ type: 'text', text: await protocol.sendMonitorCommand('dma-watch list') }] };
      }
      case 'winuae_guest_output': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        if (!['on', 'off', 'read', 'clear'].includes(args.action)) throw new Error('Action must be on, off, read or clear');
        return { content: [{ type: 'text', text: await connection.getProtocol().sendMonitorCommand(`guest-output ${args.action}`) }] };
      }
      case 'winuae_checkpoint': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        if (!['save', 'restore'].includes(args.action) || typeof args.file !== 'string' ||
            !args.file.length || /[\x00\r\n]/.test(args.file)) throw new Error('Supply save or restore and a valid host file path');
        const { resolve } = await import('path');
        const file = resolve(args.file);
        if (Buffer.byteLength(file, 'utf8') > 900) throw new Error('Checkpoint path is too long');
        const protocol = connection.getProtocol();
        await protocol.sendMonitorCommand(`checkpoint ${args.action} ${file}`);
        const registers = await protocol.readRegisters();
        return { content: [{ type: 'text', text: JSON.stringify({action:args.action,file,stopped:true,registers}) }] };
      }
      case 'winuae_attach':
      case 'winuae_launch': {
        if (!connection) connection = new WinUAEConnection(config);
        if (name === 'winuae_attach') await connection.connectExisting();
        else await connection.connect();
        return { content:[{type:'text',text:JSON.stringify(await connection.status())}] };
      }
      case 'winuae_detach':
      case 'winuae_shutdown': {
        if (!connection) throw new Error('No session');
        if (name === 'winuae_detach') await connection.detach();
        else await connection.shutdown();
        return { content:[{type:'text',text:JSON.stringify(await connection.status())}] };
      }
      case 'winuae_connect': {
        if (connection?.connected) {
          return { content: [{ type: 'text', text: 'Already connected to WinUAE' }] };
        }
        if (!connection) {
          connection = new WinUAEConnection(config);
        }
        const statusMsg = await connection.connectSmart();
        return { content: [{ type: 'text', text: statusMsg }] };
      }

      case 'winuae_disconnect': {
        if (!connection) {
          return { content: [{ type: 'text', text: 'Not connected to WinUAE' }] };
        }
        await connection.disconnect();
        connection = null;
        return { content: [{ type: 'text', text: 'Disconnected from WinUAE' }] };
      }

      case 'winuae_status': {
        const status = connection ? await connection.status() : {connected:false,owned:false,pid:null,responsive:false,execution:'disconnected'};
        return { content: [{ type:'text',text:JSON.stringify(status) }] };
      }

      case 'winuae_load': {
        const { file } = args;
        const { readFileSync, existsSync } = await import('fs');
        const { resolve } = await import('path');

        const absPath = resolve(file);
        if (!existsSync(absPath)) {
          throw new Error(`File not found: ${absPath}`);
        }

        // Detect disk images by extension — delegate to disk insertion
        if (isDiskImage(absPath)) {
          if (!connection) {
            connection = new WinUAEConnection(config);
          }
          connection.setFloppy(0, absPath);
          if (connection.connected) {
            const statusMsg = await connection.restart();
            return { content: [{ type: 'text', text: `Detected disk image. Inserted ${absPath} into DF0: and restarted.\n${statusMsg}` }] };
          } else {
            return { content: [{ type: 'text', text: `Detected disk image. ${absPath} set for DF0:. Call winuae_connect to boot.` }] };
          }
        }

        // Load binary into memory via GDB (chunked writes)
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const fileData = readFileSync(absPath);
        const protocol = connection.getProtocol();

        const loadAddr = args.address !== undefined
          ? parseHexOrDecimal(args.address)
          : 0x4000;

        if (fileData.length >= 4) {
          const magic = fileData.readUInt32BE(0);
          if (magic === 0x000003F3) {
            throw new Error('Hunk executables require winuae_hunk_load with explicit RAM placements');
          }
        }

        console.error(`[WinUAE] Loading ${fileData.length} bytes to ${hex32(loadAddr)} (chunked)...`);
        await protocol.writeMemory(loadAddr, fileData);

        // Verify first 16 bytes to confirm write succeeded
        const verifyLen = Math.min(16, fileData.length);
        const readBack = await protocol.readMemory(loadAddr, verifyLen);
        const match = readBack.equals(fileData.subarray(0, verifyLen));
        const verifyMsg = match
          ? 'Verify OK (first 16 bytes match)'
          : `VERIFY MISMATCH! Expected: ${fileData.subarray(0, verifyLen).toString('hex')} Got: ${readBack.toString('hex')}`;

        return { content: [{ type: 'text', text: `Loaded ${fileData.length} bytes from ${absPath} at ${hex32(loadAddr)}\n${verifyMsg}` }] };
      }

      case 'winuae_reset': {
        if (!connection) throw new Error('Not connected to WinUAE');
        // Restart WinUAE entirely — this is a hard reset (power cycle)
        const statusMsg = await connection.restart();
        // After restart, pause and read registers
        const resetProtocol = connection.getProtocol();
        try {
          await resetProtocol.pause();
        } catch {
          // May already be paused after fresh connect
        }
        const regs = await resetProtocol.readRegisters();
        return { content: [{ type: 'text', text: `Reset complete. ${statusMsg}\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_insert_disk': {
        const { file, drive = 0 } = args;
        const { existsSync } = await import('fs');
        const { resolve } = await import('path');

        const absPath = resolve(file);
        if (!existsSync(absPath)) {
          throw new Error(`File not found: ${absPath}`);
        }

        if (!connection) {
          connection = new WinUAEConnection(config);
        }

        connection.setFloppy(drive, absPath);

        if (connection.connected) {
          const statusMsg = await connection.restart();
          return { content: [{ type: 'text', text: `Inserted ${absPath} into DF${drive}: and restarted.\n${statusMsg}` }] };
        } else {
          return { content: [{ type: 'text', text: `Disk ${absPath} set for DF${drive}:. Will be mounted on next winuae_connect.` }] };
        }
      }

      case 'winuae_eject_disk': {
        const { drive = 0 } = args;

        if (!connection) {
          return { content: [{ type: 'text', text: 'No connection. Nothing to eject.' }] };
        }

        connection.setFloppy(drive, null);

        if (connection.connected) {
          const statusMsg = await connection.restart();
          return { content: [{ type: 'text', text: `Ejected DF${drive}: and restarted.\n${statusMsg}` }] };
        } else {
          return { content: [{ type: 'text', text: `DF${drive}: cleared. Will take effect on next winuae_connect.` }] };
        }
      }

      case 'winuae_memory_read': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length } = args;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, length);
        const hexStr = Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        return { content: [{ type: 'text', text: `Memory ${hex32(addr)}-${hex32(addr + length - 1)}:\n${hexStr}` }] };
      }

      case 'winuae_memory_write': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const bytes = Buffer.from(args.data.replace(/[^0-9A-Fa-f]/g, ''), 'hex');
        const protocol = connection.getProtocol();
        await protocol.writeMemory(addr, bytes);
        return { content: [{ type: 'text', text: `Wrote ${bytes.length} bytes to ${hex32(addr)}` }] };
      }

      case 'winuae_memory_dump': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length, bytesPerLine = 16 } = args;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, length);
        const dump = hexDump(data, addr, bytesPerLine);
        return { content: [{ type: 'text', text: dump }] };
      }

      case 'winuae_registers_get': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: formatRegisters(regs) }] };
      }

      case 'winuae_registers_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();

        // Register name to GDB index mapping
        const REG_INDEX: Record<string, number> = {
          D0: 0, D1: 1, D2: 2, D3: 3, D4: 4, D5: 5, D6: 6, D7: 7,
          A0: 8, A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15,
          SR: 16, PC: 17,
        };

        const toWrite: Array<{ name: string; idx: number; value: number }> = [];
        for (const [regName, rawValue] of Object.entries(args)) {
          if (rawValue === undefined || rawValue === null) continue;
          const idx = REG_INDEX[regName];
          if (idx === undefined) continue;
          toWrite.push({ name: regName, idx, value: parseHexOrDecimal(rawValue as string | number) });
        }

        if (toWrite.length === 0) {
          return { content: [{ type: 'text', text: 'No registers specified to write' }] };
        }

        // Apply SR before A7 because changing privilege mode switches stacks.
        toWrite.sort((a, b) => (a.idx === 16 ? -1 : b.idx === 16 ? 1 : 0));

        // Write one register at a time, verify each before proceeding.
        // The WinUAE GDB server needs time between register writes.
        const results: string[] = [];
        for (const { name, idx, value } of toWrite) {
          await protocol.writeRegister(idx, value);
          // Read back to verify and to drain the GDB server state
          const actual = await protocol.readRegister(idx);
          if (actual !== (value >>> 0)) {
            results.push(`${name}=${hex32(value)} (VERIFY FAILED: got ${hex32(actual)})`);
          } else {
            results.push(`${name}=${hex32(value)}`);
          }
        }

        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Set ${results.join(', ')}\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_breakpoint_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const protocol = connection.getProtocol();
        await protocol.setBreakpoint(addr);
        return { content: [{ type: 'text', text: `Breakpoint set at ${hex32(addr)}` }] };
      }

      case 'winuae_breakpoint_clear': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const protocol = connection.getProtocol();
        await protocol.clearBreakpoint(addr);
        return { content: [{ type: 'text', text: `Breakpoint cleared at ${hex32(addr)}` }] };
      }

      case 'winuae_watchpoint_set': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length, type } = args;
        const protocol = connection.getProtocol();
        await protocol.setWatchpoint(addr, length, type as WatchpointType);
        return { content: [{ type: 'text', text: `Watchpoint (${type}) set at ${hex32(addr)}, ${length} bytes` }] };
      }

      case 'winuae_watchpoint_clear': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const { length, type } = args;
        const protocol = connection.getProtocol();
        await protocol.clearWatchpoint(addr, length, type as WatchpointType);
        return { content: [{ type: 'text', text: `Watchpoint (${type}) cleared at ${hex32(addr)}` }] };
      }

      case 'winuae_step': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const { count = 1 } = args;
        const protocol = connection.getProtocol();

        for (let i = 0; i < count; i++) {
          await protocol.step();
        }

        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Stepped ${count} instruction(s)\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_continue': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        await protocol.continue();
        return { content: [{ type: 'text', text: 'Execution resumed. Use winuae_pause to stop.' }] };
      }

      case 'winuae_pause': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const stopReply = await protocol.pause();
        const regs = await protocol.readRegisters();
        return { content: [{ type: 'text', text: `Paused (${stopReply})\n${formatRegisters(regs)}` }] };
      }

      case 'winuae_custom_registers': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        // Read in 64-byte chunks; some ranges (ECS/AGA regs on OCS) may fail
        const chunks: Buffer[] = [];
        for (let off = 0; off < 0x200; off += 0x40) {
          try {
            chunks.push(await protocol.readMemory(0xDFF000 + off, 0x40));
          } catch {
            chunks.push(Buffer.alloc(0x40, 0)); // fill unreadable ranges with zeros
          }
        }
        const data = Buffer.concat(chunks);

        const lines: string[] = ['Amiga Custom Registers ($DFF000-$DFF1FE):'];
        for (let offset = 0; offset < 0x200; offset += 2) {
          const name = CUSTOM_REGS[offset];
          if (name) {
            const value = data.readUInt16BE(offset);
            lines.push(`  $DFF${offset.toString(16).padStart(3, '0').toUpperCase()} ${name.padEnd(10)} = ${hex16(value)}`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'winuae_copper_disassemble': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const length = args.length || 256;
        const protocol = connection.getProtocol();
        const data = await protocol.readMemory(addr, length);
        const decoded = decodeCopperList(data, addr);
        return { content: [{ type: 'text', text: `Copper list at ${hex32(addr)}:\n${decoded}` }] };
      }

      case 'winuae_disassemble': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const addr = parseHexOrDecimal(args.address);
        const count = args.count || 20;
        const protocol = connection.getProtocol();
        // Use WinUAE's built-in 68k disassembler via monitor command
        const result = await protocol.sendMonitorCommand(`disasm ${addr.toString(16)} ${count}`);
        return { content: [{ type: 'text', text: result }] };
      }

      case 'winuae_screenshot': {
        if (!connection?.connected) throw new Error('Not connected to WinUAE');
        const protocol = connection.getProtocol();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const filename = args.filename || `winuae-screen-${timestamp}.png`;
        // Resolve to absolute path using temp dir if relative
        const fs = await import('fs');
        const os = await import('os');
        let filepath = filename;
        if (!path.isAbsolute(filepath)) {
          filepath = path.join(os.tmpdir(), filepath);
        }
        // Use the native host path, including spaces and Unicode.
        const winPath = filepath;
        const result = await protocol.sendMonitorCommand(`screenshot ${winPath}`);
        if (result.startsWith('OK')) {
          // result format: "OK WxH filepath"
          return { content: [{ type: 'text', text: `Screenshot saved: ${result}\nFile: ${filepath}` }] };
        }
        throw new Error(`Screenshot failed: ${result}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text', text: `Error: ${errorMessage}` }] };
  }
}

// ─── MCP Server Setup ────────────────────────────────────────────────

const server = new Server(
  {
    name: 'winuae-emu',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Keep each tool's pause/read/write sequence together on the RSP connection.
let toolQueue: Promise<unknown> = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // Observation sends no RSP commands and must not block a queued pause.
  if (name === 'winuae_wait_stop') return handleToolCall(name, args || {});
  const result = toolQueue.then(() => handleToolCall(name, args || {}));
  toolQueue = result.catch(() => undefined);
  return result;
});

// Handle shutdown
process.on('SIGINT', async () => {
  if (connection) {
    await connection.disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (connection) {
    await connection.disconnect();
  }
  process.exit(0);
});

// A closed MCP transport must not leave its emulator child running.
process.stdin.on('end', async () => {
  if (connection) await connection.disconnect();
  process.exit(0);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP WinUAE] Server running');
  console.error(`[MCP WinUAE] WinUAE path: ${config.winuaePath}`);
  console.error(`[MCP WinUAE] Config file: ${config.configFile}`);
  console.error(`[MCP WinUAE] GDB port: ${config.gdbPort}`);
}

main().catch((error) => {
  console.error('[MCP WinUAE] Fatal error:', error);
  process.exit(1);
});
