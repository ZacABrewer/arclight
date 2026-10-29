#!/usr/bin/env node
// Usage: node scripts/build-themes.mjs [--check]
// Writes themes/index.json from the packs under themes/<id>/ (theme.json, theme.css, fonts/*.woff2,
// images/*.webp|png|jpg|jpeg|avif):
// each pack's manifest plus every file's size and sha256. Running Arclight instances read this
// index to sync new and updated packs. --check exits 1 when index.json is out of date (CI).
// Bump a pack's "version" in its theme.json whenever its files change, or instances keep the old copy.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'themes');
const check = process.argv.includes('--check');

// Text files are hashed with LF line ends: that is what git stores and what the raw URLs serve,
// whatever a Windows checkout has on disk.
const file = (dir, path) => {
  let body = readFileSync(join(dir, path));
  if (!/[.](woff2|webp|png|jpe?g|avif)$/.test(path)) body = Buffer.from(body.toString('utf8').replace(/\r\n/g, '\n'));
  return { path, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
};

const themes = [];
for (const id of readdirSync(root).sort()) {
  const dir = join(root, id);
  if (id.startsWith('.') || !statSync(dir).isDirectory()) continue;
  const manifest = JSON.parse(readFileSync(join(dir, 'theme.json'), 'utf8'));
  if (manifest.id !== id) {
    console.error(`themes/${id}/theme.json names "${manifest.id}"`);
    process.exit(1);
  }
  const files = [file(dir, 'theme.json'), file(dir, 'theme.css')];
  const fonts = join(dir, 'fonts');
  if (existsSync(fonts)) for (const name of readdirSync(fonts).sort()) if (name.endsWith('.woff2') || name.endsWith('.txt')) files.push(file(dir, `fonts/${name}`));
  const images = join(dir, 'images');
  if (existsSync(images)) for (const name of readdirSync(images).sort()) if (/[.](webp|png|jpe?g|avif)$/.test(name)) files.push(file(dir, `images/${name}`));
  themes.push({ ...manifest, files });
}

const text = `${JSON.stringify({ schema: 1, themes }, null, 2)}\n`;
const out = join(root, 'index.json');
if (check) {
  const current = existsSync(out) ? readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error('themes/index.json is out of date: run node scripts/build-themes.mjs');
    process.exit(1);
  }
  console.log(`themes/index.json is current (${themes.length} pack(s))`);
} else {
  writeFileSync(out, text);
  console.log(`themes/index.json: ${themes.map((t) => `${t.id}@${t.version}`).join(', ') || 'no packs'}`);
}
