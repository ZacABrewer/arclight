#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs <X.Y.Z>
// Sets "version" in the root, apps/api and apps/web package.json files.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/bump-version.mjs <X.Y.Z>');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const rel of ['package.json', 'apps/api/package.json', 'apps/web/package.json']) {
  const file = join(root, rel);
  const text = readFileSync(file, 'utf8');
  if (!/"version":\s*"[^"]*"/.test(text)) {
    console.error(`No version field found in ${rel}`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));
  console.log(`${rel} -> ${version}`);
}
