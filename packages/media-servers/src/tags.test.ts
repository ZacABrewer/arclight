import { describe, expect, it } from 'vitest';
import { mergeTags } from './http.js';
import { MediaBrowserServerClient } from './media-browser.js';
import { PlexServerClient } from './plex.js';
import { fakeServer, type RecordedCall } from './test-utils.js';

// Item tags (Jellyfin/Emby) and labels (Plex) for Arclight's tag sync, against fake servers.

const ITEM = {
  Id: 'm1',
  Name: 'Arrival',
  Type: 'Movie',
  Overview: 'Linguist meets visitors.',
  Genres: ['Drama'],
  Tags: ['Favourite', 'arclight:Old'],
  Studios: [{ Name: 'Studio' }],
  People: [],
  ProviderIds: { Tmdb: '329865' },
  Taglines: [],
  LockedFields: ['Overview'],
};

function jellyfin(item: Record<string, unknown> = ITEM) {
  const server = fakeServer(
    { [`POST /Items/${String(item['Id'])}`]: { status: 204 } },
    (call: RecordedCall) => {
      if (call.method !== 'GET' || call.url.pathname !== '/Items') return undefined;
      const ids = (call.url.searchParams.get('Ids') ?? '').split(',');
      return { json: { Items: ids.includes(String(item['Id'])) ? [item] : [] } };
    },
  );
  const c = new MediaBrowserServerClient({ kind: 'jellyfin', url: 'http://jellyfin.example.com:8096', apiKey: 'k', fetch: server.fetch });
  return { c, calls: server.calls };
}

describe('mergeTags', () => {
  it('removes and adds case-insensitively, keeping the casing and order of what is there', () => {
    expect(mergeTags(['Kids', 'Family'], ['kids', 'arclight:new'], ['FAMILY'])).toEqual(['Kids', 'arclight:new']);
    expect(mergeTags([], ['a', 'A', ' '], [])).toEqual(['a']);
  });
});

describe('MediaBrowserServerClient item tags', () => {
  it('reads tags in batches of 50', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    const server = fakeServer({}, (call) => {
      const batch = (call.url.searchParams.get('Ids') ?? '').split(',');
      return { json: { Items: batch.map((Id) => ({ Id, Tags: Id === 'id7' ? ['x'] : [] })) } };
    });
    const c = new MediaBrowserServerClient({ kind: 'emby', url: 'http://emby.example.com', apiKey: 'k', fetch: server.fetch });
    const tags = await c.itemTags(ids);
    expect(server.calls.map((x) => x.url.searchParams.get('Ids')!.split(',').length)).toEqual([50, 50, 20]);
    expect(server.calls[0]!.url.searchParams.get('Fields')).toBe('Tags');
    expect(tags.get('id7')).toEqual(['x']);
    expect(tags.size).toBe(120);
  });

  it('keeps the other fields and the user tags, does not duplicate, and locks Tags when asked', async () => {
    const { c, calls } = jellyfin();
    const result = await c.setItemTags('m1', ['FAVOURITE', 'arclight:Kids'], ['arclight:old'], { lock: true });
    expect(result).toEqual(['Favourite', 'arclight:Kids']);
    const post = calls.find((x) => x.method === 'POST')!;
    expect(post.url.pathname).toBe('/Items/m1');
    expect(post.body).toMatchObject({
      Name: 'Arrival',
      Overview: 'Linguist meets visitors.',
      Genres: ['Drama'],
      Studios: [{ Name: 'Studio' }],
      ProviderIds: { Tmdb: '329865' },
      Tags: ['Favourite', 'arclight:Kids'],
      LockedFields: ['Overview', 'Tags'],
    });
    expect(calls[0]!.url.searchParams.get('Fields')).toContain('LockedFields');
  });

  it('leaves LockedFields alone without lock', async () => {
    const { c, calls } = jellyfin();
    await c.setItemTags('m1', ['arclight:Kids'], []);
    expect((calls.find((x) => x.method === 'POST')!.body as { LockedFields: string[] }).LockedFields).toEqual(['Overview']);
  });

  it('fills absent list fields so the update endpoint does not read them as null', async () => {
    const { c, calls } = jellyfin({ Id: 'm2', Name: 'Bare' });
    await c.setItemTags('m2', ['a'], [], { lock: true });
    expect(calls.find((x) => x.method === 'POST')!.body).toMatchObject({ Tags: ['a'], LockedFields: ['Tags'], Genres: [], Studios: [], People: [], Taglines: [], ProviderIds: {} });
  });

  it('reports a missing item as notFound', async () => {
    const { c } = jellyfin();
    await expect(c.setItemTags('gone', ['a'], [])).rejects.toMatchObject({ code: 'notFound' });
  });
});

describe('PlexServerClient labels', () => {
  function plex(labels: Record<string, string[]>) {
    const server = fakeServer({ 'PUT /library/sections/3/all': { status: 200, body: '' } }, (call) => {
      const m = /^\/library\/metadata\/(.+)$/.exec(call.url.pathname);
      if (call.method !== 'GET' || !m) return undefined;
      const keys = decodeURIComponent(m[1]!).split(',').filter((k) => k in labels);
      if (keys.length === 0) return { status: 404 };
      return { json: { MediaContainer: { Metadata: keys.map((ratingKey) => ({ ratingKey, Label: labels[ratingKey]!.map((tag) => ({ tag })) })) } } };
    });
    return { c: new PlexServerClient({ url: 'http://plex.example.com:32400', token: 't', fetch: server.fetch }), calls: server.calls };
  }

  it('reads labels of several items in one request per 50', async () => {
    const { c, calls } = plex({ '10': ['Kids'], '11': [] });
    const labels = await c.itemLabels(['10', '11', '99']);
    expect(calls[0]!.url.pathname).toBe('/library/metadata/10,11,99');
    expect(labels).toEqual(new Map([['10', ['Kids']], ['11', []]]));
  });

  it('sends the full label list, encoded, locked, with the item type', async () => {
    const { c, calls } = plex({ '10': ['Favourite', 'arclight:old'] });
    const result = await c.setItemLabels('3', '10', 'series', ['arclight:kids & teens', 'favourite'], ['arclight:old']);
    expect(result).toEqual(['Favourite', 'arclight:kids & teens']);
    const put = calls.find((x) => x.method === 'PUT')!;
    const q = put.url.searchParams;
    expect(q.get('type')).toBe('2');
    expect(q.get('id')).toBe('10');
    expect(q.get('label[0].tag.tag')).toBe('Favourite');
    expect(q.get('label[1].tag.tag')).toBe('arclight:kids & teens');
    expect(q.get('label.locked')).toBe('1');
    expect(put.url.search).toContain('arclight%3Akids+%26+teens');
    expect(put.headers['x-plex-token']).toBe('t');
  });

  it('does not lock when asked not to', async () => {
    const { c, calls } = plex({ '10': [] });
    await c.setItemLabels('3', '10', 'movie', ['a'], [], { lock: false });
    expect(calls.find((x) => x.method === 'PUT')!.url.searchParams.has('label.locked')).toBe(false);
  });

  it('uses the removal form when the last labels go', async () => {
    const { c, calls } = plex({ '10': ['arclight:kids'] });
    expect(await c.setItemLabels('3', '10', 'movie', [], ['arclight:kids'])).toEqual([]);
    const q = calls.find((x) => x.method === 'PUT')!.url.searchParams;
    expect(q.get('type')).toBe('1');
    expect(q.get('label[].tag.tag-')).toBe('arclight:kids');
    expect(q.has('label[0].tag.tag')).toBe(false);
  });

  it('reports a missing item as notFound', async () => {
    const { c } = plex({});
    await expect(c.setItemLabels('3', '10', 'movie', ['a'], [])).rejects.toMatchObject({ code: 'notFound' });
  });
});
