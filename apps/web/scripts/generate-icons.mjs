// Builds the web app's icons in public/icons from the Arclight brand kit (design/brand).
// Run: `node apps/web/scripts/generate-icons.mjs` (outputs are committed, so the Docker build
// does not need design/).
//
// - Copied as-is from design/brand: icon.svg (mark-color.svg), favicon-16/32/48.png,
//   apple-touch-icon.png (180), icon-192.png, icon-512.png.
// - Rendered here (no dependencies: the chevrons are rasterised with 4x4 supersampling and
//   written as PNG with node:zlib):
//     maskable-512.png / maskable.svg: the mark on the full-bleed dark gradient, inside the
//       80% safe circle so any launcher mask keeps it whole;
//     badge-96.png: white mark on transparent for the Android notification badge.
// - public/favicon.ico: the 16/32/48 PNGs wrapped in an ICO container (PNG-in-ICO).
import { deflateSync } from 'node:zlib';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const OUT = join(PUBLIC, 'icons');
const BRAND = join(HERE, '..', '..', '..', 'design', 'brand');

// ---- brand geometry (100-unit artboard, same as mark-color.svg) --------------------------
const STROKE = 13;
const CHEVRONS = [
  { pts: [[48, 22], [76, 50], [48, 78]], opacity: 0.45 }, // back
  { pts: [[24, 22], [52, 50], [24, 78]], opacity: 1 }, // front
];
const FROM = [0x2f, 0x7b, 0xff];
const TO = [0x6e, 0xf6, 0xff];
const BG_TOP = [0x0b, 0x18, 0x30];
const BG_BOTTOM = [0x02, 0x07, 0x0a];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Renders an RGBA image. `scale`/`offset` place the 100-unit mark on the canvas;
 * `background` is 'gradient' (opaque brand tile, full bleed) or null (transparent);
 * `white` paints the mark white instead of the gradient.
 */
function render(size, { scale, background, white = false }) {
  const SS = 4;
  const k = (size / 100) * scale; // px per mark unit
  const off = (size - 100 * k) / 2; // centre the 100-unit artboard
  const rgba = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // background
          let c = [0, 0, 0];
          let a = 0;
          if (background === 'gradient') {
            // SVG linearGradient x1=0 y1=0 x2=.6 y2=1 (objectBoundingBox on a square tile)
            const u = px / size;
            const v = py / size;
            const t = Math.max(0, Math.min(1, (u * 0.6 + v) / (0.36 + 1)));
            c = mix(BG_TOP, BG_BOTTOM, t);
            a = 1;
          }
          // chevrons, back to front (source-over)
          const mx = (px - off) / k;
          const my = (py - off) / k;
          for (const ch of CHEVRONS) {
            const d = Math.min(segDist(mx, my, ch.pts[0], ch.pts[1]), segDist(mx, my, ch.pts[1], ch.pts[2]));
            if (d > STROKE / 2) continue;
            // gradient spans the path's geometry bbox horizontally (objectBoundingBox)
            const minX = Math.min(...ch.pts.map((p) => p[0]));
            const maxX = Math.max(...ch.pts.map((p) => p[0]));
            const col = white ? [255, 255, 255] : mix(FROM, TO, Math.max(0, Math.min(1, (mx - minX) / (maxX - minX))));
            const sa = ch.opacity;
            const na = sa + a * (1 - sa);
            c = c.map((v, i) => (col[i] * sa + v * a * (1 - sa)) / na);
            a = na;
          }
          acc = [acc[0] + c[0] * a, acc[1] + c[1] * a, acc[2] + c[2] * a, acc[3] + a];
        }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const alpha = acc[3] / n;
      rgba[o + 3] = alpha;
      for (let i = 0; i < 3; i++) rgba[o + i] = alpha > 0 ? acc[i] / acc[3] : 0;
    }
  return rgba;
}

// ---- PNG / ICO encoding ---------------------------------------------------------------------
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
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) raw[row + 1 + x * 4 + i] = Math.round(rgba[o + i]);
      raw[row + 1 + x * 4 + 3] = Math.round(rgba[o + 3] * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** ICO container holding PNG images (supported by every current browser and Windows Vista+). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// The mark's outermost point (stroke included) is ~47.4 units from the centre, so scale .56
// puts it at ~26.5% of the tile: well inside the 40%-radius maskable safe zone.
const MASKABLE_SCALE = 0.56;
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#6ef6ff"/></linearGradient><linearGradient id="bg" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#0b1830"/><stop offset="1" stop-color="#02070a"/></linearGradient></defs><rect width="100" height="100" fill="url(#bg)"/><g transform="translate(22 22) scale(${MASKABLE_SCALE})"><path d="M48,22 L76,50 L48,78" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity=".45"/><path d="M24,22 L52,50 L24,78" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></g></svg>\n`;

mkdirSync(OUT, { recursive: true });
const copies = {
  'icon.svg': 'mark-color.svg',
  'favicon-16.png': 'png/mark-16.png',
  'favicon-32.png': 'png/mark-32.png',
  'favicon-48.png': 'png/mark-48.png',
  'apple-touch-icon.png': 'png/app-icon-180.png',
  'icon-192.png': 'png/app-icon-192.png',
  'icon-512.png': 'png/app-icon-512.png',
};
for (const [name, src] of Object.entries(copies)) {
  copyFileSync(join(BRAND, src), join(OUT, name));
  console.log(`${name}  <- design/brand/${src}`);
}
const rendered = {
  'maskable-512.png': png(512, render(512, { scale: MASKABLE_SCALE, background: 'gradient' })),
  'maskable.svg': Buffer.from(maskableSvg),
  'badge-96.png': png(96, render(96, { scale: 1, background: null, white: true })),
};
for (const [name, data] of Object.entries(rendered)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name}  ${data.length} bytes`);
}
const favicon = ico([16, 32, 48].map((size) => ({ size, data: readFileSync(join(OUT, `favicon-${size}.png`)) })));
writeFileSync(join(PUBLIC, 'favicon.ico'), favicon);
console.log(`favicon.ico  ${favicon.length} bytes`);
