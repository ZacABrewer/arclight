import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCategoryMap,
  customCategoryId,
  expandCategories,
  mapFromDesc,
  mapFromTracker,
  mapToTracker,
  supportedCategories,
  synthesizeCaps,
} from './categories.js';
import { DefinitionCatalogue, loadDefinitionCatalogue, parseDefinitionYaml } from './catalogue.js';
import { DefinitionError, parseDefinition } from './schema.js';

export const FULL_DEFINITION = `
schemaVersion: 1
id: examplesite
name: ExampleSite
description: "Example private tracker for TV and movies"
language: en-US
type: private
encoding: windows-1252
followredirect: true
requestDelay: 2.5
links:
  - https://examplesite.example
legacylinks:
  - https://old.examplesite.example/
settings:
  - {name: username, type: text, label: Username}
  - {name: password, type: password, label: Password}
  - {name: freeleech, type: checkbox, label: Freeleech only, default: false}
  - name: sort
    type: select
    label: Sort
    default: created
    options: {created: created, seeders: seeders}
  - {name: help, type: info, label: Help, default: "Read the wiki"}
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "Movies HD"}
    - {id: 2, cat: TV/SD, desc: "TV SD", default: true}
    - {id: anime, cat: TV/Anime, desc: "Anime"}
  categories:
    7: Books/EBook
  modes:
    search: [q]
    tv-search: [q, season, ep, imdbid, tvdbid]
    movie-search: [q, imdbid]
  allowrawsearch: true
login:
  path: login.php
  submitpath: takelogin.php
  form: "form#login"
  cookies: ["theme=dark"]
  inputs:
    username: "{{ .Config.username }}"
    password: "{{ .Config.password }}"
  selectorinputs:
    csrf: {selector: "input[name=csrf]", attribute: value}
  getselectorinputs:
    ts: {selector: "input[name=ts]", attribute: value, optional: true}
  error:
    - selector: "div.error"
      message: {selector: "div.error span"}
  test:
    path: index.php
    selector: "a[href^='logout']"
  captcha:
    type: image
    selector: "img#captcha"
    input: captcha_code
search:
  paths:
    - path: "browse.php"
      categories: [1, 2]
      inputs: {extra: 1}
    - path: "api/search"
      method: POST
      response: {type: json, noResultsMessage: ""}
      inherit_inputs: false
  path: legacy.php
  headers:
    Accept: ["text/html"]
  keywordsfilters:
    - {name: re_replace, args: ["[._-]+", " "]}
  allow-empty-inputs: true
  inputs:
    search: "{{ .Keywords }}"
    "c[]": "{{ join .Categories \\",\\" }}"
  rows:
    selector: "table#torrents > tbody > tr"
    after: 1
    dateheaders: {selector: "td.date"}
    filters: [{name: andmatch}]
  fields:
    category: {selector: "td.cat a", attribute: href, filters: [{name: querystring, args: cat}]}
    title: {selector: "td.name a"}
    title: {text: "{{ .Result.title }} [x]"}
    download: {selector: "a.dl", attribute: href}
    size: {selector: "td.size"}
    seeders: {selector: "td.seed"}
    leechers: {selector: "td.leech"}
    downloadvolumefactor:
      case: {"img[alt=Free]": 0, "*": 1}
    uploadvolumefactor: {text: 1}
download:
  method: post
  before:
    path: "ajax/token.php"
    method: post
    inputs: {id: "{{ .DownloadUri.Query.id }}"}
  selectors:
    - selector: "a.dl-torrent"
      attribute: href
      usebeforeresponse: true
  infohash:
    hash: {selector: "td.hash"}
    title: {selector: "h1"}
`;

describe('definition schema', () => {
  it('parses and normalises a full definition', () => {
    const def = parseDefinitionYaml(FULL_DEFINITION, { fileKey: 'examplesite' });
    expect(def.id).toBe('examplesite');
    expect(def.schemaVersion).toBe(1);
    expect(def.type).toBe('private');
    expect(def.encoding).toBe('windows-1252');
    expect(def.requestdelay).toBe(2.5);
    expect(def.links).toEqual(['https://examplesite.example/']);
    expect(def.settings.map((s) => s.type)).toEqual(['text', 'password', 'checkbox', 'select', 'info']);
    expect(def.caps.modes['tv-search']).toEqual(['q', 'season', 'ep', 'imdbid', 'tvdbid']);
    expect(def.caps.allowrawsearch).toBe(true);
    expect(def.login?.method).toBe('form');
    expect(def.login?.selectorinputs?.['csrf']?.attribute).toBe('value');
    expect(def.login?.getselectorinputs?.['ts']?.optional).toBe(true);
    expect(def.warnings.some((w) => w.includes('captcha'))).toBe(true);
    // search.path sugar is appended after explicit paths (S2.11)
    expect(def.search.paths.map((p) => [p.path, p.method])).toEqual([
      ['browse.php', 'get'],
      ['api/search', 'post'],
      ['legacy.php', 'get'],
    ]);
    expect(def.search.paths[0]?.categories).toEqual(['1', '2']);
    expect(def.search.paths[0]?.inputs).toEqual({ extra: '1' });
    expect(def.search.paths[1]?.inheritinputs).toBe(false);
    expect(def.search.paths[1]?.response?.noresultsmessage).toBe('');
    // key normalisation (S2.1): allow-empty-inputs == allowEmptyInputs
    expect(def.search.allowemptyinputs).toBe(true);
    expect(def.search.headers).toEqual({ Accept: ['text/html'] });
    expect(def.search.inputs?.['c[]']).toBe('{{ join .Categories "," }}');
    expect(def.search.rows.after).toBe(1);
    // duplicate YAML keys are preserved as <key>_<n>
    expect(Object.keys(def.search.fields)).toEqual([
      'category', 'title', 'title_2', 'download', 'size', 'seeders', 'leechers', 'downloadvolumefactor', 'uploadvolumefactor',
    ]);
    expect(def.search.fields['downloadvolumefactor']?.case).toEqual({ 'img[alt=Free]': '0', '*': '1' });
    expect(def.search.fields['uploadvolumefactor']?.text).toBe('1');
    expect(def.download?.before?.inputs).toEqual({ id: '{{ .DownloadUri.Query.id }}' });
    expect(def.download?.selectors?.[0]?.usebeforeresponse).toBe(true);
    expect(def.download?.infohash?.hash.selector).toBe('td.hash');
  });

  it('defaults settings to username/password and method to form', () => {
    const def = parseDefinition({
      id: 'x',
      name: 'X',
      links: ['https://x.example/'],
      caps: { modes: { search: ['q'] } },
      login: { path: 'login' },
      search: { path: 'b', rows: { selector: 'tr' }, fields: { title: { selector: 'a' } } },
    });
    expect(def.settings.map((s) => s.name)).toEqual(['username', 'password']);
    expect(def.login?.method).toBe('form');
    expect(def.type).toBe('semi-private');
  });

  it('rejects broken definitions with typed errors', () => {
    const base = {
      id: 'x',
      name: 'X',
      links: ['https://x.example/'],
      caps: { modes: { search: ['q'] } },
      search: { path: 'b', rows: { selector: 'tr' }, fields: { title: { selector: 'a' } } },
    };
    const code = (input: unknown, fileKey?: string): string => {
      try {
        parseDefinition(input, fileKey ? { fileKey } : {});
        return 'ok';
      } catch (err) {
        return err instanceof DefinitionError ? err.code : 'other';
      }
    };
    expect(code(base)).toBe('ok');
    expect(code({ ...base, links: undefined })).toBe('missing_key');
    expect(code({ ...base, search: undefined })).toBe('missing_key');
    expect(code({ ...base, schemaVersion: 2 })).toBe('unsupported_schema_version');
    expect(code({ ...base, settings: [{ name: 'a', type: 'colour' }] })).toBe('unsupported_setting_type');
    expect(code({ ...base, caps: { modes: { search: ['q'], 'tv-search': ['q', 'bogus'] } } })).toBe('invalid_value');
    expect(code({ ...base, caps: { modes: { search: ['q'], 'odd-search': ['q'] } } })).toBe('invalid_value');
    expect(code({ ...base, caps: { modes: { 'tv-search': ['q'] } } })).toBe('missing_key');
    expect(code({ ...base, encoding: 'klingon-8' })).toBe('invalid_value');
    expect(code({ ...base, login: { method: 'telepathy' } })).toBe('invalid_value');
    expect(code({ ...base, login: { captcha: { type: 'image', image: 'x' } } })).toBe('invalid_value');
    expect(code(base, 'other-name')).toBe('id_mismatch');
    expect(code({ ...base, search: { ...base.search, path: '{{ if .X }}oops' } })).toBe('template_syntax');
    expect(code({ ...base, search: { path: 'b', paths: [], rows: { selector: 'tr' }, fields: {} }, id: 'y' })).toBe('ok');
    expect(() => parseDefinitionYaml('id: [unclosed')).toThrow(DefinitionError);
  });
});

describe('README example', () => {
  it('parses the full example from definitions/README.md', async () => {
    const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
    const block = readme.split('## Full example')[1]?.match(/```yaml\r?\n([\s\S]*?)```/)?.[1];
    expect(block).toBeDefined();
    const def = parseDefinitionYaml(block ?? '', { fileKey: 'examplesite' });
    expect(def.login?.method).toBe('form');
    expect(Object.keys(def.search.fields)).toContain('minimumseedtime');
  });
});

describe('catalogue', () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads the builtin definitions; only live-verified ones are marked tested', async () => {
    const catalogue = await loadDefinitionCatalogue();
    expect(catalogue.errors).toEqual([]);
    expect(catalogue.size).toBeGreaterThanOrEqual(8);
    expect(catalogue.ids()).toEqual(
      expect.arrayContaining(['1337x', 'thepiratebay', 'yts', 'eztv', 'nyaa', 'limetorrents', 'torrentgalaxy', 'torlock']),
    );
    for (const def of catalogue.list()) {
      // yts, eztv and torrentgalaxy were verified against the live sites on 2026-10-26.
      expect(def.tested, def.id).toBe(['yts', 'eztv', 'torrentgalaxy'].includes(def.id));
      expect(def.type, def.id).toBe('public');
      expect(def.schemaVersion).toBe(1);
    }
    expect(catalogue.find('The Pirate Bay')?.id).toBe('thepiratebay');
    expect(catalogue.find('YTS')?.id).toBe('yts');
  });

  it('loads a user directory, overrides by id and records broken files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-defs-'));
    await writeFile(join(dir, 'examplesite.yml'), FULL_DEFINITION);
    await writeFile(join(dir, 'broken.yml'), 'id: broken\nname: Broken\n');
    await writeFile(join(dir, 'yts.yml'), FULL_DEFINITION.replace('id: examplesite', 'id: yts').replace('name: ExampleSite', 'name: YTS custom'));
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const catalogue = await loadDefinitionCatalogue([dir]);
    expect(catalogue.get('examplesite')?.name).toBe('ExampleSite');
    expect(catalogue.get('yts')?.name).toBe('YTS custom');
    expect(catalogue.errors).toHaveLength(1);
    expect(catalogue.errors[0]?.file).toContain('broken.yml');
    expect(catalogue.errors[0]?.error.code).toBe('missing_key');
    const empty = new DefinitionCatalogue();
    expect(await empty.loadDirectory(join(dir, 'does-not-exist'))).toBe(0);
  });
});

describe('category mapping (S7)', () => {
  const def = parseDefinitionYaml(FULL_DEFINITION);
  const map = buildCategoryMap(def);

  it('creates standard and custom mappings', () => {
    expect(customCategoryId('12')).toBe(100012);
    const animeCustom = customCategoryId('anime');
    expect(animeCustom).toBeGreaterThanOrEqual(100000);
    expect(animeCustom).toBeLessThan(100000 + 65536);
    expect(customCategoryId('anime')).toBe(animeCustom); // stable
    expect(mapFromTracker(map, '1')).toEqual([2040, 100001]);
    expect(mapFromTracker(map, 'ANIME')).toEqual([5070, animeCustom]);
    expect(mapFromTracker(map, '7')).toEqual([7020]);
    expect(mapFromTracker(map, '99')).toEqual([]);
    expect(mapFromDesc(map, 'tv sd')).toEqual([5030, 100002]);
  });

  it('maps requests to tracker ids with parent expansion and defaults', () => {
    expect(expandCategories(map, [5000])).toEqual(expect.arrayContaining([5000, 5030, 5070]));
    expect(mapToTracker(map, [5000])).toEqual(['2', 'anime']);
    expect(mapToTracker(map, [2040])).toEqual(['1']);
    expect(mapToTracker(map, [100001])).toEqual(['1']);
    expect(mapToTracker(map, [3000])).toEqual(['2']); // nothing matches -> default
    expect(mapToTracker(map, [])).toEqual([]);
    expect(supportedCategories(map, [2000, 2040, 3000, 100001])).toEqual([2000, 2040, 100001]);
  });

  it('synthesises capabilities', () => {
    const caps = synthesizeCaps(def, map);
    expect(caps.searching.search).toEqual({ available: true, supportedParams: ['q'] });
    expect(caps.searching.tvSearch).toEqual({ available: true, supportedParams: ['q', 'season', 'ep', 'imdbid', 'tvdbid'] });
    expect(caps.searching.movieSearch.supportedParams).toEqual(['q', 'imdbid']);
    expect(caps.limits).toEqual({ max: 100, default: 100 });
    const tv = caps.categories.find((c) => c.id === 5000);
    expect(tv?.subcats.map((s) => s.id)).toEqual([5030, 5070]);
    expect(caps.categories.some((c) => c.id === 100001 && c.name === 'Movies HD')).toBe(true);
    expect(caps.categories.find((c) => c.id === 7000)?.subcats).toEqual([{ id: 7020, name: 'Books/EBook' }]);
  });
});
