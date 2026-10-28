import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { CalendarQuery, type CalendarItem, type CalendarQueryInput } from '@arclight/shared';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../db/test-utils.js';
import { settings } from '../../db/schema.js';
import { insertEpisode, insertFile, insertMovie, insertSeries, insertTag } from '../notifications/test-support.js';
import { escapeText, foldLine, renderIcs } from './ics.js';
import { calendarRoutes } from './routes.js';
import { CalendarService, ICS_TOKEN_KEY, resolveRange } from './service.js';

const NOW = new Date('2026-05-10T12:00:00Z');

async function setup() {
  const db = await createTestDb();
  const service = new CalendarService(db, () => NOW);
  const list = (q: CalendarQueryInput) => service.list(CalendarQuery.parse(q));
  return { db, service, list };
}

const labels = (items: CalendarItem[]) =>
  items.map((i) =>
    i.type === 'episode'
      ? `${i.seriesTitle} ${i.episode.episodeNumber}`
      : i.type === 'movie'
        ? `${i.movie.title} ${i.releaseKind}`
        : `${i.artistName} - ${i.album.title}`,
  );

describe('calendar range queries', () => {
  it('returns episodes whose UTC air time falls inside the inclusive range', async () => {
    const { db, list } = await setup();
    const s = insertSeries(db, { title: 'Show' });
    insertEpisode(db, s.id, { episodeNumber: 1, airDateUtc: '2026-05-09T23:59:59.000Z', airDate: '2026-05-09' });
    insertEpisode(db, s.id, { episodeNumber: 2, airDateUtc: '2026-05-10T00:00:00.000Z', airDate: '2026-05-10' });
    insertEpisode(db, s.id, { episodeNumber: 3, airDateUtc: '2026-05-12T02:00:00.000Z', airDate: '2026-05-11' });
    insertEpisode(db, s.id, { episodeNumber: 4, airDateUtc: '2026-05-13T00:00:00.000Z', airDate: '2026-05-12' });
    const items = list({ start: '2026-05-10T00:00:00Z', end: '2026-05-12T23:59:59Z' });
    expect(labels(items)).toEqual(['Show 2', 'Show 3']);
    expect(items[0]).toMatchObject({ type: 'episode', date: '2026-05-10T00:00:00.000Z', seriesId: s.id });
  });

  it('falls back to the air date when the UTC time is unknown, and treats a date-only end as the whole day', async () => {
    const { db, list } = await setup();
    const s = insertSeries(db, { title: 'Daily' });
    insertEpisode(db, s.id, { episodeNumber: 1, airDate: '2026-05-11' });
    insertEpisode(db, s.id, { episodeNumber: 2, airDate: '2026-05-14' });
    const items = list({ start: '2026-05-10', end: '2026-05-11' });
    expect(labels(items)).toEqual(['Daily 1']);
    expect(items[0]?.date).toBe('2026-05-11');
  });

  it('hides unmonitored episodes and episodes of unmonitored series unless asked', async () => {
    const { db, list } = await setup();
    const watched = insertSeries(db, { title: 'Watched' });
    const ignored = insertSeries(db, { title: 'Ignored', monitored: false });
    insertEpisode(db, watched.id, { episodeNumber: 1, airDateUtc: '2026-05-11T01:00:00Z' });
    insertEpisode(db, watched.id, { episodeNumber: 2, airDateUtc: '2026-05-11T02:00:00Z', monitored: false });
    insertEpisode(db, ignored.id, { episodeNumber: 1, airDateUtc: '2026-05-11T03:00:00Z' });
    expect(labels(list({ start: '2026-05-10', end: '2026-05-12' }))).toEqual(['Watched 1']);
    expect(labels(list({ start: '2026-05-10', end: '2026-05-12', unmonitored: 'true' }))).toEqual([
      'Watched 1',
      'Watched 2',
      'Ignored 1',
    ]);
  });

  it('includes the series summary and episode file only when requested', async () => {
    const { db, list } = await setup();
    const s = insertSeries(db, { title: 'Show' });
    const file = insertFile(db, { mediaType: 'series', seriesId: s.id, seasonNumber: 1 });
    insertEpisode(db, s.id, { airDateUtc: '2026-05-11T01:00:00Z', hasFile: true, episodeFileId: file.id });
    const plain = list({ start: '2026-05-10', end: '2026-05-12' })[0];
    expect(plain && 'series' in plain).toBe(false);
    expect(plain && 'episodeFile' in plain).toBe(false);
    const rich = list({ start: '2026-05-10', end: '2026-05-12', includeSeries: 'true', includeEpisodeFile: 'true' })[0];
    expect(rich).toMatchObject({
      series: { id: s.id, title: 'Show', network: 'HBO' },
      episodeFile: { id: file.id, episodeIds: [expect.any(Number)] },
    });
  });

  it('emits one item per movie release date in range, tagged with its kind', async () => {
    const { db, list } = await setup();
    insertMovie(db, { title: 'Alpha', inCinemas: '2026-05-11', digitalRelease: '2026-05-20', physicalRelease: '2026-05-12T00:00:00Z' });
    insertMovie(db, { title: 'Beta', digitalRelease: '2026-05-11' });
    insertMovie(db, { title: 'Hidden', inCinemas: '2026-05-11', monitored: false });
    const items = list({ start: '2026-05-10', end: '2026-05-12' });
    expect(labels(items)).toEqual(['Alpha cinema', 'Beta digital', 'Alpha physical']);
    expect(items[0]).toMatchObject({ type: 'movie', releaseKind: 'cinema', movie: { title: 'Alpha', digitalRelease: '2026-05-20' } });
  });

  it('filters by tags across series and movies, and sorts by date', async () => {
    const { db, list } = await setup();
    const kids = insertTag(db, 'kids');
    const s1 = insertSeries(db, { title: 'Cartoon', tags: [kids] });
    const s2 = insertSeries(db, { title: 'Grown' });
    insertEpisode(db, s1.id, { airDateUtc: '2026-05-11T05:00:00Z' });
    insertEpisode(db, s2.id, { airDateUtc: '2026-05-11T01:00:00Z' });
    insertMovie(db, { title: 'Family Film', inCinemas: '2026-05-11', tags: [kids] });
    expect(labels(list({ start: '2026-05-10', end: '2026-05-12', tags: String(kids) }))).toEqual(['Family Film cinema', 'Cartoon 1']);
    expect(labels(list({ start: '2026-05-10', end: '2026-05-12' }))).toEqual(['Family Film cinema', 'Grown 1', 'Cartoon 1']);
  });

  it('defaults to today through seven days and rejects an end before the start', async () => {
    expect(resolveRange({}, NOW)).toEqual({ start: new Date('2026-05-10T00:00:00Z'), end: new Date('2026-05-17T00:00:00Z') });
    const { list } = await setup();
    expect(() => list({ start: '2026-05-10', end: '2026-05-01' })).toThrow(/end must not be before start/);
    expect(() => CalendarQuery.parse({ tags: '1,x' })).toThrow();
  });
});

describe('iCal output', () => {
  it('escapes text and folds long lines at 75 octets', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const folded = foldLine(`SUMMARY:${'x'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => new TextEncoder().encode(p).length <= 75)).toBe(true);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
  });

  it('renders a VCALENDAR with timed episode and all-day movie events', async () => {
    const { db, list } = await setup();
    const s = insertSeries(db, { title: 'Show, The', runtimeMinutes: 50 });
    insertEpisode(db, s.id, { seasonNumber: 2, episodeNumber: 3, title: 'Big; Day', airDateUtc: '2026-05-11T01:00:00.000Z' });
    insertMovie(db, { title: 'Alpha', inCinemas: '2026-05-12' });
    const ics = renderIcs(list({ start: '2026-05-10', end: '2026-05-13', includeSeries: 'true' }), { now: NOW });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTAMP:20260510T120000Z');
    expect(ics).toContain('DTSTART:20260511T010000Z\r\nDTEND:20260511T015000Z');
    expect(ics).toContain('SUMMARY:Show\\, The - S02E03 - Big\\; Day');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260512\r\nDTEND;VALUE=DATE:20260513');
    expect(ics).toContain('SUMMARY:Alpha (In Cinemas)');
    expect(ics).toMatch(/UID:arclight-movie-\d+-cinema@arclight/);
  });
});

describe('calendar routes', () => {
  async function build() {
    const ctx = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(calendarRoutes(ctx.service, () => NOW), { prefix: '/api/v1' });
    return { ...ctx, app };
  }

  it('GET /calendar validates and parses the query string', async () => {
    const { app, db } = await build();
    const s = insertSeries(db, { title: 'Show' });
    insertEpisode(db, s.id, { airDateUtc: '2026-05-11T01:00:00Z' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/calendar?start=2026-05-10&end=2026-05-12&includeSeries=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ type: 'episode', series: expect.objectContaining({ title: 'Show' }) })]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/calendar?start=garbage' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/calendar?start=2026-05-10&end=2026-05-01' })).statusCode).toBe(400);
  });

  it('feed.ics requires the per-install token stored in settings', async () => {
    const { app, db } = await build();
    insertMovie(db, { title: 'Alpha', digitalRelease: '2026-05-20' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/calendar/feed.ics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/calendar/feed.ics?token=wrong' })).statusCode).toBe(401);

    const info = (await app.inject({ method: 'GET', url: '/api/v1/calendar/feed' })).json() as { token: string; path: string };
    expect(info.token).toMatch(/^[0-9a-f]{48}$/);
    expect(db.select().from(settings).where(eq(settings.key, ICS_TOKEN_KEY)).get()?.value).toBe(info.token);
    expect(info.path).toBe(`/api/v1/calendar/feed.ics?token=${info.token}`);

    const ok = await app.inject({ method: 'GET', url: `${info.path}&pastDays=1&futureDays=30` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/calendar');
    expect(ok.body).toContain('SUMMARY:Alpha (Digital Release)');
    const narrow = await app.inject({ method: 'GET', url: `${info.path}&futureDays=5` });
    expect(narrow.body).not.toContain('Alpha');
  });
});
