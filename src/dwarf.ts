import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GdbProtocol } from './gdb-protocol.js';
import { REGISTER_NAMES } from './gdb-protocol.js';
import { boundedFile, integer, range } from './debug-validation.js';
import { parseSymbols } from './symbols.js';
import { capabilities } from './target-info.js';

// The helper parses debug files but never connects to the target or executes
// guest code. All requested reads use this tool's serialized RSP connection.
export async function dwarfTool(gdb: GdbProtocol, action: 'source' | 'variable' | 'backtrace', args: Record<string, unknown>) {
  const file = await boundedFile(args.file);
  const parsed = parseSymbols(file);
  if (parsed.format !== 'elf32-m68k' || file.readUInt16BE(16) !== 2) throw new Error('DWARF tools require a linked ELF32 m68k executable');
  if (!Array.isArray(args.mappings) || !args.mappings.length || args.mappings.length > 256) throw new Error('Supply explicit runtime section mappings');
  const expression = args.expression;
  if (action === 'variable' && (typeof expression !== 'string' || expression.length > 256)) throw new Error('Supply a variable expression of at most 256 characters');
  const max_frames = integer(args.max_frames ?? 32, 'max_frames', 64, 1);
  const address = args.address === undefined ? undefined : integer(args.address, 'address');
  if (args.context !== undefined && args.context !== 'current' && args.context !== 'fault') throw new Error('Context must be current or fault');
  const process = args.process === undefined ? undefined : integer(args.process, 'process', 0xffffffff, 4);
  if (process !== undefined && process % 4) throw new Error('Process must be aligned');
  const info = await capabilities(gdb);
  if (info.mmu_model !== 0) throw new Error('DWARF inspection currently requires an MMU-disabled target; remote memory reads are physical');
  const registers = await gdb.readRegisters();
  if (args.context === 'fault') {
    const exception = JSON.parse(await gdb.sendMonitorCommand('exception'));
    const stop = gdb.lastStopReply ?? '', last = exception.last;
    const vector = /(?:^|;)winuae-exception:([\da-f]+);/i.exec(stop.slice(3));
    const pc = /(?:^|;)winuae-faultpc:([\da-f]+);/i.exec(stop.slice(3));
    if (!vector || !pc || !last || last.vector !== parseInt(vector[1],16) || last.instruction_pc !== parseInt(pc[1],16) || !Array.isArray(last.registers) || last.registers.length !== 18)
      throw new Error('No exception snapshot matching the current stop');
    REGISTER_NAMES.forEach((name, i) => registers[name] = integer(last.registers[i], name));
    registers.PC = last.instruction_pc;
  }
  let segments: { index: number; address: number; size: number }[] | undefined;
  const mappings: { section: number; linked: number; address: number; size: number }[] = [];
  for (const mapping of args.mappings) {
    if (!mapping || typeof mapping !== 'object') throw new Error('Invalid section mapping');
    const sections = parsed.sections.filter(s => mapping.section === s.index || mapping.section === s.name);
    if (sections.length !== 1) throw new Error('Mapping must identify one allocated ELF section');
    const section = sections[0], offset = integer(mapping.offset ?? 0, 'mapping offset');
    let base: number, capacity: number;
    if (mapping.address !== undefined) {
      if (mapping.segment !== undefined) throw new Error('Specify an address or segment, not both');
      base = integer(mapping.address, 'mapping address'); capacity = integer(mapping.size, 'mapping size');
    } else {
      if (!segments) {
        const report = JSON.parse(await gdb.sendMonitorCommand(`segments${process === undefined ? '' : ` ${process.toString(16)}`}`));
        if (!Array.isArray(report.segments) || report.segments.length > 256) throw new Error('Invalid segment report');
        segments = report.segments;
      }
      const index = integer(mapping.segment, 'segment', 255);
      const matches = segments!.filter(s => s.index === index);
      if (matches.length !== 1) throw new Error('Loaded segment not found');
      base = integer(matches[0].address, 'segment address'); capacity = integer(matches[0].size, 'segment size');
    }
    if (base + capacity > 0x100000000 || offset + section.size > capacity || section.address + section.size > 0x100000000)
      throw new Error('Section exceeds runtime mapping');
    const current = { section: section.index, linked: section.address, address: base + offset, size: section.size };
    if (mappings.some(m => m.section === current.section ||
      (m.address < current.address + current.size && current.address < m.address + m.size) ||
      (m.linked < current.linked + current.size && current.linked < m.linked + m.size))) throw new Error('Ambiguous or overlapping section mappings');
    mappings.push(current);
  }
  const result = await runHelper(gdb, { action, elf: file.toString('base64'), mappings, registers, expression, max_frames, address });
  return { context: args.context ?? 'current', ...result };
}

async function runHelper(gdb: GdbProtocol, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const localPython = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv-dwarf/Scripts/python.exe' : '../.venv-dwarf/bin/python', import.meta.url));
    const python = process.env.WINUAE_PYTHON || (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(python,
      ['-I', fileURLToPath(new URL('./dwarf_helper.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '', stderr = '', output = 0, bytes = 0, reads = 0;
    let result: Record<string, unknown> | undefined, error: Error | undefined, finished = false;
    let queue: Promise<void> = Promise.resolve();
    const fail = (e: unknown) => {
      if (!error) error = e instanceof Error ? e : new Error(String(e));
      child.kill();
    };
    const timer = setTimeout(() => fail(new Error('DWARF analysis exceeded 15 seconds')), 15000);
    child.on('error', e => fail(new Error(`Cannot start DWARF helper: ${e.message}. Set WINUAE_PYTHON to Python with pyelftools==0.32.`)));
    child.stdin.on('error', e => { if (!finished) fail(e); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    child.stdout.on('data', data => {
      output += data.length;
      if (output > 1024 * 1024) { fail(new Error('DWARF output budget exceeded')); return; }
      buffer += data.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        queue = queue.then(async () => {
          if (error || finished) return;
          const message = JSON.parse(line);
          if (message.error) { fail(new Error(String(message.error))); return; }
          if (message.read) {
            if (result) throw new Error('Helper requested memory after completion');
            const r = range(message.read.address, message.read.length, 4096);
            if (++reads > 512 || (bytes += r.length) > 65536) throw new Error('DWARF memory budget exceeded');
            const data = await gdb.readMemory(r.address, r.length);
            if (!error && !finished) child.stdin.write(JSON.stringify({ hex: data.toString('hex') }) + '\n');
          } else if (message.result && typeof message.result === 'object' && !result) result = message.result;
          else throw new Error('Malformed DWARF helper response');
        }).catch(fail);
      }
    });
    child.on('close', code => {
      finished = true;
      clearTimeout(timer);
      // Finish any in-flight target read before releasing the MCP tool queue.
      queue.then(() => {
        if (error) reject(error);
        else if (code !== 0 || !result || buffer) reject(new Error(`DWARF helper failed (${code}): ${stderr}`));
        else resolve(result);
      }, reject);
    });
    child.stdin.write(JSON.stringify(request) + '\n');
  });
}
