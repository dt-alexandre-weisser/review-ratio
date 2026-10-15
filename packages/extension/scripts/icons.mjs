/**
 * Generates the extension icons as PNG files without any image library: a green disc with a
 * white ↑/↓ pair. Deterministic, so the build never needs binary files in the repository.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** @param {number} size @param {(x: number, y: number) => [number, number, number, number]} shade */
export function png(size, shade) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = shade(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GREEN = [31, 136, 61];

/** Supersampled shader: a green disc with a white up arrow (left) and down arrow (right). */
function iconShader(size) {
  const samples = 4;
  return (x, y) => {
    let disc = 0;
    let glyph = 0;
    for (let sy = 0; sy < samples; sy += 1) {
      for (let sx = 0; sx < samples; sx += 1) {
        const px = (x + (sx + 0.5) / samples) / size;
        const py = (y + (sy + 0.5) / samples) / size;
        const dx = px - 0.5;
        const dy = py - 0.5;
        if (dx * dx + dy * dy <= 0.25) disc += 1;
        if (arrow(px, py, 0.33, true) || arrow(px, py, 0.67, false)) glyph += 1;
      }
    }
    const total = samples * samples;
    const a = disc / total;
    const g = glyph / total;
    const r = Math.round(GREEN[0] * (1 - g) + 255 * g);
    const gr = Math.round(GREEN[1] * (1 - g) + 255 * g);
    const b = Math.round(GREEN[2] * (1 - g) + 255 * g);
    return [r, gr, b, Math.round(a * 255)];
  };
}

/** An arrow centred on `cx`, pointing up or down, in unit coordinates. */
function arrow(px, py, cx, up) {
  const shaft = Math.abs(px - cx) <= 0.045 && py >= 0.3 && py <= 0.7;
  const tipY = up ? 0.28 : 0.72;
  const dir = up ? 1 : -1;
  const dy = (py - tipY) * dir;
  const head = dy >= 0 && dy <= 0.16 && Math.abs(px - cx) <= dy * 0.95;
  return shaft || head;
}

export function writeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    writeFileSync(join(dir, `icon-${size}.png`), png(size, iconShader(size)));
  }
}
