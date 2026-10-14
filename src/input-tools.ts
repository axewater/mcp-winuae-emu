import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GdbProtocol } from './gdb-protocol.js';
import { integer } from './debug-validation.js';
import { requireCommand } from './target-info.js';

const stepProperties = {
  after_frames: { type: 'integer', minimum: 0, maximum: 3600, default: 0 },
  action: { type: 'string', enum: ['key','mouse','button','joystick','wait'] },
  code: { type: ['integer','string'] }, port: { type: 'integer', minimum: 0, maximum: 1 },
  axis: { type: 'string', enum: ['x','y'] }, delta: { type: 'integer', minimum: -127, maximum: 127 },
  button: { type: 'integer', minimum: 0, maximum: 2 }, direction: { type: 'string', enum: ['left','right','up','down'] },
  pressed: { type: 'boolean' }
};
const timingProperties = {
  hold_frames: { type: 'integer', minimum: 1, maximum: 120, default: 3 },
  gap_frames: { type: 'integer', minimum: 1, maximum: 120, default: 3 },
  resume: { type: 'boolean', default: false, description: 'Explicitly resume execution after accepting the sequence' }
};
export const inputTools: Tool[] = [
  { name: 'winuae_input_sequence', description: 'Queue up to 256 input events with relative delays in emulated frames (3600 total). Runs asynchronously, freezes while paused, releases held inputs on completion/cancellation. Requires no existing held remote input or sequence. Use winuae_input status/release to observe/cancel. Zero delay groups events at one frame boundary. Recording/playback is unsupported.', inputSchema: { type: 'object', properties: {
    steps: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'object', properties: stepProperties, required: ['action'] } }, resume: timingProperties.resume
  }, required: ['steps'] } },
  { name: 'winuae_key_tap', description: 'Tap one raw Amiga key or chord. Press in supplied order, hold for emulated frames, release in reverse order and wait a gap. Asynchronous; observe/cancel with winuae_input. Guest execution must run to advance.', inputSchema: { type: 'object', properties: {
    codes: { type: 'array', minItems: 1, maxItems: 8, items: { type: ['integer','string'] } }, ...timingProperties
  }, required: ['codes'] } },
  { name: 'winuae_type_text', description: 'Type at most 60 characters with explicit US Amiga guest keymap. Supports printable ASCII, newline and tab. Rejects unsupported characters before any input. Does not paste host text or infer the guest keymap. Asynchronous; guest must run. Observe/cancel with winuae_input.', inputSchema: { type: 'object', properties: {
    text: { type: 'string', minLength: 1, maxLength: 60 }, layout: { type: 'string', enum: ['us'] }, ...timingProperties
  }, required: ['text','layout'] } },
  { name: 'winuae_input', description: 'Deliver guest input through WinUAE without stopping or resuming execution. Keys are Amiga raw codes, mouse motion is relative hardware counts (-127..127), ports are 0/1. Buttons 0/1/2 are left/right/middle or fire/second/third. Held inputs are released on disconnect/reset. Input recording/playback is unsupported. While paused, the guest cannot consume input; use frame sequences for taps.', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['key','mouse','button','joystick','release','status'] },
    code: { type: ['integer','string'], description: 'Amiga raw key code, 0..0x67' },
    port: { type: 'integer', minimum: 0, maximum: 1, default: 0 },
    axis: { type: 'string', enum: ['x','y'] }, delta: { type: 'integer', minimum: -127, maximum: 127 },
    button: { type: 'integer', minimum: 0, maximum: 2 },
    direction: { type: 'string', enum: ['left','right','up','down'] },
    pressed: { type: 'boolean' }
  }, required: ['action'] } }
];
export function inputEvent(args: Record<string, unknown>): number[] {
  const port = integer(args.port ?? 0, 'port', 1);
  if (args.action === 'mouse') {
    if (!['x','y'].includes(args.axis as string) || typeof args.delta !== 'number' || !Number.isInteger(args.delta) || Math.abs(args.delta) > 127)
      throw new Error('Mouse requires axis x/y and integer delta -127..127');
    return [1, port, args.axis === 'x' ? 0 : 1, args.delta >>> 0];
  }
  if (typeof args.pressed !== 'boolean') throw new Error('pressed must be boolean');
  const state = args.pressed ? 1 : 0;
  if (args.action === 'key') {
    if (port !== 0) throw new Error('Keyboard does not take a port');
    return [0, 0, integer(args.code, 'code', 0x67), state];
  }
  if (args.action === 'button') return [2, port, 4 + integer(args.button, 'button', 2), state];
  const direction = ['left','right','up','down'].indexOf(args.direction as string);
  if (args.action === 'joystick' && direction >= 0) return [2, port, direction, state];
  throw new Error('Invalid input action or direction');
}
export async function handleInputTool(name: string, args: Record<string, unknown>, gdb?: GdbProtocol): Promise<CallToolResult> {
  if (!gdb?.connected) throw new Error('Not connected to WinUAE');
  if (name !== 'winuae_input') {
    const steps = buildSequence(name, args);
    if (args.resume !== undefined && typeof args.resume !== 'boolean') throw new Error('resume must be boolean');
    await requireCommand(gdb, 'input-sequence', true);
    const result = await gdb.sendMonitorCommand(`input sequence ${steps.map(step=>step.map(n=>n.toString(16)).join(' ')).join(';')}`, true);
    if (args.resume === true) await gdb.continue();
    return { content: [{ type: 'text', text: result }] };
  }
  const command = args.action === 'status' || args.action === 'release' ? `input ${args.action}` :
    `input event ${inputEvent(args).map(n=>n.toString(16)).join(' ')}`;
  await requireCommand(gdb, 'input', true);
  return { content: [{ type: 'text', text: await gdb.sendMonitorCommand(command, true) }] };
}

// The mapping describes guest US key positions, not the host keyboard layout.
const textKeys = new Map<string, [number, boolean]>();
for (const [row, base] of [['`1234567890-=',0], ['qwertyuiop[]',0x10], ["asdfghjkl;'",0x20], ['zxcvbnm,./',0x31]] as const) {
  [...row].forEach((char,i)=>textKeys.set(char,[base+i,false]));
}
for (const char of 'abcdefghijklmnopqrstuvwxyz') textKeys.set(char.toUpperCase(),[textKeys.get(char)![0],true]);
for (const [plain, shifted] of [['`1234567890-=', '~!@#$%^&*()_+'], ['[]', '{}'], [";'", ':"'], [',./', '<>?']])
  [...plain].forEach((char,i)=>textKeys.set(shifted[i],[textKeys.get(char)![0],true]));
textKeys.set('\\',[0x0d,false]); textKeys.set('|',[0x0d,true]);
textKeys.set(' ',[0x40,false]); textKeys.set('\t',[0x42,false]); textKeys.set('\n',[0x44,false]);

export function buildSequence(name: string, args: Record<string, unknown>): number[][] {
  let steps: number[][] = [];
  if (name === 'winuae_input_sequence') {
    if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 256) throw new Error('Supply 1..256 steps');
    steps = args.steps.map(step => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid input step');
      return [integer(step.after_frames ?? 0,'after_frames',3600), ...(step.action === 'wait' ? [3,0,0,0] : inputEvent(step))];
    });
  } else {
    const hold = integer(args.hold_frames ?? 3,'hold_frames',120,1), gap = integer(args.gap_frames ?? 3,'gap_frames',120,1);
    const tap = (codes: number[]) => {
      codes.forEach(code=>steps.push([0,0,0,code,1]));
      [...codes].reverse().forEach((code,i)=>steps.push([i ? 0 : hold,0,0,code,0]));
      steps.push([gap,3,0,0,0]);
    };
    if (name === 'winuae_key_tap') {
      if (!Array.isArray(args.codes) || !args.codes.length || args.codes.length > 8) throw new Error('Supply 1..8 key codes');
      const codes = args.codes.map(code=>integer(code,'code',0x67));
      if (new Set(codes).size !== codes.length) throw new Error('Duplicate chord key');
      tap(codes);
    } else if (name === 'winuae_type_text') {
      if (args.layout !== 'us' || typeof args.text !== 'string' || !args.text.length || args.text.length > 60) throw new Error('Supply 1..60 characters and explicit layout us');
      for (const char of args.text) {
        const key = textKeys.get(char);
        if (!key) throw new Error(`Unsupported US guest character: ${JSON.stringify(char)}`);
        tap(key[1] ? [0x60,key[0]] : [key[0]]);
      }
    } else throw new Error('Unknown input tool');
  }
  if (steps.length > 256 || steps.reduce((sum,step)=>sum+step[0],0) > 3600) throw new Error('Sequence exceeds 256 events or 3600 frames; split the text/sequence');
  return steps;
}
