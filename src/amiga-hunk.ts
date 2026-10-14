// Amiga ROM Kernel Reference Manual: DOS, executable file format (chapter 11).
// Deliberately excludes overlays, external references and relative relocations.
import type { GdbProtocol } from './gdb-protocol.js';
import { requireCommand } from './target-info.js';
import { integer, range } from './debug-validation.js';

export interface Hunk {
  index: number; size: number; kind: 'code' | 'data' | 'bss';
  memory: 'any' | 'chip' | 'fast'; data: Buffer;
  relocations: { offset: number; target: number }[];
  symbols: { name: string; offset: number }[];
}
export function parseHunk(file: Buffer): Hunk[] {
  if (file.length > 16 * 1024 * 1024) throw new Error('Hunk file exceeds 16 MiB');
  let cursor = 0;
  function bytes(n: number): Buffer {
    if (!Number.isSafeInteger(n) || n < 0 || n > file.length - cursor) throw new Error(`Truncated hunk at ${cursor}`);
    const result = file.subarray(cursor, cursor + n); cursor += n; return result;
  }
  const u32 = () => bytes(4).readUInt32BE();
  const u16 = () => bytes(2).readUInt16BE();
  if (u32() !== 1011) throw new Error('Expected HUNK_HEADER executable');
  if (u32() !== 0) throw new Error('Resident-library dependencies are unsupported');
  const count = u32(), first = u32(), last = u32();
  if (!count || count > 256 || first !== 0 || last !== count - 1) throw new Error('Unsupported hunk table or overlay');
  let total = 0, symbolCount = 0, relocationCount = 0;
  const hunks: Hunk[] = [];
  for (let i = 0; i < count; i++) {
    const descriptor = u32(), flags = Math.floor(descriptor / 0x40000000);
    if (flags === 3) throw new Error('Extended memory attributes are unsupported');
    const size = (descriptor % 0x40000000) * 4;
    total += size;
    if (total > 8 * 1024 * 1024) throw new Error('Hunk allocation exceeds 8 MiB');
    hunks.push({ index: i, size, kind: 'bss', memory: flags === 1 ? 'chip' : flags === 2 ? 'fast' : 'any',
      data: Buffer.alloc(0), relocations: [], symbols: [] });
  }
  for (const hunk of hunks) {
    let payload = false, ended = false;
    const offsets = new Set<number>();
    while (!ended) {
      const tag = u32() % 0x40000000;
      if (tag === 1000 || tag === 1009) { bytes(u32() * 4); continue; } // NAME, DEBUG
      if (tag >= 1001 && tag <= 1003) {
        if (payload) throw new Error('Duplicate hunk payload');
        const size = u32() * 4;
        if (size > hunk.size) throw new Error('Payload exceeds reserved hunk size');
        hunk.kind = tag === 1001 ? 'code' : tag === 1002 ? 'data' : 'bss';
        hunk.data = tag === 1003 ? Buffer.alloc(0) : bytes(size);
        payload = true;
      } else if (tag === 1004 || tag === 1020 || tag === 1015) {
        if (!payload) throw new Error('Relocations precede payload');
        const number = tag === 1004 ? u32 : u16;
        for (;;) {
          const n = number(); if (!n) break;
          relocationCount += n;
          if (relocationCount > 262144) throw new Error('Too many relocations');
          const target = number();
          if (target >= count) throw new Error('Invalid relocation target');
          for (let i = 0; i < n; i++) {
            const offset = number();
            if (offset % 2 || offset + 4 > hunk.size || offsets.has(offset) || offsets.has(offset - 2) || offsets.has(offset + 2))
              throw new Error('Invalid or overlapping relocation offset');
            offsets.add(offset); hunk.relocations.push({ offset, target });
          }
        }
        if (tag !== 1004 && cursor % 4) bytes(2);
      } else if (tag === 1008) {
        if (!payload) throw new Error('Symbols precede payload');
        for (;;) {
          const words = u32(); if (!words) break;
          if (++symbolCount > 65536 || words > 256) throw new Error('Symbol budget exceeded');
          const raw = bytes(words * 4), end = raw.indexOf(0);
          const name = raw.subarray(0, end < 0 ? raw.length : end).toString('latin1');
          const offset = u32();
          if (!name || offset > hunk.size) throw new Error('Invalid hunk symbol');
          hunk.symbols.push({ name, offset });
        }
      } else if (tag === 1010 && payload) ended = true;
      else throw new Error(`Unsupported hunk record ${tag}`);
    }
  }
  if (cursor !== file.length) throw new Error('Trailing data or unsupported overlay');
  return hunks;
}

export function relocateHunks(hunks: Hunk[], supplied: unknown) {
  if (!Array.isArray(supplied) || supplied.length !== hunks.length) throw new Error('Supply one placement per hunk');
  const regions = supplied.map((p, i) => {
    const address = integer(p?.address, 'placement address');
    const capacity = integer(p?.capacity, 'placement capacity', 8 * 1024 * 1024);
    if (address % 4 || capacity < hunks[i].size || address + capacity > 0x100000000) throw new Error('Invalid placement capacity or alignment');
    if (p.memory !== 'chip' && p.memory !== 'fast') throw new Error('Placement memory must be chip or fast');
    if (hunks[i].memory !== 'any' && p.memory !== hunks[i].memory) throw new Error('Placement conflicts with hunk memory requirements');
    return { address, capacity };
  });
  for (let i = 0; i < regions.length; i++) for (let j = 0; j < i; j++) {
    const a = regions[i], b = regions[j];
    if (a.capacity && b.capacity && a.address < b.address + b.capacity && b.address < a.address + a.capacity)
      throw new Error('Hunk placements overlap');
  }
  const images = hunks.map(h => { const b = Buffer.alloc(h.size); h.data.copy(b); return b; });
  hunks.forEach((h, i) => h.relocations.forEach(r => {
    const value = images[i].readUInt32BE(r.offset) + regions[r.target].address;
    if (value > 0xffffffff) throw new Error('Relocation overflows the guest address space');
    images[i].writeUInt32BE(value, r.offset);
  }));
  return { regions, images };
}

export async function loadHunks(gdb: GdbProtocol, hunks: Hunk[], placements: unknown) {
  const { regions, images } = relocateHunks(hunks, placements);
  await requireCommand(gdb, 'memory-check');
  for (let i = 0; i < hunks.length; i++) if (images[i].length) {
    const check = JSON.parse(await gdb.sendMonitorCommand(`memory-check ${regions[i].address.toString(16)} ${images[i].length.toString(16)}`));
    const claimed = (placements as { memory: string }[])[i].memory;
    if (check.writable_ram !== true || check.memory !== claimed) throw new Error(`Hunk ${i} placement disagrees with target RAM type`);
  }
  await gdb.pause();
  const backups: Buffer[] = [];
  for (let i = 0; i < hunks.length; i++) backups.push(images[i].length ? await gdb.readMemory(regions[i].address, images[i].length) : Buffer.alloc(0));
  let attempted = -1;
  try {
    for (let i = 0; i < hunks.length; i++) {
      attempted = i;
      if (!images[i].length) continue;
      await gdb.writeMemory(regions[i].address, images[i]);
      if (!(await gdb.readMemory(regions[i].address, images[i].length)).equals(images[i])) throw new Error(`Hunk ${i} verification failed`);
    }
  } catch (e) {
    const failures: number[] = [];
    for (let i = attempted; i >= 0; i--) if (backups[i].length) {
      try {
        await gdb.writeMemory(regions[i].address, backups[i]);
        if (!(await gdb.readMemory(regions[i].address, backups[i].length)).equals(backups[i])) failures.push(i);
      } catch { failures.push(i); }
    }
    throw new Error(`${String(e)}; ${failures.length ? `rollback failed for hunks ${failures.join(',')}; memory may be partially modified` : 'original bytes restored'}`);
  }
  return hunks.map((h, i) => ({ index: i, address: regions[i].address, size: h.size, kind: h.kind, memory: h.memory }));
}
