import { open } from 'node:fs/promises';

export const MAX_CAPTURE = 256 * 1024;
export function integer(value: unknown, name: string, max = 0xffffffff, min = 0): number {
  let n: unknown = value;
  if (typeof value === 'string') {
    if (/^\$[\da-fA-F]+$/.test(value)) n = Number(`0x${value.slice(1)}`);
    else if (/^(?:0x[\da-fA-F]+|[0-9]+)$/.test(value)) n = Number(value);
  }
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}
export function range(address: unknown, length: unknown, max = MAX_CAPTURE) {
  const start = integer(address, 'address');
  const size = integer(length, 'length', max, 1);
  if (start + size > 0x100000000) throw new Error('Address range wraps the 32-bit address space');
  return { address: start, length: size };
}
export function hexBytes(value: unknown, max = 4096): Buffer {
  if (typeof value !== 'string' || !/^(?:[\da-fA-F]{2})+$/.test(value) || value.length > max * 2)
    throw new Error(`Expected 1-${max} bytes as an even-length hexadecimal string`);
  return Buffer.from(value, 'hex');
}
export async function boundedFile(filename: unknown, max = 16 * 1024 * 1024): Promise<Buffer> {
  if (typeof filename !== 'string' || !filename.length) throw new Error('Expected a file path');
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) throw new Error(`Expected a regular file of at most ${max} bytes`);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('File changed while reading');
      offset += bytesRead;
    }
    if ((await file.stat()).size !== data.length) throw new Error('File changed while reading');
    return data;
  } finally { await file.close(); }
}
