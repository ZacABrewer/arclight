import { stat } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { chooseRelease, type MbReleaseGroupType, type RequestPriority } from '@arclight/metadata';
import type { AddArtistRequest, AlbumDetails, Artist, Job, MusicCommand } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { albums, artists, tracks } from '../../db/schema.js';
import type { JobHandler, Scheduler } from '../../scheduler.js';
import { rescanArtist, type TagReader } from '../imports/audio/index.js';
import { LibraryError } from '../library/index.js';
import { isReleased, nextRefreshAt, releaseDateMs } from '../music/monitoring.js';
import * as music from '../music/service.js';
import { getSection } from '../settings/service.js';
import { albumCoverImages, type MusicMetadataService } from './music-service.js';

// Music metadata jobs (design 5.1, 5.3), next to RefreshSeries / RefreshMovie:
//
// * ArtistAdd (ad hoc): after POST /artist inserted the artist row, fetch its release groups,
//   keep those the album-type profile passes, apply the monitor option, then per album (monitored
//   first) browse the editions, pick one with chooseRelease and load its tracks. An existing
//   artist folder is rescanned at the end.
// * RefreshArtist (ad hoc, per artist ids): the same against an existing artist; new release
//   groups follow `monitor_new_albums`. Editions and tracks are re-read only where they can
//   have changed (new albums, albums without tracks, releases from the last 90 days or upcoming).
// * RefreshArtists (every 6 h): artists due by `next_refresh_at`, oldest first, until about
//   20 minutes of calls are spent.
// * RescanArtist (ad hoc): re-read the artist folders into `audio_files`.
// * MetadataCacheCleanup (daily): prune `metadata_cache`.
//
// Every music job is a no-op while `features.music` is off. All network calls of the jobs are
// `background` priority, so UI lookups go first on the shared 1 req/s MusicBrainz budget.

export const ARTIST_ADD_JOB = 'ArtistAdd';
export const REFRESH_ARTIST_JOB = 'RefreshArtist';
export const REFRESH_ARTISTS_JOB = 'RefreshArtists';
export const RESCAN_ARTIST_JOB = 'RescanArtist';
export const ARTIST_SEARCH_JOB = 'ArtistSearch';
export const ALBUM_SEARCH_JOB = 'AlbumSearch';
export const METADATA_CACHE_CLEANUP_JOB = 'MetadataCacheCleanup';

/** Wall-clock budget of one RefreshArtists run. */
export const REFRESH_ARTISTS_BUDGET_MS = 20 * 60 * 1000;
const RECENT_MS = 90 * 24 * 60 * 60 * 1000;
const DISABLED = 'skipped: music is not enabled';
export const SEARCH_NOT_AVAILABLE = 'not available yet: searching for albums arrives with music acquisition (Wave 2)';

export interface Started {
  job: Job;
  done: Promise<Job>;
}

export interface MusicRefresherDeps {
  db: Db;
  scheduler: Scheduler;
  service: MusicMetadataService;
  log: Logger;
  /** Built on first use (the combined music-metadata + ffprobe reader in production). */
  tagReader: () => TagReader;
  now?: () => Date;
  budgetMs?: number;
}

type RefreshMode = { kind: 'add'; option: AddArtistRequest['monitorOption'] } | { kind: 'refresh' };

interface RefreshOptions {
  priority: RequestPriority;
  /** Skip the stored artist and release-group answers (manual refresh). */
  fresh: boolean;
  signal: AbortSignal;
  log: Logger;
}

const PROFILE_TYPES: Record<string, MbReleaseGroupType> = { Album: 'album', EP: 'ep', Single: 'single', Broadcast: 'broadcast', Other: 'other' };

export class MusicRefresher {
  private readonly pending = new Set<Promise<Job>>();
  private reader: TagReader | null = null;

  constructor(private readonly deps: MusicRefresherDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  enabled(): boolean {
    return music.musicEnabled(this.db);
  }

  /** Resolves once every job this refresher started has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private start(name: string, key: string, handler: JobHandler, trigger: Job['trigger'] = 'manual'): Started {
    const started = this.deps.scheduler.runTask(name, trigger, handler, { key });
    const done = started.done.finally(() => this.pending.delete(done));
    this.pending.add(done);
    return { job: started.job, done };
  }

  // ---- add -----------------------------------------------------------------------------------

  /**
   * POST /artist: validates, fetches the artist record (interactive priority), inserts the row and
   * starts the ArtistAdd job. Returns without waiting for the job.
   */
  async addArtist(req: AddArtistRequest): Promise<{ artist: Artist } & Started> {
    music.validateAddArtist(this.db, req);
    const mb = await this.deps.service.musicBrainz().getArtist(req.mbArtistId, { priority: 'interactive' });
    const artist = music.addArtist(this.db, music.artistMetadataFrom(mb), req, this.now().toISOString());
    const started = this.start(ARTIST_ADD_JOB, `${ARTIST_ADD_JOB}:${artist.id}`, async ({ signal, log }) => {
      if (!this.enabled()) return DISABLED;
      const message = await this.refreshArtist(artist.id, { kind: 'add', option: req.monitorOption }, { priority: 'background', fresh: false, signal, log });
      const folder = await this.folderExists(artist.path);
      if (!folder || signal.aborted) return message;
      const scan = await this.rescanOne(artist.id);
      return `${message}; ${scan}`;
    });
    return { artist, ...started };
  }

  // ---- refresh -------------------------------------------------------------------------------

  private requireArtists(ids: readonly number[]): Array<{ id: number; name: string }> {
    const rows = this.db.select({ id: artists.id, name: artists.name }).from(artists).where(inArray(artists.id, [...ids])).all();
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw LibraryError.notFound('artist', missing.join(', '));
    return ids.map((id) => rows.find((r) => r.id === id)!);
  }

  /** RefreshArtist for the given ids (unknown ids throw before any job starts). */
  refresh(ids: readonly number[], opts: { trigger?: Job['trigger'] } = {}): Started {
    const rows = this.requireArtists(ids);
    const key = `${REFRESH_ARTIST_JOB}:${[...ids].sort((a, b) => a - b).join(',')}`;
    return this.start(
      REFRESH_ARTIST_JOB,
      key,
      async ({ signal, log }) => {
        if (!this.enabled()) return DISABLED;
        const parts: string[] = [];
        const failures: string[] = [];
        for (const row of rows) {
          if (signal.aborted) break;
          try {
            parts.push(await this.refreshArtist(row.id, { kind: 'refresh' }, { priority: 'background', fresh: true, signal, log }));
          } catch (err) {
            log.warn({ err, artistId: row.id }, 'artist refresh failed');
            failures.push(`${row.name}: ${errorText(err)}`);
          }
        }
        if (rows.length === 1 && failures.length === 1) throw new Error(failures[0]);
        return [...parts, ...(failures.length ? [`${failures.length} failed`] : [])].join('; ');
      },
      opts.trigger ?? 'manual',
    );
  }

  /** RefreshArtists: due artists by `next_refresh_at`, within the call budget. */
  async refreshDue({ signal, log }: { signal: AbortSignal; log: Logger }): Promise<string> {
    if (!this.enabled()) return DISABLED;
    const startedAt = Date.now();
    const budget = this.deps.budgetMs ?? REFRESH_ARTISTS_BUDGET_MS;
    const nowIso = this.now().toISOString();
    const due = this.db
      .select({ id: artists.id, next: artists.nextRefreshAt })
      .from(artists)
      .all()
      .filter((r) => r.next === null || r.next <= nowIso)
      .sort((a, b) => (a.next ?? '').localeCompare(b.next ?? '') || a.id - b.id);
    let refreshed = 0;
    let failed = 0;
    for (const row of due) {
      if (signal.aborted || Date.now() - startedAt >= budget) break;
      try {
        await this.refreshArtist(row.id, { kind: 'refresh' }, { priority: 'background', fresh: false, signal, log });
        refreshed++;
      } catch (err) {
        failed++;
        log.warn({ err, artistId: row.id }, 'scheduled artist refresh failed');
        // Try again on the next run rather than hammering a failing artist every 6 hours.
        this.db.update(artists).set({ nextRefreshAt: new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString() }).where(eq(artists.id, row.id)).run();
      }
    }
    const left = due.length - refreshed - failed;
    return `refreshed ${refreshed} of ${due.length} due artists${failed ? `, ${failed} failed` : ''}${left > 0 ? `, ${left} left for the next run` : ''}`;
  }

  /** Re-reads one artist and its albums from MusicBrainz. Returns a one-line summary. */
  private async refreshArtist(id: number, mode: RefreshMode, opts: RefreshOptions): Promise<string> {
    const { priority, fresh, signal, log } = opts;
    const client = this.deps.service.musicBrainz();
    const row = music.artistRow(this.db, id);
    const mb = await client.getArtist(row.mbArtistId, { priority, fresh, signal });
    const images = await this.deps.service.artistImages(row.mbArtistId, mb.links, priority);
    if (!this.exists(id)) return `${row.name}: deleted during refresh`;
    music.applyArtistMetadata(this.db, id, music.artistMetadataFrom(mb), images);

    const profile = music.getAlbumTypeProfile(this.db, row.albumTypeProfileId);
    const types = [...new Set(profile.primaryTypes.map((t) => PROFILE_TYPES[t] ?? 'other'))];
    const groups = await client.browseReleaseGroups(row.mbArtistId, { priority, fresh, signal, types });
    if (!this.exists(id)) return `${row.name}: deleted during refresh`;
    const now = this.now();
    const sync = music.syncReleaseGroups(
      this.db,
      id,
      groups,
      mode.kind === 'add' ? { kind: 'add', option: mode.option } : { kind: 'refresh', monitorNewAlbums: music.artistRow(this.db, id).monitorNewAlbums },
      albumCoverImages,
      now.toISOString(),
    );

    const prefs = this.deps.service.releasePreferences();
    const added = new Set(sync.added);
    let loaded = 0;
    let dropped = 0;
    let failed = 0;
    for (const album of music.albumsForTrackLoading(this.db, id)) {
      if (signal.aborted) break;
      const hasTracks = this.db.select({ id: tracks.id }).from(tracks).where(eq(tracks.albumId, album.id)).limit(1).get() !== undefined;
      const recent = this.isRecent(album.releaseDate, now);
      if (mode.kind === 'refresh' && !added.has(album.id) && hasTracks && album.selectedReleaseId !== null && !recent) continue;
      try {
        const summaries = await client.browseReleases(album.mbReleaseGroupId, { priority, signal });
        if (!this.albumExists(album.id)) continue;
        const rows = music.saveReleases(this.db, album.id, summaries);
        const statuses = rows.flatMap((r) => (r.status ? [r.status] : []));
        if (statuses.length > 0 && !statuses.some((s) => profile.releaseStatuses.includes(s)) && !this.albumHasFiles(album.id)) {
          // Only bootlegs (or other excluded statuses): the profile does not want this album.
          this.db.delete(albums).where(eq(albums.id, album.id)).run();
          dropped++;
          continue;
        }
        const current = rows.find((r) => r.id === album.selectedReleaseId);
        const candidates = rows.filter((r) => !r.status || profile.releaseStatuses.includes(r.status));
        const target =
          current ??
          chooseRelease(
            (candidates.length > 0 ? candidates : rows).map((r) => ({
              mbid: r.mbReleaseId,
              ...(r.status ? { status: r.status } : {}),
              ...(r.country ? { country: r.country } : {}),
              ...(r.date ? { date: r.date } : {}),
              formats: r.formats,
              trackCount: r.trackCount,
              row: r,
            })),
            prefs,
          )?.row;
        if (!target) continue;
        if (current && hasTracks && !recent && !added.has(album.id)) continue;
        const release = await client.getRelease(target.mbReleaseId, { priority, signal });
        if (!this.albumExists(album.id)) continue;
        music.selectRelease(this.db, album.id, release, row.name);
        loaded++;
      } catch (err) {
        if (signal.aborted) break;
        failed++;
        log.warn({ err, albumId: album.id, mbReleaseGroupId: album.mbReleaseGroupId }, 'album editions/tracks not loaded');
      }
    }

    const dates = this.db.select({ releaseDate: albums.releaseDate }).from(albums).where(eq(albums.artistId, id)).all().map((r) => r.releaseDate);
    const status = music.artistRow(this.db, id).status;
    const at = this.now();
    music.markArtistRefreshed(this.db, id, at.toISOString(), nextRefreshAt(status, dates, at));
    const albumCount = dates.length;
    return [
      `${row.name}: ${albumCount} albums`,
      sync.added.length ? `${sync.added.length} new` : null,
      sync.removed + dropped ? `${sync.removed + dropped} removed` : null,
      `tracks loaded for ${loaded}`,
      failed ? `${failed} failed` : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  private isRecent(date: string | null, now: Date): boolean {
    const ms = releaseDateMs(date);
    return ms !== null && (ms >= now.getTime() - RECENT_MS || !isReleased(date, now));
  }

  private exists(id: number): boolean {
    return this.db.select({ id: artists.id }).from(artists).where(eq(artists.id, id)).get() !== undefined;
  }

  private albumExists(id: number): boolean {
    return this.db.select({ id: albums.id }).from(albums).where(eq(albums.id, id)).get() !== undefined;
  }

  private albumHasFiles(id: number): boolean {
    return this.db.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.albumId, id), eq(tracks.hasFile, true))).limit(1).get() !== undefined;
  }

  // ---- edition switch ------------------------------------------------------------------------

  /** PUT /album/:id with `selectedReleaseId`: fetch that edition's tracks and re-link the files. */
  async switchRelease(albumId: number, releaseId: number): Promise<AlbumDetails> {
    const album = music.albumRow(this.db, albumId);
    const target = music.releaseRow(this.db, albumId, releaseId);
    const hasTracks = this.db.select({ id: tracks.id }).from(tracks).where(eq(tracks.albumReleaseId, releaseId)).limit(1).get();
    if (album.selectedReleaseId !== releaseId || !hasTracks) {
      const release = await this.deps.service.musicBrainz().getRelease(target.mbReleaseId, { priority: 'interactive' });
      music.selectRelease(this.db, albumId, release, music.artistRow(this.db, album.artistId).name);
    }
    return music.getAlbumDetails(this.db, albumId);
  }

  // ---- rescan --------------------------------------------------------------------------------

  private tagReader(): TagReader {
    this.reader ??= this.deps.tagReader();
    return this.reader;
  }

  private async folderExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Scans one artist folder and writes the result. Returns a one-line summary. */
  async rescanOne(id: number): Promise<string> {
    const row = music.artistRow(this.db, id);
    if (!(await this.folderExists(row.path))) return `${row.name}: folder ${row.path} does not exist`;
    const result = await rescanArtist({
      artistFolder: row.path,
      albums: music.knownAlbumsFor(this.db, id),
      tagReader: this.tagReader(),
      threshold: getSection(this.db, 'audio').trackMatchThreshold,
    });
    if (!this.exists(id)) return `${row.name}: deleted during rescan`;
    const w = music.applyRescan(this.db, id, result, this.now().toISOString());
    return [
      `${row.name}: ${w.linked} track files`,
      w.added ? `${w.added} new` : null,
      w.removed ? `${w.removed} removed` : null,
      w.unmatchedGroups ? `${w.unmatchedGroups} unmatched folders` : null,
      w.unmatchedFiles ? `${w.unmatchedFiles} unmatched files` : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  rescan(ids: readonly number[]): Started {
    const rows = this.requireArtists(ids);
    return this.start(RESCAN_ARTIST_JOB, `${RESCAN_ARTIST_JOB}:${[...ids].sort((a, b) => a - b).join(',')}`, async ({ signal, log }) => {
      if (!this.enabled()) return DISABLED;
      const parts: string[] = [];
      for (const row of rows) {
        if (signal.aborted) break;
        try {
          parts.push(await this.rescanOne(row.id));
        } catch (err) {
          log.warn({ err, artistId: row.id }, 'artist rescan failed');
          if (rows.length === 1) throw err;
          parts.push(`${row.name}: ${errorText(err)}`);
        }
      }
      return parts.join('; ');
    });
  }

  // ---- commands ------------------------------------------------------------------------------

  /** POST /command. Unknown ids throw before a job starts. */
  command(cmd: MusicCommand): Started {
    switch (cmd.name) {
      case 'RefreshArtist':
        return this.refresh(cmd.artistIds);
      case 'RescanArtist':
        return this.rescan(cmd.artistIds);
      case 'ArtistSearch':
        this.requireArtists(cmd.artistIds);
        return this.searchStub(ARTIST_SEARCH_JOB, cmd.artistIds);
      case 'AlbumSearch': {
        const found = this.db.select({ id: albums.id }).from(albums).where(inArray(albums.id, cmd.albumIds)).all();
        const missing = cmd.albumIds.filter((id) => !found.some((r) => r.id === id));
        if (missing.length > 0) throw LibraryError.notFound('album', missing.join(', '));
        return this.searchStub(ALBUM_SEARCH_JOB, cmd.albumIds);
      }
    }
  }

  /** Artist/album search until Wave 2: a job that only reports it is not available. */
  searchStub(name: typeof ARTIST_SEARCH_JOB | typeof ALBUM_SEARCH_JOB, ids: readonly number[]): Started {
    return this.start(name, `${name}:${ids.join(',')}`, async () => SEARCH_NOT_AVAILABLE);
  }

  // ---- cache ---------------------------------------------------------------------------------

  cleanupCache(): string {
    const pruned = this.deps.service.store.prune();
    return `pruned ${pruned} cached metadata responses`;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerMusicJobs(scheduler: Scheduler, refresher: MusicRefresher): void {
  // Every 6 hours, off the hour so it does not start with the TMDB refreshes.
  scheduler.register({ name: REFRESH_ARTISTS_JOB, cron: '20 */6 * * *', handler: (ctx) => refreshDueHandler(refresher, ctx) });
  scheduler.register({ name: METADATA_CACHE_CLEANUP_JOB, cron: '50 5 * * *', handler: async () => refresher.cleanupCache() });
}

function refreshDueHandler(refresher: MusicRefresher, ctx: { signal: AbortSignal; log: Logger }): Promise<string> {
  return refresher.refreshDue(ctx);
}
