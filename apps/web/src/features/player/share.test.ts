import { describe, expect, it } from 'vitest';
import { copyText, serverOrigin, shareUrlFor } from './share.js';

// "Copy link": the player's public address plus the title's page below the player root.

describe('shareUrlFor', () => {
  const origin = 'https://nas.example.com/arclight';

  it('puts the title page below the player address', () => {
    expect(shareUrlFor({ kind: 'movie', id: 12 }, 'https://watch.example.com', origin)).toBe('https://watch.example.com/watch/movies/12');
    expect(shareUrlFor({ kind: 'show', id: 4 }, 'https://example.com/tv/', origin)).toBe('https://example.com/tv/watch/shows/4');
    expect(shareUrlFor({ kind: 'album', id: 3 }, 'https://example.com/player', origin)).toBe('https://example.com/player/music/album/3');
    expect(shareUrlFor({ kind: 'book', id: 9 }, 'https://watch.example.com/arclight', origin)).toBe('https://watch.example.com/arclight/books/9');
  });

  it('falls back to the server this page talks to', () => {
    expect(shareUrlFor({ kind: 'movie', id: 12 }, null, origin)).toBe('https://nas.example.com/arclight/player/watch/movies/12');
    expect(serverOrigin('/arclight/api/v1', 'https://nas.example.com/arclight/player')).toBe('https://nas.example.com/arclight');
    expect(serverOrigin('/api/v1', 'https://nas.example.com/player')).toBe('https://nas.example.com');
    // The Arclight app's api client gives absolute addresses on the signed-in server.
    expect(serverOrigin('https://media.example.com/api/v1', 'capacitor://localhost/')).toBe('https://media.example.com');
  });
});

describe('copyText', () => {
  it('reports whether the clipboard took the link', async () => {
    const written: string[] = [];
    expect(await copyText('x', { writeText: async (s: string) => void written.push(s) })).toBe(true);
    expect(written).toEqual(['x']);
    expect(await copyText('x', { writeText: () => Promise.reject(new Error('denied')) })).toBe(false);
    expect(await copyText('x', undefined)).toBe(false);
  });
});
