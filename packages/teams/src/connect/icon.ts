// A bot's picture, as Teams takes one: a PNG of exactly 192 by 192 pixels.
// An agent's avatar in Voiceflow is whatever size it was uploaded at, and
// Microsoft's command refuses any other ("Icon must be 192x192px"). So the
// picture is read, cut to a square about its middle, and scaled, here: PNG
// in, PNG out, with nothing but Node's own zlib.
//
// Only a PNG is read. Another kind of image (a JPEG, a WebP) is said to be one,
// and the bot gets Voiceflow's icon, which is a PNG.
import { deflateSync, inflateSync } from 'node:zlib';

/** The side of a Teams app's colour icon, in pixels. */
export const TEAMS_ICON_SIZE = 192;
/** The largest picture read: a larger one is refused, not unpacked. */
const MAX_PIXELS = 4096 * 4096;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface Pixels {
  width: number;
  height: number;
  /** Four bytes a pixel: red, green, blue, and how opaque. */
  rgba: Uint8Array;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((byte, i) => bytes[i] === byte);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reads a PNG's pixels. Throws, with why, for one it can't read. */
export function decodePng(bytes: Uint8Array): Pixels {
  if (!isPng(bytes)) throw new Error("it isn't a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: { width: number; height: number; depth: number; type: number; interlace: number } | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length < length) throw new Error('it is cut short');
    if (type === 'IHDR') {
      header = { width: view.getUint32(at + 8), height: view.getUint32(at + 12), depth: bytes[at + 16]!, type: bytes[at + 17]!, interlace: bytes[at + 20]! };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!header) throw new Error('it has no header');
  const { width, height, depth, type, interlace } = header;
  const channels = CHANNELS[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && type !== 0 && type !== 3)) throw new Error('it is of a kind this can’t read');
  if (interlace !== 0) throw new Error('it is interlaced, which this can’t read');
  if (!width || !height || width * height > MAX_PIXELS) throw new Error(`it is ${width} by ${height} pixels, which is too large`);
  if (type === 3 && !palette) throw new Error('it has no palette');

  const bitsPerPixel = channels * depth;
  const step = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: height * (rowBytes + 1) + 1024 });
  } catch (error) {
    throw new Error(`its pixels couldn't be unpacked (${(error as Error).message})`);
  }
  if (raw.length < height * (rowBytes + 1)) throw new Error('it is cut short');

  // Each row was written as its difference from the pixels beside and above it: undone here, a row at a time.
  const rows = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!;
    const from = y * (rowBytes + 1) + 1;
    const to = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= step ? rows[to + i - step]! : 0;
      const up = y ? rows[to - rowBytes + i]! : 0;
      const corner = y && i >= step ? rows[to - rowBytes + i - step]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const a = Math.abs(p - left);
        const b = Math.abs(p - up);
        const c = Math.abs(p - corner);
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      } else if (filter !== 0) throw new Error('it is of a kind this can’t read');
      rows[to + i] = (raw[from + i]! + predicted) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const scale = 255 / ((1 << Math.min(depth, 8)) - 1);
  /** One sample of a row: a whole byte, the high byte of two, or a few bits of one. */
  const sample = (row: number, index: number): number => {
    if (depth === 8) return rows[row + index]!;
    if (depth === 16) return rows[row + index * 2]!;
    const bit = index * depth;
    return (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  // A grey picture can name one shade as see-through.
  const clearGrey = type === 0 && transparency && transparency.length >= 2 ? (depth === 16 ? transparency[0]! : transparency[1]!) : -1;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (type === 3) {
        const index = sample(row, x);
        rgba[out] = palette![index * 3] ?? 0;
        rgba[out + 1] = palette![index * 3 + 1] ?? 0;
        rgba[out + 2] = palette![index * 3 + 2] ?? 0;
        rgba[out + 3] = transparency?.[index] ?? 255;
      } else if (type === 0 || type === 4) {
        const grey = sample(row, x * channels);
        const shade = depth < 8 ? Math.round(grey * scale) : grey;
        rgba[out] = rgba[out + 1] = rgba[out + 2] = shade;
        rgba[out + 3] = type === 4 ? sample(row, x * channels + 1) : grey === clearGrey ? 0 : 255;
      } else {
        rgba[out] = sample(row, x * channels);
        rgba[out + 1] = sample(row, x * channels + 1);
        rgba[out + 2] = sample(row, x * channels + 2);
        rgba[out + 3] = type === 6 ? sample(row, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * A picture as a square of `size` pixels: the largest square about its middle, scaled. Each new pixel is the
 * average of the old ones it covers, weighed by how much of each it covers, so a large picture comes down smooth.
 */
export function squareOf({ width, height, rgba }: Pixels, size: number): Pixels {
  const side = Math.min(width, height);
  const left = (width - side) / 2;
  const top = (height - side) / 2;
  const ratio = side / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = top + y * ratio;
    const y1 = y0 + ratio;
    for (let x = 0; x < size; x++) {
      const x0 = left + x * ratio;
      const x1 = x0 + ratio;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < height; sy++) {
        const tall = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < width; sx++) {
          const weight = tall * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          if (weight <= 0) continue;
          const at = (sy * width + sx) * 4;
          // Colour counts by how opaque it is: a see-through pixel's colour mustn't tint its neighbours.
          const opaque = rgba[at + 3]! * weight;
          r += rgba[at]! * opaque;
          g += rgba[at + 1]! * opaque;
          b += rgba[at + 2]! * opaque;
          a += opaque;
          area += weight;
        }
      }
      const to = (y * size + x) * 4;
      if (a > 0) {
        out[to] = Math.round(r / a);
        out[to + 1] = Math.round(g / a);
        out[to + 2] = Math.round(b / a);
      }
      out[to + 3] = area > 0 ? Math.round(a / area) : 0;
    }
  }
  return { width: size, height: size, rgba: out };
}

let table: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Writes pixels as a PNG: eight bits a channel, with transparency. */
export function encodePng({ width, height, rgba }: Pixels): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

/** An image as a Teams app's colour icon, or why it can't be one. */
export function teamsIcon(bytes: Uint8Array): { png: Uint8Array } | { problem: string } {
  if (!isPng(bytes)) return { problem: "it isn't a PNG, and only a PNG can be made the 192 by 192 pixels Teams takes" };
  try {
    const pixels = decodePng(bytes);
    // Already the size Teams takes: it goes as it is.
    if (pixels.width === TEAMS_ICON_SIZE && pixels.height === TEAMS_ICON_SIZE) return { png: bytes };
    return { png: encodePng(squareOf(pixels, TEAMS_ICON_SIZE)) };
  } catch (error) {
    return { problem: `it couldn't be read: ${(error as Error).message}` };
  }
}
