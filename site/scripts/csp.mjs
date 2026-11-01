#!/usr/bin/env node
// After `astro build`: hashes every inline <script> in dist/**/*.html and writes the hashes into
// dist/_headers (placeholder __SCRIPT_HASHES__), giving a script-src without 'unsafe-inline'.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const hashes = new Set();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.html')) {
      const html = readFileSync(p, 'utf8');
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = m[1];
        if (/\bsrc\s*=/.test(attrs)) continue;
        if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template)/i.test(attrs)) continue;
        hashes.add(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
      }
    }
  }
};
walk(DIST);

const file = join(DIST, '_headers');
const headers = readFileSync(file, 'utf8');
if (!headers.includes('__SCRIPT_HASHES__')) {
  console.error('csp: placeholder __SCRIPT_HASHES__ not found in dist/_headers');
  process.exit(1);
}
writeFileSync(file, headers.replaceAll('__SCRIPT_HASHES__', [...hashes].sort().join(' ')));
console.log(`csp: ${hashes.size} inline script hash(es) written to dist/_headers`);
