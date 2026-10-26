#!/usr/bin/env node
// Writes packages/indexers/src/definitions/builtin/index.json: the builtin indexer definitions
// in the definition-feed index format, so this repository can serve as its own feed
// (point indexers.definitionFeed.url at the raw URL of that folder).
//
//   node scripts/build-definition-index.mjs          write index.json
//   node scripts/build-definition-index.mjs --check  exit 1 when index.json is out of date
//
// Format: { schemaVersion: 1, definitions: [{ id, version, file, sha256 }] } sorted by id.
// sha256 is over the file's UTF-8 text with CRLF normalised to LF (a Windows checkout gives
// the same digest as the LF bytes GitHub serves). version is the first 12 hex digits of it.
// The id is read from the top-level `id:` line; the package parser validates the files in tests.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'packages', 'indexers', 'src', 'definitions', 'builtin');
const target = join(dir, 'index.json');

export async function buildIndex(definitionsDir = dir) {
  const names = (await readdir(definitionsDir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  const definitions = [];
  for (const file of names) {
    const text = (await readFile(join(definitionsDir, file), 'utf8')).replace(/\r\n/g, '\n');
    const id = /^id:\s*["']?([a-z0-9._-]+)["']?\s*$/m.exec(text)?.[1];
    if (!id) throw new Error(`${file}: no top-level id`);
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    definitions.push({ id, version: sha256.slice(0, 12), file, sha256 });
  }
  definitions.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const d of definitions) {
    if (ids.has(d.id)) throw new Error(`duplicate id ${d.id}`);
    ids.add(d.id);
  }
  return { schemaVersion: SCHEMA_VERSION, definitions };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const json = `${JSON.stringify(await buildIndex(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current.replace(/\r\n/g, '\n') !== json) {
      console.error('index.json is out of date: run node scripts/build-definition-index.mjs');
      process.exit(1);
    }
    console.log('index.json is up to date');
  } else {
    await writeFile(target, json, 'utf8');
    console.log(`wrote ${target}`);
  }
}
