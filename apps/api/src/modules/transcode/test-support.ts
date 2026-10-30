import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { AddMovieRequest, AddSeriesRequest, QUALITIES, TranscodeRuleInput, type MediaInfo, type ServerEvent, type TranscodeRuleInputRaw } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { mediaFiles } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { RecycleBin } from '../imports/mover.js';
import { libraryService } from '../library/index.js';
import type { ProcessResult, RunningProcess, TranscodeRunner } from './runner.js';
import * as tables from './schema.js';
import { TranscodeService, type TranscodedNotice } from './service.js';

/** Scriptable ffmpeg for tests. Not used by production code. */
export class FakeRunner implements TranscodeRunner {
  binary: string | null = '/usr/bin/ffmpeg';
  calls: string[][] = [];
  inFlight = 0;
  maxInFlight = 0;
  killed = 0;
  /** When true, processes wait for `release()` (or a kill). */
  hold = false;
  exitCode = 0;
  output = 'transcoded-bytes';
  /** Progress text written to stdout before finishing. */
  progress: string[] = [];
  hwaccelsOutput = 'Hardware acceleration methods:\nvdpau\ncuda\nvaapi\nqsv\ndrm\n';
  /**
   * Per-call override of the result (exit code / stderr) by argv; undefined uses `exitCode`.
   * Capability tests (output `-`) succeed unless this says otherwise.
   */
  respond: ((args: readonly string[]) => { exitCode: number | null; stderr?: string } | undefined) | null = null;
  private readonly waiting: Array<() => void> = [];

  async locate(): Promise<string | null> {
    return this.binary;
  }

  start(_binary: string, args: readonly string[], onStdout: (chunk: string) => void): RunningProcess {
    this.calls.push([...args]);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    let settle!: (r: ProcessResult) => void;
    const done = new Promise<ProcessResult>((r) => (settle = r));
    let settled = false;
    const scripted = this.respond?.(args);
    const toNull = args.at(-1) === '-';
    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      if (!toNull) {
        if (code === 0) await writeFile(args.at(-1)!, this.output);
        else await writeFile(args.at(-1)!, 'partial').catch(() => undefined);
      }
      this.inFlight--;
      const stderr = scripted?.stderr ?? (code === 0 ? '' : 'Conversion failed!');
      settle({ exitCode: code, stderrTail: stderr.trim().split(/\r?\n/).slice(-5).join('\n'), stderr });
    };
    const exitCode = scripted ? scripted.exitCode : toNull ? 0 : this.exitCode;
    setTimeout(() => {
      for (const p of this.progress) onStdout(p);
      if (this.hold && !toNull) this.waiting.push(() => void finish(exitCode));
      else void finish(exitCode);
    }, 1);
    return {
      done,
      kill: () => {
        this.killed++;
        void finish(null);
      },
    };
  }

  release(): void {
    for (const f of this.waiting.splice(0)) f();
  }

  async exec(): Promise<string> {
    return this.hwaccelsOutput;
  }
}

export const NOW = new Date(2026, 9, 26, 12, 0, 0);
export const log = pino({ level: 'silent' });

export const HEVC_INFO: MediaInfo = {
  videoCodec: 'HEVC',
  videoFormat: 'hevc',
  container: 'matroska',
  width: 3840,
  height: 2160,
  videoBitDepth: 10,
  videoDynamicRange: 'HDR10',
  durationMs: 100_000,
  overallBitrate: 40_000_000,
  audioFormat: 'truehd',
  audioStreams: [
    { codec: 'truehd', channels: 8, language: 'eng' },
    { codec: 'ac3', channels: 6, language: 'ger' },
  ],
  subtitleStreams: [
    { codec: 'subrip', language: 'eng', forced: false, hearingImpaired: false },
    { codec: 'hdmv_pgs_subtitle', language: 'eng', forced: false, hearingImpaired: false },
  ],
};

export const H264_INFO: MediaInfo = {
  videoCodec: 'AVC',
  videoFormat: 'h264',
  container: 'matroska',
  width: 1920,
  height: 1080,
  videoBitDepth: 8,
  videoDynamicRange: 'SDR',
  durationMs: 60_000,
  overallBitrate: 8_000_000,
  audioFormat: 'dts',
  audioStreams: [{ codec: 'dts', channels: 6, language: 'eng' }],
  subtitleStreams: [],
};

const quality = () => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

export interface Fixture {
  db: Db;
  tmp: string;
  binPath: string;
  bus: EventBus;
  events: ServerEvent[];
  runner: FakeRunner;
  service: TranscodeService;
  notices: TranscodedNotice[];
  reanalyzed: number[];
  clock: { now: Date };
  movieId: number;
  movieFileId: number;
  moviePath: string;
  seriesId: number;
  episodeFileId: number;
  episodePath: string;
}

export async function setup(opts: { recycleBin?: boolean } = {}): Promise<Fixture> {
  const db = await createTestDb({ ...tables });
  const tmp = await mkdtemp(join(tmpdir(), 'arclight-transcode-'));
  const binPath = join(tmp, 'recycle');
  await mkdir(join(tmp, 'movies'), { recursive: true });
  await mkdir(join(tmp, 'tv'), { recursive: true });
  await libraryService.addRootFolder(db, { path: join(tmp, 'movies'), mediaType: 'movie' });
  await libraryService.addRootFolder(db, { path: join(tmp, 'tv'), mediaType: 'series' });
  const tag = libraryService.createTag(db, 'transcode');
  const movie = libraryService.addMovie(
    db,
    { tmdbId: 2, title: 'Film', year: 2021, status: 'released' },
    AddMovieRequest.parse({ tmdbId: 2, rootFolderPath: join(tmp, 'movies'), qualityProfileId: 1, tags: [tag.id] }),
    NOW.toISOString(),
  );
  const series = libraryService.addSeries(
    db,
    {
      tmdbId: 1,
      title: 'Show',
      year: 2020,
      status: 'continuing',
      seasons: [{ seasonNumber: 1 }],
      episodes: [{ seasonNumber: 1, episodeNumber: 1, title: 'E1' }],
    },
    AddSeriesRequest.parse({ tmdbId: 1, rootFolderPath: join(tmp, 'tv'), qualityProfileId: 2 }),
    NOW.toISOString(),
  );
  await mkdir(movie.path, { recursive: true });
  await mkdir(join(series.path, 'Season 01'), { recursive: true });
  const moviePath = join(movie.path, 'Film (2021).mkv');
  const episodePath = join(series.path, 'Season 01', 'Show S01E01.mkv');
  await writeFile(moviePath, 'original-movie-bytes');
  await writeFile(episodePath, 'original-episode');
  const movieFile = libraryService.addMediaFile(db, {
    mediaType: 'movie',
    movieId: movie.id,
    relativePath: 'Film (2021).mkv',
    path: moviePath,
    sizeBytes: 20,
    quality: quality(),
    languages: ['en'],
  }).file;
  const ep = libraryService.listEpisodes(db, { seriesId: series.id })[0]!;
  const episodeFile = libraryService.addMediaFile(db, {
    mediaType: 'series',
    seriesId: series.id,
    seasonNumber: 1,
    episodeIds: [ep.id],
    relativePath: 'Season 01/Show S01E01.mkv',
    path: episodePath,
    sizeBytes: 16,
    quality: quality(),
    languages: ['en'],
  }).file;
  db.update(mediaFiles).set({ mediaInfo: HEVC_INFO }).where(eq(mediaFiles.id, movieFile.id)).run();
  db.update(mediaFiles).set({ mediaInfo: H264_INFO }).where(eq(mediaFiles.id, episodeFile.id)).run();

  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const runner = new FakeRunner();
  const notices: TranscodedNotice[] = [];
  const reanalyzed: number[] = [];
  const clock = { now: NOW };
  const service = new TranscodeService({
    db,
    runner,
    bus,
    log,
    now: () => clock.now,
    reanalyze: (id) => reanalyzed.push(id),
    notify: (n) => void notices.push(n),
    ...(opts.recycleBin === false ? {} : { recycleBin: () => new RecycleBin(binPath, () => clock.now) }),
  });
  return {
    db,
    tmp,
    binPath,
    bus,
    events,
    runner,
    service,
    notices,
    reanalyzed,
    clock,
    movieId: movie.id,
    movieFileId: movieFile.id,
    moviePath,
    seriesId: series.id,
    episodeFileId: episodeFile.id,
    episodePath,
  };
}

export function ruleInput(raw: Partial<TranscodeRuleInputRaw> = {}): TranscodeRuleInput {
  return TranscodeRuleInput.parse({ name: 'Rule', action: 'remux', ...raw });
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}
