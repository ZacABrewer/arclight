import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, asc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  QUALITIES,
  type Job,
  type MediaType,
  type MediaVersion,
  type ProfileFileStatus,
  type ProfileFileStatusReason,
  type ProfileItemStatus,
  type ProfileMigrationApplyResult,
  type ProfileMigrationCounts,
  type ProfileMigrationPreview,
  type ProfileMigrationPreviewItem,
  type ProfileMigrationProfileSettings,
  type ProfileMigrationProfileUpdate,
  type ProfileMigrationProgress,
  type ProfileMigrationRequest,
  type ProfileMigrationSearchResult,
  type ProfileMigrationSelection,
  type ProfileMigrationSettings,
  type ProfileMismatchAction,
  type ProfileMismatchPage,
  type ProfileMismatchQuery,
  type ProfileMismatchRecord,
  type ProfileReplacementState,
  type QualityDefinitionItem,
  type QualityModel,
  type QualityProfile,
} from '@arclight/shared';
import { effectiveCutoff, fileFit, findItem, itemQualityIds } from '@arclight/profiles-engine';
import type { Db } from '../../db/index.js';
import { history, mediaRequests, trackedDownloads } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import type { Scheduler } from '../../scheduler.js';
import { fileFormatScore, libraryService } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { upcomingRuns } from '../releases/search-status.js';
import { getSection, setSection } from '../settings/service.js';
import { itemKey, loadLibrary, profileForSlot, profileMap, type EpisodeInfo, type FileInfo, type ItemInfo, type LibraryScope } from './library-view.js';
import {
  profileFileFits,
  profileItemSnapshots,
  profileMigrationQueue,
  profileMigrationRules,
  profileMigrationSearches,
  type ProfileFileFitRow,
  type ProfileMigrationQueueRow,
} from './schema.js';

// Profile migration (see docs/USER-GUIDE.md, "Changing profiles"):
//
// * Fit: every library file is judged against the profile governing it (its item's, or its
//   version slot's): meets / upgradeAllowed / notAllowed. Re-evaluated in one pass over stored
//   rows (no file I/O) whenever an item, a profile or a custom format changes, and nightly.
// * Change detection: the last seen profile of every item and slot is kept, so a change made
//   anywhere is recorded once in history (`profileChanged`).
// * Work list: files that do not meet a profile with a replacement rule become queue rows. The
//   ProfileMigration job searches them a few at a time (normal decision engine; the engine knows
//   the rule through `mismatchActionFor`). When a replacement is imported the row is done and
//   history gets `profileReplaced`.

export const PROFILE_MIGRATION_JOB = 'ProfileMigration';
export const PROFILE_MIGRATION_SEARCH_JOB = 'ProfileMigrationSearch';
export const PROFILE_FIT_REFRESH_JOB = 'ProfileFitRefresh';

const ACTIVE_DOWNLOAD_STATES = ['pending', 'downloading', 'importPending', 'importing', 'failedPending'] as const;
const DONE_RETENTION_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A grab with no download left in the queue after this long goes back to `queued`. */
const GRAB_STALE_MS = 2 * HOUR_MS;
const SAMPLE_SIZE = 200;
const MB = 1024 * 1024;

const UNKNOWN_QUALITY: QualityModel = { quality: { ...QUALITIES.Unknown, mediaTypes: [...QUALITIES.Unknown.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
const STATUS_RANK: Record<ProfileFileStatus, number> = { meets: 0, upgradeAllowed: 1, notAllowed: 2 };

export type ProfileMigrationErrorCode = 'NOT_FOUND' | 'VALIDATION';

export class ProfileMigrationError extends Error {
  constructor(
    public readonly code: ProfileMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileMigrationError';
  }
}

export type MigrationSearchTarget = { movieId: number } | { seriesId: number; episodeIds: number[] };

export interface ProfileMigrationPorts {
  /** Automatic search + grab through the decision engine (releases.searchFor). */
  search?: (target: MigrationSearchTarget, opts: { userInvoked: boolean; signal?: AbortSignal }) => Promise<{ grabbed: string[] }>;
  /** Free bytes at a path; null when unknown. */
  freeSpace?: (path: string) => Promise<number | null>;
  /** Movies and episodes with a download in the queue; defaults to the tracked-downloads table. */
  activeDownloads?: () => { movieIds: Set<number>; episodeIds: Set<number> };
}

export interface ProfileMigrationServiceOptions {
  db: Db;
  bus?: EventBus;
  log?: Logger;
  scheduler?: Scheduler;
  now?: () => Date;
  ports?: ProfileMigrationPorts;
  /** Delay before event-driven re-evaluations run (they are merged meanwhile). Default 500 ms. */
  debounceMs?: number;
}

/** Items a re-evaluation looks at; 'all' is the whole library. */
export type EvaluateScope = 'all' | { seriesIds?: number[]; movieIds?: number[] };

export interface ReevaluateSummary {
  files: number;
  changedFits: number;
  profileChanges: number;
  queued: number;
  replaced: number;
}

interface Unit {
  key: string;
  info: FileInfo;
  profileId: number;
  status: ProfileFileStatus;
  episode?: EpisodeInfo;
}

interface SearchGroup {
  profileId: number;
  item: { mediaType: MediaType; id: number };
  target: MigrationSearchTarget;
  rows: ProfileMigrationQueueRow[];
}

const iso = (d: Date) => d.toISOString();

/** The database or a transaction on it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbOrTx = Db | Tx;

export class ProfileMigrationService {
  private readonly db: Db;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly scheduler: Scheduler | undefined;
  private readonly now: () => Date;
  private readonly profiles: ProfilesService;
  private ports: ProfileMigrationPorts;
  private readonly debounceMs: number;
  private ruleCache: Map<number, ProfileMigrationProfileSettings> | undefined;
  private pending: { all: boolean; seriesIds: Set<number>; movieIds: Set<number> } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(opts: ProfileMigrationServiceOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.log = opts.log;
    this.scheduler = opts.scheduler;
    this.now = opts.now ?? (() => new Date());
    this.profiles = new ProfilesService({ db: opts.db });
    this.ports = { ...opts.ports };
    this.debounceMs = opts.debounceMs ?? 500;
  }

  setPorts(ports: Partial<ProfileMigrationPorts>): void {
    this.ports = { ...this.ports, ...ports };
  }

  // -------------------------------------------------------------------------------------
  // rules and settings

  getSettings(): ProfileMigrationSettings {
    return getSection(this.db, 'profileMigration');
  }

  updateSettings(input: Partial<ProfileMigrationSettings>): ProfileMigrationSettings {
    const next: ProfileMigrationSettings = { ...this.getSettings() };
    for (const [key, value] of Object.entries(input) as Array<[keyof ProfileMigrationSettings, never]>) {
      if (value !== undefined) next[key] = value;
    }
    const saved = setSection(this.db, 'profileMigration', next);
    if (this.scheduler?.has(PROFILE_MIGRATION_JOB)) this.scheduler.update(PROFILE_MIGRATION_JOB, cronForInterval(saved.intervalMinutes));
    this.bus?.publish({ type: 'settings', section: 'profileMigration' });
    return saved;
  }

  /** The rule the decision engine and imports apply to files a profile does not allow. */
  mismatchActionFor(qualityProfileId: number): ProfileMismatchAction {
    return this.rules().get(qualityProfileId)?.mismatchAction ?? 'none';
  }

  private rules(): Map<number, ProfileMigrationProfileSettings> {
    this.ruleCache ??= new Map(this.db.select().from(profileMigrationRules).all().map((r) => [r.qualityProfileId, r]));
    return this.ruleCache;
  }

  profileSettings(qualityProfileId: number): ProfileMigrationProfileSettings {
    return this.rules().get(qualityProfileId) ?? { qualityProfileId, mismatchAction: 'none', autoEnabled: false, paused: false };
  }

  updateProfileSettings(qualityProfileId: number, patch: ProfileMigrationProfileUpdate): ProfileMigrationProgress {
    this.requireProfile(qualityProfileId);
    const next = { ...this.profileSettings(qualityProfileId) };
    if (patch.mismatchAction !== undefined) next.mismatchAction = patch.mismatchAction;
    if (patch.autoEnabled !== undefined) next.autoEnabled = patch.autoEnabled;
    if (patch.paused !== undefined) next.paused = patch.paused;
    this.db
      .insert(profileMigrationRules)
      .values(next)
      .onConflictDoUpdate({
        target: profileMigrationRules.qualityProfileId,
        set: { mismatchAction: next.mismatchAction, autoEnabled: next.autoEnabled, paused: next.paused },
      })
      .run();
    this.ruleCache = undefined;
    // The rule decides which files are on the work list.
    this.reevaluate('all');
    this.announce();
    return this.progress(qualityProfileId);
  }

  private requireProfile(id: number): QualityProfile {
    const profile = this.profiles.listQualityProfiles().find((p) => p.id === id);
    if (!profile) throw new ProfileMigrationError('NOT_FOUND', `quality profile ${id} not found`);
    return profile;
  }

  // -------------------------------------------------------------------------------------
  // re-evaluation

  /** Merge a re-evaluation request and run it shortly (event handlers call this). */
  requestReevaluate(scope: EvaluateScope): void {
    const p = (this.pending ??= { all: false, seriesIds: new Set(), movieIds: new Set() });
    if (scope === 'all') p.all = true;
    else {
      for (const id of scope.seriesIds ?? []) p.seriesIds.add(id);
      for (const id of scope.movieIds ?? []) p.movieIds.add(id);
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Run any pending re-evaluation now. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const p = this.pending;
    this.pending = undefined;
    if (!p) return this.flushing;
    this.flushing = this.flushing.then(() => {
      try {
        if (p.all) this.reevaluate('all');
        else if (p.seriesIds.size > 0 || p.movieIds.size > 0) this.reevaluate({ seriesIds: [...p.seriesIds], movieIds: [...p.movieIds] });
      } catch (err) {
        this.log?.warn({ err }, 'profile re-evaluation failed');
      }
    });
    return this.flushing;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  /**
   * Judge the files of the items in scope against their current profiles, record profile
   * changes in history, and bring the migration work list up to date. Synchronous: everything
   * it reads is stored in the database.
   */
  reevaluate(scope: EvaluateScope = 'all'): ReevaluateSummary {
    const now = iso(this.now());
    const libScope: LibraryScope | null = scope === 'all' ? null : { seriesIds: scope.seriesIds ?? [], movieIds: scope.movieIds ?? [] };
    const view = loadLibrary(this.db, libScope);
    const profiles = new Map(this.profiles.listQualityProfiles().map((p) => [p.id, p]));
    const formats = this.profiles.listCustomFormats();
    const rules = this.rules();
    const summary: ReevaluateSummary = { files: 0, changedFits: 0, profileChanges: 0, queued: 0, replaced: 0 };

    // ---- 1. fits
    const fits = new Map<number, typeof profileFileFits.$inferInsert>();
    for (const f of view.files) {
      const profileId = profileForSlot(f.item, f.slot);
      const profile = profiles.get(profileId);
      if (!profile) continue;
      const score = fileFormatScore(profile, formats, f.file);
      const fit = fileFit(profile, f.file.quality, score);
      fits.set(f.file.id, {
        mediaFileId: f.file.id,
        mediaType: f.item.mediaType,
        seriesId: f.item.mediaType === 'series' ? f.item.id : null,
        movieId: f.item.mediaType === 'movie' ? f.item.id : null,
        slot: f.slot,
        qualityProfileId: profileId,
        status: fit.status,
        reasons: fit.reasons,
        qualityName: f.file.quality.quality.name,
        formatScore: score,
        evaluatedAt: now,
      });
    }
    summary.files = fits.size;

    const scopeWhere = (seriesCol: typeof profileFileFits.seriesId | typeof profileMigrationQueue.seriesId, movieCol: typeof profileFileFits.movieId | typeof profileMigrationQueue.movieId) =>
      scopeCondition(libScope, seriesCol, movieCol);

    const existingFits = this.selectChunked(scopeWhere(profileFileFits.seriesId, profileFileFits.movieId), (where) =>
      this.db.select().from(profileFileFits).where(where).all(),
    );
    const existingQueue = this.selectChunked(scopeWhere(profileMigrationQueue.seriesId, profileMigrationQueue.movieId), (where) =>
      this.db.select().from(profileMigrationQueue).where(where).all(),
    );

    this.db.transaction((tx) => {
      const seen = new Set<number>();
      for (const row of existingFits) {
        seen.add(row.mediaFileId);
        const next = fits.get(row.mediaFileId);
        if (!next) {
          tx.delete(profileFileFits).where(eq(profileFileFits.mediaFileId, row.mediaFileId)).run();
          summary.changedFits++;
          continue;
        }
        if (!sameFit(row, next)) summary.changedFits++;
        tx.update(profileFileFits).set(next).where(eq(profileFileFits.mediaFileId, row.mediaFileId)).run();
      }
      for (const [id, next] of fits) {
        if (seen.has(id)) continue;
        // A file may have moved between items; replace any stale row.
        tx.insert(profileFileFits).values(next).onConflictDoUpdate({ target: profileFileFits.mediaFileId, set: next }).run();
        summary.changedFits++;
      }

      // ---- 2. profile changes -> history
      summary.profileChanges = this.detectProfileChanges(tx, view.items, libScope, profiles, view.files, now);

      // ---- 3. work list
      const units = this.unitsFor(view, fits, rules);
      const counts = this.syncQueue(tx, existingQueue, units, profiles, now);
      summary.queued = counts.queued;
      summary.replaced = counts.replaced;

      if (scope === 'all') {
        // Rules of deleted profiles.
        const stale = [...rules.keys()].filter((id) => !profiles.has(id));
        if (stale.length > 0) {
          tx.delete(profileMigrationRules).where(inArray(profileMigrationRules.qualityProfileId, stale)).run();
          this.ruleCache = undefined;
        }
      }
    });

    if (summary.changedFits > 0 || summary.profileChanges > 0 || summary.queued > 0 || summary.replaced > 0) this.announce();
    return summary;
  }

  private selectChunked<T>(where: SQL | SQL[] | undefined, run: (where: SQL | undefined) => T[]): T[] {
    if (Array.isArray(where)) return where.flatMap((w) => run(w));
    return run(where);
  }

  private detectProfileChanges(
    tx: DbOrTx,
    items: Map<string, ItemInfo>,
    scope: LibraryScope | null,
    profiles: Map<number, QualityProfile>,
    files: readonly FileInfo[],
    now: string,
  ): number {
    const snapshots = new Map<string, typeof profileItemSnapshots.$inferSelect>();
    const conditions: SQL[] = [];
    if (scope === null) {
      for (const s of tx.select().from(profileItemSnapshots).all()) snapshots.set(itemKey(s.mediaType, s.itemId), s);
    } else {
      for (const [type, ids] of [['series', scope.seriesIds ?? []], ['movie', scope.movieIds ?? []]] as const) {
        for (const chunk of chunks(ids)) conditions.push(and(eq(profileItemSnapshots.mediaType, type), inArray(profileItemSnapshots.itemId, chunk))!);
      }
      for (const where of conditions) {
        for (const s of tx.select().from(profileItemSnapshots).where(where).all()) snapshots.set(itemKey(s.mediaType, s.itemId), s);
      }
    }

    const name = (id: number) => profiles.get(id)?.name ?? `#${id}`;
    const historyRows: Array<typeof history.$inferInsert> = [];
    for (const [key, item] of items) {
      const current = profileMap(item);
      const prev = snapshots.get(key);
      snapshots.delete(key);
      if (!prev) {
        tx.insert(profileItemSnapshots).values({ mediaType: item.mediaType, itemId: item.id, profiles: current }).run();
        continue;
      }
      if (sameProfiles(prev.profiles, current)) continue;
      for (const [slot, newId] of Object.entries(current)) {
        const oldId = prev.profiles[slot];
        if (oldId === undefined || oldId === newId) continue;
        const file = files.find((f) => f.item === item && f.slot === slot);
        historyRows.push({
          eventType: 'profileChanged',
          mediaType: item.mediaType,
          seriesId: item.mediaType === 'series' ? item.id : null,
          episodeId: null,
          movieId: item.mediaType === 'movie' ? item.id : null,
          sourceTitle: item.title,
          quality: item.mediaType === 'movie' && file ? file.file.quality : UNKNOWN_QUALITY,
          languages: [],
          date: now,
          downloadId: null,
          data: compact({
            oldProfileId: String(oldId),
            oldProfile: name(oldId),
            newProfileId: String(newId),
            newProfile: name(newId),
            versionTag: slot === '' ? undefined : slot,
          }),
        });
      }
      tx.update(profileItemSnapshots).set({ profiles: current }).where(eq(profileItemSnapshots.id, prev.id)).run();
    }
    // Items in scope that are gone.
    for (const stale of snapshots.values()) tx.delete(profileItemSnapshots).where(eq(profileItemSnapshots.id, stale.id)).run();
    this.insertHistory(tx, historyRows);
    return historyRows.length;
  }

  /** Every movie / episode slot whose file does not meet a profile that has a replacement rule. */
  private unitsFor(
    view: ReturnType<typeof loadLibrary>,
    fits: Map<number, typeof profileFileFits.$inferInsert>,
    rules: Map<number, ProfileMigrationProfileSettings>,
  ): { desired: Map<string, Unit>; current: Map<string, Unit> } {
    const desired = new Map<string, Unit>();
    const current = new Map<string, Unit>();
    for (const info of view.files) {
      const fit = fits.get(info.file.id);
      if (!fit) continue;
      const wanted =
        fit.status !== 'meets' && (rules.get(fit.qualityProfileId)?.mismatchAction ?? 'none') !== 'none' && info.slotEnabled && info.item.monitored;
      if (info.item.mediaType === 'movie') {
        const unit: Unit = { key: `m:${info.item.id}:${info.slot}`, info, profileId: fit.qualityProfileId, status: fit.status };
        current.set(unit.key, unit);
        if (wanted) desired.set(unit.key, unit);
        continue;
      }
      for (const episodeId of info.file.episodeIds) {
        const episode = view.episodes.get(episodeId);
        if (!episode) continue;
        const unit: Unit = { key: `e:${episodeId}:${info.slot}`, info, profileId: fit.qualityProfileId, status: fit.status, episode };
        current.set(unit.key, unit);
        if (wanted && episode.monitored) desired.set(unit.key, unit);
      }
    }
    return { desired, current };
  }

  private syncQueue(
    tx: DbOrTx,
    existing: readonly ProfileMigrationQueueRow[],
    units: { desired: Map<string, Unit>; current: Map<string, Unit> },
    profiles: Map<number, QualityProfile>,
    now: string,
  ): { queued: number; replaced: number } {
    const counts = { queued: 0, replaced: 0 };
    const replacedGroups = new Map<string, { row: ProfileMigrationQueueRow; unit: Unit; episodeIds: number[] }>();
    const handled = new Set<string>();

    for (const row of existing) {
      handled.add(row.unitKey);
      const cur = units.current.get(row.unitKey);
      const want = units.desired.get(row.unitKey);
      if (row.state === 'done') {
        if (want && want.info.file.id !== row.mediaFileId) {
          tx.update(profileMigrationQueue).set(this.freshRow(want, now)).where(eq(profileMigrationQueue.id, row.id)).run();
          counts.queued++;
        }
        continue;
      }
      if (cur && cur.info.file.id !== row.mediaFileId) {
        // The file was replaced while on the work list.
        const groupKey = `${row.mediaFileId}>${cur.info.file.id}`;
        const group = replacedGroups.get(groupKey) ?? { row, unit: cur, episodeIds: [] };
        if (row.episodeId !== null) group.episodeIds.push(row.episodeId);
        replacedGroups.set(groupKey, group);
        counts.replaced++;
        if (want) {
          tx.update(profileMigrationQueue)
            .set({ ...this.freshRow(want, now), message: 'replaced, but the new file still does not meet the profile' })
            .where(eq(profileMigrationQueue.id, row.id))
            .run();
        } else {
          tx.update(profileMigrationQueue)
            .set({ state: 'done', finishedAt: now, updatedAt: now, message: null, nextSearchAt: null })
            .where(eq(profileMigrationQueue.id, row.id))
            .run();
        }
        continue;
      }
      if (want) {
        if (want.profileId !== row.qualityProfileId || want.status !== row.fileStatus) {
          tx.update(profileMigrationQueue)
            .set({ qualityProfileId: want.profileId, fileStatus: want.status, updatedAt: now })
            .where(eq(profileMigrationQueue.id, row.id))
            .run();
        }
        continue;
      }
      // Resolved without a replacement (profile edited, rule off, unmonitored, file removed).
      tx.delete(profileMigrationQueue).where(eq(profileMigrationQueue.id, row.id)).run();
    }

    const fresh = [...units.desired.values()].filter((u) => !handled.has(u.key));
    if (fresh.length > 0) {
      const requests = this.requestCounts(tx);
      for (const unit of fresh) {
        const values = {
          ...this.freshRow(unit, now),
          unitKey: unit.key,
          mediaType: unit.info.item.mediaType,
          seriesId: unit.info.item.mediaType === 'series' ? unit.info.item.id : null,
          seasonNumber: unit.episode?.seasonNumber ?? null,
          episodeId: unit.episode?.id ?? null,
          movieId: unit.info.item.mediaType === 'movie' ? unit.info.item.id : null,
          slot: unit.info.slot,
          requests: requests.get(`${unit.info.item.mediaType}:${unit.info.item.tmdbId}`) ?? 0,
          itemAdded: unit.info.item.added,
          createdAt: now,
        };
        tx.insert(profileMigrationQueue).values(values).onConflictDoUpdate({ target: profileMigrationQueue.unitKey, set: values }).run();
        counts.queued++;
      }
    }

    // History: one `profileReplaced` per replaced file (per episode on series, like imports).
    const rows: Array<typeof history.$inferInsert> = [];
    for (const { row, unit, episodeIds } of replacedGroups.values()) {
      const file = unit.info.file;
      const profile = profiles.get(unit.profileId);
      const base = {
        eventType: 'profileReplaced' as const,
        sourceTitle: file.sceneName ?? file.relativePath,
        quality: file.quality,
        languages: file.languages,
        date: now,
        downloadId: null,
        data: compact({
          qualityProfileId: String(unit.profileId),
          qualityProfile: profile?.name ?? `#${unit.profileId}`,
          oldQuality: row.oldQualityName,
          oldPath: row.oldPath,
          path: file.path,
          fileId: String(file.id),
          reason: row.fileStatus,
          versionTag: unit.info.slot === '' ? undefined : unit.info.slot,
        }),
      };
      if (unit.info.item.mediaType === 'movie') {
        rows.push({ ...base, mediaType: 'movie', seriesId: null, episodeId: null, movieId: unit.info.item.id });
      } else {
        for (const episodeId of episodeIds.length > 0 ? episodeIds : [null]) {
          rows.push({ ...base, mediaType: 'series', seriesId: unit.info.item.id, episodeId, movieId: null });
        }
      }
    }
    this.insertHistory(tx, rows);
    return counts;
  }

  private freshRow(unit: Unit, now: string) {
    return {
      qualityProfileId: unit.profileId,
      mediaFileId: unit.info.file.id,
      fileStatus: unit.status,
      oldQualityName: unit.info.file.quality.quality.name,
      oldPath: unit.info.file.path,
      state: 'queued' as const,
      attempts: 0,
      lastSearchedAt: null,
      nextSearchAt: null,
      grabbedAt: null,
      finishedAt: null,
      message: null,
      updatedAt: now,
    };
  }

  private requestCounts(tx: DbOrTx): Map<string, number> {
    const rows = tx
      .select({ type: mediaRequests.type, tmdbId: mediaRequests.tmdbId, n: sql<number>`count(*)` })
      .from(mediaRequests)
      .groupBy(mediaRequests.type, mediaRequests.tmdbId)
      .all();
    return new Map(rows.map((r) => [`${r.type}:${r.tmdbId}`, Number(r.n)]));
  }

  private insertHistory(tx: DbOrTx, rows: Array<typeof history.$inferInsert>): void {
    if (rows.length === 0) return;
    tx.insert(history).values(rows).run();
    this.bus?.publish({ type: 'history', action: 'added' });
  }

  private announce(): void {
    this.bus?.publish({ type: 'profileMigration', action: 'changed' });
  }

  // -------------------------------------------------------------------------------------
  // progress, lists

  progressAll(): ProfileMigrationProgress[] {
    return this.profiles.listQualityProfiles().map((p) => this.progressFor(p));
  }

  progress(qualityProfileId: number): ProfileMigrationProgress {
    return this.progressFor(this.requireProfile(qualityProfileId));
  }

  private progressFor(profile: QualityProfile): ProfileMigrationProgress {
    const fits = this.db
      .select({
        mediaType: profileFileFits.mediaType,
        seriesId: profileFileFits.seriesId,
        movieId: profileFileFits.movieId,
        status: profileFileFits.status,
        evaluatedAt: profileFileFits.evaluatedAt,
      })
      .from(profileFileFits)
      .where(eq(profileFileFits.qualityProfileId, profile.id))
      .all();
    const files = { meets: 0, upgradeAllowed: 0, notAllowed: 0 };
    const items = new Set<string>();
    const mismatched = new Set<string>();
    let evaluatedAt: string | null = null;
    for (const f of fits) {
      files[f.status]++;
      const key = f.mediaType === 'series' ? `s${f.seriesId}` : `m${f.movieId}`;
      items.add(key);
      if (f.status !== 'meets') mismatched.add(key);
      if (evaluatedAt === null || f.evaluatedAt > evaluatedAt) evaluatedAt = f.evaluatedAt;
    }
    const queue = this.db.select().from(profileMigrationQueue).where(eq(profileMigrationQueue.qualityProfileId, profile.id)).all();
    const counts: ProfileMigrationCounts = { remaining: 0, inProgress: 0, done: 0, failed: 0 };
    for (const row of queue) {
      if (row.state === 'queued') counts.remaining++;
      else if (row.state === 'grabbed') counts.inProgress++;
      else if (row.state === 'done') counts.done++;
      else counts.failed++;
    }
    return {
      qualityProfileId: profile.id,
      qualityProfileName: profile.name,
      settings: this.profileSettings(profile.id),
      items: items.size,
      mismatchedItems: mismatched.size,
      files,
      queue: counts,
      pendingSearches: groupRows(queue.filter((r) => r.state === 'queued')).length,
      evaluatedAt,
    };
  }

  /** Items with files that do not meet their profile (library badges). */
  itemStatuses(): ProfileItemStatus[] {
    const rows = this.db
      .select({ mediaType: profileFileFits.mediaType, seriesId: profileFileFits.seriesId, movieId: profileFileFits.movieId, status: profileFileFits.status })
      .from(profileFileFits)
      .where(inArray(profileFileFits.status, ['upgradeAllowed', 'notAllowed']))
      .all();
    const out = new Map<string, ProfileItemStatus>();
    for (const r of rows) {
      const id = r.mediaType === 'series' ? r.seriesId : r.movieId;
      if (id === null) continue;
      const key = `${r.mediaType}:${id}`;
      const entry = out.get(key) ?? { mediaType: r.mediaType, id, status: 'upgradeAllowed' as ProfileFileStatus, notAllowed: 0, upgradeAllowed: 0 };
      if (r.status === 'notAllowed') entry.notAllowed++;
      else entry.upgradeAllowed++;
      if (STATUS_RANK[r.status] > STATUS_RANK[entry.status]) entry.status = r.status;
      out.set(key, entry);
    }
    return [...out.values()];
  }

  /** Wanted -> Profile mismatch: one row per file, sorted by title. */
  mismatchPage(query: ProfileMismatchQuery): ProfileMismatchPage {
    const statuses = query.status && query.status.length > 0 ? query.status : (['notAllowed'] as ProfileFileStatus[]);
    const where: SQL[] = [inArray(profileFileFits.status, statuses)];
    if (query.mediaType) where.push(eq(profileFileFits.mediaType, query.mediaType));
    if (query.qualityProfileId !== undefined) where.push(eq(profileFileFits.qualityProfileId, query.qualityProfileId));
    const fits = this.db.select().from(profileFileFits).where(and(...where)).all();
    if (fits.length === 0) return { page: query.page, pageSize: query.pageSize, totalRecords: 0, records: [] };

    const view = loadLibrary(this.db, {
      seriesIds: [...new Set(fits.map((f) => f.seriesId).filter((id): id is number => id !== null))],
      movieIds: [...new Set(fits.map((f) => f.movieId).filter((id): id is number => id !== null))],
    });
    const byFile = new Map(view.files.map((f) => [f.file.id, f]));
    const profileNames = new Map(this.profiles.listQualityProfiles().map((p) => [p.id, p.name]));
    const rows = fits
      .map((fit) => ({ fit, info: byFile.get(fit.mediaFileId) }))
      .filter((r): r is { fit: ProfileFileFitRow; info: FileInfo } => r.info !== undefined)
      .map((r) => ({ ...r, firstEpisode: r.info.file.episodeIds.map((id) => view.episodes.get(id)).find((e) => e !== undefined) }))
      .sort(
        (a, b) =>
          a.info.item.sortTitle.localeCompare(b.info.item.sortTitle) ||
          (a.firstEpisode?.seasonNumber ?? 0) - (b.firstEpisode?.seasonNumber ?? 0) ||
          (a.firstEpisode?.episodeNumber ?? 0) - (b.firstEpisode?.episodeNumber ?? 0) ||
          a.fit.mediaFileId - b.fit.mediaFileId,
      );
    const start = (query.page - 1) * query.pageSize;
    const pageRows = rows.slice(start, start + query.pageSize);

    const queueByFile = new Map<number, ProfileMigrationQueueRow>();
    const fileIds = pageRows.map((r) => r.fit.mediaFileId);
    for (const chunk of chunks(fileIds)) {
      for (const q of this.db.select().from(profileMigrationQueue).where(inArray(profileMigrationQueue.mediaFileId, chunk)).all()) {
        if (q.state !== 'done' && !queueByFile.has(q.mediaFileId)) queueByFile.set(q.mediaFileId, q);
      }
    }

    const settings = this.getSettings();
    const schedule = queueByFile.size > 0 ? this.replacementSchedule(settings) : { jobOn: true, runs: new Map<number, Date | null>() };
    const records: ProfileMismatchRecord[] = pageRows.map(({ fit, info }) => {
      const eps = info.file.episodeIds.map((id) => view.episodes.get(id)).filter((e): e is EpisodeInfo => e !== undefined);
      const q = queueByFile.get(fit.mediaFileId);
      const monitored = info.item.monitored && info.slotEnabled && (fit.mediaType === 'movie' || eps.some((e) => e.monitored));
      const state = replacementState({
        queue: q ?? null,
        status: fit.status,
        monitored,
        rule: this.profileSettings(fit.qualityProfileId),
        enabled: settings.enabled && schedule.jobOn,
      });
      const nextSearchAt = state === 'scheduled' && q ? (schedule.runs.get(q.id) ?? null) : null;
      return {
        mediaFileId: fit.mediaFileId,
        mediaType: fit.mediaType,
        seriesId: fit.seriesId,
        movieId: fit.movieId,
        episodeIds: info.file.episodeIds,
        title: info.item.title,
        year: info.item.year || null,
        episodeLabel: eps.length > 0 ? eps.map((e) => `S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`).join('') : null,
        versionTag: fit.slot === '' ? null : fit.slot,
        qualityProfileId: fit.qualityProfileId,
        qualityProfileName: profileNames.get(fit.qualityProfileId) ?? `#${fit.qualityProfileId}`,
        quality: fit.qualityName,
        formatScore: fit.formatScore,
        status: fit.status,
        reasons: fit.reasons,
        migration: q ? { state: q.state, attempts: q.attempts, lastSearchedAt: q.lastSearchedAt, nextSearchAt: q.nextSearchAt, message: q.message } : null,
        replacement: { state, nextSearchAt: nextSearchAt ? nextSearchAt.toISOString() : null, maxAttempts: settings.maxAttempts },
      };
    });
    return { page: query.page, pageSize: query.pageSize, totalRecords: rows.length, records };
  }

  // -------------------------------------------------------------------------------------
  // bulk migration

  preview(request: ProfileMigrationRequest): ProfileMigrationPreview {
    return this.plan(request).preview;
  }

  apply(request: ProfileMigrationRequest): ProfileMigrationApplyResult {
    const plan = this.plan(request);
    const changedSeries = plan.changes.filter((c) => c.item.mediaType === 'series').map((c) => c.item.id);
    const changedMovies = plan.changes.filter((c) => c.item.mediaType === 'movie').map((c) => c.item.id);
    // Make sure every item has a snapshot first, so the change below is recorded as a change.
    this.reevaluate({ seriesIds: changedSeries, movieIds: changedMovies });
    for (const change of plan.changes) {
      const body = {
        ...(change.qualityProfileId !== change.item.qualityProfileId ? { qualityProfileId: change.qualityProfileId } : {}),
        ...(change.versions !== null ? { versions: change.versions } : {}),
      };
      if (change.item.mediaType === 'series') libraryService.updateSeries(this.db, change.item.id, body);
      else libraryService.updateMovie(this.db, change.item.id, body);
      this.bus?.publish({ type: 'library', action: 'updated', mediaType: change.item.mediaType, id: change.item.id });
    }
    if (plan.changes.length > 0) this.reevaluate({ seriesIds: changedSeries, movieIds: changedMovies });
    this.log?.info({ toProfileId: request.toProfileId, series: changedSeries.length, movies: changedMovies.length }, 'profile migration applied');
    return { preview: plan.preview, changedSeries, changedMovies };
  }

  private plan(request: ProfileMigrationRequest): {
    preview: ProfileMigrationPreview;
    changes: Array<{ item: ItemInfo; qualityProfileId: number; versions: MediaVersion[] | null }>;
  } {
    const target = this.requireProfile(request.toProfileId);
    const profiles = new Map(this.profiles.listQualityProfiles().map((p) => [p.id, p]));
    const formats = this.profiles.listCustomFormats();
    const sel = request.selection;
    const view = loadLibrary(this.db, this.candidateScope(sel));
    const definitions = new Map(this.profiles.listQualityDefinitions().map((d) => [d.qualityId, d]));
    const perMinute = cutoffBytesPerMinute(target, definitions);

    const filesByItem = new Map<string, FileInfo[]>();
    for (const f of view.files) {
      const key = itemKey(f.item.mediaType, f.item.id);
      filesByItem.set(key, [...(filesByItem.get(key) ?? []), f]);
    }

    const changes: Array<{ item: ItemInfo; qualityProfileId: number; versions: MediaVersion[] | null }> = [];
    const sample: ProfileMigrationPreviewItem[] = [];
    const files = { total: 0, meets: 0, upgradeAllowed: 0, notAllowed: 0 };
    let unchanged = 0;
    let withoutFiles = 0;
    let estimate = 0;
    let estimateKnown = false;
    const name = (id: number) => profiles.get(id)?.name ?? `#${id}`;

    for (const [key, item] of view.items) {
      if (!matchesSelection(item, sel)) continue;
      const next = applyChange(item, sel, target.id);
      if (next === 'skip') continue;
      if (next === 'unchanged') {
        unchanged++;
        continue;
      }
      changes.push({ item, ...next });
      const nextItem = { qualityProfileId: next.qualityProfileId, versions: next.versions ?? item.versions };
      const before = profileMap(item);
      const fromProfiles = [...new Set(Object.entries(profileMap(nextItem)).filter(([slot, id]) => before[slot] !== id).map(([slot]) => name(before[slot] ?? item.qualityProfileId)))];
      const own = (filesByItem.get(key) ?? []).filter((f) => profileForSlot(nextItem, f.slot) !== profileForSlot(item, f.slot));
      let worst: ProfileFileStatus | null = null;
      for (const f of own) {
        const fit = fileFit(target, f.file.quality, fileFormatScore(target, formats, f.file));
        files.total++;
        files[fit.status]++;
        if (worst === null || STATUS_RANK[fit.status] > STATUS_RANK[worst]) worst = fit.status;
        if (fit.status !== 'meets' && perMinute !== null) {
          const runtime = runtimeOf(f, view.episodes);
          if (runtime > 0) {
            estimate += perMinute * runtime;
            estimateKnown = true;
          }
        }
      }
      if ((filesByItem.get(key) ?? []).length === 0) withoutFiles++;
      sample.push({ mediaType: item.mediaType, id: item.id, title: item.title, fromProfiles, files: own.length, status: worst });
    }

    sample.sort((a, b) => (b.status ? STATUS_RANK[b.status] + 1 : 0) - (a.status ? STATUS_RANK[a.status] + 1 : 0) || a.title.localeCompare(b.title));
    return {
      changes,
      preview: {
        toProfileId: target.id,
        toProfileName: target.name,
        mismatchAction: this.mismatchActionFor(target.id),
        items: changes.length,
        series: changes.filter((c) => c.item.mediaType === 'series').length,
        movies: changes.filter((c) => c.item.mediaType === 'movie').length,
        unchanged,
        itemsWithoutFiles: withoutFiles,
        files,
        needReplacing: files.notAllowed + files.upgradeAllowed,
        estimatedDownloadBytes: estimateKnown ? Math.round(estimate) : null,
        sample: sample.slice(0, SAMPLE_SIZE),
      },
    };
  }

  /** Narrow the library read when the selection names items. */
  private candidateScope(sel: ProfileMigrationSelection): LibraryScope | null {
    if (sel.seriesIds === undefined && sel.movieIds === undefined) return null;
    return { seriesIds: sel.mediaType === 'movie' ? [] : (sel.seriesIds ?? []), movieIds: sel.mediaType === 'series' ? [] : (sel.movieIds ?? []) };
  }

  // -------------------------------------------------------------------------------------
  // searching

  /** The scheduled job: a few searches per run within the daily budget, oldest/most requested first. */
  async runAutomatic(signal?: AbortSignal): Promise<string> {
    await this.flush();
    const settings = this.getSettings();
    this.reviveStaleGrabs();
    if (!settings.enabled) return 'automatic profile migration is off';
    const eligible = [...this.rules().values()].filter((r) => r.autoEnabled && !r.paused && r.mismatchAction !== 'none').map((r) => r.qualityProfileId);
    if (eligible.length === 0) return 'no profile has automatic migration on';
    const since = iso(new Date(this.now().getTime() - DAY_MS));
    const usedToday = this.db
      .select({ n: sql<number>`count(*)` })
      .from(profileMigrationSearches)
      .where(and(gte(profileMigrationSearches.at, since), eq(profileMigrationSearches.automatic, true)))
      .get();
    const budget = Math.min(settings.searchesPerRun, settings.maxSearchesPerDay - Number(usedToday?.n ?? 0));
    if (budget <= 0) return `daily search limit reached (${settings.maxSearchesPerDay})`;

    const now = iso(this.now());
    const due = this.db
      .select()
      .from(profileMigrationQueue)
      .where(
        and(
          eq(profileMigrationQueue.state, 'queued'),
          inArray(profileMigrationQueue.qualityProfileId, eligible),
          or(sql`${profileMigrationQueue.nextSearchAt} IS NULL`, lt(profileMigrationQueue.nextSearchAt, now)),
        ),
      )
      .orderBy(...QUEUE_ORDER)
      .all();
    const result = await this.searchGroups(groupRows(due), { budget, automatic: true, userInvoked: false, ...(signal ? { signal } : {}) });
    return `searched ${result.searched}, grabbed ${result.grabbed}${result.skipped ? `, skipped ${result.skipped}` : ''}`;
  }

  /**
   * Which upcoming ProfileMigration run searches each queued row (by row id; null when none in
   * the next two weeks). Replays runAutomatic: rows of profiles with automatic mode on, in
   * queue order, grouped per movie / season, `searchesPerRun` groups a run within the rolling
   * `maxSearchesPerDay`, rows waiting out `retryAfterHours` skipped until then. An estimate: it
   * assumes no search grabs anything and nothing new is queued. `jobOn` is false when the job
   * does not run on a schedule (on demand only, or switched off).
   */
  replacementSchedule(settings: ProfileMigrationSettings = this.getSettings()): { jobOn: boolean; runs: Map<number, Date | null> } {
    const runs = new Map<number, Date | null>();
    const job = this.scheduler?.jobSchedule(PROFILE_MIGRATION_JOB) ?? { cron: cronForInterval(settings.intervalMinutes), enabled: true };
    const jobOn = job.enabled && job.cron !== null;
    const eligible = [...this.rules().values()].filter((r) => r.autoEnabled && !r.paused && r.mismatchAction !== 'none').map((r) => r.qualityProfileId);
    if (!settings.enabled || !jobOn || job.cron === null || eligible.length === 0) return { jobOn, runs };

    const now = this.now();
    let remaining = this.db
      .select()
      .from(profileMigrationQueue)
      .where(and(eq(profileMigrationQueue.state, 'queued'), inArray(profileMigrationQueue.qualityProfileId, eligible)))
      .orderBy(...QUEUE_ORDER)
      .all();
    const used = this.db
      .select({ at: profileMigrationSearches.at })
      .from(profileMigrationSearches)
      .where(and(gte(profileMigrationSearches.at, iso(new Date(now.getTime() - DAY_MS))), eq(profileMigrationSearches.automatic, true)))
      .all()
      .map((r) => Date.parse(r.at));
    for (const run of upcomingRuns(job.cron, now)) {
      if (remaining.length === 0) break;
      const at = run.getTime();
      const inWindow = used.filter((t) => t > at - DAY_MS).length;
      const budget = Math.min(settings.searchesPerRun, settings.maxSearchesPerDay - inWindow);
      if (budget <= 0) continue;
      const due = remaining.filter((r) => r.nextSearchAt === null || Date.parse(r.nextSearchAt) < at);
      const taken = groupRows(due).slice(0, budget);
      if (taken.length === 0) continue;
      const done = new Set<number>();
      for (const group of taken) {
        used.push(at);
        for (const row of group.rows) {
          runs.set(row.id, run);
          done.add(row.id);
        }
      }
      remaining = remaining.filter((r) => !done.has(r.id));
    }
    for (const row of remaining) runs.set(row.id, null);
    return { jobOn, runs };
  }

  /** Searches "search all now" would start for a profile. */
  pendingSearches(qualityProfileId: number): number {
    return groupRows(this.queuedRows(qualityProfileId)).length;
  }

  /** Manual "search all now": every queued item of the profile, regardless of the schedule and limits. */
  searchAllNow(qualityProfileId: number): ProfileMigrationSearchResult {
    const profile = this.requireProfile(qualityProfileId);
    if (this.mismatchActionFor(profile.id) === 'none') {
      throw new ProfileMigrationError('VALIDATION', `profile "${profile.name}" has no replacement rule; choose one first`);
    }
    const groups = groupRows(this.queuedRows(qualityProfileId));
    if (groups.length === 0) return { searches: 0, job: null };
    const run = async (signal?: AbortSignal) => {
      const r = await this.searchGroups(groups, { budget: Number.MAX_SAFE_INTEGER, automatic: false, userInvoked: true, ...(signal ? { signal } : {}) });
      return `${profile.name}: searched ${r.searched}, grabbed ${r.grabbed}${r.skipped ? `, skipped ${r.skipped}` : ''}`;
    };
    if (!this.scheduler) {
      void run();
      return { searches: groups.length, job: null };
    }
    const started = this.scheduler.runTask(PROFILE_MIGRATION_SEARCH_JOB, 'manual', ({ signal }) => run(signal), {
      key: `${PROFILE_MIGRATION_SEARCH_JOB}:${qualityProfileId}`,
    });
    return { searches: groups.length, job: started.job };
  }

  /** Failed items of a profile go back on the work list. */
  retryFailed(qualityProfileId: number): ProfileMigrationProgress {
    this.requireProfile(qualityProfileId);
    this.db
      .update(profileMigrationQueue)
      .set({ state: 'queued', attempts: 0, nextSearchAt: null, message: null, updatedAt: iso(this.now()) })
      .where(and(eq(profileMigrationQueue.qualityProfileId, qualityProfileId), eq(profileMigrationQueue.state, 'failed')))
      .run();
    this.announce();
    return this.progress(qualityProfileId);
  }

  private queuedRows(qualityProfileId: number): ProfileMigrationQueueRow[] {
    return this.db
      .select()
      .from(profileMigrationQueue)
      .where(and(eq(profileMigrationQueue.qualityProfileId, qualityProfileId), eq(profileMigrationQueue.state, 'queued')))
      .orderBy(...QUEUE_ORDER)
      .all();
  }

  private async searchGroups(
    groups: readonly SearchGroup[],
    opts: { budget: number; automatic: boolean; userInvoked: boolean; signal?: AbortSignal },
  ): Promise<{ searched: number; grabbed: number; skipped: number }> {
    const out = { searched: 0, grabbed: 0, skipped: 0 };
    const search = this.ports.search;
    if (!search) {
      this.log?.warn('profile migration has no search port; nothing searched');
      return out;
    }
    const settings = this.getSettings();
    const media = getSection(this.db, 'mediaManagement');
    const freeCache = new Map<string, number | null>();
    for (const group of groups) {
      if (out.searched >= opts.budget || opts.signal?.aborted) break;
      const now = iso(this.now());
      const active = this.activeDownloads();
      if (isActive(group, active)) {
        out.skipped++;
        continue;
      }
      // Disk space: do not search when the item's root folder is below the minimum free space.
      const root = this.rootFolderOf(group);
      if (root && !media.skipFreeSpaceCheck) {
        if (!freeCache.has(root)) freeCache.set(root, await (this.ports.freeSpace ?? freeSpaceAt)(root).catch(() => null));
        const free = freeCache.get(root) ?? null;
        if (free !== null && free < media.minimumFreeSpaceMb * MB) {
          this.setRows(group.rows, { message: `not enough free space in ${root}`, updatedAt: now });
          out.skipped++;
          continue;
        }
      }

      out.searched++;
      this.db.insert(profileMigrationSearches).values({ at: now, qualityProfileId: group.profileId, automatic: opts.automatic }).run();
      let grabbed = 0;
      let error: string | null = null;
      try {
        grabbed = (await search(group.target, { userInvoked: opts.userInvoked, ...(opts.signal ? { signal: opts.signal } : {}) })).grabbed.length;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        this.log?.warn({ err, target: group.target }, 'profile migration search failed');
      }
      out.grabbed += grabbed;
      const after = this.activeDownloads();
      const done = iso(this.now());
      for (const row of group.rows) {
        const attempts = row.attempts + 1;
        const downloading = row.movieId !== null ? after.movieIds.has(row.movieId) : row.episodeId !== null && after.episodeIds.has(row.episodeId);
        if (grabbed > 0 && downloading) {
          this.setRows([row], { state: 'grabbed', attempts, lastSearchedAt: done, grabbedAt: done, nextSearchAt: null, message: null, updatedAt: done });
        } else if (attempts >= settings.maxAttempts) {
          this.setRows([row], { state: 'failed', attempts, lastSearchedAt: done, nextSearchAt: null, message: error ?? 'no release found that fits the profile', updatedAt: done });
        } else {
          this.setRows([row], {
            attempts,
            lastSearchedAt: done,
            nextSearchAt: iso(new Date(this.now().getTime() + settings.retryAfterHours * HOUR_MS)),
            message: error ?? 'no suitable release found yet',
            updatedAt: done,
          });
        }
      }
      this.announce();
    }
    this.pruneSearchLog();
    return out;
  }

  private setRows(rows: readonly ProfileMigrationQueueRow[], set: Partial<typeof profileMigrationQueue.$inferInsert>): void {
    const ids = rows.map((r) => r.id);
    for (const chunk of chunks(ids)) this.db.update(profileMigrationQueue).set(set).where(inArray(profileMigrationQueue.id, chunk)).run();
  }

  private activeDownloads(): { movieIds: Set<number>; episodeIds: Set<number> } {
    if (this.ports.activeDownloads) return this.ports.activeDownloads();
    const rows = this.db
      .select({ movieId: trackedDownloads.movieId, episodeIds: trackedDownloads.episodeIds })
      .from(trackedDownloads)
      .where(inArray(trackedDownloads.state, [...ACTIVE_DOWNLOAD_STATES]))
      .all();
    const movieIds = new Set<number>();
    const episodeIds = new Set<number>();
    for (const r of rows) {
      if (r.movieId !== null) movieIds.add(r.movieId);
      for (const id of r.episodeIds ?? []) episodeIds.add(id);
    }
    return { movieIds, episodeIds };
  }

  private rootFolderOf(group: SearchGroup): string | null {
    const view = loadLibrary(this.db, group.item.mediaType === 'series' ? { seriesIds: [group.item.id], movieIds: [] } : { seriesIds: [], movieIds: [group.item.id] });
    return view.items.get(itemKey(group.item.mediaType, group.item.id))?.rootFolderPath ?? null;
  }

  /** Grabs whose download left the queue without a replacement go back to `queued`. */
  private reviveStaleGrabs(): void {
    const cutoff = iso(new Date(this.now().getTime() - GRAB_STALE_MS));
    const stale = this.db
      .select()
      .from(profileMigrationQueue)
      .where(and(eq(profileMigrationQueue.state, 'grabbed'), lt(profileMigrationQueue.grabbedAt, cutoff)))
      .all();
    if (stale.length === 0) return;
    const active = this.activeDownloads();
    const settings = this.getSettings();
    const now = iso(this.now());
    for (const row of stale) {
      const downloading = row.movieId !== null ? active.movieIds.has(row.movieId) : row.episodeId !== null && active.episodeIds.has(row.episodeId);
      if (downloading) continue;
      const failed = row.attempts >= settings.maxAttempts;
      this.setRows([row], {
        state: failed ? 'failed' : 'queued',
        grabbedAt: null,
        message: 'the grabbed download did not replace the file',
        updatedAt: now,
      });
    }
    this.announce();
  }

  private pruneSearchLog(): void {
    const cutoff = iso(new Date(this.now().getTime() - 2 * DAY_MS));
    this.db.delete(profileMigrationSearches).where(lt(profileMigrationSearches.at, cutoff)).run();
  }

  /** Nightly: full re-evaluation, old `done` rows and the search log pruned. */
  housekeeping(): string {
    const summary = this.reevaluate('all');
    const cutoff = iso(new Date(this.now().getTime() - DONE_RETENTION_DAYS * DAY_MS));
    const pruned = this.db
      .delete(profileMigrationQueue)
      .where(and(eq(profileMigrationQueue.state, 'done'), lt(profileMigrationQueue.finishedAt, cutoff)))
      .run().changes;
    this.pruneSearchLog();
    return `evaluated ${summary.files} files (${summary.changedFits} changed), ${summary.queued} queued, ${summary.replaced} replaced, pruned ${pruned}`;
  }

  /** Run a full re-evaluation as a visible job. */
  reevaluateAsJob(): Job | null {
    if (!this.scheduler) {
      this.reevaluate('all');
      return null;
    }
    return this.scheduler.runTask(PROFILE_FIT_REFRESH_JOB, 'manual', async () => {
      const s = this.reevaluate('all');
      return `evaluated ${s.files} files (${s.changedFits} changed), ${s.queued} queued, ${s.replaced} replaced`;
    }).job;
  }
}

// ---------------------------------------------------------------------------------------
// helpers

const QUEUE_ORDER = [
  sql`${profileMigrationQueue.requests} DESC`,
  asc(profileMigrationQueue.itemAdded),
  asc(profileMigrationQueue.seriesId),
  asc(profileMigrationQueue.seasonNumber),
  asc(profileMigrationQueue.id),
];

/** Rows become searches: one per movie, one per series season (the same as the Wanted searches). */
function groupRows(rows: readonly ProfileMigrationQueueRow[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const row of rows) {
    if (row.movieId !== null) {
      const key = `m${row.movieId}`;
      const g = groups.get(key) ?? { profileId: row.qualityProfileId, item: { mediaType: 'movie', id: row.movieId }, target: { movieId: row.movieId }, rows: [] };
      g.rows.push(row);
      groups.set(key, g);
      continue;
    }
    if (row.seriesId === null || row.episodeId === null) continue;
    const key = `s${row.seriesId}:${row.seasonNumber ?? 0}`;
    const g = groups.get(key) ?? {
      profileId: row.qualityProfileId,
      item: { mediaType: 'series' as const, id: row.seriesId },
      target: { seriesId: row.seriesId, episodeIds: [] as number[] },
      rows: [],
    };
    g.rows.push(row);
    if ('episodeIds' in g.target && !g.target.episodeIds.includes(row.episodeId)) g.target.episodeIds.push(row.episodeId);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Will a mismatched file be replaced (see ProfileReplacementState)? `queue` is its open
 * work-list row, `rule` its profile's migration settings, `enabled` whether automatic
 * migration runs at all (global switch and job schedule).
 */
export function replacementState(input: {
  queue: Pick<ProfileMigrationQueueRow, 'state'> | null;
  status: ProfileFileStatus;
  monitored: boolean;
  rule: Pick<ProfileMigrationProfileSettings, 'mismatchAction' | 'autoEnabled' | 'paused'>;
  enabled: boolean;
}): ProfileReplacementState {
  const { queue, rule } = input;
  if (queue) {
    if (queue.state === 'grabbed') return 'downloading';
    if (queue.state === 'failed') return 'failed';
    if (!input.enabled) return 'globalOff';
    if (!rule.autoEnabled) return 'manualOnly';
    if (rule.paused) return 'paused';
    return 'scheduled';
  }
  if (!input.monitored) return 'unmonitored';
  if (rule.mismatchAction === 'none') return input.status === 'upgradeAllowed' ? 'cutoffSearch' : 'noRule';
  // A rule but no work-list row yet: the next re-evaluation (moments away) queues it.
  if (!input.enabled) return 'globalOff';
  if (!rule.autoEnabled) return 'manualOnly';
  if (rule.paused) return 'paused';
  return 'scheduled';
}

function isActive(group: SearchGroup, active: { movieIds: Set<number>; episodeIds: Set<number> }): boolean {
  if ('movieId' in group.target) return active.movieIds.has(group.target.movieId);
  return group.target.episodeIds.some((id) => active.episodeIds.has(id));
}

function matchesSelection(item: ItemInfo, sel: ProfileMigrationSelection): boolean {
  if (sel.mediaType && item.mediaType !== sel.mediaType) return false;
  if (sel.seriesIds !== undefined || sel.movieIds !== undefined) {
    const ids = item.mediaType === 'series' ? sel.seriesIds : sel.movieIds;
    if (!ids || !ids.includes(item.id)) return false;
  }
  if (sel.fromProfileId !== undefined && !Object.values(profileMap(item)).includes(sel.fromProfileId)) return false;
  if (sel.rootFolderPath !== undefined && trimSlash(item.rootFolderPath) !== trimSlash(sel.rootFolderPath)) return false;
  if (sel.tagIds && sel.tagIds.length > 0 && !sel.tagIds.some((t) => item.tags.includes(t))) return false;
  return true;
}

/**
 * The item's new profile settings under the selection. A version tag changes only that slot;
 * on a versioned item a `fromProfileId` changes the slots (and item profile) using it;
 * otherwise the item's own profile changes.
 */
function applyChange(
  item: ItemInfo,
  sel: ProfileMigrationSelection,
  to: number,
): 'skip' | 'unchanged' | { qualityProfileId: number; versions: MediaVersion[] | null } {
  const versions = item.versions ?? [];
  if (sel.versionTag !== undefined) {
    const i = versions.findIndex((v) => v.tag.toLowerCase() === sel.versionTag!.toLowerCase());
    if (i < 0) return 'skip';
    if (versions[i]!.qualityProfileId === to) return 'unchanged';
    if (sel.fromProfileId !== undefined && versions[i]!.qualityProfileId !== sel.fromProfileId) return 'skip';
    const next = versions.map((v, j) => (j === i ? { ...v, qualityProfileId: to } : v));
    return { qualityProfileId: item.qualityProfileId, versions: next };
  }
  if (versions.length > 0 && sel.fromProfileId !== undefined) {
    const from = sel.fromProfileId;
    const next = versions.map((v) => (v.qualityProfileId === from ? { ...v, qualityProfileId: to } : v));
    const changedSlots = next.some((v, j) => v.qualityProfileId !== versions[j]!.qualityProfileId);
    const itemProfile = item.qualityProfileId === from ? to : item.qualityProfileId;
    if (!changedSlots && itemProfile === item.qualityProfileId) return 'unchanged';
    return { qualityProfileId: itemProfile, versions: changedSlots ? next : null };
  }
  if (item.qualityProfileId === to) return 'unchanged';
  return { qualityProfileId: to, versions: null };
}

/** Bytes per minute of runtime at the profile's cutoff quality (preferred, else max, else min size). */
function cutoffBytesPerMinute(profile: QualityProfile, definitions: Map<number, QualityDefinitionItem>): number | null {
  const item = findItem(profile, effectiveCutoff(profile));
  const ids = item ? itemQualityIds(item) : [profile.cutoff];
  let best: number | null = null;
  for (const id of ids) {
    const d = definitions.get(id);
    const mb = d ? (d.preferredSize ?? d.maxSize ?? d.minSize ?? null) : null;
    if (mb !== null && mb > 0 && (best === null || mb > best)) best = mb;
  }
  return best === null ? null : best * MB;
}

function runtimeOf(f: FileInfo, episodes: Map<number, EpisodeInfo>): number {
  if (f.item.mediaType === 'movie') return f.item.runtimeMinutes ?? 0;
  let total = 0;
  for (const id of f.file.episodeIds) total += episodes.get(id)?.runtimeMinutes ?? f.item.runtimeMinutes ?? 0;
  return total;
}

function scopeCondition(
  scope: LibraryScope | null,
  seriesCol: typeof profileFileFits.seriesId | typeof profileMigrationQueue.seriesId,
  movieCol: typeof profileFileFits.movieId | typeof profileMigrationQueue.movieId,
): SQL[] | undefined {
  if (scope === null) return undefined;
  const out: SQL[] = [];
  for (const chunk of chunks(scope.seriesIds ?? [])) out.push(inArray(seriesCol, chunk));
  for (const chunk of chunks(scope.movieIds ?? [])) out.push(inArray(movieCol, chunk));
  return out;
}

function sameFit(row: ProfileFileFitRow, next: typeof profileFileFits.$inferInsert): boolean {
  return (
    row.status === next.status &&
    row.qualityProfileId === next.qualityProfileId &&
    row.formatScore === next.formatScore &&
    row.slot === (next.slot ?? '') &&
    row.qualityName === next.qualityName &&
    JSON.stringify(row.reasons) === JSON.stringify(next.reasons satisfies ProfileFileStatusReason[])
  );
}

function sameProfiles(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function compact(data: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out;
}

function chunks<T>(values: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '');

/** Cron for "every N minutes" (approximate when N does not divide the hour/day). */
export function cronForInterval(minutes: number): string {
  if (minutes < 60) return `*/${Math.max(1, minutes)} * * * *`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return hours >= 24 ? '0 3 * * *' : `0 */${hours} * * *`;
}

/** Free bytes on the volume holding `path`, walking up to the nearest existing folder. */
export async function freeSpaceAt(path: string): Promise<number | null> {
  let current = path;
  for (;;) {
    try {
      const s = await statfs(current);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}
