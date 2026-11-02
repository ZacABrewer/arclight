#!/usr/bin/env node
// Builds the website's brand files from design/brand/ (the single source of the logo):
//   src/assets/lockup-dark.svg, lockup-light.svg  lockups with the wordmark converted to outlines,
//                                                   so they render without the font being loaded
//   public/favicon.svg, favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png
//   public/og.png                                   1200x630 social card
// All outputs are git-ignored and rebuilt before every dev/build run.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '..');
const BRAND = resolve(SITE, '..', 'design', 'brand');
const ASSETS = join(SITE, 'src', 'assets');
const PUBLIC = join(SITE, 'public');
mkdirSync(ASSETS, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });

const require = createRequire(import.meta.url);
const fontFile = require.resolve('@fontsource/chakra-petch/files/chakra-petch-latin-700-normal.woff');
const buf = readFileSync(fontFile);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/** Replace the <text> element of a brand lockup with outlined <path>s. */
function outline(svg) {
  return svg.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/, (_m, attrs, inner) => {
    const num = (name, dflt = 0) => Number(attrs.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? dflt);
    let x = num('x');
    const y = num('y');
    const size = num('font-size', 16);
    const spacing = num('letter-spacing');
    const parts = [...inner.matchAll(/<tspan[^>]*fill="([^"]+)"[^>]*>([^<]*)<\/tspan>/g)];
    return parts
      .map(([, fill, text]) => {
        let d = '';
        for (const ch of text) {
          const glyph = font.charToGlyph(ch);
          d += glyph.getPath(x, y, size).toPathData(2);
          x += (glyph.advanceWidth / font.unitsPerEm) * size + spacing;
        }
        return `<path fill="${fill}" d="${d}"/>`;
      })
      .join('');
  });
}

const dark = outline(readFileSync(join(BRAND, 'lockup-dark-bg.svg'), 'utf8'));
const light = outline(readFileSync(join(BRAND, 'lockup-light-bg.svg'), 'utf8'));
writeFileSync(join(ASSETS, 'lockup-dark.svg'), dark);
writeFileSync(join(ASSETS, 'lockup-light.svg'), light);

copyFileSync(join(BRAND, 'mark-color.svg'), join(PUBLIC, 'favicon.svg'));
copyFileSync(join(BRAND, 'png', 'mark-32.png'), join(PUBLIC, 'favicon-32.png'));
copyFileSync(join(BRAND, 'png', 'app-icon-180.png'), join(PUBLIC, 'apple-touch-icon.png'));
copyFileSync(join(BRAND, 'png', 'app-icon-192.png'), join(PUBLIC, 'icon-192.png'));
copyFileSync(join(BRAND, 'png', 'app-icon-512.png'), join(PUBLIC, 'icon-512.png'));

// Social card: lockup centred on the brand gradient with a faint grid.
const lockupWidth = Number(dark.match(/viewBox="0 0 ([0-9.]+)/)[1]);
const inner = dark.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const tagline = 'Self-hosted media automation in one app';
let tx = 0;
const tagSize = 34;
let tagPath = '';
const tagWidth = [...tagline].reduce((w, ch) => w + (font.charToGlyph(ch).advanceWidth / font.unitsPerEm) * tagSize + 1, 0);
tx = (1200 - tagWidth) / 2;
for (const ch of tagline) {
  const g = font.charToGlyph(ch);
  tagPath += g.getPath(tx, 470, tagSize).toPathData(2);
  tx += (g.advanceWidth / font.unitsPerEm) * tagSize + 1;
}
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#0b1830"/><stop offset="1" stop-color="#02070a"/></linearGradient>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#6ef6ff" stroke-opacity="0.07" stroke-width="1"/></pattern>
  <radialGradient id="glow" cx="0.5" cy="0.45" r="0.5"><stop offset="0" stop-color="#2f7bff" stop-opacity="0.28"/><stop offset="1" stop-color="#2f7bff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/>
<rect width="1200" height="630" fill="url(#grid)"/>
<rect width="1200" height="630" fill="url(#glow)"/>
<rect x="0" y="626" width="1200" height="4" fill="#6ef6ff" fill-opacity="0.6"/>
<g transform="translate(${(1200 - lockupWidth * 2.6) / 2} 160) scale(2.6)">${inner}</g>
<path fill="#9fd8ff" d="${tagPath}"/>
</svg>`;
await sharp(Buffer.from(og)).png({ compressionLevel: 9 }).toFile(join(PUBLIC, 'og.png'));

console.log('brand-assets: lockups, icons and og.png written');
