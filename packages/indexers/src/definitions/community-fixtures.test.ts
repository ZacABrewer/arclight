import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDEXER_PRESETS } from '../presets.js';
import { DefinitionCatalogue, limitingWarnings, parseDefinitionYaml, peekDefinitionYaml } from './catalogue.js';

// Community-catalogue style files (hand-written fixtures, see fixtures/community): what loads,
// what loads with a limitation, and what is reported instead of loaded.

const DIR = fileURLToPath(new URL('../../fixtures/community/', import.meta.url));

describe('community fixtures through the loader', () => {
  it('loads the good files and records the broken ones without stopping', async () => {
    const catalogue = await DefinitionCatalogue.fromDirectories([DIR]);
    expect(catalogue.ids()).toEqual(['alphatracker', 'betaprivate', 'deltahyphen']);
    const failed = catalogue.errors.map((e) => [e.file.replace(/\\/g, '/').split('/').pop(), e.error.code]);
    expect(failed).toEqual([
      ['broken.yml', 'invalid_yaml'],
      ['gammamismatch.yml', expect.any(String)],
    ]);
    expect(catalogue.errors[1]?.error.message).toMatch(/does not match file name/);
  });

  it('marks a login captcha as a limitation, not other warnings', async () => {
    const beta = parseDefinitionYaml(await readFile(`${DIR}betaprivate.yml`, 'utf8'), { fileKey: 'betaprivate' });
    expect(limitingWarnings(beta)).toEqual([expect.stringMatching(/captcha/)]);
    const alpha = parseDefinitionYaml(await readFile(`${DIR}alphatracker.yml`, 'utf8'), { fileKey: 'alphatracker' });
    expect(limitingWarnings(alpha)).toEqual([]);
    expect(limitingWarnings({ warnings: ['certificates are parsed and ignored'] })).toEqual([]);
  });

  it('peeks identity fields of files that do not load', async () => {
    expect(peekDefinitionYaml(await readFile(`${DIR}gammamismatch.yml`, 'utf8'))).toEqual({
      id: 'gamma-api',
      name: 'GammaMismatch',
      description: 'Semi-private test tracker with a wrong id',
      language: 'fr-FR',
      type: 'semi-private',
      links: ['https://gamma.example/'],
    });
    expect(peekDefinitionYaml(await readFile(`${DIR}broken.yml`, 'utf8')).name).toBeUndefined();
    expect(peekDefinitionYaml('- just\n- a list')).toEqual({ links: [] });
  });
});

describe('presets', () => {
  it('have unique ids, https or local base URLs and an API path', () => {
    const ids = INDEXER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of INDEXER_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(() => new URL(p.baseUrl)).not.toThrow();
      expect(p.baseUrl.startsWith('https://') || p.baseUrl.startsWith('http://localhost')).toBe(true);
      expect(p.apiPath.startsWith('/')).toBe(true);
    }
    expect(INDEXER_PRESETS.filter((p) => p.implementation === 'newznab').length).toBeGreaterThanOrEqual(10);
  });
});
