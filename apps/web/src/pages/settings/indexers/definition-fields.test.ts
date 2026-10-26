import { describe, expect, it } from 'vitest';
import type { IndexerDefinitionSummary, IndexerProxy } from '@media-tron/shared';
import { definitionBase, definitionFields, definitionNotes, filterDefinitions, EMPTY_CATALOGUE_FILTER, toDefinitionBody } from './definition-fields.js';
import { indexerSourceLine } from './indexers-page.js';

const def = (over: Partial<IndexerDefinitionSummary> = {}): IndexerDefinitionSummary => ({
  id: 'examplesite',
  name: 'ExampleSite',
  description: 'Example private tracker',
  language: 'en-US',
  type: 'private',
  privacy: 'private',
  protocol: 'torrent',
  links: ['https://a.example/', 'https://b.example/'],
  settingsFields: [
    { name: 'username', type: 'text', label: 'Username', informational: false },
    { name: 'password', type: 'password', label: 'Password', informational: false },
    { name: 'freeleech', type: 'checkbox', label: 'Freeleech only', default: false, informational: false },
    { name: 'sort', type: 'select', label: 'Sort', default: 'added', options: [{ value: 'added', label: 'Added' }, { value: 'seeders', label: 'Seeders' }], informational: false },
    { name: 'info_cookie', type: 'info_cookie', label: 'How to get the cookie', default: 'Open dev tools', informational: true },
  ],
  categories: [{ id: 2000, name: 'Movies' }],
  tested: false,
  source: 'builtin',
  ...over,
});

const proxy: IndexerProxy = { id: 3, name: 'Flare', type: 'flaresolverr', host: 'http://flare', port: 8191, tags: [] };

describe('definition editor fields', () => {
  it('renders settings fields by type and keeps info entries as notes', () => {
    const fields = definitionFields(def(), [proxy]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName['settings.fields.username']?.type).toBe('text');
    expect(byName['settings.fields.password']?.type).toBe('password');
    expect(byName['settings.fields.freeleech']?.type).toBe('checkbox');
    expect(byName['settings.fields.sort']?.options).toHaveLength(2);
    expect(byName['settings.fields.info_cookie']).toBeUndefined();
    expect(byName['settings.baseUrl']?.options?.map((o) => o.value)).toEqual(['https://a.example/', 'https://b.example/']);
    expect(byName['proxyId']?.options?.map((o) => o.value)).toEqual(['', 3]);
    expect(definitionNotes(def()).map((n) => n.name)).toEqual(['info_cookie']);
  });

  it('omits the site-link select for single-mirror definitions', () => {
    expect(definitionFields(def({ links: ['https://a.example/'] })).some((f) => f.name === 'settings.baseUrl')).toBe(false);
  });

  it('starts from definition defaults and builds a typed create body', () => {
    const base = definitionBase(def());
    expect(base).toMatchObject({ name: 'ExampleSite', implementation: 'definition', settings: { definitionId: 'examplesite', baseUrl: 'https://a.example/', fields: { freeleech: false, sort: 'added' } } });
    const body = toDefinitionBody({ ...base, settings: { ...(base['settings'] as object), fields: { username: 'me', freeleech: true, sort: 'seeders' } } }, 'examplesite');
    expect(body).toMatchObject({
      implementation: 'definition',
      proxyId: null,
      settings: { definitionId: 'examplesite', apiPath: '', fields: { username: 'me', freeleech: true, sort: 'seeders' } },
    });
    expect(toDefinitionBody({ ...base, proxyId: 3 }, 'examplesite').proxyId).toBe(3);
  });

  it('filters the catalogue by words, privacy and language', () => {
    const list = [def(), def({ id: 'yts', name: 'YTS', description: 'Movies', privacy: 'public', type: 'public' }), def({ id: 'rutor', name: 'Rutor', language: 'ru-RU', privacy: 'public', type: 'public' })];
    expect(filterDefinitions(list, { ...EMPTY_CATALOGUE_FILTER, text: 'movies' }).map((d) => d.id)).toEqual(['yts']);
    expect(filterDefinitions(list, { ...EMPTY_CATALOGUE_FILTER, privacy: 'public' }).map((d) => d.id)).toEqual(['rutor', 'yts']);
    expect(filterDefinitions(list, { ...EMPTY_CATALOGUE_FILTER, language: 'ru' }).map((d) => d.id)).toEqual(['rutor']);
  });

  it('describes the definition and proxies on indexer cards', () => {
    const settings = { baseUrl: '', apiPath: '', categories: [], animeCategories: [], definitionId: 'yts' };
    expect(indexerSourceLine({ implementation: 'definition', definitionName: 'YTS', settings, proxyNames: ['Flare'] })).toBe('definition: YTS · proxy: Flare');
    expect(indexerSourceLine({ implementation: 'torznab', settings })).toBe('');
  });
});
