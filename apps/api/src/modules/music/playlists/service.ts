import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Logger } from 'pino';
import { isMetadataError, type FetchLike, type MbRecording, type SourcePlaylist, type SourcePlaylistTrack } from '@arclight/metadata';
import {
  applyMusicPlaylistsUpdate,
  maskMusicPlaylistsSettings,
  type CreateMusicPlaylist,
  type MediaServerConfig,
  type MusicPlaylist,
  type MusicPlaylistEntry,
  type MusicPlaylistPreview,
  type MusicPlaylistsSettings,
  type MusicPlaylistsSettingsResponse,
  type MusicPlaylistsSettingsUpdate,
  type MusicPlaylistSyncStarted,
  type PlaylistEntryStatus,
  type PlaylistMatchMethod,
  type PlaylistSource,
  type PlaylistSyncStatus,
  type SimilarArtist,
  type UpdateMusicPlaylist,
} from '@arclight/shared';
import type { Db } from '../../../db/index.js';
import { albums, artists, audioFiles, qualityProfiles, rootFolders, tracks } from '../../../db/schema.js';
import type { Scheduler } from '../../../scheduler.js';
import { getSection, setSection } from '../../settings/service.js';
import { albumCoverImages, type MusicMetadataService } from '../../metadata/music-service.js';
import { ALBUM_SEARCH_JOB, type MusicRefresher } from '../../metadata/music-jobs.js';
import { addReleaseGroupAlbum, artistIdsByMbid } from '../service.js';
import {
  baseTitle,
  chooseReleaseGroup,
  creditedArtists,
  entryStatus,
  isSyncDue,
  mergeSimilarArtists,
  normalize,
  pickRecording,
  playlistFileName,
  primaryArtistMbid,
  renderM3u8,
  trackMonitoringChanges,
  type LibraryHit,
  type LocalTrack,
  type MergedSimilarArtist,
} from './map.js';
import { PlaylistError, PlaylistProviders, type PlaylistProviderOverrides } from './providers.js';
import { musicPlaylistEntries, musicPlaylists, type MusicPlaylistEntryRow, type MusicPlaylistRow, type PlaylistTargetState } from './schema.js';
import { jellyfinPusher, plexPusher, subsonicPusher, type PlaylistPusher } from './targets.js';

export const MUSIC_PLAYLIST_SYNC_JOB = 'MusicPlaylistSync';

const DAY = 86_400_000;
const MATCH_CACHE = 'playlist-match';
const SIMILAR_CACHE = 'similar-artists';

/** `tracks.monitored`: per-track wanting. */
const trackMonitored: SQLiteColumn | null = tracks.monitored;

export interface PlaylistServiceDeps {
  db: Db;
  log: Logger;
  scheduler: Scheduler;
  musicMetadata: () => MusicMetadataService | null;
  refresher: () => MusicRefresher | null;
  mediaServers: () => MediaServerConfig[];
  overrides?: PlaylistProviderOverrides;
}

interface ResolvedEntry {
  track: SourcePlaylistTrack;
  recording?: MbRecording | undefined;
  method?: PlaylistMatchMethod | undefined;
  releaseGroupMbid?: string | undefined;
  artistMbid?: string | undefined;
  hit: LibraryHit;
  artistAdded: boolean;
}

interface SyncReport {
  status: PlaylistSyncStatus;
  message: string;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

export class MusicPlaylistService {
  readonly providers: PlaylistProviders;

  constructor(private readonly deps: PlaylistServiceDeps) {
    this.providers = new PlaylistProviders({
      settings: () => this.settings(),
      listenBrainz: () => deps.musicMetadata()?.listenBrainz() ?? null,
      fallbackLastfmKey: () => {
        const v = (getSection(deps.db, 'musicMetadata') as unknown as Record<string, unknown>)['lastfmApiKey'];
        return typeof v === 'string' && v ? v : undefined;
      },
      ...(deps.overrides ? { overrides: deps.overrides } : {}),
    });
  }

  private get db(): Db {
    return this.deps.db;
  }

  private now(): Date {
    return this.deps.overrides?.now?.() ?? new Date();
  }

  private fetchImpl(): FetchLike {
    return this.deps.overrides?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  // ---- settings ------------------------------------------------------------------------------

  settings(): MusicPlaylistsSettings {
    return getSection(this.db, 'musicPlaylists');
  }

  getSettings(): MusicPlaylistsSettingsResponse {
    return maskMusicPlaylistsSettings(this.settings());
  }

  updateSettings(update: MusicPlaylistsSettingsUpdate): MusicPlaylistsSettingsResponse {
    return maskMusicPlaylistsSettings(setSection(this.db, 'musicPlaylists', applyMusicPlaylistsUpdate(this.settings(), update)));
  }

  // ---- CRUD ----------------------------------------------------------------------------------

  private row(id: number): MusicPlaylistRow {
    const row = this.db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id)).get();
    if (!row) throw new PlaylistError('NOT_FOUND', `playlist ${id} not found`, 404);
    return row;
  }

  private counts(ids: readonly number[]): Map<number, MusicPlaylist['counts']> {
    const out = new Map<number, MusicPlaylist['counts']>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({ playlistId: musicPlaylistEntries.playlistId, status: musicPlaylistEntries.status, n: sql<number>`count(*)` })
      .from(musicPlaylistEntries)
      .where(inArray(musicPlaylistEntries.playlistId, [...ids]))
      .groupBy(musicPlaylistEntries.playlistId, musicPlaylistEntries.status)
      .all();
    for (const id of ids) out.set(id, { total: 0, matched: 0, available: 0, wanted: 0 });
    for (const r of rows) {
      const c = out.get(r.playlistId)!;
      c.total += r.n;
      if (r.status !== 'unmatched') c.matched += r.n;
      if (r.status === 'available') c.available += r.n;
      if (r.status === 'wanted') c.wanted += r.n;
    }
    return out;
  }

  private toApi(row: MusicPlaylistRow, counts?: MusicPlaylist['counts']): MusicPlaylist {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      want: row.want,
      addArtists: row.addArtists,
      rootFolderPath: row.rootFolderPath,
      qualityProfileId: row.qualityProfileId,
      searchOnWant: row.searchOnWant,
      writeM3u: row.writeM3u,
      targets: row.targets,
      syncIntervalHours: row.syncIntervalHours,
      enabled: row.enabled,
      sourceTitle: row.sourceTitle,
      lastSyncAt: row.lastSyncAt,
      lastSyncStatus: row.lastSyncStatus,
      lastSyncMessage: row.lastSyncMessage,
      counts: counts ?? this.counts([row.id]).get(row.id)!,
      createdAt: row.createdAt,
    };
  }

  list(): MusicPlaylist[] {
    const rows = this.db.select().from(musicPlaylists).orderBy(asc(musicPlaylists.name), asc(musicPlaylists.id)).all();
    const counts = this.counts(rows.map((r) => r.id));
    return rows.map((r) => this.toApi(r, counts.get(r.id)));
  }

  get(id: number): MusicPlaylist {
    return this.toApi(this.row(id));
  }

  private validateTargets(targets: readonly string[]): void {
    const servers = new Map(this.deps.mediaServers().map((s) => [s.id, s]));
    for (const t of targets) {
      if (t === 'navidrome') continue;
      const server = servers.get(t.slice('server:'.length));
      if (!server) throw new PlaylistError('VALIDATION', `unknown media server in ${t}`, 400);
      if (server.kind === 'audiobookshelf') throw new PlaylistError('VALIDATION', `${server.name} (Audiobookshelf) has no music playlists`, 400);
    }
  }

  private validateLibraryChoices(rootFolderPath: string | null, qualityProfileId: number | null): void {
    if (rootFolderPath !== null && !this.musicRoots().includes(rootFolderPath)) {
      throw new PlaylistError('VALIDATION', `${rootFolderPath} is not a music root folder`, 400);
    }
    if (qualityProfileId !== null) {
      const p = this.db.select({ domain: qualityProfiles.mediaDomain }).from(qualityProfiles).where(eq(qualityProfiles.id, qualityProfileId)).get();
      if (!p || p.domain !== 'music') throw new PlaylistError('VALIDATION', `quality profile ${qualityProfileId} is not a music profile`, 400);
    }
  }

  create(input: CreateMusicPlaylist): MusicPlaylist {
    this.validateTargets(input.targets);
    this.validateLibraryChoices(input.rootFolderPath, input.qualityProfileId);
    const row = this.db
      .insert(musicPlaylists)
      .values({
        name: input.name,
        source: input.source,
        want: input.want,
        addArtists: input.addArtists,
        rootFolderPath: input.rootFolderPath,
        qualityProfileId: input.qualityProfileId,
        searchOnWant: input.searchOnWant,
        writeM3u: input.writeM3u,
        targets: [...new Set(input.targets)],
        targetState: [],
        ownedAlbumIds: [],
        syncIntervalHours: input.syncIntervalHours,
        enabled: input.enabled,
        createdAt: nowIso(this.now()),
      })
      .returning()
      .get();
    return this.toApi(row);
  }

  update(id: number, input: UpdateMusicPlaylist): MusicPlaylist {
    const row = this.row(id);
    if (input.targets) this.validateTargets(input.targets);
    this.validateLibraryChoices(
      input.rootFolderPath !== undefined ? input.rootFolderPath : null,
      input.qualityProfileId !== undefined ? input.qualityProfileId : null,
    );
    const patch: Partial<typeof musicPlaylists.$inferInsert> = {};
    for (const key of ['name', 'want', 'addArtists', 'rootFolderPath', 'qualityProfileId', 'searchOnWant', 'writeM3u', 'syncIntervalHours', 'enabled'] as const) {
      if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
    }
    if (input.targets) {
      patch.targets = [...new Set(input.targets)];
      patch.targetState = row.targetState.filter((s) => patch.targets!.includes(s.target));
    }
    if (input.source && JSON.stringify(input.source) !== JSON.stringify(row.source)) {
      patch.source = input.source;
      patch.sourceTitle = null;
      patch.lastSyncStatus = 'never';
      patch.lastSyncAt = null;
      patch.lastSyncMessage = null;
      this.db.delete(musicPlaylistEntries).where(eq(musicPlaylistEntries.playlistId, id)).run();
    }
    if (Object.keys(patch).length > 0) this.db.update(musicPlaylists).set(patch).where(eq(musicPlaylists.id, id)).run();
    return this.get(id);
  }

  delete(id: number): void {
    this.row(id);
    this.db.delete(musicPlaylists).where(eq(musicPlaylists.id, id)).run();
  }

  entries(id: number): MusicPlaylistEntry[] {
    this.row(id);
    const rows = this.db
      .select()
      .from(musicPlaylistEntries)
      .where(eq(musicPlaylistEntries.playlistId, id))
      .orderBy(asc(musicPlaylistEntries.position))
      .all();
    const albumIds = [...new Set(rows.map((r) => r.albumId).filter((v): v is number => v !== null))];
    const artistIds = [...new Set(rows.map((r) => r.artistId).filter((v): v is number => v !== null))];
    const albumTitles = new Map(albumIds.length ? this.db.select({ id: albums.id, title: albums.title }).from(albums).where(inArray(albums.id, albumIds)).all().map((a) => [a.id, a.title]) : []);
    const artistNames = new Map(artistIds.length ? this.db.select({ id: artists.id, name: artists.name }).from(artists).where(inArray(artists.id, artistIds)).all().map((a) => [a.id, a.name]) : []);
    return rows.map((r) => this.entryToApi(r, albumTitles, artistNames));
  }

  private entryToApi(r: MusicPlaylistEntryRow, albumTitles: Map<number, string>, artistNames: Map<number, string>): MusicPlaylistEntry {
    return {
      position: r.position,
      title: r.title,
      artist: r.artist,
      album: r.album,
      durationMs: r.durationMs,
      isrc: r.isrc,
      status: r.status,
      matchMethod: r.matchMethod,
      recordingMbid: r.recordingMbid,
      releaseGroupMbid: r.releaseGroupMbid,
      artistMbid: r.artistMbid,
      // Library rows deleted since the sync read as gone.
      artistId: r.artistId !== null && artistNames.has(r.artistId) ? r.artistId : null,
      albumId: r.albumId !== null && albumTitles.has(r.albumId) ? r.albumId : null,
      trackId: r.trackId,
      albumTitle: r.albumId !== null ? (albumTitles.get(r.albumId) ?? null) : null,
      artistName: r.artistId !== null ? (artistNames.get(r.artistId) ?? null) : null,
    };
  }

  async preview(source: PlaylistSource): Promise<MusicPlaylistPreview> {
    const p = await this.providers.load(source);
    return {
      title: p.title,
      description: p.description ?? null,
      owner: p.owner ?? null,
      trackCount: p.tracks.length,
      tracks: p.tracks.slice(0, 100).map((t) => ({ title: t.title, artist: t.artist, album: t.album ?? null, durationMs: t.durationMs ?? null })),
    };
  }

  // ---- sync ----------------------------------------------------------------------------------

  /** Starts the sync job for one playlist (a running sync of the same playlist is reused). */
  startSync(id: number, trigger: 'manual' | 'scheduled' | 'system' = 'manual', opts: { followUp?: boolean } = {}): MusicPlaylistSyncStarted & { done: Promise<unknown> } {
    const row = this.row(id);
    const started = this.deps.scheduler.runTask(
      MUSIC_PLAYLIST_SYNC_JOB,
      trigger,
      async ({ signal, log }) => {
        const report = await this.sync(id, { signal, log, followUp: opts.followUp ?? false });
        return `${row.name}: ${report.message}`;
      },
      { key: `${MUSIC_PLAYLIST_SYNC_JOB}:${id}` },
    );
    return { jobId: started.job.id ?? null, status: 'running', done: started.done };
  }

  /** The scheduled run: every enabled playlist whose interval has passed, one after another. */
  async syncDue(signal: AbortSignal, log: Logger): Promise<string> {
    const now = this.now();
    const due = this.db.select().from(musicPlaylists).all().filter((p) => isSyncDue(p, now));
    const parts: string[] = [];
    for (const p of due) {
      if (signal.aborted) break;
      const report = await this.sync(p.id, { signal, log, followUp: false });
      parts.push(`${p.name}: ${report.status}`);
    }
    return due.length === 0 ? 'no playlists due' : parts.join('; ');
  }

  private finish(id: number, report: SyncReport, extra: Partial<typeof musicPlaylists.$inferInsert> = {}): SyncReport {
    this.db
      .update(musicPlaylists)
      .set({ lastSyncAt: nowIso(this.now()), lastSyncStatus: report.status, lastSyncMessage: report.message.slice(0, 2000), ...extra })
      .where(eq(musicPlaylists.id, id))
      .run();
    return report;
  }

  async sync(id: number, ctx: { signal?: AbortSignal; log?: Logger; followUp?: boolean } = {}): Promise<SyncReport> {
    const playlist = this.row(id);
    const log = ctx.log ?? this.deps.log;
    this.db.update(musicPlaylists).set({ lastSyncStatus: 'running' }).where(eq(musicPlaylists.id, id)).run();
    let source: SourcePlaylist;
    try {
      source = await this.providers.load(playlist.source, ctx.signal);
    } catch (err) {
      log.warn({ err, playlistId: id }, 'playlist source failed');
      return this.finish(id, { status: 'failed', message: err instanceof Error ? err.message : String(err) });
    }

    const problems: string[] = [];
    const resolved = await this.resolveAll(source.tracks, ctx.signal, problems);
    const want = await this.applyWant(playlist, resolved, problems);
    this.saveEntries(id, resolved);

    const outputs = await this.writeOutputs(playlist, resolved, problems);
    const counts = this.counts([id]).get(id)!;
    const summary = [
      `${counts.total} tracks: ${counts.matched} matched, ${counts.available} available, ${counts.wanted} wanted`,
      ...(want.added > 0 ? [`${want.added} artists added`] : []),
      ...(want.newlyWanted > 0 ? [`${want.newlyWanted} albums wanted`] : []),
      ...outputs,
      ...problems,
    ].join('; ');
    const report = this.finish(
      id,
      { status: problems.length > 0 ? 'partial' : 'ok', message: summary },
      { sourceTitle: source.title, ownedAlbumIds: want.owned, targetState: want.targetState ?? this.row(id).targetState },
    );
    // Albums of freshly added artists show up once their ArtistAdd jobs finish: match once more then.
    if (want.addedJobs.length > 0 && !ctx.followUp) {
      void Promise.allSettled(want.addedJobs).then(() => {
        try {
          if (this.db.select({ id: musicPlaylists.id }).from(musicPlaylists).where(eq(musicPlaylists.id, id)).get()) this.startSync(id, 'system', { followUp: true });
        } catch (err) {
          this.deps.log.warn({ err, playlistId: id }, 'playlist follow-up sync failed to start');
        }
      });
    }
    return report;
  }

  // ---- matching ------------------------------------------------------------------------------

  private cached<T>(key: string): { hit: true; value: T } | { hit: false } {
    const store = this.deps.musicMetadata()?.store;
    const entry = store?.get<T>(MATCH_CACHE, key);
    return entry ? { hit: true, value: entry.body } : { hit: false };
  }

  private remember(key: string, value: unknown, ttlMs: number): void {
    this.deps.musicMetadata()?.store.set(MATCH_CACHE, key, value, ttlMs);
  }

  private async resolveAll(source: readonly SourcePlaylistTrack[], signal: AbortSignal | undefined, problems: string[]): Promise<ResolvedEntry[]> {
    const mbService = this.deps.musicMetadata();
    const settings = this.settings();
    let searches = 0;
    let mbFailures = 0;
    let mbDown = false;
    const libraryIndex = this.libraryTitleIndex();
    const out: ResolvedEntry[] = [];

    const lookup = async <T>(key: string, ttl: number, missTtl: number, load: () => Promise<T | null>): Promise<T | null> => {
      const c = this.cached<T | null>(key);
      if (c.hit) return c.value;
      if (mbDown || !mbService) return null;
      try {
        const value = await load();
        this.remember(key, value, value === null || (Array.isArray(value) && value.length === 0) ? missTtl : ttl);
        mbFailures = 0;
        return value;
      } catch (err) {
        if (isMetadataError(err, 'not-found')) {
          this.remember(key, null, missTtl);
          return null;
        }
        if (++mbFailures >= 3) mbDown = true;
        this.deps.log.warn({ err, key }, 'playlist recording lookup failed');
        return null;
      }
    };

    for (const track of source) {
      if (signal?.aborted) break;
      const mb = () => mbService!.musicBrainz();
      let recording: MbRecording | undefined;
      let method: PlaylistMatchMethod | undefined;
      if (track.recordingMbid) {
        recording = (await lookup(`rec:${track.recordingMbid}`, 30 * DAY, 7 * DAY, () => mb().getRecording(track.recordingMbid!, { priority: 'background' }))) ?? undefined;
        if (recording) method = 'recording';
      }
      if (!recording && track.isrc) {
        const list = (await lookup(`isrc:${track.isrc}`, 30 * DAY, 7 * DAY, () => mb().recordingsByIsrc(track.isrc!, { priority: 'background' }))) ?? [];
        recording = pickRecording(track, list, 0.5);
        if (recording) method = 'isrc';
      }
      let hit: LibraryHit = {};
      if (!recording) {
        const local = libraryIndex(track);
        if (local) {
          hit = this.hitForTrack(local);
          method = 'library';
        }
      }
      if (!recording && method !== 'library') {
        const key = `search:${normalize(baseTitle(track.title))}|${normalize(creditedArtists(track.artist)[0] ?? track.artist)}|${normalize(track.album ?? '')}`;
        const known = this.cached<MbRecording[] | null>(key);
        let list: MbRecording[] = [];
        if (known.hit) list = known.value ?? [];
        else if (searches < settings.maxSearchesPerSync) {
          searches++;
          list =
            (await lookup(key, 14 * DAY, 3 * DAY, async () => {
              const page = await mb().searchRecordings(
                { title: baseTitle(track.title), artist: creditedArtists(track.artist)[0] ?? track.artist, ...(track.album ? { release: track.album.replace(/\s+-\s+(single|ep)$/i, '') } : {}) },
                { limit: 10, priority: 'background' },
              );
              return page.results;
            })) ?? [];
          // A miss with the album named may be a compilation the source lists: try without it once.
          if (list.length === 0 && track.album && searches < settings.maxSearchesPerSync) {
            searches++;
            list =
              (await lookup(`${key}|any`, 14 * DAY, 3 * DAY, async () => {
                const page = await mb().searchRecordings({ title: baseTitle(track.title), artist: creditedArtists(track.artist)[0] ?? track.artist }, { limit: 10, priority: 'background' });
                return page.results;
              })) ?? [];
          }
        }
        recording = pickRecording(track, list);
        if (recording) method = 'search';
      }

      const choice = recording ? chooseReleaseGroup(track, recording) : undefined;
      const artistMbid = recording ? primaryArtistMbid(recording) : track.artistMbids?.[0];
      if (recording) hit = this.hitForRecording(recording, choice?.releaseGroup.mbid, artistMbid);
      out.push({ track, recording, method, releaseGroupMbid: choice?.releaseGroup.mbid, artistMbid, hit, artistAdded: false });
    }
    if (mbDown) problems.push('MusicBrainz lookups failed; the rest were skipped');
    else if (mbFailures > 0) problems.push('some MusicBrainz lookups failed');
    if (!mbService) problems.push('the music metadata service is not running');
    return out;
  }

  /** Finds library tracks by artist name + title (no MusicBrainz call) for sources without ids. */
  private libraryTitleIndex(): (track: SourcePlaylistTrack) => number | undefined {
    const byName = new Map<string, number>();
    for (const a of this.db.select({ id: artists.id, name: artists.name }).from(artists).all()) byName.set(normalize(a.name), a.id);
    const perArtist = new Map<number, Map<string, number>>();
    return (track) => {
      const names = [track.artist, ...creditedArtists(track.artist)];
      const artistId = names.map((n) => byName.get(normalize(n))).find((v) => v !== undefined);
      if (artistId === undefined) return undefined;
      let titles = perArtist.get(artistId);
      if (!titles) {
        titles = new Map();
        const rows = this.db
          .select({ id: tracks.id, title: tracks.title, hasFile: tracks.hasFile })
          .from(tracks)
          .innerJoin(albums, eq(tracks.albumId, albums.id))
          .where(eq(albums.artistId, artistId))
          .all();
        // Tracks with files first so they win the title slot.
        for (const r of rows.sort((a, b) => Number(b.hasFile) - Number(a.hasFile))) {
          const key = normalize(baseTitle(r.title));
          if (!titles.has(key)) titles.set(key, r.id);
        }
        perArtist.set(artistId, titles);
      }
      return titles.get(normalize(baseTitle(track.title)));
    };
  }

  private trackSelect() {
    return {
      id: tracks.id,
      albumId: tracks.albumId,
      hasFile: tracks.hasFile,
      artistId: albums.artistId,
      albumMonitored: albums.monitored,
      ...(trackMonitored ? { trackMonitored: sql<number>`${trackMonitored}` } : {}),
    };
  }

  private hitFromRow(r: { id: number; albumId: number; hasFile: boolean; artistId: number; albumMonitored: boolean; trackMonitored?: number }): LibraryHit {
    return {
      artistId: r.artistId,
      albumId: r.albumId,
      trackId: r.id,
      hasFile: r.hasFile,
      albumMonitored: r.albumMonitored,
      ...(r.trackMonitored !== undefined ? { trackMonitored: Boolean(r.trackMonitored) } : {}),
    };
  }

  private hitForTrack(trackId: number): LibraryHit {
    const r = this.db.select(this.trackSelect()).from(tracks).innerJoin(albums, eq(tracks.albumId, albums.id)).where(eq(tracks.id, trackId)).get();
    return r ? this.hitFromRow(r) : {};
  }

  private hitForRecording(rec: MbRecording, releaseGroupMbid: string | undefined, artistMbid: string | undefined): LibraryHit {
    const rows = this.db
      .select(this.trackSelect())
      .from(tracks)
      .innerJoin(albums, eq(tracks.albumId, albums.id))
      .where(eq(tracks.mbRecordingId, rec.mbid))
      .all()
      .sort((a, b) => Number(b.hasFile) - Number(a.hasFile) || Number(b.albumMonitored) - Number(a.albumMonitored) || a.id - b.id);
    if (rows[0]) return this.hitFromRow(rows[0]);
    const groups = [...new Set([releaseGroupMbid, ...rec.releases.map((r) => r.releaseGroup?.mbid)].filter((v): v is string => !!v))];
    if (groups.length > 0) {
      const found = this.db
        .select({ id: albums.id, artistId: albums.artistId, monitored: albums.monitored, mbid: albums.mbReleaseGroupId })
        .from(albums)
        .where(inArray(albums.mbReleaseGroupId, groups))
        .all();
      const album = found.find((a) => a.mbid === releaseGroupMbid) ?? found.find((a) => a.monitored) ?? found[0];
      if (album) return { artistId: album.artistId, albumId: album.id, albumMonitored: album.monitored };
    }
    if (artistMbid) {
      const artistId = artistIdsByMbid(this.db, [artistMbid]).get(artistMbid.toLowerCase()) ?? artistIdsByMbid(this.db, [artistMbid]).get(artistMbid);
      if (artistId !== undefined) return { artistId };
    }
    return {};
  }

  // ---- wanting -------------------------------------------------------------------------------

  private musicRoots(): string[] {
    return this.db.select({ path: rootFolders.path }).from(rootFolders).where(eq(rootFolders.mediaType, 'music')).all().map((r) => r.path);
  }

  private firstMusicProfile(): number | undefined {
    return this.db.select({ id: qualityProfiles.id }).from(qualityProfiles).where(eq(qualityProfiles.mediaDomain, 'music')).orderBy(asc(qualityProfiles.id)).get()?.id;
  }

  private setTracksMonitored(ids: readonly number[], monitored: boolean): void {
    if (!trackMonitored || ids.length === 0) return;
    this.db
      .update(tracks)
      .set({ [trackMonitored.name]: monitored } as never)
      .where(inArray(tracks.id, [...ids]))
      .run();
  }

  private albumTracks(albumId: number): Array<{ id: number; monitored: boolean }> {
    if (!trackMonitored) return [];
    return this.db
      .select({ id: tracks.id, monitored: sql<number>`${trackMonitored}` })
      .from(tracks)
      .where(eq(tracks.albumId, albumId))
      .all()
      .map((r) => ({ id: r.id, monitored: Boolean(r.monitored) }));
  }

  private async applyWant(
    playlist: MusicPlaylistRow,
    entries: ResolvedEntry[],
    problems: string[],
  ): Promise<{ added: number; newlyWanted: number; owned: number[]; addedJobs: Promise<unknown>[]; targetState?: PlaylistTargetState[] }> {
    const owned = new Set(playlist.ownedAlbumIds);
    const result = { added: 0, newlyWanted: 0, owned: [...owned], addedJobs: [] as Promise<unknown>[] };
    if (playlist.want === 'none' && !playlist.addArtists) return result;
    const refresher = this.deps.refresher();
    const wanted = new Set<number>();
    const refresh = new Set<number>();
    const addedArtists = new Map<string, boolean>();

    for (const e of entries) {
      if (!e.recording) continue;
      if (e.hit.artistId === undefined && e.artistMbid && playlist.addArtists) {
        const key = e.artistMbid.toLowerCase();
        if (!addedArtists.has(key)) addedArtists.set(key, await this.addArtist(playlist, e.artistMbid, refresher, result.addedJobs, problems));
        e.artistAdded = addedArtists.get(key)!;
        continue;
      }
      if (playlist.want === 'none' || e.hit.artistId === undefined) continue;
      if (e.hit.albumId === undefined) {
        const group = e.recording.releases.find((r) => r.releaseGroup?.mbid === e.releaseGroupMbid)?.releaseGroup;
        if (!group) continue;
        const albumId = addReleaseGroupAlbum(
          this.db,
          e.hit.artistId,
          { mbid: group.mbid, title: group.title, secondaryTypes: group.secondaryTypes, artistCredits: [], ...(group.primaryType ? { primaryType: group.primaryType } : {}), ...(group.firstReleaseDate ? { firstReleaseDate: group.firstReleaseDate } : {}), ...(group.year !== undefined ? { year: group.year } : {}) },
          albumCoverImages,
          true,
        );
        const artistId = e.hit.artistId;
        e.hit = { artistId, albumId, albumMonitored: true };
        wanted.add(albumId);
        refresh.add(artistId);
        if (playlist.want === 'tracks') owned.add(albumId);
        continue;
      }
      const { artistId, albumId } = e.hit;
      if (!e.hit.albumMonitored) {
        this.db.update(albums).set({ monitored: true }).where(eq(albums.id, albumId)).run();
        e.hit = { ...e.hit, albumMonitored: true };
        wanted.add(albumId);
        if (playlist.want === 'tracks') owned.add(albumId);
      }
      if (e.hit.trackId === undefined) refresh.add(artistId);
    }

    if (playlist.want === 'tracks' && trackMonitored) {
      const listed = new Map<number, Set<number>>();
      for (const e of entries) {
        if (e.hit.albumId === undefined || e.hit.trackId === undefined) continue;
        listed.set(e.hit.albumId, (listed.get(e.hit.albumId) ?? new Set()).add(e.hit.trackId));
      }
      for (const [albumId, ids] of listed) {
        if (owned.has(albumId)) {
          const { monitor, unmonitor } = trackMonitoringChanges(this.albumTracks(albumId), ids);
          this.setTracksMonitored(monitor, true);
          this.setTracksMonitored(unmonitor, false);
        } else {
          // An album monitored before the playlist: only make sure the listed tracks are wanted.
          this.setTracksMonitored([...ids], true);
        }
      }
      for (const e of entries) if (e.hit.trackId !== undefined && e.hit.albumId !== undefined && listed.get(e.hit.albumId)?.has(e.hit.trackId)) e.hit.trackMonitored = true;
    } else if (playlist.want === 'albums' && trackMonitored) {
      for (const albumId of wanted) this.setTracksMonitored(this.albumTracks(albumId).map((t) => t.id), true);
    }

    result.owned = [...owned].filter((albumId) => this.db.select({ id: albums.id }).from(albums).where(eq(albums.id, albumId)).get());
    result.newlyWanted = wanted.size;
    result.added = [...addedArtists.values()].filter(Boolean).length;
    if (refresher) {
      const ids = [...refresh].filter((a) => this.db.select({ id: artists.id }).from(artists).where(eq(artists.id, a)).get());
      if (ids.length > 0) {
        try {
          refresher.refresh(ids, { trigger: 'system' });
        } catch (err) {
          this.deps.log.warn({ err }, 'playlist artist refresh failed to start');
        }
      }
      if (playlist.searchOnWant && wanted.size > 0) refresher.search(ALBUM_SEARCH_JOB, [...wanted], 'system');
    }
    return result;
  }

  private async addArtist(playlist: MusicPlaylistRow, mbid: string, refresher: MusicRefresher | null, jobs: Promise<unknown>[], problems: string[]): Promise<boolean> {
    if (!refresher) return false;
    const root = playlist.rootFolderPath ?? this.musicRoots()[0];
    const profile = playlist.qualityProfileId ?? this.firstMusicProfile();
    if (!root || profile === undefined) {
      if (!problems.includes('artists not added: no music root folder or quality profile')) problems.push('artists not added: no music root folder or quality profile');
      return false;
    }
    try {
      const started = await refresher.addArtist({
        mbArtistId: mbid,
        rootFolderPath: root,
        qualityProfileId: profile,
        monitored: true,
        // Nothing wanted up front: the follow-up sync wants what the playlist lists.
        monitorOption: 'none',
        monitorNewAlbums: 'none',
        tags: [],
        searchOnAdd: false,
      });
      jobs.push(started.done);
      return true;
    } catch (err) {
      this.deps.log.info({ err, mbid }, 'playlist artist not added');
      return false;
    }
  }

  private saveEntries(id: number, entries: readonly ResolvedEntry[]): void {
    this.db.transaction((tx) => {
      tx.delete(musicPlaylistEntries).where(eq(musicPlaylistEntries.playlistId, id)).run();
      entries.forEach((e, i) => {
        const status: PlaylistEntryStatus = entryStatus(e.recording !== undefined || e.method === 'library', e.hit, e.artistAdded);
        tx.insert(musicPlaylistEntries)
          .values({
            playlistId: id,
            position: i + 1,
            title: e.track.title,
            artist: e.track.artist,
            album: e.track.album ?? null,
            durationMs: e.track.durationMs ?? null,
            isrc: e.track.isrc ?? null,
            status,
            matchMethod: e.method ?? null,
            recordingMbid: e.recording?.mbid ?? null,
            releaseGroupMbid: e.releaseGroupMbid ?? null,
            artistMbid: e.artistMbid ?? null,
            artistId: e.hit.artistId ?? null,
            albumId: e.hit.albumId ?? null,
            trackId: e.hit.trackId ?? null,
          })
          .run();
      });
    });
  }

  // ---- outputs -------------------------------------------------------------------------------

  private localTracks(entries: readonly ResolvedEntry[]): LocalTrack[] {
    const ids = entries.map((e) => (e.hit.hasFile ? e.hit.trackId : undefined)).filter((v): v is number => v !== undefined);
    if (ids.length === 0) return [];
    const rows = this.db
      .select({ id: tracks.id, title: tracks.title, mbid: tracks.mbRecordingId, credit: tracks.artistCredit, durationMs: tracks.durationMs, path: audioFiles.path, artist: artists.name })
      .from(tracks)
      .innerJoin(audioFiles, eq(tracks.audioFileId, audioFiles.id))
      .innerJoin(albums, eq(tracks.albumId, albums.id))
      .innerJoin(artists, eq(albums.artistId, artists.id))
      .where(inArray(tracks.id, ids))
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: LocalTrack[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || seen.has(id)) continue;
      seen.add(id);
      out.push({ path: r.path, recordingMbid: r.mbid ?? undefined, title: r.title, artist: r.credit ?? r.artist, durationMs: r.durationMs });
    }
    return out;
  }

  /** The playlist's .m3u8 file path (null without a folder to write to). */
  m3uPathFor(name: string): string | null {
    const folder = this.settings().m3uFolder || this.musicRoots()[0];
    return folder ? join(folder, playlistFileName(name)) : null;
  }

  private pusherFor(target: string, settings: MusicPlaylistsSettings): { pusher: PlaylistPusher; label: string } {
    const fetchImpl = this.fetchImpl();
    if (target === 'navidrome') {
      if (!settings.navidromeUrl || !settings.navidromeUser) throw new Error('Navidrome is not set up (Playlists → Sources & outputs)');
      return { label: 'Navidrome', pusher: subsonicPusher({ url: settings.navidromeUrl, user: settings.navidromeUser, password: settings.navidromePassword, label: 'Navidrome', fetchImpl }) };
    }
    const server = this.deps.mediaServers().find((s) => `server:${s.id}` === target);
    if (!server) throw new Error(`${target}: the media server was removed`);
    if (!server.enabled) throw new Error(`${server.name}: the media server is turned off`);
    if (server.kind === 'jellyfin' || server.kind === 'emby') return { label: server.name, pusher: jellyfinPusher({ url: server.url, apiKey: server.apiKey, label: server.name, fetchImpl }) };
    if (server.kind === 'plex') return { label: server.name, pusher: plexPusher({ url: server.url, token: server.apiKey, label: server.name, fetchImpl }) };
    throw new Error(`${server.name}: ${server.kind} has no music playlists`);
  }

  private async writeOutputs(playlist: MusicPlaylistRow, entries: readonly ResolvedEntry[], problems: string[]): Promise<string[]> {
    const notes: string[] = [];
    const items = this.localTracks(entries);
    const settings = this.settings();
    if (playlist.writeM3u) {
      const path = this.m3uPathFor(playlist.name);
      if (!path) problems.push('no folder for the .m3u8 (add a music root folder or set one)');
      else {
        try {
          await mkdir(join(path, '..'), { recursive: true });
          await writeFile(path, renderM3u8(playlist.name, items, path, settings.m3uPaths), 'utf8');
          notes.push(`${playlistFileName(playlist.name)} written (${items.length})`);
        } catch (err) {
          problems.push(`.m3u8 not written: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const state = new Map(playlist.targetState.map((s) => [s.target, s]));
    for (const target of playlist.targets) {
      const prev = state.get(target);
      try {
        const { pusher, label } = this.pusherFor(target, settings);
        if (items.length === 0 && !prev?.remoteId) {
          notes.push(`${label}: nothing to push yet`);
          continue;
        }
        const r = await pusher.push(playlist.name, items, prev?.remoteId);
        state.set(target, { target, remoteId: r.remoteId, lastPushAt: nowIso(this.now()) });
        notes.push(`${label}: ${r.pushed} pushed${r.missing ? `, ${r.missing} not found on the server` : ''}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.set(target, { ...(prev ?? { target }), target, error: message });
        problems.push(message);
      }
    }
    this.db
      .update(musicPlaylists)
      .set({ targetState: [...state.values()].filter((s) => playlist.targets.includes(s.target)) })
      .where(eq(musicPlaylists.id, playlist.id))
      .run();
    return notes;
  }

  // ---- similar artists -----------------------------------------------------------------------

  /** Similar artists for an MBID, ListenBrainz and/or Last.fm per the settings, cached for a day. */
  async similarByMbid(mbid: string, opts: { limit?: number; name?: string } = {}): Promise<MergedSimilarArtist[]> {
    const id = mbid.toLowerCase();
    const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
    const mode = this.settings().similarSource;
    const store = this.deps.musicMetadata()?.store;
    const key = `${mode}:${id}`;
    const fresh = store?.get<MergedSimilarArtist[]>(SIMILAR_CACHE, key);
    if (fresh) return fresh.body.slice(0, limit);

    const lfClient = mode === 'listenbrainz' ? null : this.providers.lastfmClient();
    const [lb, lf] = await Promise.allSettled([
      mode === 'lastfm' ? Promise.resolve([]) : this.providers.listenBrainz().similarArtists(id, { limit: 50 }),
      lfClient ? lfClient.similarArtists({ mbid: id, ...(opts.name ? { name: opts.name } : {}) }, { limit: 50 }) : Promise.resolve([]),
    ]);
    if (lb.status === 'rejected' && (lf.status === 'rejected' || !lfClient)) {
      const stale = store?.get<MergedSimilarArtist[]>(SIMILAR_CACHE, key, { allowStale: true });
      if (stale) return stale.body.slice(0, limit);
      const reason = lb.reason instanceof Error ? lb.reason.message : String(lb.reason);
      throw new PlaylistError('SOURCE_FAILED', `similar artists are unavailable: ${reason}`, 502);
    }
    const merged = mergeSimilarArtists(lb.status === 'fulfilled' ? lb.value : [], lf.status === 'fulfilled' ? lf.value : [], id, 50);
    store?.set(SIMILAR_CACHE, key, merged, DAY);
    return merged.slice(0, limit);
  }

  /** GET /artist/{id}/similar: similar artists with their library ids. */
  async similarForArtist(artistId: number, limit?: number): Promise<SimilarArtist[]> {
    const artist = this.db.select({ mbid: artists.mbArtistId, name: artists.name }).from(artists).where(eq(artists.id, artistId)).get();
    if (!artist) throw new PlaylistError('NOT_FOUND', `artist ${artistId} not found`, 404);
    const list = await this.similarByMbid(artist.mbid, { name: artist.name, ...(limit !== undefined ? { limit } : {}) });
    return this.withLibraryIds(list);
  }

  withLibraryIds(list: readonly MergedSimilarArtist[]): SimilarArtist[] {
    const ids = artistIdsByMbid(this.db, list.map((a) => a.mbid));
    return list.map((a) => ({ ...a, artistId: ids.get(a.mbid) ?? null }));
  }
}

/** Status filter helper for tests and the UI: entries of one status. */
export function statusIs(status: PlaylistEntryStatus): SQL {
  return and(eq(musicPlaylistEntries.status, status))!;
}
