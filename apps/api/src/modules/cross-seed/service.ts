import { link, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Cron } from 'croner';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { DownloadClient } from '@arclight/download-clients';
import type { SearchRequest } from '@arclight/indexers';
import { parseRelease } from '@arclight/parser';
import { parseTorrent, Storage, type Metainfo, type Session } from '@arclight/torrent-engine';
import {
  CrossSeedSettings,
  type CrossSeedListQuery,
  type CrossSeedResource,
  type CrossSeedSearchResult,
  type CrossSeedSkip,
  type Indexer,
  type ReleaseResource,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, series, trackedDownloads } from '../../db/schema.js';
import type { ReleaseDownload } from '../indexers/index.js';
import { getSection, setSection } from '../settings/service.js';
import { crossSeeds, crossSeedSearches, type CrossSeedRow } from './schema.js';

// Cross-seeding: for a library file, search torrent indexers for the same release (size within
// tolerance, parsed title naming the same episode(s) or movie), download the .torrent, check
// that its piece layout matches the file on disk (first and last piece hashed with the engine's
// Storage), and add it to the built-in engine or qBittorrent seed-only (skip checking) pointing
// at the existing file. A torrent that names the file differently gets a hard link (symlink as
// a fallback) under the link folder. Season packs and multi-file torrents are skipped.

export type CrossSeedErrorCode = 'NOT_FOUND' | 'VALIDATION';

export class CrossSeedError extends Error {
  override readonly name = 'CrossSeedError';
  constructor(
    readonly code: CrossSeedErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the module needs from the indexers module (IndexersService satisfies it). */
export interface CrossSeedIndexersPort {
  list(): Array<Pick<Indexer, 'id' | 'name' | 'protocol' | 'enableAutomaticSearch'>>;
  search(request: SearchRequest, opts: { mode: 'automatic'; indexerIds?: readonly number[] }): Promise<ReleaseResource[]>;
  downloadRelease(indexerId: number, url: string): Promise<ReleaseDownload>;
}

export interface CrossSeedClient {
  id: number;
  name: string;
  implementation: string;
  client: DownloadClient;
}

export interface CrossSeedServiceOptions {
  db: Db;
  indexers: CrossSeedIndexersPort;
  /** Enabled download clients (only `builtin` and `qbittorrent` are used). */
  clients: () => CrossSeedClient[];
  /** The built-in engine (dedupe against torrents it already has). */
  session?: () => Session | null;
  /** Link folder when the `linkDir` setting is empty. */
  defaultLinkDir: () => string;
  log?: Logger;
  now?: () => Date;
  /** Called after a cross-seed is recorded (tracker attribution caches). */
  onAdded?: (row: CrossSeedRow) => void;
}

const SUPPORTED_CLIENTS = ['builtin', 'qbittorrent'];

interface Target {
  file: typeof mediaFiles.$inferSelect;
  mediaType: 'series' | 'movie';
  title: string;
  altTitles: string[];
  year: number;
  tags: number[];
  season?: number;
  episodeNumbers?: number[];
  request: SearchRequest;
}

interface Candidate {
  release: ReleaseResource;
  exact: boolean;
}

/** Lowercase letters and digits only (`The Office (US)` → `theofficeus`). */
export function cleanName(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

/** Size within `tolerancePercent` of `fileSize`. */
export function sizeMatches(size: number, fileSize: number, tolerancePercent: number): { ok: boolean; exact: boolean } {
  if (size <= 0 || fileSize <= 0) return { ok: false, exact: false };
  const exact = size === fileSize;
  return { ok: exact || Math.abs(size - fileSize) <= (fileSize * tolerancePercent) / 100, exact };
}

/**
 * Why a release title does not name the same episode(s) / movie as the target, or null when
 * it does. Season packs (full or partial) and multi-season releases never match.
 */
export function titleMismatch(title: string, target: Pick<Target, 'mediaType' | 'title' | 'altTitles' | 'year' | 'season' | 'episodeNumbers'>): string | null {
  const parsed = parseRelease(title, target.mediaType);
  const names = new Set([target.title, ...target.altTitles].map(cleanName));
  if (target.mediaType === 'series') {
    const s = parsed.series;
    if (!s) return 'not an episode release';
    if (s.fullSeason || s.isPartialSeason || s.isMultiSeason || s.isSeasonExtra) return 'season pack';
    if (!names.has(cleanName(s.titleInfo.titleWithoutYear)) && !names.has(cleanName(s.title))) return 'different series';
    if (s.seasons.length !== 1 || s.seasons[0] !== target.season) return 'different season';
    const want = [...(target.episodeNumbers ?? [])].sort((a, b) => a - b).join(',');
    const got = [...s.episodes].sort((a, b) => a - b).join(',');
    return want === got ? null : 'different episodes';
  }
  const m = parsed.movie;
  if (!m) return 'not a movie release';
  if (!names.has(cleanName(m.titleWithoutYear))) return 'different movie';
  if (m.year > 0 && target.year > 0 && Math.abs(m.year - target.year) > 1) return 'different year';
  return null;
}

/** Hash the first and last piece of `meta` from the files under `savePath`. */
export async function verifyEnds(meta: Metainfo, savePath: string): Promise<boolean> {
  const storage = new Storage(meta, { savePath, cacheBytes: 2 * meta.pieceLength });
  try {
    const last = meta.pieceCount - 1;
    if (!(await storage.verifyPiece(0))) return false;
    return last === 0 || (await storage.verifyPiece(last));
  } finally {
    await storage.close().catch(() => undefined);
  }
}

export class CrossSeedService {
  private readonly db: Db;
  private readonly indexers: CrossSeedIndexersPort;
  private readonly clients: () => CrossSeedClient[];
  private readonly session: () => Session | null;
  private readonly defaultLinkDir: () => string;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly onAdded: ((row: CrossSeedRow) => void) | undefined;

  constructor(opts: CrossSeedServiceOptions) {
    this.db = opts.db;
    this.indexers = opts.indexers;
    this.clients = opts.clients;
    this.session = opts.session ?? (() => null);
    this.defaultLinkDir = opts.defaultLinkDir;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.onAdded = opts.onAdded;
  }

  // ---- settings ----------------------------------------------------------------------

  settings(): CrossSeedSettings {
    return getSection(this.db, 'crossSeed');
  }

  updateSettings(input: z.input<typeof CrossSeedSettings>): CrossSeedSettings {
    const parsed = CrossSeedSettings.safeParse(input);
    if (!parsed.success) throw new CrossSeedError('VALIDATION', z.prettifyError(parsed.error));
    try {
      new Cron(parsed.data.schedule, { paused: true }).stop();
    } catch {
      throw new CrossSeedError('VALIDATION', `"${parsed.data.schedule}" is not a valid cron expression`);
    }
    return setSection(this.db, 'crossSeed', parsed.data);
  }

  // ---- reading -----------------------------------------------------------------------

  list(query: CrossSeedListQuery = {}): CrossSeedResource[] {
    const where = [
      ...(query.mediaFileId !== undefined ? [eq(crossSeeds.mediaFileId, query.mediaFileId)] : []),
      ...(query.state ? [eq(crossSeeds.state, query.state)] : []),
    ];
    const rows = this.db
      .select()
      .from(crossSeeds)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(crossSeeds.addedAt), desc(crossSeeds.id))
      .all();
    const names = new Map(this.indexers.list().map((i) => [i.id, i.name]));
    return rows.map((r) => ({
      id: r.id,
      mediaFileId: r.mediaFileId,
      indexerId: r.indexerId,
      indexerName: r.indexerId === null ? null : (names.get(r.indexerId) ?? null),
      infoHash: r.infoHash,
      title: r.title,
      size: r.size,
      state: r.state,
      message: r.message,
      downloadClientId: r.downloadClientId,
      savePath: r.savePath,
      addedAt: r.addedAt,
    }));
  }

  /** The indexer a cross-seeded torrent came from (tracker-stats attribution). */
  indexerFor(infoHash: string): number | undefined {
    const row = this.db.select({ indexerId: crossSeeds.indexerId }).from(crossSeeds).where(eq(crossSeeds.infoHash, infoHash.toLowerCase())).get();
    return row?.indexerId ?? undefined;
  }

  // ---- searching ---------------------------------------------------------------------

  async search(req: { mediaFileId?: number | undefined; seriesId?: number | undefined; movieId?: number | undefined }): Promise<CrossSeedSearchResult> {
    let fileIds: number[];
    if (req.mediaFileId !== undefined) {
      if (!this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.id, req.mediaFileId)).get()) {
        throw new CrossSeedError('NOT_FOUND', `media file ${req.mediaFileId} not found`);
      }
      fileIds = [req.mediaFileId];
    } else if (req.seriesId !== undefined) {
      if (!this.db.select({ id: series.id }).from(series).where(eq(series.id, req.seriesId)).get()) {
        throw new CrossSeedError('NOT_FOUND', `series ${req.seriesId} not found`);
      }
      fileIds = this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.seriesId, req.seriesId)).orderBy(asc(mediaFiles.id)).all().map((r) => r.id);
    } else if (req.movieId !== undefined) {
      if (!this.db.select({ id: movies.id }).from(movies).where(eq(movies.id, req.movieId)).get()) {
        throw new CrossSeedError('NOT_FOUND', `movie ${req.movieId} not found`);
      }
      fileIds = this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.movieId, req.movieId)).orderBy(asc(mediaFiles.id)).all().map((r) => r.id);
    } else {
      throw new CrossSeedError('VALIDATION', 'pass exactly one of mediaFileId, seriesId or movieId');
    }
    return this.searchFiles(fileIds);
  }

  async searchFiles(fileIds: readonly number[], signal?: AbortSignal): Promise<CrossSeedSearchResult> {
    const result: CrossSeedSearchResult = { filesSearched: 0, candidates: 0, added: [], skipped: [] };
    for (const id of fileIds) {
      if (signal?.aborted) break;
      const one = await this.searchFile(id);
      result.filesSearched += one.filesSearched;
      result.candidates += one.candidates;
      result.added.push(...one.added);
      result.skipped.push(...one.skipped);
    }
    return result;
  }

  /** Scheduled run: files not searched within `searchIntervalDays`, newest first. */
  async runScheduled(signal?: AbortSignal): Promise<string> {
    const s = this.settings();
    if (!s.enabled) return 'cross-seeding is disabled';
    const cutoff = this.now().getTime() - s.searchIntervalDays * 86_400_000;
    const searched = new Map(this.db.select().from(crossSeedSearches).all().map((r) => [r.mediaFileId, Date.parse(r.searchedAt)]));
    const due = this.db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .orderBy(desc(mediaFiles.dateAdded), desc(mediaFiles.id))
      .all()
      .filter((r) => (searched.get(r.id) ?? 0) < cutoff)
      .slice(0, s.maxPerRun)
      .map((r) => r.id);
    const res = await this.searchFiles(due, signal);
    return `${res.filesSearched} file(s) searched, ${res.candidates} candidate(s), ${res.added.length} cross-seed(s) added`;
  }

  /** After an import: search the item's files that were never searched. */
  async searchAfterImport(mediaType: 'series' | 'movie', mediaId: number): Promise<CrossSeedSearchResult | null> {
    const s = this.settings();
    if (!s.enabled || !s.onImport) return null;
    const column = mediaType === 'series' ? mediaFiles.seriesId : mediaFiles.movieId;
    const searched = new Set(this.db.select({ id: crossSeedSearches.mediaFileId }).from(crossSeedSearches).all().map((r) => r.id));
    const ids = this.db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(column, mediaId)).all().map((r) => r.id).filter((id) => !searched.has(id));
    return ids.length > 0 ? this.searchFiles(ids) : null;
  }

  private target(fileId: number): Target | string {
    const file = this.db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId)).get();
    if (!file) return 'media file not found';
    if (file.mediaType === 'series') {
      if (file.seriesId === null) return 'file has no series';
      const show = this.db.select().from(series).where(eq(series.id, file.seriesId)).get();
      if (!show) return 'series not found';
      const eps = this.db.select().from(episodes).where(eq(episodes.episodeFileId, file.id)).orderBy(asc(episodes.episodeNumber)).all();
      const first = eps[0];
      if (!first) return 'file is not linked to an episode';
      if (eps.some((e) => e.seasonNumber !== first.seasonNumber)) return 'file spans seasons';
      const request: SearchRequest = {
        kind: 'tv',
        query: show.title,
        season: first.seasonNumber,
        episode: first.episodeNumber,
        ...(show.tvdbId !== null ? { tvdbId: show.tvdbId } : {}),
        ...(show.imdbId !== null ? { imdbId: show.imdbId } : {}),
        tmdbId: show.tmdbId,
      };
      return {
        file,
        mediaType: 'series',
        title: show.title,
        altTitles: [show.cleanTitle],
        year: show.year,
        tags: show.tags,
        season: first.seasonNumber,
        episodeNumbers: eps.map((e) => e.episodeNumber),
        request,
      };
    }
    if (file.movieId === null) return 'file has no movie';
    const movie = this.db.select().from(movies).where(eq(movies.id, file.movieId)).get();
    if (!movie) return 'movie not found';
    const request: SearchRequest = {
      kind: 'movie',
      query: movie.title,
      tmdbId: movie.tmdbId,
      year: movie.year,
      ...(movie.imdbId !== null ? { imdbId: movie.imdbId } : {}),
    };
    return { file, mediaType: 'movie', title: movie.title, altTitles: [movie.originalTitle], year: movie.year, tags: movie.tags, request };
  }

  private indexerIds(s: CrossSeedSettings): number[] {
    const torrent = this.indexers.list().filter((i) => i.protocol === 'torrent');
    if (s.indexerIds.length > 0) {
      const wanted = new Set(s.indexerIds);
      return torrent.filter((i) => wanted.has(i.id)).map((i) => i.id);
    }
    return torrent.filter((i) => i.enableAutomaticSearch).map((i) => i.id);
  }

  /** Info-hashes already known: cross-seeds, tracked downloads and the engine's torrents. */
  private known(infoHash: string): boolean {
    const h = infoHash.toLowerCase();
    if (this.db.select({ id: crossSeeds.id }).from(crossSeeds).where(eq(crossSeeds.infoHash, h)).get()) return true;
    const tracked = this.db.select({ id: trackedDownloads.id }).from(trackedDownloads).where(inArray(trackedDownloads.downloadId, [h, h.toUpperCase()])).get();
    if (tracked) return true;
    return this.session()?.getTorrent(h) !== undefined;
  }

  private pickClient(s: CrossSeedSettings): CrossSeedClient | null {
    const usable = this.clients().filter((c) => SUPPORTED_CLIENTS.includes(c.implementation));
    if (s.downloadClientId !== null) return usable.find((c) => c.id === s.downloadClientId) ?? null;
    return usable.find((c) => c.implementation === 'builtin') ?? usable[0] ?? null;
  }

  async searchFile(fileId: number): Promise<CrossSeedSearchResult> {
    const s = this.settings();
    const result: CrossSeedSearchResult = { filesSearched: 0, candidates: 0, added: [], skipped: [] };
    const target = this.target(fileId);
    if (typeof target === 'string') {
      this.log?.debug({ fileId, reason: target }, 'cross-seed: file skipped');
      return result;
    }
    if (target.tags.some((t) => s.excludeTags.includes(t))) return result;
    const indexerIds = this.indexerIds(s);
    if (indexerIds.length === 0) return result;
    result.filesSearched = 1;

    let releases: ReleaseResource[] = [];
    try {
      releases = await this.indexers.search(target.request, { mode: 'automatic', indexerIds });
    } catch (err) {
      this.log?.warn({ err, fileId }, 'cross-seed search failed');
    }
    const skip = (r: ReleaseResource, reason: string) => result.skipped.push({ title: r.title, indexerId: r.indexerId, reason } satisfies CrossSeedSkip);
    const allowed = new Set(indexerIds);
    const candidates: Candidate[] = [];
    for (const r of releases) {
      if (r.protocol !== 'torrent' || !allowed.has(r.indexerId)) continue;
      const size = sizeMatches(r.size, target.file.sizeBytes, s.sizeTolerancePercent);
      if (!size.ok) {
        skip(r, 'size does not match');
        continue;
      }
      const mismatch = titleMismatch(r.title, target);
      if (mismatch) {
        skip(r, mismatch);
        continue;
      }
      if (r.infoHash && this.known(r.infoHash)) {
        skip(r, 'already in a download client');
        continue;
      }
      candidates.push({ release: r, exact: size.exact });
    }
    // Exact sizes first, then the best-seeded; one torrent per indexer.
    candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || (b.release.seeders ?? 0) - (a.release.seeders ?? 0));
    result.candidates = candidates.length;
    const done = new Set<number>();
    for (const c of candidates) {
      if (done.has(c.release.indexerId)) {
        skip(c.release, 'another release of this indexer was used');
        continue;
      }
      const outcome = await this.tryCandidate(target, c.release, s);
      if (typeof outcome === 'string') skip(c.release, outcome);
      else {
        result.added.push(outcome);
        if (outcome.state === 'seeding') done.add(c.release.indexerId);
      }
    }
    const searchedAt = this.now().toISOString();
    const values = { searchedAt, candidates: result.candidates, added: result.added.filter((a) => a.state === 'seeding').length };
    this.db
      .insert(crossSeedSearches)
      .values({ mediaFileId: fileId, ...values })
      .onConflictDoUpdate({ target: crossSeedSearches.mediaFileId, set: values })
      .run();
    return result;
  }

  /** Download, verify and add one release. Returns the recorded row or why it was skipped. */
  private async tryCandidate(target: Target, release: ReleaseResource, s: CrossSeedSettings): Promise<CrossSeedResource | string> {
    let download: ReleaseDownload;
    try {
      download = await this.indexers.downloadRelease(release.indexerId, release.magnetUrl ?? release.downloadUrl);
    } catch (err) {
      return `download failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (download.kind !== 'file' || download.protocol !== 'torrent') return 'magnet links cannot be verified before seeding';
    let meta: Metainfo;
    try {
      meta = parseTorrent(download.data);
    } catch (err) {
      return `invalid torrent: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (this.known(meta.infoHashHex)) return 'already in a download client';
    const files = meta.files.filter((f) => !f.padding);
    const entry = files[0];
    if (files.length !== 1 || !entry) return 'multi-file torrent';
    if (meta.version === 'v2') return 'v2-only torrent';
    const local = target.file.path;
    let localSize: number;
    try {
      localSize = (await stat(local)).size;
    } catch {
      return 'library file is missing';
    }
    if (entry.length !== localSize) return 'file size differs from the torrent';

    // Seed in place when the torrent names the file the same; otherwise link it.
    let savePath: string;
    let linked: string | null = null;
    if (!meta.isMultiFile && meta.name === basename(local)) savePath = dirname(local);
    else {
      savePath = join(s.linkDir || this.defaultLinkDir(), meta.infoHashHex);
      const dest = join(savePath, ...entry.pathSegments);
      try {
        await mkdir(dirname(dest), { recursive: true });
        await link(local, dest).catch(async () => symlink(local, dest));
        linked = savePath;
      } catch (err) {
        return `could not link the file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const cleanup = async () => {
      if (linked) await rm(linked, { recursive: true, force: true }).catch(() => undefined);
    };
    let verified = false;
    try {
      verified = await verifyEnds(meta, savePath);
    } catch {
      verified = false;
    }
    if (!verified) {
      await cleanup();
      return 'piece hashes do not match the file';
    }

    const client = this.pickClient(s);
    if (!client) {
      await cleanup();
      return 'no built-in or qBittorrent download client is enabled';
    }
    let state: 'seeding' | 'failed' = 'seeding';
    let message: string | null = null;
    try {
      const added = await client.client.addTorrent({
        torrentFile: download.data,
        title: release.title,
        category: s.category,
        savePath,
        paused: false,
        skipChecking: true,
      });
      if (added.warnings.length > 0) message = added.warnings.join(' ');
    } catch (err) {
      state = 'failed';
      message = err instanceof Error ? err.message : String(err);
      await cleanup();
    }
    const row = this.db
      .insert(crossSeeds)
      .values({
        mediaFileId: target.file.id,
        indexerId: release.indexerId,
        infoHash: meta.infoHashHex,
        title: release.title,
        size: entry.length,
        state,
        message,
        downloadClientId: client.id,
        savePath: state === 'seeding' ? savePath : null,
        addedAt: this.now().toISOString(),
      })
      .returning()
      .get();
    this.onAdded?.(row);
    this.log?.info({ title: release.title, client: client.name, state }, 'cross-seed added');
    return this.list().find((r) => r.id === row.id) as CrossSeedResource;
  }
}
