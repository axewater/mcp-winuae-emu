import { GdbProtocol, REGISTER_NAMES } from './gdb-protocol.js';
import { MAX_CAPTURE, range } from './debug-validation.js';

export async function captureSnapshot(gdb: GdbProtocol, requested: unknown = []) {
  if (!Array.isArray(requested) || requested.length > 16) throw new Error('Supply at most 16 memory ranges');
  const ranges = requested.map(r => range(r?.address, r?.length));
  if (ranges.reduce((n, r) => n + r.length, 0) > MAX_CAPTURE) throw new Error('Snapshot exceeds 256 KiB');
  await gdb.pause();
  const registers = await gdb.readRegisters();
  const memory = [];
  for (const r of ranges) memory.push({ ...r, hex: (await gdb.readMemory(r.address, r.length)).toString('hex') });
  return { format: 'winuae-snapshot-v1', captured_at: new Date().toISOString(),
    stop_reply: gdb.lastStopReply, registers, memory };
}

export async function postmortem(gdb: GdbProtocol) {
  const snapshot = await captureSnapshot(gdb);
  const errors: Record<string, string> = {};
  async function optional<T>(name: string, action: () => Promise<T>): Promise<T | null> {
    try { return await action(); }
    catch (e) { errors[name] = e instanceof Error ? e.message : String(e); return null; }
  }
  const exception = await optional('exception', async () => JSON.parse(await gdb.sendMonitorCommand('exception')));
  const stop = snapshot.stop_reply ?? '';
  const vector = /(?:^|;)winuae-exception:([\da-f]+);/i.exec(stop.slice(3));
  const pc = /(?:^|;)winuae-faultpc:([\da-f]+);/i.exec(stop.slice(3));
  const last = exception?.last;
  const currentFault = !!(vector && pc && last && last.vector === parseInt(vector[1], 16) &&
    last.instruction_pc === parseInt(pc[1], 16) && Array.isArray(last.registers) &&
    last.registers.length === 18 && last.registers.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff));
  const faultRegisters = currentFault ? Object.fromEntries(REGISTER_NAMES.map((name, i) => [name, last.registers[i]])) : null;
  const context = faultRegisters ?? snapshot.registers;
  // Exception snapshots precede stack-frame construction; current registers
  // already describe entry to the exception handler. Preserve both contexts.
  const instructionPC = currentFault ? last.instruction_pc : context.PC;
  const disassembly = await optional('disassembly', () => gdb.sendMonitorCommand(`disasm ${instructionPC.toString(16)} 12`));
  const stack = await optional('stack', async () => {
    const r = range(context.A7, 256);
    return { ...r, hex: (await gdb.readMemory(r.address, r.length)).toString('hex') };
  });
  const segments = await optional('segments', async () => JSON.parse(await gdb.sendMonitorCommand('segments')));
  const guest_output = await optional('guest_output', async () => JSON.parse(await gdb.sendMonitorCommand('guest-output read')));
  return { format: 'winuae-postmortem-v1', snapshot,
    diagnosis_context: currentFault ? 'fault' : 'current',
    fault: currentFault ? { ...last, instruction_pc: instructionPC, registers: faultRegisters } : null,
    last_exception: exception, disassembly, stack, segments, guest_output, errors };
}
