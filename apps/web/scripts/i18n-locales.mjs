#!/usr/bin/env node
// Sync every locale file with en.json (pnpm --filter @arclight/web i18n:locales).
//   - keys missing from a locale get a placeholder: the English text prefixed with the
//     locale code ("[de] Add series"), so untranslated strings are visible in the UI
//   - placeholders whose English changed are refreshed; real translations are kept
//   - keys no longer in en.json are removed
// Files are written sorted, two-space JSON, like en.json.
//
//   node scripts/i18n-locales.mjs [de fr ...]     (default: every locale file + the shipped set)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'src', 'i18n', 'locales');
const SHIPPED = ['de', 'fr', 'es', 'nl'];

export const placeholder = (code, english) => `[${code}] ${english}`;
const isPlaceholder = (code, value) => typeof value === 'string' && value.startsWith(`[${code}] `);

/** The synced messages for one locale. */
export function syncLocale(code, en, existing = {}) {
  const out = {};
  for (const k of Object.keys(en).sort()) {
    const have = existing[k];
    out[k] = have === undefined || isPlaceholder(code, have) ? placeholder(code, en[k]) : have;
  }
  return out;
}

function main() {
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  const present = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json') && f !== 'en.json').map((f) => f.replace(/\.json$/, ''));
  const codes = process.argv.slice(2).length ? process.argv.slice(2) : [...new Set([...SHIPPED, ...present])];
  for (const code of codes) {
    const file = path.join(LOCALES_DIR, `${code}.json`);
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const synced = syncLocale(code, en, existing);
    const translated = Object.entries(synced).filter(([, v]) => !isPlaceholder(code, v)).length;
    fs.writeFileSync(file, `${JSON.stringify(synced, null, 2)}\n`);
    console.log(`${code}: ${Object.keys(synced).length} keys, ${translated} translated`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
