import { describe, expect, it } from 'vitest';
import { createAgent, NOTIFICATION_AGENT_KINDS, type NotificationAgentKind } from './index.js';
import { formatEvent, mediaHeadline } from './format.js';
import { fakeFetch, fakeSmtp, fakeSpawn, type RecordedCall } from './test-utils.js';
import type { GrabEvent, ImportEvent, MediaAddedEvent, MediaInfo, NotificationEvent } from './types.js';
import type { WebhookPayload } from './agents/webhook.js';
import { PlexAgent, type PlexSection } from './agents/plex.js';

const ARTIST: MediaInfo = {
  id: 3,
  mediaType: 'music',
  title: 'Radiohead',
  year: 0,
  tmdbId: 0,
  path: '/music/Radiohead',
  genres: ['Alternative'],
  tags: [],
  images: [{ coverType: 'poster', url: 'https://img.example/okc.jpg' }],
};

const AUTHOR: MediaInfo = {
  id: 9,
  mediaType: 'audiobook',
  title: 'Brandon Sanderson',
  year: 0,
  tmdbId: 0,
  path: '/audiobooks/Brandon Sanderson',
  genres: [],
  tags: [],
  images: [],
};

const base = { instanceName: 'Arclight', applicationUrl: 'https://arc.example/', timestamp: '2026-10-28T12:00:00.000Z' };

const MUSIC_IMPORT: ImportEvent = {
  ...base,
  type: 'import',
  media: ARTIST,
  artist: { id: 3, name: 'Radiohead', mbArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', path: '/music/Radiohead' },
  album: {
    id: 11,
    title: 'OK Computer',
    albumType: 'Album',
    releaseDate: '1997-05-21',
    mbReleaseGroupId: 'b1392450-e666-3926-a536-22c65f834433',
    path: '/music/Radiohead/OK Computer (1997)',
  },
  tracks: [
    { id: 2, title: 'Paranoid Android', mediumNumber: 1, trackNumber: 2 },
    { id: 1, title: 'Airbag', mediumNumber: 1, trackNumber: 1, durationMs: 284_000 },
  ],
  file: {
    id: 5,
    path: '/music/Radiohead/OK Computer (1997)/01 - Airbag.flac',
    relativePath: 'OK Computer (1997)/01 - Airbag.flac',
    quality: 'FLAC',
    qualityVersion: 1,
    size: 300_000_000,
    dateAdded: '2026-10-28T12:00:00.000Z',
    languages: [],
  },
};

const MUSIC_GRAB: GrabEvent = {
  ...base,
  type: 'grab',
  media: ARTIST,
  album: MUSIC_IMPORT.album!,
  release: {
    title: 'Radiohead-OK_Computer-CD-FLAC-1997-GRP',
    quality: 'FLAC 24bit',
    qualityVersion: 1,
    size: 450_000_000,
    customFormats: [],
    customFormatScore: 0,
  },
};

const BOOK_IMPORT: ImportEvent = {
  ...base,
  type: 'import',
  media: AUTHOR,
  author: { id: 9, name: 'Brandon Sanderson' },
  book: {
    id: 21,
    title: 'The Way of Kings',
    narrators: ['Michael Kramer', 'Kate Reading'],
    seriesTitle: 'The Stormlight Archive',
    seriesPosition: '1',
    asin: 'B003ZWFO7E',
    runtimeMs: 45 * 3_600_000 + 30 * 60_000,
  },
  file: { ...MUSIC_IMPORT.file, path: '/audiobooks/x.m4b', relativePath: 'x.m4b', quality: 'M4B' },
};

const ARTIST_ADDED: MediaAddedEvent = { ...base, type: 'mediaAdded', media: ARTIST, addMethod: 'manual' };

describe('music and audiobook formatting', () => {
  it('imports and grabs read "Artist – Album [Quality]"', () => {
    const imported = formatEvent(MUSIC_IMPORT);
    expect(imported.subject).toBe('Album Imported');
    expect(imported.title).toBe('Radiohead – OK Computer [FLAC]');
    expect(imported.link).toBe('https://arc.example/library/music/album/11');
    expect(imported.fields).toContainEqual({ name: 'Tracks (2)', value: '01 Airbag\n02 Paranoid Android' });
    expect(imported.fields).toContainEqual({ name: 'Released', value: '1997-05-21', inline: true });

    const grabbed = formatEvent(MUSIC_GRAB);
    expect(grabbed.subject).toBe('Album Grabbed');
    expect(grabbed.title).toBe('Radiohead – OK Computer [FLAC 24bit]');
  });

  it('audiobooks read "Author – Title (narrated by X)"', () => {
    const f = formatEvent(BOOK_IMPORT);
    expect(f.subject).toBe('Audiobook Imported');
    expect(f.title).toBe('Brandon Sanderson – The Way of Kings (narrated by Michael Kramer and Kate Reading)');
    expect(f.link).toBe('https://arc.example/library/audiobooks/book/21');
    expect(f.fields).toContainEqual({ name: 'Series', value: 'The Stormlight Archive #1', inline: true });
    expect(f.fields).toContainEqual({ name: 'Runtime', value: '45 h 30 min', inline: true });
    expect(mediaHeadline(AUTHOR, undefined, { book: { id: 1, title: 'Elantris', narrators: ['Jack Garrett'] } })).toBe(
      'Brandon Sanderson – Elantris (narrated by Jack Garrett)',
    );
  });

  it('library events name the artist and author', () => {
    const f = formatEvent(ARTIST_ADDED);
    expect(f.subject).toBe('Artist Added');
    expect(f.title).toBe('Radiohead');
    expect(f.link).toBe('https://arc.example/library/music/artist/3');
    expect(formatEvent({ ...ARTIST_ADDED, media: AUTHOR }).subject).toBe('Author Added');
    // No TMDB fallback link for audio without an instance URL.
    expect(formatEvent({ type: 'mediaAdded', instanceName: 'x', timestamp: base.timestamp, media: ARTIST, addMethod: 'manual' }).link).toBeUndefined();
  });

  it('video headlines are unchanged', () => {
    expect(mediaHeadline({ ...ARTIST, mediaType: 'movie', title: 'Film', year: 2001 })).toBe('Film (2001)');
  });
});

describe('webhook payload', () => {
  it('carries artist, album and tracks objects', async () => {
    const http = fakeFetch();
    await createAgent('webhook', { url: 'https://hooks.example/in' }, { fetch: http.fetch }).send(MUSIC_IMPORT);
    const body = http.calls[0]!.json() as WebhookPayload & Record<string, unknown>;
    expect(body.eventType).toBe('import');
    expect(body['media']).toMatchObject({ mediaType: 'music', title: 'Radiohead' });
    expect(body['artist']).toMatchObject({ name: 'Radiohead', mbArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' });
    expect(body['album']).toMatchObject({ title: 'OK Computer', mbReleaseGroupId: 'b1392450-e666-3926-a536-22c65f834433' });
    expect(body['tracks']).toHaveLength(2);
  });
});

const SMTP_OK = [
  '250-smtp.example\r\n250 AUTH PLAIN\r\n',
  '235 ok\r\n',
  '250 ok\r\n',
  '250 ok\r\n',
  '354 go ahead\r\n',
  '250 ok\r\n',
  '221 bye\r\n',
];

const SETTINGS: Record<NotificationAgentKind, unknown> = {
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x' },
  telegram: { botToken: 't', chatId: '1' },
  webhook: { url: 'https://example.com/hook' },
  email: { host: 'smtp.example', from: 'mt@example.com', to: ['ops@example.org'], security: 'none', username: 'u', password: 'p' },
  'custom-script': { path: '/bin/true' },
  ntfy: { topics: ['t'] },
  gotify: { serverUrl: 'http://g', appToken: 'x' },
  pushover: { apiToken: 'a'.repeat(30), userKey: 'b'.repeat(30) },
  jellyfin: { host: 'jf', apiKey: 'k' },
  emby: { host: 'emby', apiKey: 'k', notify: true },
  plex: { host: 'plex', authToken: 't' },
};

const PLEX_SECTIONS = {
  MediaContainer: {
    Directory: [
      { key: 1, title: 'Movies', type: 'movie', Location: [{ path: '/movies' }] },
      { key: 4, title: 'Music', type: 'artist', Location: [{ path: '/music' }] },
      { key: 5, title: 'Audiobooks', type: 'artist', Location: [{ path: '/audiobooks' }] },
    ],
  },
};

function server(call: RecordedCall) {
  const url = new URL(call.url);
  if (url.pathname === '/library/sections') return { status: 200, json: PLEX_SECTIONS };
  if (url.hostname === 'api.telegram.org') return { status: 200, json: { ok: true } };
  return { status: 200, json: {} };
}

describe('every agent handles music and audiobook events', () => {
  for (const kind of NOTIFICATION_AGENT_KINDS) {
    it(kind, async () => {
      const http = fakeFetch(server);
      const spawner = fakeSpawn(({ child }) => child.emit('close', 0, null));
      for (const event of [MUSIC_IMPORT, MUSIC_GRAB, BOOK_IMPORT, ARTIST_ADDED] as NotificationEvent[]) {
        const agent = createAgent(kind, SETTINGS[kind] as never, { fetch: http.fetch, connect: fakeSmtp(SMTP_OK).connect, spawn: spawner.spawn });
        if (!agent.supportedEvents.has(event.type)) continue;
        await expect(agent.send(event)).resolves.toBeUndefined();
      }
    });
  }

  it('Discord shows the audio title, tracks and MusicBrainz link', async () => {
    const http = fakeFetch();
    await createAgent('discord', SETTINGS.discord as never, { fetch: http.fetch }).send(MUSIC_IMPORT);
    const embed = (http.calls[0]!.json() as { embeds: Array<{ title: string; fields?: Array<{ name: string; value: string }> }> }).embeds[0]!;
    expect(embed.title).toBe('Radiohead – OK Computer [FLAC]');
    const json = JSON.stringify(embed);
    expect(json).toContain('Tracks (2)');
    expect(json).toContain('musicbrainz.org/release-group/b1392450');
  });

  it('Telegram renders the audiobook headline', async () => {
    const http = fakeFetch(server);
    await createAgent('telegram', SETTINGS.telegram as never, { fetch: http.fetch }).send(BOOK_IMPORT);
    expect((http.calls[0]!.json() as { text: string }).text).toContain('narrated by Michael Kramer and Kate Reading');
  });
});

describe('Plex matchSections', () => {
  const sections: PlexSection[] = PLEX_SECTIONS.MediaContainer.Directory.map((d) => ({
    key: String(d.key),
    title: d.title,
    type: d.type,
    locations: d.Location.map((l) => l.path),
  }));
  const agent = new PlexAgent({ host: 'plex', port: 32400, useSsl: false, authToken: 't', updateLibrary: true } as never);

  it('maps music and audiobooks to artist sections by path', () => {
    expect(agent.matchSections(sections, ARTIST).map((s) => s.key)).toEqual(['4']);
    expect(agent.matchSections(sections, AUTHOR).map((s) => s.key)).toEqual(['5']);
    expect(agent.matchSections(sections, { ...ARTIST, path: '/movies/x' })).toEqual([]);
  });

  it('refreshes the music section with the artist path', async () => {
    const http = fakeFetch(server);
    await createAgent('plex', SETTINGS.plex as never, { fetch: http.fetch }).send(MUSIC_IMPORT);
    const refresh = new URL(http.calls[1]!.url);
    expect(refresh.pathname).toBe('/library/sections/4/refresh');
    expect(refresh.searchParams.get('path')).toBe('/music/Radiohead');
  });
});
