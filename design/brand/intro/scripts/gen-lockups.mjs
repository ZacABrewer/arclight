#!/usr/bin/env node
// Writes design/brand/lockup-dark-bg.svg and lockup-light-bg.svg: the fast-forward mark next to
// the "Light Slice" wordmark (wordmark.svg, Michroma outlines with a light line through them).
// The letters are already outlines, so the lockups render without any font loaded.
//   node scripts/gen-lockups.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BRAND = resolve(here, '..', '..');
const word = readFileSync(join(BRAND, 'intro', 'wordmark.svg'), 'utf8');
const letters = word.match(/<path d="([^"]+)"/)[1];

// wordmark.svg letters run from y = 27 to 90 over 738 units; scale them to the old lockup's cap height.
const SCALE = 0.42;
const X = 88;
const Y = 26.4 - 27 * SCALE;
const WIDTH = Math.ceil(X + 738 * SCALE + 6);

const mark = `<g transform="translate(0 4) scale(.72)"><path d="M48,22 L76,50 L48,78" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity=".45"/><path d="M24,22 L52,50 L24,78" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></g>`;

function lockup({ from, to, line }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} 80" width="${WIDTH}" height="80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f7bff"/><stop offset="1" stop-color="#6ef6ff"/></linearGradient><linearGradient id="w" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="738" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient><linearGradient id="l" gradientUnits="userSpaceOnUse" x1="0" x2="738" y1="0" y2="0"><stop offset="0" stop-color="${line}" stop-opacity="0"/><stop offset=".5" stop-color="${line}"/><stop offset="1" stop-color="${line}" stop-opacity="0"/></linearGradient><mask id="s" maskUnits="userSpaceOnUse" x="-20" y="0" width="778" height="120"><rect x="-20" width="778" height="120" fill="#fff"/><rect x="-20" y="55.5" width="778" height="6" fill="#000"/></mask><filter id="gl" x="-10%" y="-600%" width="120%" height="1300%"><feGaussianBlur stdDeviation="3"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${mark}<g transform="translate(${X} ${Y.toFixed(2)}) scale(${SCALE})"><path d="${letters}" fill="url(#w)" mask="url(#s)"/><rect y="57.75" width="738" height="1.5" fill="url(#l)" filter="url(#gl)"/></g></svg>\n`;
}

writeFileSync(join(BRAND, 'lockup-dark-bg.svg'), lockup({ from: '#2f7bff', to: '#6ef6ff', line: '#6ef6ff' }));
writeFileSync(join(BRAND, 'lockup-light-bg.svg'), lockup({ from: '#0b1830', to: '#2f7bff', line: '#2f7bff' }));
console.log(`gen-lockups: lockup-dark-bg.svg and lockup-light-bg.svg written (${WIDTH}x80)`);
