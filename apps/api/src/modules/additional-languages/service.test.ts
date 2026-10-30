import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { AdditionalLanguageRequest, type AdditionalLanguageRequestInput, type MediaInfo } from '@arclight/shared';
import { history, jobs, mediaFiles, movies } from '../../db/schema.js';
import { Scheduler } from '../../scheduler.js';
import { languageProfiles } from '../subtitles/schema.js';
import { FakeProvider, GOOD_EPISODE, GOOD_MOVIE, candidate, setup, type Fixture } from '../subtitles/test-support.js';
import { additionalLanguagesRoutes } from './routes.js';
import { additionalLanguages } from './schema.js';
import { AdditionalLanguagesService, type ReleasesPort } from './service.js';

let fx: Fixture | undefined;
afterEach(async () => {
  await fx?.service.idle();
  await fx?.cleanup();
  fx = undefined;
});

class FakeReleases implements ReleasesPort {
  calls: unknown[] = [];
  grab: string[] = [];
  async searchFor(target: unknown) {
    this.calls.push(target);
    return { releases: 1, approved: this.grab.length, grabbed: this.grab };
  }
}

async function build() {
  fx = await setup();
  const releases = new FakeReleases();
  const scheduler = new Scheduler(fx.db, fx.bus, pino({ level: 'silent' }));
  const f = fx;
  const service = new AdditionalLanguagesService({
    db: f.db,
    bus: f.bus,
    log: pino({ level: 'silent' }),
    scheduler,
    subtitles: () => f.service,
    releases: () => releases,
    now: () => new Date(f.clock.now()),
    waitMs: 5000,
  });
  return { f, service, releases };
}

const req = (input: AdditionalLanguageRequestInput) => AdditionalLanguageRequest.parse(input);
const ENGLISH: MediaInfo = { audioStreams: [{ codec: 'eac3', language: 'eng' }] };

describe('additional subtitle languages', () => {
  it('previews without saving anything', async () => {
    const { f, service } = await build();
    const r = await service.preview(req({ kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'spa' }] }));
    expect(r.applied).toBe(false);
    expect(r.whisperAvailable).toBe(false);
    expect(r.items[0]).toMatchObject({ key: `movie:${f.movieId}`, outcome: 'willSearch', files: 1, subtitles: [{ language: 'es', forced: false, hi: false, outcome: 'willSearch' }] });
    expect(f.db.select().from(additionalLanguages).all()).toEqual([]);
  });

  it('adds the language for the item only, searches it now and keeps existing subtitles', async () => {
    const { f, service } = await build();
    f.providers.podnapisi.candidates = [candidate('podnapisi', 'es1', { language: 'es', matches: GOOD_MOVIE })];
    const r = await service.apply(req({ kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'es' }] }));
    expect(r.applied).toBe(true);
    expect(r.items[0]).toMatchObject({ outcome: 'found', subtitles: [{ language: 'es', outcome: 'found' }] });
    expect(await readFile(f.videos.movie.replace(/\.mkv$/, '.es.srt'), 'utf8')).toContain('Kenobi');
    // The shared language profile is untouched.
    expect(f.db.select().from(languageProfiles).get()!.languages.map((l) => l.code)).toEqual(['en']);
    expect(f.db.select().from(additionalLanguages).all()).toMatchObject([{ kind: 'subtitle', movieId: f.movieId, language: 'es', status: 'found' }]);
    // The search ran as an Activity task and history has the request and the outcome.
    expect(f.db.select().from(jobs).where(eq(jobs.id, r.jobId!)).get()).toMatchObject({ name: 'AdditionalLanguageSearch', status: 'completed' });
    expect(f.db.select().from(history).all().map((h) => [h.eventType, h.data['outcome']])).toEqual([
      ['additionalLanguage', 'requested'],
      ['additionalLanguage', 'found'],
    ]);
  });

  it('counts a language no provider answered for as not found, not as present', async () => {
    const { f } = await build();
    // A subtitles port whose search reports nothing (no provider took the language).
    const silent = Object.create(f.service) as typeof f.service;
    silent.searchFile = async () => undefined as never;
    const service = new AdditionalLanguagesService({
      db: f.db,
      bus: f.bus,
      log: pino({ level: 'silent' }),
      scheduler: new Scheduler(f.db, f.bus, pino({ level: 'silent' })),
      subtitles: () => silent,
      releases: () => new FakeReleases(),
      now: () => new Date(f.clock.now()),
      waitMs: 5000,
    });
    const r = await service.apply(req({ kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'es' }] }));
    expect(r.items[0]).toMatchObject({ outcome: 'notFound', subtitles: [{ language: 'es', outcome: 'notFound' }] });
    expect(f.db.select().from(additionalLanguages).all()).toMatchObject([{ language: 'es', status: 'notFound' }]);
  });

  it('keeps wanting a language nobody has, past the profile cutoff, only within the chosen season', async () => {
    const { f, service } = await build();
    f.db.update(languageProfiles).set({ cutoff: 'en' }).run();
    const r = await service.apply(req({ kind: 'subtitle', targets: [{ seriesId: f.seriesId, seasonNumber: 1 }], languages: [{ code: 'fr' }] }));
    expect(r.items[0]).toMatchObject({ key: `series:${f.seriesId}:s1`, outcome: 'notFound', files: 2 });
    expect(r.items[0]!.message).toMatch(/normal schedule/);
    const wanted = f.service.wanted({ mediaType: 'series', page: 1, pageSize: 50 }).records;
    const fr = wanted.filter((w) => w.missing.some((m) => m.language === 'fr')).map((w) => w.mediaFileId).sort();
    expect(fr).toEqual([f.files.s1e1, f.files.s1e2].sort());
  });

  it('wants additional languages on items without a language profile', async () => {
    const { f, service } = await build();
    f.db.update(movies).set({ languageProfileId: null }).run();
    await service.apply(req({ kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'de' }], searchNow: false }));
    const wanted = f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 50 }).records;
    expect(wanted).toMatchObject([{ mediaFileId: f.files.movie, languageProfileId: null, missing: [{ language: 'de' }] }]);
  });

  it('falls back to Whisper when asked and set up', async () => {
    const { f, service } = await build();
    const whisper = new FakeProvider('whisperai');
    whisper.candidates = [candidate('whisperai', 'w1', { language: 'fr', matches: GOOD_EPISODE })];
    (f.providers as Record<string, FakeProvider>)['whisperai'] = whisper;
    f.settings((s) => {
      s.providers.push({ id: 'whisperai', enabled: false, settings: { endpoint: 'http://whisper.test' } });
    });
    const r = await service.apply(req({ kind: 'subtitle', targets: [{ seriesId: f.seriesId, episodeIds: [f.ep.s1e1] }], languages: [{ code: 'fr' }], useWhisper: true }));
    expect(r.whisperAvailable).toBe(true);
    expect(r.items[0]).toMatchObject({ outcome: 'found', episodeIds: [f.ep.s1e1] });
    expect(whisper.downloads).toEqual(['w1']);
  });

  it('reports languages the item already has', async () => {
    const { f, service } = await build();
    f.probes.set(f.videos.movie, { streams: [{ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ita' } }] });
    await f.service.scan({ movieId: f.movieId });
    const r = await service.apply(req({ kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'it' }] }));
    expect(r.items[0]).toMatchObject({ outcome: 'alreadyPresent' });
    expect(r.jobId).toBeNull();
    expect(r.items[0]!.currentSubtitles).toContain('it');
  });
});

describe('additional audio languages', () => {
  function english(f: Fixture) {
    f.db.update(mediaFiles).set({ mediaInfo: ENGLISH }).run();
  }

  it('replace: previews the languages a release must carry, then searches through the normal pipeline', async () => {
    const { f, service, releases } = await build();
    english(f);
    const preview = await service.preview(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'spa' }));
    expect(preview.items[0]).toMatchObject({ outcome: 'willSearch', currentAudio: ['en'], requiredAudio: ['es', 'en'] });
    releases.grab = ['Test.Movie.2021.SPANISH.ENGLISH.1080p.WEB-DL-GRP'];
    const r = await service.apply(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'spa' }));
    expect(r.items[0]).toMatchObject({ outcome: 'grabbed' });
    expect(r.items[0]!.message).toMatch(/replaces the current file once it imports/);
    expect(releases.calls).toEqual([{ movieId: f.movieId }]);
    expect(f.db.select().from(additionalLanguages).all()).toMatchObject([{ kind: 'audio', mode: 'replace', language: 'es', status: 'grabbed' }]);
  });

  it('replace: searches only the episodes whose files lack the language', async () => {
    const { f, service, releases } = await build();
    english(f);
    f.db.update(mediaFiles).set({ mediaInfo: { audioStreams: [{ codec: 'aac', language: 'eng' }, { codec: 'aac', language: 'spa' }] } }).where(eq(mediaFiles.id, f.files.s1e2)).run();
    const r = await service.apply(req({ kind: 'audio', targets: [{ seriesId: f.seriesId }], language: 'es' }));
    expect(r.items[0]).toMatchObject({ outcome: 'notFound', currentAudio: ['en', 'es'] });
    expect(releases.calls).toEqual([{ seriesId: f.seriesId, episodeIds: [f.ep.s1e1, f.ep.s2e1].sort((a, b) => a - b) }]);
  });

  it('says so when the file already has the language', async () => {
    const { f, service, releases } = await build();
    f.db.update(mediaFiles).set({ mediaInfo: { audioStreams: [{ codec: 'aac', language: 'eng' }, { codec: 'aac', language: 'spa' }] } }).run();
    const r = await service.apply(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'es' }));
    expect(r.items[0]).toMatchObject({ outcome: 'alreadyPresent' });
    expect(releases.calls).toEqual([]);
  });

  it('version: adds a language slot next to the current file and searches it', async () => {
    const { f, service, releases } = await build();
    english(f);
    const preview = await service.preview(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'es', mode: 'version' }));
    expect(preview.items[0]).toMatchObject({ outcome: 'willAddVersion', versionTag: 'Spanish' });
    expect(f.db.select().from(movies).get()!.versions).toBeNull();
    const r = await service.apply(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'es', mode: 'version' }));
    expect(r.items[0]).toMatchObject({ outcome: 'versionAdded', versionTag: 'Spanish' });
    expect(f.db.select().from(movies).get()!.versions).toEqual([
      { tag: 'Standard', qualityProfileId: 1, enabled: true },
      { tag: 'Spanish', qualityProfileId: 1, enabled: true, audioLanguages: ['es'] },
    ]);
    expect(releases.calls).toEqual([{ movieId: f.movieId }]);
    // Asking again reuses the slot.
    await service.apply(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'spa', mode: 'version' }));
    expect(f.db.select().from(movies).get()!.versions).toHaveLength(2);
  });
});

describe('item languages and routes', () => {
  it('lists present and added languages, and removing a record stops wanting it', async () => {
    const { f, service } = await build();
    f.db.update(mediaFiles).set({ mediaInfo: ENGLISH }).run();
    await service.apply(req({ kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'nl' }] }));
    await service.apply(req({ kind: 'audio', targets: [{ movieId: f.movieId }], language: 'es', searchNow: false }));
    const langs = service.itemLanguages({ movieId: f.movieId });
    expect(langs.audio).toEqual([
      { language: 'en', present: true, added: false },
      { language: 'es', present: false, added: true },
    ]);
    expect(langs.subtitles).toContainEqual({ language: 'nl', present: false, added: true });
    expect(langs.records.map((r) => [r.kind, r.language])).toEqual([
      ['subtitle', 'nl'],
      ['audio', 'es'],
    ]);
    service.remove(langs.records[0]!.id);
    expect(f.service.wanted({ mediaType: 'movie', page: 1, pageSize: 50 }).records.flatMap((w) => w.missing.map((m) => m.language))).not.toContain('nl');
  });

  it('serves the routes and validates input', async () => {
    const { f, service } = await build();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(additionalLanguagesRoutes(service), { prefix: '/api/v1' });

    const preview = await app.inject({ method: 'POST', url: '/api/v1/additional-language/preview', payload: { kind: 'audio', targets: [{ movieId: f.movieId }], language: 'de' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ kind: 'audio', applied: false });

    const bad = await app.inject({ method: 'POST', url: '/api/v1/additional-language', payload: { kind: 'audio', targets: [{ movieId: f.movieId, seriesId: f.seriesId }], language: 'de' } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/additional-language', payload: { kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'zz-nope' }] } });
    expect(unknown.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/additional-language/preview', payload: { kind: 'audio', targets: [{ movieId: 9999 }], language: 'de' } });
    expect(missing.statusCode).toBe(404);

    const applied = await app.inject({ method: 'POST', url: '/api/v1/additional-language', payload: { kind: 'subtitle', targets: [{ movieId: f.movieId }], languages: [{ code: 'sv' }], searchNow: false } });
    expect(applied.json()).toMatchObject({ applied: true, jobId: null, items: [{ outcome: 'saved' }] });
    const item = await app.inject({ method: 'GET', url: `/api/v1/additional-language?movieId=${f.movieId}` });
    const id = item.json().records[0].id as number;
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/additional-language/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/additional-language/${id}` })).statusCode).toBe(404);
  });
});
