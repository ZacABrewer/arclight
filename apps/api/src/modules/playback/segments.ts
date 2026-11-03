import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setPriority } from 'node:os';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { EpisodeSegmentsRow, MediaInfo, PlayerSettings, SeasonSegmentsResponse, VideoSegment, VideoSegmentEdit } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles } from '../library/schema.js';
import { alignCodes, codesFromBlob, codesToBlob, fingerprint, FRAME_MS, pcmFromS16le, SAMPLE_RATE } from './fingerprint.js';
import { videoFingerprints, videoSegmentOverrides, videoSegments, videoSegmentScans } from './segments-schema.js';
import { fileStamp, type Limiter } from './video-stream.js';

// Intro and credits detection. Segments come from three places, and per type the first one that
// has it wins: a manual edit (admin), a chapter mark in the file, an audio fingerprint match.
//
// Detection works per season: each episode's first minutes (head) and last minutes (tail) are
// fingerprinted (fingerprint.ts) and compared with up to three neighbouring episodes. A stretch
// of 15-150 s that an episode shares with its neighbours near the start is its intro; one of at
// least 15 s near the end is its credits. The median over the accepted pairs is stored when at
// least half the comparisons agree. All ffmpeg work goes through the shared background limiter
// and waits while every live video slot is taken.

const HEAD_MAX_MS = 600_000;
const HEAD_SHARE = 0.4;
const TAIL_MAX_MS = 420_000;
const TAIL_SHARE = 0.35;
const INTRO_MIN_MS = 15_000;
const INTRO_MAX_MS = 150_000;
const CREDITS_MIN_MS = 15_000;
/** A credits run ending this close to the window end runs to the end of the file. */
const CREDITS_TO_END_MS = 5_000;
const NEIGHBOURS = 3;
const MIN_CONFIDENCE = 0.5;

export type Part = 'head' | 'tail';

/** The audio window of a file part: where it starts and how long it is (ms). */
export function windowOf(part: Part, durationMs: number): { startMs: number; lengthMs: number } {
  if (part === 'head') return { startMs: 0, lengthMs: Math.round(Math.min(HEAD_MAX_MS, durationMs * HEAD_SHARE)) };
  const lengthMs = Math.round(Math.min(TAIL_MAX_MS, durationMs * TAIL_SHARE));
  return { startMs: Math.max(0, durationMs - lengthMs), lengthMs };
}

/** ffmpeg arguments that write mono 8 kHz s16le PCM of one audio stream's window to stdout. */
export function buildAudioExtractArgs(input: string, audioOrdinal: number, startMs: number, lengthMs: number): string[] {
  const secs = (ms: number) => (ms / 1000).toFixed(3);
  return [
    '-nostdin',
    '-v',
    'error',
    ...(startMs > 0 ? ['-ss', secs(startMs)] : []),
    '-t',
    secs(lengthMs),
    '-i',
    input,
    '-map',
    `0:a:${audioOrdinal}`,
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ];
}

/** The default audio stream's ordinal among the audio streams (0 when none is marked). */
export function defaultAudioOrdinal(info: MediaInfo | null): number {
  const i = (info?.audioStreams ?? []).findIndex((s) => s.default);
  return i < 0 ? 0 : i;
}

/** Runs ffmpeg at low priority and returns stdout (PCM); rejects on a non-zero exit. */
export type PcmExtractor = (bin: string, args: readonly string[], timeoutMs: number) => Promise<Buffer>;

export const ffmpegPcm: PcmExtractor = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // not permitted here: normal priority
      }
    }
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout!.on('data', (c: Buffer) => chunks.push(c));
    child.stderr!.on('data', (c: Buffer) => {
      if (err.length < 2000) err += c.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().slice(0, 300)}`));
    });
  });

// ---- the pure season logic -------------------------------------------------------------------

export interface PartCodes {
  startMs: number;
  lengthMs: number;
  codes: Uint32Array;
}

export interface EpisodeCodes {
  mediaFileId: number;
  durationMs: number;
  head: PartCodes | null;
  tail: PartCodes | null;
}

export interface DetectedSegment {
  mediaFileId: number;
  type: 'intro' | 'credits';
  startMs: number;
  endMs: number;
  confidence: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/** Up to `n` other indexes, nearest first: i-1, i+1, i-2, i+2 ... */
export function neighbourIndexes(i: number, count: number, n = NEIGHBOURS): number[] {
  const out: number[] = [];
  for (let d = 1; out.length < n && (i - d >= 0 || i + d < count); d++) {
    if (i - d >= 0) out.push(i - d);
    if (out.length < n && i + d < count) out.push(i + d);
  }
  return out;
}

/** A run of `part` on the episode's own timeline when it passes the intro / credits rules. */
function runOf(type: 'intro' | 'credits', a: PartCodes, b: PartCodes, durationMs: number): { startMs: number; endMs: number } | null {
  const run = alignCodes(a.codes, b.codes);
  if (!run) return null;
  const startMs = Math.round(a.startMs + run.startA * FRAME_MS);
  let endMs = Math.round(a.startMs + run.endA * FRAME_MS);
  const len = endMs - startMs;
  if (type === 'intro') return len >= INTRO_MIN_MS && len <= INTRO_MAX_MS ? { startMs, endMs } : null;
  if (len < CREDITS_MIN_MS) return null;
  const windowEnd = a.startMs + a.codes.length * FRAME_MS;
  if (windowEnd - endMs <= CREDITS_TO_END_MS) endMs = durationMs;
  return { startMs, endMs: Math.min(endMs, durationMs) };
}

/** Season consensus: per episode and type, the median accepted run when ≥ half the comparisons agree. */
export function detectSeason(eps: readonly EpisodeCodes[]): DetectedSegment[] {
  const out: DetectedSegment[] = [];
  if (eps.length < 2) return out;
  for (let i = 0; i < eps.length; i++) {
    const me = eps[i]!;
    for (const type of ['intro', 'credits'] as const) {
      const part = type === 'intro' ? 'head' : 'tail';
      const mine = me[part];
      if (!mine) continue;
      let compared = 0;
      const runs: Array<{ startMs: number; endMs: number }> = [];
      for (const j of neighbourIndexes(i, eps.length)) {
        const other = eps[j]![part];
        if (!other) continue;
        compared++;
        const r = runOf(type, mine, other, me.durationMs);
        if (r) runs.push(r);
      }
      if (compared === 0 || runs.length === 0) continue;
      const confidence = runs.length / compared;
      if (confidence < MIN_CONFIDENCE) continue;
      const startMs = median(runs.map((r) => r.startMs));
      const endMs = median(runs.map((r) => r.endMs));
      if (endMs > startMs) out.push({ mediaFileId: me.mediaFileId, type, startMs, endMs, confidence });
    }
  }
  return out;
}

/**
 * Effective segments of a file: manual rows only when the file has an override; else per type the
 * chapter segment, else a fingerprint segment taken from the file as it is now (`stamp`).
 */
export function mergeSegments(
  chapterSegments: readonly VideoSegment[],
  stored: ReadonlyArray<{ type: VideoSegment['type']; startMs: number; endMs: number; source: 'fingerprint' | 'manual'; fileStamp: string | null }>,
  override: boolean,
  stamp: string | null,
): VideoSegment[] {
  if (override) {
    return stored
      .filter((s) => s.source === 'manual')
      .map((s) => ({ type: s.type, startMs: s.startMs, endMs: s.endMs, source: 'manual' as const }))
      .sort((a, b) => a.startMs - b.startMs);
  }
  const out: VideoSegment[] = chapterSegments.map((s) => ({ ...s, source: 'chapter' as const }));
  const have = new Set(out.map((s) => s.type));
  for (const s of stored) {
    if (s.source !== 'fingerprint' || have.has(s.type) || !stamp || s.fileStamp !== stamp) continue;
    out.push({ type: s.type, startMs: s.startMs, endMs: s.endMs, source: 'fingerprint' });
    have.add(s.type);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Effective segments for a file (PlayableItem.segments). */
export async function effectiveSegments(db: Db, file: { id: number; path: string }, chapterSegments: readonly VideoSegment[]): Promise<VideoSegment[]> {
  const override = db.select({ id: videoSegmentOverrides.mediaFileId }).from(videoSegmentOverrides).where(eq(videoSegmentOverrides.mediaFileId, file.id)).get() !== undefined;
  const stored = db
    .select({ type: videoSegments.type, startMs: videoSegments.startMs, endMs: videoSegments.endMs, source: videoSegments.source, fileStamp: videoSegments.fileStamp })
    .from(videoSegments)
    .where(eq(videoSegments.mediaFileId, file.id))
    .all();
  const stamp = !override && stored.some((s) => s.source === 'fingerprint') ? await fileStamp(file.path) : null;
  return mergeSegments(chapterSegments, stored, override, stamp);
}

/** Replaces a file's manual segments and marks it overridden ([] = no segments, detection ignored). */
export function setManualSegments(db: Db, mediaFileId: number, segments: readonly VideoSegmentEdit[], nowIso: string): void {
  db.transaction((tx) => {
    tx.delete(videoSegments).where(and(eq(videoSegments.mediaFileId, mediaFileId), eq(videoSegments.source, 'manual'))).run();
    for (const s of segments) {
      tx.insert(videoSegments).values({ mediaFileId, type: s.type, startMs: s.startMs, endMs: s.endMs, source: 'manual', confidence: null, fileStamp: null, createdAt: nowIso, updatedAt: nowIso }).run();
    }
    tx.insert(videoSegmentOverrides).values({ mediaFileId, updatedAt: nowIso }).onConflictDoUpdate({ target: videoSegmentOverrides.mediaFileId, set: { updatedAt: nowIso } }).run();
  });
}

/** Drops a file's override and manual rows: back to chapters and detection. */
export function clearManualSegments(db: Db, mediaFileId: number): void {
  db.transaction((tx) => {
    tx.delete(videoSegments).where(and(eq(videoSegments.mediaFileId, mediaFileId), eq(videoSegments.source, 'manual'))).run();
    tx.delete(videoSegmentOverrides).where(eq(videoSegmentOverrides.mediaFileId, mediaFileId)).run();
  });
}

// ---- the service -----------------------------------------------------------------------------

export interface SegmentServiceOptions {
  db: Db;
  locate: () => Promise<string | null>;
  settings: () => PlayerSettings;
  /** True while every live video slot is in use. */
  liveBusy: () => boolean;
  limiter: Limiter;
  extract?: PcmExtractor;
  pollMs?: number;
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
}

interface SeasonFile {
  mediaFileId: number;
  episodeId: number;
  episodeNumber: number;
  title: string | null;
  path: string;
  mediaInfo: MediaInfo | null;
  durationMs: number;
  dateAdded: string;
}

const seasonKey = (seriesId: number, seasonNumber: number) => `${seriesId}:${seasonNumber}`;

export class SegmentService {
  private readonly queued = new Map<string, { seriesId: number; seasonNumber: number; force: boolean }>();
  private readonly order: string[] = [];
  private pumping: Promise<void> | null = null;
  private readonly extract: PcmExtractor;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly opts: SegmentServiceOptions) {
    this.extract = opts.extract ?? ffmpegPcm;
    this.now = opts.now ?? Date.now;
  }

  /** The primary file of each episode with one in a season, by episode number. */
  seasonFiles(seriesId: number, seasonNumber: number): SeasonFile[] {
    const rows = this.opts.db
      .select({ episode: episodes, file: mediaFiles })
      .from(episodes)
      .innerJoin(mediaFiles, eq(mediaFiles.id, episodes.episodeFileId))
      .where(and(eq(episodes.seriesId, seriesId), eq(episodes.seasonNumber, seasonNumber), isNotNull(episodes.episodeFileId)))
      .all()
      .sort((a, b) => a.episode.episodeNumber - b.episode.episodeNumber);
    const seen = new Set<number>();
    const out: SeasonFile[] = [];
    for (const r of rows) {
      // A multi-episode file is one entry (its first episode).
      if (seen.has(r.file.id)) continue;
      seen.add(r.file.id);
      const info = r.file.mediaInfo ?? null;
      out.push({
        mediaFileId: r.file.id,
        episodeId: r.episode.id,
        episodeNumber: r.episode.episodeNumber,
        title: r.episode.title,
        path: r.file.path,
        mediaInfo: info,
        durationMs: info?.durationMs ?? (info?.runtimeSeconds ? info.runtimeSeconds * 1000 : 0),
        dateAdded: r.file.dateAdded,
      });
    }
    return out;
  }

  /** Hash of the member files' identities (stamp and known duration): a changed season scans again. */
  async seasonStamp(files: readonly SeasonFile[]): Promise<string> {
    const parts: string[] = [];
    for (const f of files) parts.push(`${f.mediaFileId}:${(await fileStamp(f.path)) ?? 'missing'}:${f.durationMs || 'x'}`);
    return createHash('sha1').update(parts.join('|')).digest('hex');
  }

  private scanRow(seriesId: number, seasonNumber: number) {
    return this.opts.db
      .select()
      .from(videoSegmentScans)
      .where(and(eq(videoSegmentScans.seriesId, seriesId), eq(videoSegmentScans.seasonNumber, seasonNumber)))
      .get();
  }

  private setScan(seriesId: number, seasonNumber: number, values: { status: 'queued' | 'running' | 'done' | 'failed'; stamp?: string | null; error?: string | null; scannedAt?: string | null }): void {
    this.opts.db
      .insert(videoSegmentScans)
      .values({ seriesId, seasonNumber, status: values.status, stamp: values.stamp ?? null, error: values.error ?? null, scannedAt: values.scannedAt ?? null })
      .onConflictDoUpdate({
        target: [videoSegmentScans.seriesId, videoSegmentScans.seasonNumber],
        set: { status: values.status, ...(values.stamp !== undefined ? { stamp: values.stamp } : {}), ...(values.error !== undefined ? { error: values.error } : {}), ...(values.scannedAt !== undefined ? { scannedAt: values.scannedAt } : {}) },
      })
      .run();
  }

  /** Queues one season (once); `force` re-detects even when nothing changed. True when it was queued now. */
  enqueue(seriesId: number, seasonNumber: number, force = false): boolean {
    const key = seasonKey(seriesId, seasonNumber);
    const had = this.queued.get(key);
    if (had) {
      had.force ||= force;
      return false;
    }
    this.queued.set(key, { seriesId, seasonNumber, force });
    this.order.push(key);
    this.pumping ??= this.pump().finally(() => {
      this.pumping = null;
    });
    return true;
  }

  isQueued(seriesId: number, seasonNumber: number): boolean {
    return this.queued.has(seasonKey(seriesId, seasonNumber));
  }

  async idle(signal?: AbortSignal): Promise<void> {
    while (this.pumping && !signal?.aborted) await this.pumping;
  }

  /** Stops after the current season (shutdown). */
  stop(): void {
    this.stopped = true;
    this.order.length = 0;
  }

  private async pump(): Promise<void> {
    for (;;) {
      const key = this.order.shift();
      if (key === undefined || this.stopped) return;
      const job = this.queued.get(key)!;
      try {
        await this.scanSeason(job.seriesId, job.seasonNumber, job.force);
      } catch (err) {
        if (this.stopped) return;
        this.opts.log?.warn({ err, seriesId: job.seriesId, seasonNumber: job.seasonNumber }, 'intro and credits detection failed');
        this.setScan(job.seriesId, job.seasonNumber, { status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : String(err), scannedAt: new Date(this.now()).toISOString() });
      } finally {
        this.queued.delete(key);
      }
    }
  }

  /** Runs one ffmpeg job under the background limiter, after any live-stream rush has passed. */
  private async background<T>(job: () => Promise<T>): Promise<T> {
    while (this.opts.liveBusy() && !this.stopped) await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 5000));
    if (this.stopped) throw new Error('stopped');
    return this.opts.limiter.run(job);
  }

  /** The codes of one part, from the table when taken from this exact file, else extracted and stored. */
  private async codesOf(f: SeasonFile, part: Part, stamp: string, bin: string): Promise<PartCodes | null> {
    const win = windowOf(part, f.durationMs);
    if (win.lengthMs < 20_000) return null;
    const row = this.opts.db
      .select()
      .from(videoFingerprints)
      .where(and(eq(videoFingerprints.mediaFileId, f.mediaFileId), eq(videoFingerprints.part, part)))
      .get();
    if (row && row.fileStamp === stamp && row.startMs === win.startMs) return { startMs: row.startMs, lengthMs: win.lengthMs, codes: codesFromBlob(row.hashes) };
    const args = buildAudioExtractArgs(f.path, defaultAudioOrdinal(f.mediaInfo), win.startMs, win.lengthMs);
    const pcm = await this.background(() => this.extract(bin, args, 10 * 60_000));
    const codes = fingerprint(pcmFromS16le(pcm));
    const createdAt = new Date(this.now()).toISOString();
    const values = { mediaFileId: f.mediaFileId, part, fileStamp: stamp, frameMs: FRAME_MS, startMs: win.startMs, hashes: codesToBlob(codes), createdAt };
    this.opts.db
      .insert(videoFingerprints)
      .values(values)
      .onConflictDoUpdate({ target: [videoFingerprints.mediaFileId, videoFingerprints.part], set: values })
      .run();
    return { startMs: win.startMs, lengthMs: win.lengthMs, codes };
  }

  /** Detects one season now (the queue calls this). Returns segments stored. */
  async scanSeason(seriesId: number, seasonNumber: number, force = false): Promise<number> {
    // Turned off since it was queued: nothing happens.
    if (!this.opts.settings().segmentDetection) return 0;
    const files = this.seasonFiles(seriesId, seasonNumber).filter((f) => f.durationMs > 0);
    const stamp = await this.seasonStamp(this.seasonFiles(seriesId, seasonNumber));
    const prev = this.scanRow(seriesId, seasonNumber);
    if (!force && prev?.stamp === stamp && prev.status === 'done') return 0;
    if (files.length < 2) {
      this.setScan(seriesId, seasonNumber, { status: 'done', stamp, error: null, scannedAt: new Date(this.now()).toISOString() });
      return 0;
    }
    this.setScan(seriesId, seasonNumber, { status: 'running' });
    const bin = await this.opts.locate();
    if (!bin) throw new Error('ffmpeg was not found');
    const eps: EpisodeCodes[] = [];
    const stamps = new Map<number, string>();
    let failures = 0;
    for (const f of files) {
      const fs = await fileStamp(f.path);
      if (!fs) continue;
      stamps.set(f.mediaFileId, fs);
      try {
        eps.push({ mediaFileId: f.mediaFileId, durationMs: f.durationMs, head: await this.codesOf(f, 'head', fs, bin), tail: await this.codesOf(f, 'tail', fs, bin) });
      } catch (err) {
        failures++;
        this.opts.log?.warn({ err, mediaFileId: f.mediaFileId }, 'could not read the audio of an episode');
      }
    }
    if (eps.length < 2 && failures > 0) throw new Error(`could not read the audio of ${failures} episodes`);
    const found = detectSeason(eps);
    const nowIso = new Date(this.now()).toISOString();
    const ids = files.map((f) => f.mediaFileId);
    this.opts.db.transaction((tx) => {
      tx.delete(videoSegments).where(and(inArray(videoSegments.mediaFileId, ids), eq(videoSegments.source, 'fingerprint'))).run();
      for (const s of found) {
        tx.insert(videoSegments)
          .values({ mediaFileId: s.mediaFileId, type: s.type, startMs: s.startMs, endMs: s.endMs, source: 'fingerprint', confidence: Math.round(s.confidence * 100) / 100, fileStamp: stamps.get(s.mediaFileId) ?? null, createdAt: nowIso, updatedAt: nowIso })
          .run();
      }
    });
    this.setScan(seriesId, seasonNumber, { status: 'done', stamp, error: failures > 0 ? `could not read the audio of ${failures} episodes` : null, scannedAt: nowIso });
    return found.length;
  }

  /** Seasons (with ≥ 2 files) whose stamp changed since their last scan, newest file first. */
  async changedSeasons(seriesId?: number): Promise<Array<{ seriesId: number; seasonNumber: number }>> {
    const rows = this.opts.db
      .select({ seriesId: episodes.seriesId, seasonNumber: episodes.seasonNumber, dateAdded: mediaFiles.dateAdded })
      .from(episodes)
      .innerJoin(mediaFiles, eq(mediaFiles.id, episodes.episodeFileId))
      .where(seriesId !== undefined ? eq(episodes.seriesId, seriesId) : isNotNull(episodes.episodeFileId))
      .all();
    const seasons = new Map<string, { seriesId: number; seasonNumber: number; files: number; newest: string }>();
    for (const r of rows) {
      const k = seasonKey(r.seriesId, r.seasonNumber);
      const s = seasons.get(k) ?? { seriesId: r.seriesId, seasonNumber: r.seasonNumber, files: 0, newest: '' };
      s.files++;
      if (r.dateAdded > s.newest) s.newest = r.dateAdded;
      seasons.set(k, s);
    }
    const out: Array<{ seriesId: number; seasonNumber: number; newest: string }> = [];
    for (const s of seasons.values()) {
      if (s.files < 2) continue;
      const prev = this.scanRow(s.seriesId, s.seasonNumber);
      if (prev && prev.status === 'done' && prev.stamp === (await this.seasonStamp(this.seasonFiles(s.seriesId, s.seasonNumber)))) continue;
      out.push({ seriesId: s.seriesId, seasonNumber: s.seasonNumber, newest: s.newest });
    }
    out.sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : a.seriesId - b.seriesId || a.seasonNumber - b.seasonNumber));
    return out.map(({ seriesId: id, seasonNumber }) => ({ seriesId: id, seasonNumber }));
  }

  /** The nightly job: queue every changed season and wait for the queue. */
  async nightly(signal?: AbortSignal): Promise<string> {
    if (!this.opts.settings().segmentDetection) return 'intro and credits detection is turned off';
    const seasons = await this.changedSeasons();
    for (const s of seasons) this.enqueue(s.seriesId, s.seasonNumber);
    await this.idle(signal);
    return seasons.length === 0 ? 'no season changed' : `scanned ${seasons.length} seasons`;
  }

  /** GET /playback/segments/series/:seriesId/season/:seasonNumber. */
  async season(seriesId: number, seasonNumber: number, chaptersOf: (f: { id: number; path: string; durationMs: number }) => Promise<VideoSegment[]>): Promise<SeasonSegmentsResponse> {
    const scan = this.scanRow(seriesId, seasonNumber);
    const queued = this.isQueued(seriesId, seasonNumber);
    const rows: EpisodeSegmentsRow[] = [];
    for (const f of this.seasonFiles(seriesId, seasonNumber)) {
      const manual = this.opts.db.select({ id: videoSegmentOverrides.mediaFileId }).from(videoSegmentOverrides).where(eq(videoSegmentOverrides.mediaFileId, f.mediaFileId)).get() !== undefined;
      rows.push({
        episodeId: f.episodeId,
        mediaFileId: f.mediaFileId,
        seasonNumber,
        episodeNumber: f.episodeNumber,
        title: f.title,
        durationMs: f.durationMs,
        segments: await effectiveSegments(this.opts.db, { id: f.mediaFileId, path: f.path }, await chaptersOf({ id: f.mediaFileId, path: f.path, durationMs: f.durationMs })),
        manual,
      });
    }
    // A 'running' row left by a restart is not running any more.
    const status = queued ? (scan?.status === 'running' ? 'running' : 'queued') : scan?.status === 'done' || scan?.status === 'failed' ? scan.status : scan?.scannedAt ? 'done' : 'never';
    return { seriesId, seasonNumber, scan: { status, scannedAt: scan?.scannedAt ?? null, error: scan?.error ?? null }, episodes: rows };
  }
}
