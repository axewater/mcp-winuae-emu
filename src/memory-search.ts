import type { GdbProtocol } from './gdb-protocol.js';
import { hexBytes, integer, range } from './debug-validation.js';

export async function searchMemory(gdb: GdbProtocol, args: Record<string, unknown>) {
  const r = range(args.address, args.length, 16 * 1024 * 1024);
  const pattern = hexBytes(args.hex, 4096);
  if (pattern.length > r.length) throw new Error('Pattern exceeds search range');
  const limit = integer(args.max_matches ?? 256, 'max_matches', 4096, 1);
  const alignment = integer(args.alignment ?? 1, 'alignment', 4096, 1);
  await gdb.pause();
  const matches: number[] = [];
  let carry = Buffer.alloc(0);
  for (let offset = 0; offset < r.length;) {
    const size = Math.min(65536, r.length - offset);
    const data = Buffer.concat([carry, await gdb.readMemory(r.address + offset, size)]);
    const base = r.address + offset - carry.length;
    let at = data.indexOf(pattern);
    while (at >= 0) {
      const address = base + at;
      if (address % alignment === 0) {
        matches.push(address);
        if (matches.length === limit) return { ...r, matches, limit_reached: true,
          next_address: address + 1, remaining: r.address + r.length - address - 1 };
      }
      at = data.indexOf(pattern, at + 1);
    }
    offset += size;
    carry = data.subarray(Math.max(0, data.length - pattern.length + 1));
  }
  return { ...r, matches, limit_reached: false, next_address: null, remaining: 0 };
}
