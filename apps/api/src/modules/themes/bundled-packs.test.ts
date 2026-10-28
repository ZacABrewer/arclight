import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPacks } from './store.js';

// Every pack shipped in the repository's themes/ folder must pass the same checks a synced pack
// does (manifest schema, stylesheet rules, font files and sizes), or the API would skip it.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'themes');
const dirs = existsSync(root) ? readdirSync(root).filter((d) => !d.startsWith('.') && statSync(join(root, d)).isDirectory()) : [];

describe('bundled theme packs', () => {
  it('finds the repository themes/ folder', () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('reads every pack without problems', () => {
    const { packs, problems } = readPacks(root, 'bundled');
    expect(problems).toEqual([]);
    expect(packs.map((p) => p.manifest.id).sort()).toEqual([...dirs].sort());
  });

  it('gives each pack a name, a description and at least the background and accent swatches', () => {
    const { packs } = readPacks(root, 'bundled');
    for (const p of packs) {
      expect(p.manifest.name.length, p.manifest.id).toBeGreaterThan(0);
      expect(p.manifest.description.length, p.manifest.id).toBeGreaterThan(0);
      expect(p.manifest.swatches.length, p.manifest.id).toBeGreaterThanOrEqual(2);
    }
  });
});
