import { describe, expect, it } from 'vitest';
import type { MediaServerItem } from '@arclight/media-servers';
import { buildRemoteIndex, remoteIdFor } from './remote-index.js';

const item = (id: string, mediaType: 'movie' | 'series', ids: Partial<MediaServerItem['ids']>): MediaServerItem => ({
  id,
  mediaType,
  title: id,
  year: null,
  ids: { tmdbId: null, tvdbId: null, imdbId: null, ...ids },
  path: null,
  libraryId: 'lib',
});

describe('remote index', () => {
  const listed: string[] = [];
  const client = {
    async listItems(kind: string) {
      listed.push(kind);
      return kind === 'movie'
        ? [item('m1', 'movie', { tmdbId: 10 }), item('m2', 'movie', { imdbId: 'TT0000002' })]
        : [item('s1', 'series', { tvdbId: 77 }), item('s2', 'series', { tmdbId: 10 })];
    },
  };

  it('lists each kind once and matches by tmdb, then tvdb, then imdb, per kind', async () => {
    const index = await buildRemoteIndex(client, ['movie', 'series', 'movie']);
    expect(listed).toEqual(['movie', 'series']);
    expect(remoteIdFor(index, 'movie', { tmdbId: 10 })).toBe('m1');
    expect(remoteIdFor(index, 'series', { tmdbId: 10 })).toBe('s2');
    expect(remoteIdFor(index, 'series', { tmdbId: 1, tvdbId: 77 })).toBe('s1');
    expect(remoteIdFor(index, 'movie', { tmdbId: 1, imdbId: 'tt0000002' })).toBe('m2');
    expect(remoteIdFor(index, 'movie', { tmdbId: 1, tvdbId: 77, imdbId: null })).toBeUndefined();
  });

  it('takes a single kind', async () => {
    const index = await buildRemoteIndex(client, 'series');
    expect(remoteIdFor(index, 'movie', { tmdbId: 10 })).toBeUndefined();
    expect(remoteIdFor(index, 'series', { tmdbId: 10 })).toBe('s2');
  });
});
