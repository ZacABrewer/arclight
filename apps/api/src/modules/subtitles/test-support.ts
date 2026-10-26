import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { QUALITIES, SubtitleSettings, type LanguageProfileInput, type QualityModel, type ServerEvent } from '@media-tron/shared';
import type { NotificationEvent } from '@media-tron/notifications';
import type {
  ProbeResult,
  ProviderCapabilities,
  ProviderKind,
  RateLimit,
  SubtitleCandidate,
  SubtitleFile,
  SubtitleProvider,
  SubtitleQuery,
  SupportResult,
} from '@media-tron/subtitles';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, series } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { setSection } from '../settings/service.js';
import type { ProcessRunner, RunOptions, RunResult } from './runner.js';
import * as subtitleTables from './schema.js';
import { SubtitlesService, type SubtitlesServiceOptions } from './service.js';

// Fixtures for the subtitles tests: an in-memory db, a temp library folder with real (tiny)
// video files, fake providers and a fake process runner.

export const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral Kenobi\n';
export const SRT_HI = '1\n00:00:01,000 --> 00:00:02,000\n[DOOR CREAKS]\n\n2\n00:00:03,000 --> 00:00:04,000\n(sighs) Hello\n';
export const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello from VTT\n';

export class Clock {
  constructor(public t = Date.parse('2026-01-10T12:00:00.000Z')) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Candidate with provider-asserted matches (scoring adds the rest). */
export function candidate(provider: ProviderKind, id: string, o: Partial<Omit<SubtitleCandidate, 'matches'>> & { matches?: string[] } = {}): SubtitleCandidate {
  const { matches, ...rest } = o;
  return {
    provider,
    id,
    language: 'en',
    forced: false,
    hi: false,
    releaseInfo: '',
    score: 0,
    scoreWithoutHash: 0,
    hashVerifiable: false,
    hiVerifiable: true,
    ...rest,
    matches: new Set((matches ?? []) as never[]),
  };
}

/** Episode matches worth 335/360 (passes 90 %). */
export const GOOD_EPISODE = ['series', 'season', 'episode', 'year', 'source'];
/** Episode matches worth 220/360 (fails 90 %, fine for manual search). */
export const WEAK_EPISODE = ['series', 'season', 'episode'];
/** Movie matches that pass 70 %. */
export const GOOD_MOVIE = ['title', 'year', 'source'];

export class FakeProvider implements SubtitleProvider {
  readonly needsAuth = false;
  readonly rateLimit: RateLimit = { minIntervalMs: 0, requestTimeoutMs: 1000 };
  readonly capabilities: ProviderCapabilities = {
    mediaTypes: ['episode', 'movie'],
    inputs: ['title'],
    languages: 'any',
    forced: true,
    hi: true,
    hashVerifiable: false,
    hiVerifiable: true,
  };
  candidates: SubtitleCandidate[] = [];
  contents = new Map<string, string>();
  searchError: Error | null = null;
  downloadErrors = new Map<string, Error>();
  searches: SubtitleQuery[] = [];
  downloads: string[] = [];
  tested = 0;

  constructor(readonly kind: ProviderKind) {}

  supports(): SupportResult {
    return { ok: true };
  }

  async search(query: SubtitleQuery): Promise<SubtitleCandidate[]> {
    this.searches.push(query);
    if (this.searchError) throw this.searchError;
    return this.candidates
      .filter((c) => query.languages.some((l) => l.tag === c.language && l.forced === c.forced))
      .map((c) => ({ ...c, matches: new Set(c.matches) }));
  }

  async download(c: SubtitleCandidate): Promise<SubtitleFile> {
    this.downloads.push(c.id);
    const err = this.downloadErrors.get(c.id);
    if (err) throw err;
    return { bytes: new TextEncoder().encode(this.contents.get(c.id) ?? SRT), format: 'srt', encoding: 'utf-8' };
  }

  async test(): Promise<void> {
    this.tested++;
  }
}

export interface RunnerCall {
  command: string;
  args: readonly string[];
  opts: RunOptions;
}

/** Records calls; `handler` may write files and return a result. */
export function fakeRunner(handler?: (call: RunnerCall) => Promise<Partial<RunResult> | void> | Partial<RunResult> | void) {
  const calls: RunnerCall[] = [];
  const runner: ProcessRunner = async (command, args, opts) => {
    const call = { command, args, opts };
    calls.push(call);
    const r = (await handler?.(call)) ?? {};
    return { ok: true, exitCode: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false, ...r };
  };
  return { runner, calls };
}

export function quality(): QualityModel {
  const q = QUALITIES['WEBDL-1080p'];
  return { quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}

export interface Fixture {
  db: Db;
  bus: EventBus;
  events: ServerEvent[];
  clock: Clock;
  dir: string;
  service: SubtitlesService;
  providers: { podnapisi: FakeProvider; addic7ed: FakeProvider };
  runner: ReturnType<typeof fakeRunner>;
  notifications: NotificationEvent[];
  probes: Map<string, ProbeResult>;
  seriesId: number;
  movieId: number;
  ep: { s1e1: number; s1e2: number; s2e1: number };
  /** Media file ids. */
  files: { s1e1: number; s1e2: number; s2e1: number; movie: number };
  videos: { s1e1: string; s1e2: string; s2e1: string; movie: string };
  profileId: number;
  makeService(overrides?: Partial<SubtitlesServiceOptions>): SubtitlesService;
  settings(patch: (s: SubtitleSettings) => void): void;
  cleanup(): Promise<void>;
}

export const EN_PROFILE: LanguageProfileInput = { name: 'English', languages: [{ code: 'en', forced: 'never', hi: 'also' }], cutoff: null, mustContain: [], mustNotContain: [], originalFormat: false };

export interface SetupOptions {
  runner?: Parameters<typeof fakeRunner>[0];
}

export async function setup(opts: SetupOptions = {}): Promise<Fixture> {
  const db = await createTestDb({ ...subtitleTables });
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const clock = new Clock();
  const dir = await mkdtemp(join(tmpdir(), 'mt-subs-'));
  const providers = { podnapisi: new FakeProvider('podnapisi'), addic7ed: new FakeProvider('addic7ed') };
  const runner = fakeRunner(opts.runner);
  const notifications: NotificationEvent[] = [];
  const probes = new Map<string, ProbeResult>();

  const seriesId = db
    .insert(series)
    .values({
      tmdbId: 100,
      tvdbId: 7000,
      imdbId: 'tt0100',
      title: 'Test Show',
      sortTitle: 'test show',
      cleanTitle: 'testshow',
      year: 2020,
      status: 'continuing',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: join(dir, 'Test Show'),
      rootFolderPath: dir,
      qualityProfileId: 1,
      tags: [],
      added: '2025-01-01T00:00:00.000Z',
    })
    .returning({ id: series.id })
    .get().id;
  const movieId = db
    .insert(movies)
    .values({
      tmdbId: 200,
      imdbId: 'tt0200',
      title: 'Test Movie',
      originalTitle: 'Test Movie',
      sortTitle: 'test movie',
      cleanTitle: 'testmovie',
      year: 2021,
      status: 'released',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: join(dir, 'Test Movie (2021)'),
      rootFolderPath: dir,
      qualityProfileId: 1,
      tags: [],
      added: '2025-01-01T00:00:00.000Z',
    })
    .returning({ id: movies.id })
    .get().id;

  const videos = {
    s1e1: join(dir, 'Test Show', 'Season 01', 'Test.Show.S01E01.1080p.WEB-DL.mkv'),
    s1e2: join(dir, 'Test Show', 'Season 01', 'Test.Show.S01E02.1080p.WEB-DL.mkv'),
    s2e1: join(dir, 'Test Show', 'Season 02', 'Test.Show.S02E01.1080p.WEB-DL.mkv'),
    movie: join(dir, 'Test Movie (2021)', 'Test.Movie.2021.1080p.WEB-DL.mkv'),
  };
  for (const p of Object.values(videos)) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, 'video');
  }
  const addFile = (path: string, o: { seriesId?: number; movieId?: number; seasonNumber?: number }) =>
    db
      .insert(mediaFiles)
      .values({
        mediaType: o.movieId ? 'movie' : 'series',
        seriesId: o.seriesId ?? null,
        movieId: o.movieId ?? null,
        seasonNumber: o.seasonNumber ?? null,
        relativePath: path.slice(dir.length + 1),
        path,
        sizeBytes: 5,
        dateAdded: '2025-01-02T00:00:00.000Z',
        quality: quality(),
        languages: ['en'],
      })
      .returning({ id: mediaFiles.id })
      .get().id;
  const files = {
    s1e1: addFile(videos.s1e1, { seriesId, seasonNumber: 1 }),
    s1e2: addFile(videos.s1e2, { seriesId, seasonNumber: 1 }),
    s2e1: addFile(videos.s2e1, { seriesId, seasonNumber: 2 }),
    movie: addFile(videos.movie, { movieId }),
  };
  const addEp = (season: number, episode: number, fileId: number) =>
    db
      .insert(episodes)
      .values({ seriesId, seasonNumber: season, episodeNumber: episode, title: `Episode ${episode}`, hasFile: true, episodeFileId: fileId })
      .returning({ id: episodes.id })
      .get().id;
  const ep = { s1e1: addEp(1, 1, files.s1e1), s1e2: addEp(1, 2, files.s1e2), s2e1: addEp(2, 1, files.s2e1) };

  const base = SubtitleSettings.parse({});
  setSection(db, 'subtitles', {
    ...base,
    providers: [
      { id: 'podnapisi', enabled: true, settings: {} },
      { id: 'addic7ed', enabled: true, settings: {} },
    ],
  });

  const makeService = (overrides: Partial<SubtitlesServiceOptions> = {}) =>
    new SubtitlesService({
      db,
      bus,
      log: pino({ level: 'silent' }),
      runner: runner.runner,
      probe: async (path) => probes.get(path) ?? null,
      createProvider: (id) => {
        const p = (providers as Record<string, FakeProvider | undefined>)[id];
        if (!p) throw new Error(`no fake for ${id}`);
        return p;
      },
      notify: async (e) => {
        notifications.push(e);
      },
      describeMedia: (mediaType, id) => ({ id, mediaType, title: mediaType === 'series' ? 'Test Show' : 'Test Movie', year: 2020, tmdbId: 1, path: dir, genres: [], tags: [], images: [] }),
      now: clock.now,
      sleep: async () => {},
      retryDelayMs: 0,
      ...overrides,
    });
  const service = makeService();
  const profileId = service.createProfile(EN_PROFILE).id;
  db.update(series).set({ languageProfileId: profileId }).run();
  db.update(movies).set({ languageProfileId: profileId }).run();

  return {
    db,
    bus,
    events,
    clock,
    dir,
    service,
    providers,
    runner,
    notifications,
    probes,
    seriesId,
    movieId,
    ep,
    files,
    videos,
    profileId,
    makeService,
    settings(patch) {
      const s = service.settings();
      patch(s);
      setSection(db, 'subtitles', s);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
