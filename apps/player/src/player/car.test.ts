import { describe, expect, it, vi } from 'vitest';
import type { PlayerAlbum, PlayerTrack } from '@arclight/shared';
import { book, track } from '@web/features/player/test-utils';
import type { ArclightPlayerPlugin, BrowseNode, BrowseTree } from '../native/definitions';
import { CAR_ROOT, CarBrowser, type CarLibrary } from './car';

const ptrack = (id: number): PlayerTrack => ({
  id,
  itemKey: `track:${id}`,
  title: `Song ${id}`,
  artistName: 'Test Artist',
  artistId: 1,
  albumTitle: 'Test Album',
  albumId: 1,
  discNumber: 1,
  trackNumber: id,
  durationMs: 180_000,
  formatLabel: 'FLAC',
  lossless: true,
  artworkUrl: 'https://music.example.com/art/1?sig=x',
  explicit: false,
});

const palbum: PlayerAlbum = {
  id: 1,
  title: 'Test Album',
  artistName: 'Test Artist',
  artistId: 1,
  year: 2020,
  albumType: 'album',
  trackCount: 3,
  durationMs: 540_000,
  formatLabel: 'FLAC',
  lossless: true,
  artworkUrl: null,
  addedAt: null,
  genres: [],
};

function harness(online = true) {
  const handlers = new Map<string, (e: never) => void>();
  const answers: Array<{ requestId: string; items: BrowseNode[] }> = [];
  const trees: BrowseTree[] = [];
  const plugin = {
    addListener: async (name: string, l: (e: never) => void) => {
      handlers.set(name, l);
      return { remove: async () => void handlers.delete(name) };
    },
    answerBrowse: async (a: { requestId: string; items: BrowseNode[] }) => void answers.push(a),
    setBrowseTree: async (t: BrowseTree) => void trees.push(t),
  };
  const state = { online };
  const library: CarLibrary = {
    online: () => state.online,
    continueListening: async () => [{ item: book(), progress: { positionMs: 900_000 } as never }],
    albums: async () => [palbum],
    album: async () => ({ ...palbum, tracks: [ptrack(1), ptrack(2), ptrack(3)], discCount: 1 }),
    artists: async () => [{ id: 1, name: 'Test Artist', imageUrl: null, albumCount: 1, trackCount: 3, genres: [] }],
    artist: async () => ({ id: 1, name: 'Test Artist', imageUrl: null, albumCount: 1, trackCount: 3, genres: [], overview: null, topTracks: [], albums: [palbum] }),
    playlists: async () => [{ id: 4, name: 'Road trip', description: null, trackCount: 2, durationMs: 1, artworkUrls: [], updatedAt: '' }],
    playlist: async () => ({ id: 4, name: 'Road trip', description: null, trackCount: 2, durationMs: 1, artworkUrls: [], updatedAt: '', tracks: [ptrack(3), ptrack(1)], entryIds: [1, 2], trackIds: [3, 1] }),
    books: async () => [],
    search: async () => ({ tracks: [ptrack(2)], albums: [palbum], artists: [], audiobooks: [], movies: [], series: [] }),
    downloads: () => [{ item: track(10, { albumId: 5, artistId: 6, context: 'Offline Album', subtitle: 'Offline Artist' }) }, { item: track(11, { albumId: 5, artistId: 6 }) }, { item: book(8) }],
  };
  const player = { playItems: vi.fn(async () => undefined), playItem: vi.fn(async () => undefined) };
  const car = new CarBrowser({ plugin: plugin as unknown as ArclightPlayerPlugin, library, player: () => player, answerWithinMs: 50 });
  car.start();
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    car,
    state,
    player,
    answers,
    trees,
    settle,
    request: async (e: { requestId: string; parentId?: string; query?: string }) => {
      handlers.get('browseRequest')!(e as never);
      await settle();
      await settle();
      return answers.find((a) => a.requestId === e.requestId)?.items ?? [];
    },
    play: async (e: { nodeId: string; parentId?: string }) => {
      handlers.get('browsePlay')!(e as never);
      await settle();
      await settle();
    },
  };
}

describe('CarBrowser', () => {
  it('answers the root and the sections from the server', async () => {
    const h = harness();
    expect((await h.request({ requestId: '1', parentId: 'root' })).map((n) => n.id)).toEqual([...CAR_ROOT]);
    expect((await h.request({ requestId: '2', parentId: 'albums' }))[0]).toMatchObject({ id: 'album:1', browsable: true, playable: true });
    expect((await h.request({ requestId: '3', parentId: 'album:1' })).map((n) => n.id)).toEqual(['track:1', 'track:2', 'track:3']);
    expect((await h.request({ requestId: '4', parentId: 'artist:1' })).map((n) => n.id)).toEqual(['album:1']);
    expect((await h.request({ requestId: '5', parentId: 'continue' }))[0]).toMatchObject({ id: 'audiobook:7', progress: 0.25 });
    expect((await h.request({ requestId: '6', query: 'song' })).map((n) => n.id)).toEqual(['album:1', 'track:2']);
  });

  it('answers from the downloads when offline', async () => {
    const h = harness(false);
    expect((await h.request({ requestId: '1', parentId: 'albums' })).map((n) => [n.id, n.title])).toEqual([['album:5', 'Offline Album']]);
    expect((await h.request({ requestId: '2', parentId: 'album:5' })).map((n) => n.id)).toEqual(['track:10', 'track:11']);
    expect((await h.request({ requestId: '3', parentId: 'artists' })).map((n) => n.id)).toEqual(['artist:6']);
    expect((await h.request({ requestId: '4', parentId: 'books' })).map((n) => n.id)).toEqual(['audiobook:8']);
    expect(await h.request({ requestId: '5', parentId: 'playlists' })).toEqual([]);
    expect((await h.request({ requestId: '6', query: 'test book' })).map((n) => n.id)).toEqual(['audiobook:8']);
  });

  it('caches a tree natively with every section', async () => {
    const h = harness();
    await h.settle();
    await h.settle();
    const tree = h.trees.at(-1)!;
    expect(tree.root.map((n) => n.id)).toEqual([...CAR_ROOT]);
    expect(tree.children.albums?.[0]?.id).toBe('album:1');
    expect(tree.children.downloads).toHaveLength(3);
    // Downloaded albums open without JS.
    expect(tree.children['album:5']?.map((n) => n.id)).toEqual(['track:10', 'track:11']);
  });

  it('turns a pick into a queue', async () => {
    const h = harness();
    await h.play({ nodeId: 'album:1', parentId: 'albums' });
    expect(h.player.playItems).toHaveBeenLastCalledWith(['track:1', 'track:2', 'track:3'], { source: 'album:1' });
    await h.play({ nodeId: 'track:1', parentId: 'playlist:4' });
    expect(h.player.playItems).toHaveBeenLastCalledWith(['track:3', 'track:1'], { startIndex: 1, source: 'playlist:4' });
    await h.play({ nodeId: 'book:7', parentId: 'books' });
    expect(h.player.playItem).toHaveBeenLastCalledWith('audiobook:7', { source: 'audiobook:7' });
    await h.play({ nodeId: 'track:2', parentId: 'search' });
    expect(h.player.playItem).toHaveBeenLastCalledWith('track:2', {});
  });
});
