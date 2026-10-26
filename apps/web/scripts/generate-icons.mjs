// Generates the PWA icons in public/icons from the Arclight diamond mark (Design Kit: a
// square outline rotated 45° with a filled inner diamond, cyan #6ef6ff on black).
// No dependencies: shapes are rasterised here with 4x4 supersampling and written as PNG
// with node:zlib. Run: `node apps/web/scripts/generate-icons.mjs` (outputs are committed).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BG = [0, 0, 0];
const CYAN = [0x6e, 0xf6, 0xff];

/**
 * `scale` = outer square side as a fraction of the canvas (before the 45° turn).
 * Proportions follow <Mark>: border 1.5px and inner square 35% at a 40px mark.
 */
function mark(size, scale) {
  const side = size * scale;
  const half = Math.SQRT1_2;
  const outer = side * half; // L1 radius of the rotated outer square
  const stroke = Math.max(side * 0.06, 1.5) * Math.SQRT2; // a little heavier than 1.5/40 so it reads at 48px
  const inner = side * 0.35 * half;
  return { outer, stroke, inner };
}

function coverage(px, py, size, m) {
  const c = size / 2;
  const SS = 4;
  let hit = 0;
  for (let sy = 0; sy < SS; sy++)
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS - c;
      const y = py + (sy + 0.5) / SS - c;
      const d = Math.abs(x) + Math.abs(y);
      if ((d <= m.outer && d >= m.outer - m.stroke) || d <= m.inner) hit++;
    }
  return hit / (SS * SS);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, scale) {
  const m = mark(size, scale);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, size, m);
      for (let i = 0; i < 3; i++) raw[row + 1 + x * 3 + i] = Math.round(BG[i] * (1 - a) + CYAN[i] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function svg(scale) {
  const size = 512;
  const m = mark(size, scale);
  const c = size / 2;
  const d = (r) => `M${c} ${c - r}L${c + r} ${c}L${c} ${c + r}L${c - r} ${c}Z`;
  const mid = m.outer - m.stroke / 2;
  // L1 stroke width → perpendicular stroke width on a 45° edge.
  const w = (m.stroke / Math.SQRT2).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#000"/><path d="${d(mid)}" fill="none" stroke="#6ef6ff" stroke-width="${w}"/><path d="${d(m.inner)}" fill="#6ef6ff"/></svg>\n`;
}

mkdirSync(OUT, { recursive: true });
// "any" icons: the mark fills ~half the tile. Maskable: kept inside the 80% safe circle.
const files = {
  'icon-192.png': png(192, 0.42),
  'icon-512.png': png(512, 0.42),
  'maskable-512.png': png(512, 0.34),
  'apple-touch-icon.png': png(180, 0.42),
  'favicon-32.png': png(32, 0.6),
  'icon.svg': svg(0.42),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name}  ${data.length} bytes`);
}
