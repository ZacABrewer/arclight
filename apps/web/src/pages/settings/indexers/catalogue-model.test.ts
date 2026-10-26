import { describe, expect, it } from 'vitest';
import type { Indexer, IndexerCatalogueEntry } from '@arclight/shared';
import {
  addedIndex,
  EMPTY_CHOOSER_FILTER,
  existingFor,
  filterEntries,
  languageOptions,
  moveActive,
  nextSort,
  presetTemplate,
  primaryLanguage,
  sortEntries,
  sourceFilterOf,
} from './catalogue-model.js';
import { measuredRange } from './use-measured-rows.js';

const e = (over: Partial<IndexerCatalogueEntry> & Pick<IndexerCatalogueEntry, 'id' | 'name'>): IndexerCatalogueEntry => ({
  key: `${over.kind ?? 'definition'}:${over.id}`,
  kind: 'definition',
  description: '',
  language: 'en-US',
  protocol: 'torrent',
  privacy: 'public',
  links: [],
  categoryIds: [],
  categoryGroups: [],
  tested: true,
  source: 'builtin',
  support: 'supported',
  ...over,
});

const indexer = (over: Partial<Indexer>): Indexer => ({
  id: 1,
  name: 'x',
  implementation: 'newznab',
  protocol: 'usenet',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 25,
  tags: [],
  settings: { baseUrl: '', apiPath: '/api', categories: [], animeCategories: [] },
  ...over,
});

const geek = e({
  id: 'nzbgeek',
  kind: 'preset',
  name: 'NZBgeek',
  protocol: 'usenet',
  source: 'preset',
  preset: { implementation: 'newznab', baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', categories: [2000], animeCategories: [5070] },
});

describe('catalogue model', () => {
  it('groups builtin and feed as Arclight, generic with presets', () => {
    expect(sourceFilterOf('builtin')).toBe('arclight');
    expect(sourceFilterOf('feed')).toBe('arclight');
    expect(sourceFilterOf('generic')).toBe('preset');
    expect(sourceFilterOf('community')).toBe('community');
  });

  it('counts languages by primary subtag', () => {
    expect(primaryLanguage('zh-CN')).toBe('zh');
    expect(primaryLanguage('')).toBe('');
    const list = [e({ id: 'a', name: 'A', language: 'en-US' }), e({ id: 'b', name: 'B', language: 'en-GB' }), e({ id: 'c', name: 'C', language: 'ru-RU' }), e({ id: 'd', name: 'D', language: '' })];
    expect(languageOptions(list)).toEqual([
      { code: 'en', count: 2 },
      { code: 'ru', count: 1 },
    ]);
  });

  it('matches every search word against id, name, description, language and links', () => {
    const list = [e({ id: 'a', name: 'Alpha', links: ['https://alpha.example/'] }), e({ id: 'b', name: 'Beta', description: 'Anime site' })];
    expect(filterEntries(list, { ...EMPTY_CHOOSER_FILTER, text: 'alpha.example' }).map((x) => x.id)).toEqual(['a']);
    expect(filterEntries(list, { ...EMPTY_CHOOSER_FILTER, text: 'anime beta' }).map((x) => x.id)).toEqual(['b']);
    expect(filterEntries(list, { ...EMPTY_CHOOSER_FILTER, text: 'anime alpha' })).toEqual([]);
  });

  it('keeps generic endpoints on top whatever the sort', () => {
    const list = [e({ id: 'z', name: 'Zed', privacy: 'private' }), e({ id: 'torznab', kind: 'generic', name: 'Torznab', source: 'generic' }), e({ id: 'a', name: 'Ace' })];
    expect(sortEntries(list, { key: 'name', direction: 'desc' }).map((x) => x.id)).toEqual(['torznab', 'z', 'a']);
    expect(sortEntries(list, { key: 'privacy', direction: 'asc' }).map((x) => x.id)).toEqual(['torznab', 'a', 'z']);
    expect(nextSort({ key: 'name', direction: 'asc' }, 'name')).toEqual({ key: 'name', direction: 'desc' });
    expect(nextSort({ key: 'name', direction: 'desc' }, 'source')).toEqual({ key: 'source', direction: 'asc' });
  });

  it('finds existing indexers by definition id, or by preset host and implementation', () => {
    const index = addedIndex([
      indexer({ id: 1, name: 'Mine', implementation: 'definition', protocol: 'torrent', settings: { baseUrl: '', apiPath: '', categories: [], animeCategories: [], definitionId: 'yts' } }),
      indexer({ id: 2, name: 'Geek', settings: { baseUrl: 'https://API.nzbgeek.info/', apiPath: '/api', categories: [], animeCategories: [] } }),
      indexer({ id: 3, name: 'Geek via torznab', implementation: 'torznab', protocol: 'torrent', settings: { baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', categories: [], animeCategories: [] } }),
    ]);
    expect(existingFor(e({ id: 'yts', name: 'YTS' }), index).map((i) => i.name)).toEqual(['Mine']);
    expect(existingFor(geek, index).map((i) => i.name)).toEqual(['Geek']);
    expect(existingFor(e({ id: 'torznab', kind: 'generic', name: 'Torznab' }), index)).toEqual([]);
  });

  it('turns a preset into an editor template with the API key left blank', () => {
    const tpl = presetTemplate(geek);
    expect(tpl).toMatchObject({
      implementation: 'newznab',
      implementationName: 'NZBgeek',
      protocol: 'usenet',
      template: { name: 'NZBgeek', settings: { baseUrl: 'https://api.nzbgeek.info', apiPath: '/api', apiKey: '', categories: [2000], animeCategories: [5070] } },
    });
    expect(presetTemplate(e({ id: 'yts', name: 'YTS' }))).toBeNull();
  });

  it('moves the active row with navigation keys only', () => {
    expect(moveActive('ArrowDown', 0, 3, 10)).toBe(1);
    expect(moveActive('ArrowDown', 2, 3, 10)).toBe(2);
    expect(moveActive('ArrowUp', 0, 3, 10)).toBe(0);
    expect(moveActive('End', 0, 3, 10)).toBe(2);
    expect(moveActive('PageDown', 0, 30, 10)).toBe(10);
    expect(moveActive('PageUp', 5, 30, 10)).toBe(0);
    expect(moveActive('a', 0, 3, 10)).toBeNull();
    expect(moveActive('ArrowDown', 0, 0, 10)).toBeNull();
  });
});

describe('measured virtual range', () => {
  it('uses real heights where known and finds the window by offset', () => {
    const heights = [100, 50, 50, 200, 50, 50];
    expect(measuredRange(heights, 0, 120, 0)).toMatchObject({ start: 0, end: 2, padTop: 0, padBottom: 350 });
    expect(measuredRange(heights, 160, 100, 0)).toMatchObject({ start: 2, end: 4, padTop: 150, padBottom: 100 });
    expect(measuredRange(heights, 160, 100, 1)).toMatchObject({ start: 1, end: 5, padTop: 100, padBottom: 50 });
    expect(measuredRange([], 0, 100, 2)).toMatchObject({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
});
