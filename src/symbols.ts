import type { GdbProtocol } from './gdb-protocol.js';
import { parseHunk } from './amiga-hunk.js';
import { boundedFile, integer, range } from './debug-validation.js';
import { createHash } from 'node:crypto';

interface Section { index: number; name: string; size: number; address: number }
interface Symbol { name: string; section: number; offset: number; size: number | null }
interface Symbols { format: string; sections: Section[]; symbols: Symbol[] }

// ELF32 header, section and symbol layouts from the generic ELF ABI.
// No DWARF interpretation or implicit mapping of ELF sections to DOS hunks.
export function parseSymbols(file: Buffer): Symbols {
  if (file.length > 16 * 1024 * 1024) throw new Error('Symbol file exceeds 16 MiB');
  if (file.length >= 4 && file.readUInt32BE() === 1011) {
    const hunks = parseHunk(file);
    return { format: 'hunk', sections: hunks.map(h => ({ index: h.index, name: `${h.kind}:${h.index}`, size: h.size, address: 0 })),
      symbols: hunks.flatMap(h => h.symbols.map(s => ({ ...s, section: h.index, size: null }))) };
  }
  function bytes(offset: number, size: number): Buffer {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > file.length)
      throw new Error('ELF record extends beyond file');
    return file.subarray(offset, offset + size);
  }
  const header = bytes(0, 52), type = header.readUInt16BE(16);
  if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 1 || header[5] !== 2 || header[6] !== 1 ||
      header.readUInt16BE(18) !== 4 || header.readUInt32BE(20) !== 1 || ![1, 2].includes(type) || header.readUInt16BE(40) !== 52)
    throw new Error('Expected ELF32 big-endian m68k relocatable or executable file');
  const table = header.readUInt32BE(32), entrySize = header.readUInt16BE(46), count = header.readUInt16BE(48), namesIndex = header.readUInt16BE(50);
  if (entrySize !== 40 || count < 1 || count > 4096 || namesIndex >= count || !namesIndex) throw new Error('Unsupported ELF section table');
  bytes(table, count * entrySize);
  const raw = Array.from({ length: count }, (_, i) => {
    const h = bytes(table + i * entrySize, entrySize);
    const section = { index: i, nameOffset: h.readUInt32BE(0), type: h.readUInt32BE(4), flags: h.readUInt32BE(8), address: h.readUInt32BE(12),
      offset: h.readUInt32BE(16), size: h.readUInt32BE(20), link: h.readUInt32BE(24), entrySize: h.readUInt32BE(36) };
    if (section.type !== 8) bytes(section.offset, section.size);
    if (section.flags & 0x800) throw new Error('Compressed ELF sections are unsupported');
    return section;
  });
  function string(sectionIndex: number, offset: number): string {
    const section = raw[sectionIndex];
    if (!section || section.type !== 3 || offset >= section.size) throw new Error('Invalid ELF string reference');
    const data = bytes(section.offset, section.size), end = data.indexOf(0, offset);
    if (end < 0 || end - offset > 4096) throw new Error('Unterminated or oversized ELF string');
    return data.toString('utf8', offset, end);
  }
  const sections = raw.filter(s => s.flags & 2).map(s => ({ index: s.index, name: string(namesIndex, s.nameOffset), size: s.size, address: s.address }));
  const symbols: Symbol[] = [], seen = new Set<string>();
  let entries = 0;
  for (const table of raw.filter(s => s.type === 2 || s.type === 11)) {
    if (table.entrySize !== 16 || table.size % 16) throw new Error('Invalid ELF symbol table');
    entries += table.size / 16;
    if (entries > 65536) throw new Error('ELF symbol budget exceeded');
    for (let offset = 0; offset < table.size; offset += 16) {
      const record = bytes(table.offset + offset, 16), sectionIndex = record.readUInt16BE(14);
      const section = sections.find(s => s.index === sectionIndex);
      if (!section || ![0, 1, 2].includes(record[12] & 15)) continue;
      const name = string(table.link, record.readUInt32BE()); if (!name) continue;
      const value = record.readUInt32BE(4), size = record.readUInt32BE(8);
      const relative = type === 1 ? value : value - section.address;
      // Linker-defined zero-sized NOTYPE markers may sit in alignment
      // padding beyond the last section byte. Listing them is valid; reads
      // still have to satisfy the section bounds.
      if (relative < 0 || (relative + size > section.size && ((record[12] & 15) !== 0 || size !== 0)))
        throw new Error(`Symbol ${name} exceeds its section`);
      const symbol = { name, section: sectionIndex, offset: relative, size: size || null };
      const key = JSON.stringify(symbol);
      if (!seen.has(key)) { seen.add(key); symbols.push(symbol); }
    }
  }
  return { format: 'elf32-m68k', sections, symbols };
}

export async function listSymbols(args: Record<string, unknown>) {
  const file = await boundedFile(args.file), parsed = parseSymbols(file);
  const limit = integer(args.limit ?? 256, 'limit', 1024, 1);
  if (args.prefix !== undefined && (typeof args.prefix !== 'string' || args.prefix.length > 1024)) throw new Error('Invalid symbol prefix');
  const symbols = parsed.symbols.filter(s => s.name.startsWith(args.prefix as string ?? ''));
  return { format: parsed.format, sha256: createHash('sha256').update(file).digest('hex'), sections: parsed.sections,
    symbols: symbols.slice(0, limit), total: symbols.length, truncated: symbols.length > limit };
}

export async function readSymbol(gdb: GdbProtocol, args: Record<string, unknown>) {
  const parsed = parseSymbols(await boundedFile(args.file));
  if (typeof args.symbol !== 'string' || !args.symbol || args.symbol.length > 1024) throw new Error('Expected an exact symbol name');
  const sectionFilter = args.section === undefined ? undefined : integer(args.section, 'section', 4095);
  const candidates = parsed.symbols.filter(s => s.name === args.symbol && (sectionFilter === undefined || s.section === sectionFilter));
  if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous symbol; supply its section index' : 'Symbol not found');
  const symbol = candidates[0], section = parsed.sections.find(s => s.index === symbol.section)!;
  const formats = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4 };
  const format = args.format ?? 'bytes';
  if (format !== 'bytes' && (typeof format !== 'string' || !Object.hasOwn(formats, format))) throw new Error('Unsupported scalar format');
  const elementSize = format === 'bytes' ? 1 : formats[format as keyof typeof formats];
  const size = format === 'bytes' ? integer(args.length, 'length', 4096, 1) : elementSize * integer(args.count ?? 1, 'count', 256, 1);
  const offset = integer(args.offset ?? 0, 'offset');
  if (symbol.size !== null && offset + size > symbol.size) throw new Error('Read exceeds symbol size');
  if (symbol.offset + offset + size > section.size) throw new Error('Read exceeds symbol section');
  if (args.mappings !== undefined && (!Array.isArray(args.mappings) || args.mappings.length > 256)) throw new Error('Expected at most 256 section mappings');
  const mappings = (args.mappings ?? []) as Record<string, unknown>[];
  if (mappings.some(m => !m || typeof m !== 'object')) throw new Error('Invalid section mapping');
  const matching = mappings.filter(m => m.section === section.index || m.section === section.name);
  if (matching.length > 1 || (!matching.length && parsed.format !== 'hunk')) throw new Error('ELF requires exactly one explicit mapping for this section');
  const mapping = matching[0] ?? { segment: section.index };
  const sectionOffset = integer(mapping.offset ?? 0, 'mapping offset');
  const process = args.process === undefined ? undefined : integer(args.process, 'process', 0xffffffff, 4);
  if (process !== undefined && process % 4) throw new Error('Process must be longword aligned');
  let base: number, capacity: number;
  if (mapping.address !== undefined) {
    if (mapping.segment !== undefined) throw new Error('Mapping cannot specify both address and segment');
    base = integer(mapping.address, 'mapping address'); capacity = integer(mapping.size, 'mapping size');
  } else {
    const index = integer(mapping.segment, 'segment', 255);
    await gdb.pause();
    const report = JSON.parse(await gdb.sendMonitorCommand(`segments${process === undefined ? '' : ` ${process.toString(16)}`}`));
    const matches = Array.isArray(report.segments) ? report.segments.filter((s: { index: number }) => s.index === index) : [];
    if (matches.length !== 1) throw new Error('Loaded segment not found');
    base = integer(matches[0].address, 'segment address'); capacity = integer(matches[0].size, 'segment size');
  }
  if (base + capacity > 0x100000000 || sectionOffset + section.size > capacity) throw new Error('Section does not fit mapped segment');
  const r = range(base + sectionOffset + symbol.offset + offset, size, 4096);
  const data = await gdb.readMemory(r.address, r.length);
  const values: number[] = [];
  if (format !== 'bytes') for (let i = 0; i < size; i += elementSize)
    values.push((format as string).startsWith('s') ? data.readIntBE(i, elementSize) : data.readUIntBE(i, elementSize));
  return { symbol, section, address: r.address, length: size, format, hex: data.toString('hex'),
    ...(format === 'bytes' ? {} : { values }), type_source: 'explicit caller format; no DWARF inference' };
}
