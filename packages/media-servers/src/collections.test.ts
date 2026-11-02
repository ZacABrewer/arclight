import { describe, expect, it } from 'vitest';
import { MediaBrowserServerClient } from './media-browser.js';
import { fakeServer, type RecordedCall } from './test-utils.js';

// Collection (BoxSet) calls of the Jellyfin/Emby client.

function client(routes: Record<string, unknown>, fallback?: (c: RecordedCall) => { status?: number; json?: unknown } | undefined) {
  const server = fakeServer(routes, fallback);
  const c = new MediaBrowserServerClient({ kind: 'jellyfin', url: 'http://jellyfin.example.com:8096', apiKey: 'k', fetch: server.fetch, pageSize: 2 });
  return { c, calls: server.calls };
}

describe('MediaBrowserServerClient collections', () => {
  it('creates a collection with the first batch of ids and adds the rest in batches', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    const { c, calls } = client({ 'POST /Collections': { Id: 'box1' }, 'POST /Collections/box1/Items': {} });
    expect(await c.createCollection('Leaving Soon', ids)).toBe('box1');
    expect(calls[0]!.url.searchParams.get('Name')).toBe('Leaving Soon');
    expect(calls[0]!.url.searchParams.get('Ids')!.split(',')).toHaveLength(50);
    const adds = calls.filter((x) => x.url.pathname === '/Collections/box1/Items');
    expect(adds.map((x) => x.url.searchParams.get('Ids')!.split(',').length)).toEqual([50, 20]);
    expect(adds.every((x) => x.method === 'POST')).toBe(true);
  });

  it('creates an empty collection without an Ids parameter', async () => {
    const { c, calls } = client({ 'POST /Collections': { Id: 'box2' } });
    await c.createCollection('Empty');
    expect(calls[0]!.url.searchParams.has('Ids')).toBe(false);
  });

  it('removes items with DELETE and pages through the children', async () => {
    const children = [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }];
    const { c, calls } = client(
      { 'DELETE /Collections/box1/Items': { status: 204 } },
      (call) => {
        if (call.method !== 'GET' || call.url.pathname !== '/Items') return undefined;
        const q = call.url.searchParams;
        if (q.get('Ids') === 'box1') return { json: { Items: [{ Id: 'box1', Type: 'BoxSet', Name: 'X' }] } };
        if (q.get('ParentId') === 'box1') {
          const start = Number(q.get('StartIndex'));
          return { json: { Items: children.slice(start, start + 2), TotalRecordCount: 3 } };
        }
        return undefined;
      },
    );
    expect(await c.collectionItemIds('box1')).toEqual(['a', 'b', 'c']);
    await c.removeFromCollection('box1', ['a']);
    const del = calls.find((x) => x.method === 'DELETE')!;
    expect(del.url.pathname).toBe('/Collections/box1/Items');
    expect(del.url.searchParams.get('Ids')).toBe('a');
  });

  it('reports a missing collection as null and treats deleting a gone one as done', async () => {
    const { c } = client({ 'GET /Items': { Items: [] } });
    expect(await c.collectionItemIds('gone')).toBeNull();
    await expect(c.deleteCollection('gone')).resolves.toBeUndefined();
  });

  it('lists collections and updates an overview by sending the item back with the field locked', async () => {
    const { c, calls } = client({
      'GET /Items': (call: RecordedCall) =>
        call.url.searchParams.get('IncludeItemTypes') === 'BoxSet'
          ? { json: { Items: [{ Id: 'box1', Name: 'Leaving Soon', Overview: null }], TotalRecordCount: 1 } }
          : { json: { Items: [{ Id: 'box1', Name: 'Leaving Soon', LockedFields: ['Name'], Genres: null }] } },
      'POST /Items/box1': { status: 204 },
    });
    expect(await c.collections()).toEqual([{ id: 'box1', name: 'Leaving Soon', overview: null }]);
    await c.setCollectionOverview('box1', 'Leaving 12 Nov');
    const post = calls.find((x) => x.method === 'POST')!;
    expect(post.body).toMatchObject({ Id: 'box1', Overview: 'Leaving 12 Nov', LockedFields: ['Name', 'Overview'], Genres: [], Tags: [] });
  });
});
