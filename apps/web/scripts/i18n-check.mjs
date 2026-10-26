#!/usr/bin/env node
// i18n consistency check (pnpm --filter @arclight/web i18n:check). Fails when:
//   - a locale file lacks a key that en.json has, or has a key en.json does not
//   - a message does not parse (ICU-lite syntax) or uses different {params} than English
//   - code calls t('key') / <Trans k="key"> with a key missing from en.json
//   - en.json has a key nothing in src/ references (unused)
// A key counts as used when it appears as a string literal anywhere in src (t('a.b'),
// lookup tables of keys) or matches a template prefix (t(`status.${s}`) uses status.*).
//
//   node scripts/i18n-check.mjs [--src <dir>] [--locales <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messageParams } from '../src/i18n/message-format.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Check a source tree and its locale folder. Returns a list of problems (empty = pass) and
 * some counts for the summary line.
 */
export function checkI18n({ srcDir = path.join(ROOT, 'src'), localesDir = path.join(srcDir, 'i18n', 'locales'), sourceLocale = 'en' } = {}) {
  const problems = [];
  const read = (f) => JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'));
  const en = read(`${sourceLocale}.json`);
  const enKeys = Object.keys(en);
  const enParams = new Map();
  for (const k of enKeys) {
    try {
      enParams.set(k, messageParams(en[k]));
    } catch (err) {
      problems.push(`${sourceLocale}.json: ${k}: ${err.message}`);
    }
  }

  const locales = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json') && f !== `${sourceLocale}.json`);
  for (const file of locales) {
    const msgs = read(file);
    for (const k of enKeys) if (!(k in msgs)) problems.push(`${file}: missing key ${k}`);
    for (const k of Object.keys(msgs)) {
      if (!(k in en)) {
        problems.push(`${file}: key not in ${sourceLocale}.json: ${k}`);
        continue;
      }
      let params;
      try {
        params = messageParams(msgs[k]);
      } catch (err) {
        problems.push(`${file}: ${k}: ${err.message}`);
        continue;
      }
      const want = enParams.get(k);
      if (want && !sameSet(params, want)) problems.push(`${file}: ${k}: uses {${[...params].join(', ')}} but English uses {${[...want].join(', ')}}`);
    }
  }

  // Usage in code.
  const used = new Set();
  const prefixes = new Set();
  const called = []; // [file, key] from t('...') / k="..."
  const files = walk(srcDir).filter((f) => /\.(tsx?|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith(localesDir));
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/['"`]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)['"`]/g)) used.add(m[1]);
    for (const m of text.matchAll(/`([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\.)\$\{/g)) prefixes.add(m[1]);
    // Calls inside comments are examples, not usage.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const m of code.matchAll(/\bt\(\s*'([^']+)'|\bk="([^"]+)"/g)) called.push([path.relative(srcDir, f).split(path.sep).join('/'), m[1] ?? m[2]]);
  }
  for (const [file, key] of called) if (!(key in en)) problems.push(`${file}: t('${key}') is not in ${sourceLocale}.json`);
  const unused = enKeys.filter((k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
  for (const k of unused) problems.push(`${sourceLocale}.json: unused key ${k}`);

  return { problems, keys: enKeys.length, locales: locales.map((f) => f.replace(/\.json$/, '')), unused };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? path.resolve(args[i + 1]) : undefined;
  };
  const srcDir = opt('--src');
  const localesDir = opt('--locales');
  const result = checkI18n({ ...(srcDir ? { srcDir } : {}), ...(localesDir ? { localesDir } : {}) });
  for (const p of result.problems) console.error(`  ${p}`);
  const summary = `${result.keys} keys, locales: ${['en', ...result.locales].join(', ')}`;
  if (result.problems.length) {
    console.error(`i18n:check failed: ${result.problems.length} problem(s) (${summary})`);
    process.exit(1);
  }
  console.log(`i18n:check passed (${summary})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
