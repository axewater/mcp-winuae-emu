import { deflateSync } from 'node:zlib';
import type { GdbProtocol } from './gdb-protocol.js';
import { integer, range } from './debug-validation.js';

function chunk(name: string, bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length); out.write(name, 4, 4, 'ascii'); bytes.copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

export function planarPNG(width: number, height: number, planes: Buffer[], stride: number, palette: number[]): Buffer {
  integer(width, 'width', 2048, 1); integer(height, 'height', 2048, 1);
  integer(planes.length, 'planes', 8, 1);
  integer(stride, 'row_stride', 65536, Math.ceil(width / 8));
  if (width * height > 262144) throw new Error('Bitmap exceeds 262144 pixels');
  if (palette.length !== 2 ** planes.length) throw new Error('Palette must contain one RGB value for every color index');
  palette.forEach(c => integer(c, 'palette color', 0xffffff));
  if (planes.some(p => p.length < (height - 1) * stride + Math.ceil(width / 8))) throw new Error('Truncated bitplane');
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let color = 0;
    for (let p = 0; p < planes.length; p++) color |= ((planes[p][y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) << p;
    const rgb = palette[color], offset = y * (1 + width * 3) + 1 + x * 3;
    rows[offset] = rgb >>> 16; rows[offset + 1] = rgb >>> 8; rows[offset + 2] = rgb;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export async function readBitmap(gdb: GdbProtocol, args: Record<string, unknown>) {
  const width = integer(args.width, 'width', 2048, 1), height = integer(args.height, 'height', 2048, 1);
  const rowBytes = Math.ceil(width / 8);
  const stride = integer(args.row_stride ?? Math.ceil(width / 16) * 2, 'row_stride', 65536, rowBytes);
  if (width * height > 262144) throw new Error('Bitmap exceeds 262144 pixels');
  if (!Array.isArray(args.planes) || args.planes.length < 1 || args.planes.length > 8) throw new Error('Supply 1-8 plane addresses, least significant plane first');
  const ranges = args.planes.map(address => range(address, (height - 1) * stride + rowBytes, 2 * 1024 * 1024));
  if (ranges.reduce((n, r) => n + r.length, 0) > 2 * 1024 * 1024) throw new Error('Bitmap reads exceed 2 MiB');
  if (!Array.isArray(args.palette) || args.palette.length !== 2 ** ranges.length) throw new Error('Supply 2^planes RGB palette values');
  const palette = args.palette.map(c => integer(c, 'palette color', 0xffffff));
  await gdb.pause();
  const planes = [];
  for (const r of ranges) planes.push(await gdb.readMemory(r.address, r.length));
  return { width, height, png: planarPNG(width, height, planes, stride, palette) };
}
