import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SubtitleCandidate, SubtitleQuery } from '../types.js';
import { GestdownProvider } from './gestdown.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/gestdown/${name}`, import.meta.url), 'utf8');

function make(route: (url: string) => Response) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return route(String(input));
  }) as typeof fetch;
  const p = new GestdownProvider({}, { fetch: impl, sleep: async (ms) => void sleeps.push(ms) });
  return { p, calls, sleeps };
}
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

const SHOW = '6f8a1c2e-0000-4000-8000-000000000001';
const query: SubtitleQuery = {
  mediaType: 'episode',
  title: 'The Show',
  season: 2,
  episode: 5,
  seriesTvdbId: 371980,
  resolution: '1080p',
  languages: [{ tag: 'en', forced: false, hi: 'normal' }],
};
const happy = (url: string) =>
  url.includes('/shows/external/tvdb/') ? json(fx('shows.json')) : url.includes('/subtitles/get/') ? json(fx('subtitles-english.json')) : json('{}', 404);

describe('GestdownProvider', () => {
  it('refuses movies, missing tvdb id and forced-only requests', () => {
    const { p } = make(happy);
    expect(p.supports({ ...query, mediaType: 'movie' }).ok).toBe(false);
    expect(p.supports({ ...query, seriesTvdbId: undefined }).ok).toBe(false);
    expect(p.supports({ ...query, languages: [{ tag: 'en', forced: true, hi: 'normal' }] }).ok).toBe(false);
    expect(p.supports(query).ok).toBe(true);
  });

  it('resolves the show by tvdb id then asks per language by Addic7ed name', async () => {
    const { p, calls } = make(happy);
    await p.search({ ...query, languages: [{ tag: 'en', forced: false, hi: 'normal' }, { tag: 'ca', forced: false, hi: 'normal' }] });
    expect(calls[0]).toBe('https://api.gestdown.info/shows/external/tvdb/371980');
    expect(calls[1]).toBe(`https://api.gestdown.info/subtitles/get/${SHOW}/2/5/English`);
    expect(calls[2]).toBe(`https://api.gestdown.info/subtitles/get/${SHOW}/2/5/Catal%C3%A0`);
  });

  it('maps completed subtitles with identity matches, HI and versions', async () => {
    const { p } = make(happy);
    const res = await p.search(query);
    expect(res).toHaveLength(2);
    const a = res[0]!;
    expect(a.language).toBe('en');
    expect(a.hi).toBe(false);
    expect([...a.matches].sort()).toEqual(['episode', 'resolution', 'season', 'series', 'title', 'tvdb_id', 'year']);
    expect(a.releaseInfo).toBe('GROUP\nOTHER');
    expect(a.downloadUrl).toBe('https://api.gestdown.info/subtitles/download/b1f0c1e0-1111-4000-8000-000000000001');
    expect(a.downloads).toBe(812);
    expect(res[1]!.hi).toBe(true);
    expect(res[1]!.matches.has('resolution')).toBe(false);
  });

  it('treats 404 show lookup as empty', async () => {
    const { p } = make(() => json('{}', 404));
    expect(await p.search(query)).toEqual([]);
  });

  it('retries 423 three times with 30 s pauses, then returns empty', async () => {
    const { p, calls, sleeps } = make((url) => (url.includes('/shows/') ? json(fx('shows.json')) : json('', 423)));
    expect(await p.search(query)).toEqual([]);
    expect(calls.filter((c) => c.includes('/subtitles/get/'))).toHaveLength(3);
    expect(sleeps.filter((s) => s === 30_000)).toHaveLength(2);
  });

  it('treats non-JSON as empty and propagates server errors', async () => {
    const a = make((url) => (url.includes('/shows/') ? json(fx('shows.json')) : json('<html>')));
    expect(await a.p.search(query)).toEqual([]);
    const b = make(() => json('x', 500));
    await expect(b.p.search(query)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('downloads the subtitle body from the absolute URL', async () => {
    const { p, calls } = make(() => new Response('1\n00:00:01,000 --> 00:00:02,000\nHello\n'));
    const f = await p.download({ id: 'x', downloadUrl: 'https://api.gestdown.info/subtitles/download/x' } as SubtitleCandidate);
    expect(calls).toEqual(['https://api.gestdown.info/subtitles/download/x']);
    expect(f.format).toBe('srt');
  });
});
