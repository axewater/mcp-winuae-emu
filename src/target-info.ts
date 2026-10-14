import type { GdbProtocol } from './gdb-protocol.js';
export async function capabilities(gdb: GdbProtocol, live = false) {
  let result;
  try { result = JSON.parse(await gdb.sendMonitorCommand('capabilities', live)); }
  catch (e) { throw new Error(`Target does not provide capability discovery; use a WinUAE version with the built-in GDB server. ${String(e)}`); }
  if (result.protocol !== 1 || !Array.isArray(result.commands) || !result.commands.every((c: unknown) => typeof c === 'string'))
    throw new Error('Unsupported target capability response');
  return result as { protocol: number; commands: string[]; execution: string[]; cpu_model: number; mmu_model: number; memory_addressing: string };
}
export async function requireCommand(gdb: GdbProtocol, command: string, live = false) {
  const info = await capabilities(gdb, live);
  if (!info.commands.includes(command)) throw new Error(`Target does not support ${command} in this configuration`);
  return info;
}
