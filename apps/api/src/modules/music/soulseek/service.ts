import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  DownloadClientError,
  remoteBaseName,
  remoteDirName,
  SlskdClient,
  SlskdSettings,
  type ClientRuntime,
  type SlskdDownload,
} from '@arclight/download-clients';
import { compareQ } from '../../imports/decisions.js';
import {
  applySoulseekUpdate,
  maskSoulseekSettings,
  SoulseekSettings,
  WantedAlbumsQuery,
  type QualityModel,
  type QualityProfile,
  type SoulseekAutoResult,
  type SoulseekCandidate,
  type SoulseekDownload,
  type SoulseekGrabRequest,
  type SoulseekSearchResult,
  type SoulseekSettingsResponse,
  type SoulseekSettingsUpdate,
  type SoulseekTestResult,
} from '@arclight/shared';
import type { Db } from '../../../db/index.js';
import { albums, artists, audioFiles, tracks } from '../../../db/schema.js';
import { ProfilesService } from '../../profiles/index.js';
import { getSection, setSection } from '../../settings/service.js';
import { LibraryError } from '../../library/index.js';
import type { MusicImportRun } from '../../imports/audio/music-import.js';
import { knownAlbumsFor, listMissingAlbums } from '../service.js';
import { chooseCandidates } from './choose.js';
import { soulseekDownloads, type SoulseekDownloadRow, type SoulseekFileState } from './schema.js';

// The Soulseek source: searches through the user's slskd, ranks peer folders against the
// album (choose.ts), queues the chosen folder, follows its transfers and hands the finished
// folder to the music importer. Everything goes through slskd's HTTP API; Arclight never
// speaks the Soulseek protocol itself.

/** Errors with an HTTP status and a stable code for the routes. */
export class SoulseekError extends Error {
  constructor(
    readonly code: 'SOULSEEK_DISABLED' | 'SOULSEEK_NOT_CONFIGURED' | 'SOULSEEK_UNREACHABLE' | 'SOULSEEK_AUTH' | 'SOULSEEK_ERROR' | 'SOULSEEK_NO_TRACKS',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SoulseekError';
  }
}

/** The import seam: ImportsService.importMusicFolder in the app, a fake in tests. */
export type FolderImporter = (input: {
  path: string;
  downloadId: string;
  title: string;
  artistId: number;
  albumIds: readonly number[];
  mode: 'copy' | 'move';
  /** The slskd downloads folder: the importer only removes an emptied folder strictly inside it. */
  downloadsRoot: string;
}) => Promise<MusicImportRun>;

export interface SoulseekServiceOptions {
  db: Db;
  log?: Logger | undefined;
  importFolder: FolderImporter;
  /** HTTP runtime overrides (tests inject a fake slskd's fetch). */
  runtime?: Partial<ClientRuntime>;
  now?: () => Date;
}

const ACTIVE: ReadonlyArray<SoulseekDownloadRow['status']> = ['queued', 'downloading', 'importing'];
/** Albums with a Soulseek grab this recent are skipped by the automatic search. */
const AUTO_RETRY_MS = 24 * 3600_000;
const AUTO_ALBUMS_PER_RUN = 5;

function wrap(error: unknown): never {
  if (error instanceof DownloadClientError) {
    if (error.code === 'auth') throw new SoulseekError('SOULSEEK_AUTH', error.message, 502);
    if (error.code === 'unreachable') throw new SoulseekError('SOULSEEK_UNREACHABLE', error.message, 502);
    throw new SoulseekError('SOULSEEK_ERROR', error.message, 502);
  }
  throw error;
}

/** "Artist - Album" without the punctuation Soulseek's word search trips over. */
export function searchQueryFor(artistName: string, albumTitle: string): string {
  return `${artistName} ${albumTitle}`
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Where slskd puts a finished file: `<downloads>/<remote parent folder>/<file name>`. Both
 * names come from the peer, so they are reduced to single safe segments (`..`, `.`, empty and
 * drive segments become `_`) and the result always stays strictly inside the downloads folder.
 */
export function localPathOf(downloadsPath: string, remoteFile: string): string {
  return join(downloadsPath, remoteBaseName(remoteDirName(remoteFile)), remoteBaseName(remoteFile));
}

/** True when `folder` is strictly inside `root` (not the root itself, not outside it). */
export function isStrictlyInside(root: string, folder: string): boolean {
  const rel = relative(resolve(root), resolve(folder));
  return rel !== '' && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

export class SoulseekService {
  private readonly db: Db;
  private readonly now: () => Date;
  private monitoring = false;

  constructor(private readonly o: SoulseekServiceOptions) {
    this.db = o.db;
    this.now = o.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------------------ settings

  getSettings(): SoulseekSettingsResponse {
    return maskSoulseekSettings(getSection(this.db, 'soulseek'));
  }

  updateSettings(update: SoulseekSettingsUpdate): SoulseekSettingsResponse {
    return maskSoulseekSettings(setSection(this.db, 'soulseek', applySoulseekUpdate(getSection(this.db, 'soulseek'), update)));
  }

  private clientFor(settings: SoulseekSettings): SlskdClient {
    if (settings.host === '') throw new SoulseekError('SOULSEEK_NOT_CONFIGURED', 'Set the slskd host first.', 409);
    const runtime: ClientRuntime = {
      fetch: (input, init) => globalThis.fetch(input, init),
      now: () => this.now().getTime(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      requestTimeoutMs: 30_000,
      ...this.o.runtime,
    };
    return new SlskdClient(
      SlskdSettings.parse({ host: settings.host, port: settings.port, useSsl: settings.useSsl, urlBase: settings.urlBase || undefined, apiKey: settings.apiKey }),
      runtime,
    );
  }

  /** The configured client; throws while the source is off or has no host. */
  private client(): { client: SlskdClient; settings: SoulseekSettings } {
    const settings = getSection(this.db, 'soulseek');
    if (!settings.enabled) throw new SoulseekError('SOULSEEK_DISABLED', 'The Soulseek source is turned off (Settings → Soulseek).', 409);
    return { client: this.clientFor(settings), settings };
  }

  /** Tests unsaved settings (a masked or missing key uses the stored one); never throws for slskd errors. */
  async test(update: SoulseekSettingsUpdate = {}): Promise<SoulseekTestResult> {
    const settings = applySoulseekUpdate(getSection(this.db, 'soulseek'), update);
    try {
      const result = await this.clientFor(settings).test();
      return { ok: result.loggedIn, version: result.version ?? null, loggedIn: result.loggedIn, message: result.message };
    } catch (error) {
      if (error instanceof DownloadClientError || error instanceof SoulseekError) {
        return { ok: false, version: null, loggedIn: false, message: error.message };
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------------------ search

  private albumContext(albumId: number) {
    const album = this.db.select().from(albums).where(eq(albums.id, albumId)).get();
    if (!album) throw LibraryError.notFound('album', albumId);
    const artist = this.db.select().from(artists).where(eq(artists.id, album.artistId)).get();
    if (!artist) throw LibraryError.notFound('artist', album.artistId);
    const known = knownAlbumsFor(this.db, artist.id).find((k) => k.albumId === albumId);
    const release = known?.releases[0];
    if (!release) {
      throw new SoulseekError('SOULSEEK_NO_TRACKS', `The tracks of "${album.title}" are not loaded yet; refresh the artist first.`, 409);
    }
    const trackRows = this.db.select().from(tracks).where(and(eq(tracks.albumId, albumId), eq(tracks.albumReleaseId, album.selectedReleaseId!))).all();
    // Per-track wanted: tracks the user switched off.
    const unwantedTrackIds = new Set(trackRows.filter((t) => !t.monitored).map((t) => t.id));
    let profile: QualityProfile | null = null;
    try {
      profile = new ProfilesService({ db: this.db }).getQualityProfile(artist.qualityProfileId);
    } catch {
      profile = null; // a missing profile ranks by quality weight alone
    }
    return { album, artist, release, trackRows, unwantedTrackIds, profile };
  }

  /** The quality to beat: the lowest among the album's files, once every wanted track has one. */
  private currentQuality(profile: QualityProfile | null, trackRows: ReadonlyArray<typeof tracks.$inferSelect>, unwanted: ReadonlySet<number>, albumId: number): QualityModel | null {
    const wanted = trackRows.filter((t) => !unwanted.has(t.id));
    if (wanted.length === 0 || wanted.some((t) => !t.hasFile)) return null;
    const files = this.db.select({ quality: audioFiles.quality }).from(audioFiles).where(eq(audioFiles.albumId, albumId)).all();
    if (files.length === 0) return null;
    return files.map((f) => f.quality).reduce((low, q) => (compareQ(profile, q, low) < 0 ? q : low));
  }

  async searchAlbum(albumId: number, query?: string, signal?: AbortSignal): Promise<SoulseekSearchResult> {
    const { client, settings } = this.client();
    const c = this.albumContext(albumId);
    const text = query ?? searchQueryFor(c.artist.name, c.album.title);
    if (signal?.aborted) return { query: text, candidates: [] };
    const responses = await client
      .search(randomUUID(), text, { searchTimeoutMs: settings.searchTimeoutSeconds * 1000 })
      .catch(wrap);
    const candidates = chooseCandidates(
      responses,
      { release: c.release, unwantedTrackIds: c.unwantedTrackIds },
      {
        profile: c.profile,
        currentQuality: this.currentQuality(c.profile, c.trackRows, c.unwantedTrackIds, albumId),
        threshold: getSection(this.db, 'audio').trackMatchThreshold,
        maxPeerQueue: settings.maxPeerQueue,
      },
    );
    return { query: text, candidates };
  }

  // ------------------------------------------------------------------------------ grabs

  async grab(request: SoulseekGrabRequest): Promise<SoulseekDownload> {
    const { client } = this.client();
    const album = this.db.select().from(albums).where(eq(albums.id, request.albumId)).get();
    if (!album) throw LibraryError.notFound('album', request.albumId);
    const active = this.db
      .select({ id: soulseekDownloads.id })
      .from(soulseekDownloads)
      .where(and(eq(soulseekDownloads.albumId, album.id), inArray(soulseekDownloads.status, [...ACTIVE])))
      .get();
    if (active) throw new LibraryError('CONFLICT', `album ${album.id} already has a Soulseek download in progress`);
    await client.enqueue(request.username, request.files).catch(wrap);
    const now = this.now().toISOString();
    const row = this.db
      .insert(soulseekDownloads)
      .values({
        albumId: album.id,
        artistId: album.artistId,
        username: request.username,
        directory: request.directory,
        files: request.files.map((f) => ({ filename: f.filename, size: f.size })),
        qualityName: request.qualityName ?? null,
        status: 'queued',
        progress: 0,
        message: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.o.log?.info({ albumId: album.id, username: request.username, files: request.files.length }, 'soulseek download queued');
    return this.toDownload(row);
  }

  /** Searches and grabs the best accepted folder, if any. */
  async autoAlbum(albumId: number, signal?: AbortSignal): Promise<SoulseekAutoResult> {
    const result = await this.searchAlbum(albumId, undefined, signal);
    const best = result.candidates.find((c) => c.accepted);
    if (!best) {
      return { grabbed: null, candidates: result.candidates.length, message: `No acceptable folder among ${result.candidates.length} candidates.` };
    }
    const grabbed = await this.grab(grabRequestFor(albumId, best));
    return { grabbed, candidates: result.candidates.length, message: `Queued ${best.files.length} files from ${best.username}.` };
  }

  /** The scheduled automatic search over wanted albums. */
  async autoSearchWanted(signal?: AbortSignal): Promise<string> {
    const settings = getSection(this.db, 'soulseek');
    if (!settings.enabled || !settings.autoSearch || settings.host === '') return 'automatic Soulseek search is off';
    const recent = new Set(
      this.db
        .select({ albumId: soulseekDownloads.albumId, createdAt: soulseekDownloads.createdAt, status: soulseekDownloads.status })
        .from(soulseekDownloads)
        .all()
        .filter((r) => ACTIVE.includes(r.status) || this.now().getTime() - Date.parse(r.createdAt) < AUTO_RETRY_MS)
        .map((r) => r.albumId),
    );
    const wanted = listMissingAlbums(this.db, WantedAlbumsQuery.parse({ pageSize: 100 }), this.now()).records.filter((a) => !recent.has(a.id));
    let searched = 0;
    let grabbed = 0;
    for (const album of wanted.slice(0, AUTO_ALBUMS_PER_RUN)) {
      if (signal?.aborted) break;
      searched++;
      try {
        if ((await this.autoAlbum(album.id, signal)).grabbed) grabbed++;
      } catch (err) {
        this.o.log?.warn({ err, albumId: album.id }, 'soulseek automatic search failed');
      }
    }
    return `searched ${searched} albums on Soulseek, ${grabbed} queued`;
  }

  // ------------------------------------------------------------------------------ downloads

  listDownloads(): SoulseekDownload[] {
    return this.db.select().from(soulseekDownloads).orderBy(desc(soulseekDownloads.id)).all().map((r) => this.toDownload(r));
  }

  /** Cancels the transfers that are still running (best effort) and removes the row. */
  async removeDownload(id: number): Promise<void> {
    const row = this.db.select().from(soulseekDownloads).where(eq(soulseekDownloads.id, id)).get();
    if (!row) throw LibraryError.notFound('soulseek download', id);
    if (row.status === 'queued' || row.status === 'downloading') {
      try {
        const { client } = this.client();
        for (const f of row.files) if (f.transferId) await client.cancelDownload(row.username, f.transferId);
      } catch (err) {
        this.o.log?.warn({ err, id }, 'could not cancel soulseek transfers');
      }
    }
    this.db.delete(soulseekDownloads).where(eq(soulseekDownloads.id, id)).run();
  }

  /**
   * One monitor pass: reads slskd's transfer list, updates every active download, imports the
   * ones whose files all finished and fails the ones that stalled or errored.
   */
  async monitor(): Promise<string> {
    if (this.monitoring) return 'already running';
    const rows = this.db.select().from(soulseekDownloads).where(inArray(soulseekDownloads.status, ['queued', 'downloading'])).all();
    if (rows.length === 0) return 'no active Soulseek downloads';
    this.monitoring = true;
    try {
      const { client, settings } = this.client();
      const transfers = await client.listDownloads().catch(wrap);
      let imported = 0;
      let failed = 0;
      for (const row of rows) {
        const outcome = await this.advance(row, transfers, settings);
        if (outcome === 'imported') imported++;
        if (outcome === 'failed') failed++;
      }
      return `${rows.length} active, ${imported} imported${failed ? `, ${failed} failed` : ''}`;
    } finally {
      this.monitoring = false;
    }
  }

  private async advance(row: SoulseekDownloadRow, transfers: readonly SlskdDownload[], settings: SoulseekSettings): Promise<SoulseekDownloadRow['status']> {
    const byFile = new Map(transfers.filter((t) => t.username === row.username).map((t) => [t.filename, t]));
    const files: SoulseekFileState[] = row.files.map((f) => {
      const t = byFile.get(f.filename);
      return t ? { ...f, transferId: t.id, state: t.state, bytesTransferred: t.bytesTransferred ?? 0 } : f;
    });
    const phases = files.map((f) => {
      const t = byFile.get(f.filename);
      return t ? t.phase : 'missing';
    });
    const total = files.reduce((n, f) => n + f.size, 0);
    const done = files.reduce((n, f, i) => n + (phases[i] === 'completed' ? f.size : Math.min(f.size, f.bytesTransferred ?? 0)), 0);
    const progress = total > 0 ? done / total : 0;
    const now = this.now();
    const changed = progress > row.progress + 1e-9;
    const update = (values: Partial<SoulseekDownloadRow>) =>
      this.db
        .update(soulseekDownloads)
        .set({ files, progress, ...values })
        .where(eq(soulseekDownloads.id, row.id))
        .run();

    const errored = phases.filter((p) => p === 'failed' || p === 'cancelled').length;
    const pending = phases.filter((p) => p === 'queued' || p === 'downloading' || p === 'missing').length;
    if (errored > 0 && pending === 0) {
      update({ status: 'failed', message: `${errored} of ${files.length} files failed on the peer's side.`, updatedAt: now.toISOString() });
      return 'failed';
    }
    if (pending > 0) {
      const stalledFor = now.getTime() - Date.parse(row.updatedAt);
      if (!changed && stalledFor > settings.stalledHours * 3600_000) {
        for (const f of files) if (f.transferId) await this.cancelQuietly(row.username, f.transferId);
        update({ status: 'failed', message: `No progress for ${settings.stalledHours} hours.`, updatedAt: now.toISOString() });
        return 'failed';
      }
      const status = phases.some((p) => p === 'downloading') || done > 0 ? 'downloading' : 'queued';
      // updatedAt only moves with progress, so it doubles as "last progress" for the stall check.
      update({ status, ...(changed || status !== row.status ? { updatedAt: now.toISOString() } : {}) });
      return status;
    }
    if (settings.downloadsPath === '') {
      update({ status: 'failed', message: 'Set the slskd downloads folder (Settings → Soulseek) so Arclight can import the files.', updatedAt: now.toISOString() });
      return 'failed';
    }
    update({ status: 'importing', progress: 1, updatedAt: now.toISOString() });
    return this.importRow({ ...row, files }, settings);
  }

  private async cancelQuietly(username: string, transferId: string): Promise<void> {
    try {
      await this.client().client.cancelDownload(username, transferId);
    } catch (err) {
      this.o.log?.debug({ err }, 'soulseek cancel skipped');
    }
  }

  /** Imports every local folder the files landed in (one per remote folder, so disc folders too). */
  private async importRow(row: SoulseekDownloadRow, settings: SoulseekSettings): Promise<SoulseekDownloadRow['status']> {
    const folders = [...new Set(row.files.map((f) => localPathOf(settings.downloadsPath, f.filename)).map((p) => join(p, '..')))];
    const album = this.db.select({ title: albums.title }).from(albums).where(eq(albums.id, row.albumId)).get();
    const artist = this.db.select({ name: artists.name }).from(artists).where(eq(artists.id, row.artistId)).get();
    const title = `${artist?.name ?? 'Unknown'} - ${album?.title ?? 'Unknown'}${row.qualityName ? ` [${row.qualityName}]` : ''}`;
    let last: MusicImportRun | null = null;
    let error: string | null = null;
    for (const path of folders) {
      if (!isStrictlyInside(settings.downloadsPath, path)) {
        // Defence in depth: localPathOf already keeps peer names inside the downloads folder.
        error = 'A downloaded file is not inside the slskd downloads folder; nothing was imported.';
        this.o.log?.warn({ id: row.id, path }, 'soulseek import folder outside the downloads folder');
        continue;
      }
      try {
        last = await this.o.importFolder({
          path,
          downloadId: `slskd:${row.id}`,
          title,
          artistId: row.artistId,
          albumIds: [row.albumId],
          mode: settings.importMode,
          downloadsRoot: settings.downloadsPath,
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        this.o.log?.error({ err, id: row.id, path }, 'soulseek import failed');
      }
    }
    const verified = last?.verified === true && error === null;
    const message = verified ? null : (error ?? (last?.messages.join(' · ') || 'Import did not complete.'));
    this.db
      .update(soulseekDownloads)
      .set({ status: verified ? 'imported' : 'failed', message, updatedAt: this.now().toISOString() })
      .where(eq(soulseekDownloads.id, row.id))
      .run();
    return verified ? 'imported' : 'failed';
  }

  private toDownload(row: SoulseekDownloadRow): SoulseekDownload {
    const album = this.db.select({ title: albums.title }).from(albums).where(eq(albums.id, row.albumId)).get();
    const artist = this.db.select({ name: artists.name }).from(artists).where(eq(artists.id, row.artistId)).get();
    return {
      id: row.id,
      albumId: row.albumId,
      artistId: row.artistId,
      albumTitle: album?.title ?? '',
      artistName: artist?.name ?? '',
      username: row.username,
      directory: row.directory,
      fileCount: row.files.length,
      totalSize: row.files.reduce((n, f) => n + f.size, 0),
      qualityName: row.qualityName,
      status: row.status,
      progress: row.progress,
      message: row.message,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export function grabRequestFor(albumId: number, candidate: SoulseekCandidate): SoulseekGrabRequest {
  return {
    albumId,
    username: candidate.username,
    directory: candidate.directory,
    files: candidate.files.map((f) => ({ filename: f.filename, size: f.size })),
    qualityName: candidate.qualityName,
  };
}
