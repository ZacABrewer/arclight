import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { ItemPrefs, PLAYED_THRESHOLD, RESUME_MIN, type PlayableKind, type PlaybackProgress, type ProgressReport, type ProgressUpdate } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { getSection } from '../settings/service.js';
import { mediaServerUsers, watchState } from '../watch-history/schema.js';
import { normaliseExternalId } from '../watch-history/store.js';
import { playbackPlays, playbackProgress, type PlaybackProgressRow } from './schema.js';

// Progress rules for the player (playback_progress), and the merge with linked media-server
// accounts. Pure parts (applyReport, mergeProgress) are exported for tests.
//
// - Reports carry the device's clock (`clientTime`); one older than the stored row is ignored,
//   so an offline queue that sends late cannot move a newer position back.
// - Reaching PLAYED_THRESHOLD marks the item played and counts one play (a playback_plays row);
//   it counts again only after the item was started over: a start/progress report under
//   RESUME_MIN on a played item clears `played`.

/** The stored fields the rules work on. */
export interface ProgressState {
  positionMs: number;
  durationMs: number;
  played: boolean;
  playCount: number;
  lastPlayedAt: string | null;
  updatedAt: string;
  favorite: boolean;
  prefs: ItemPrefs;
  deviceId: string | null;
}

export interface ReportOutcome {
  /** False when the report was older than the stored state. */
  accepted: boolean;
  next: ProgressState;
  /** This report finished a play-through. */
  completed: boolean;
}

/** Applies one report to the stored state at `nowMs`. */
export function applyReport(prev: ProgressState | null, report: ProgressReport, nowMs: number): ReportOutcome {
  const parsed = Date.parse(report.clientTime);
  const clientMs = Number.isFinite(parsed) ? Math.min(parsed, nowMs) : nowMs;
  if (prev && clientMs < Date.parse(prev.updatedAt)) return { accepted: false, next: prev, completed: false };
  const at = new Date(clientMs).toISOString();
  const durationMs = report.durationMs > 0 ? report.durationMs : (prev?.durationMs ?? 0);
  const positionMs = durationMs > 0 ? Math.min(report.positionMs, durationMs) : report.positionMs;
  const ratio = durationMs > 0 ? positionMs / durationMs : 0;
  let played = prev?.played ?? false;
  let playCount = prev?.playCount ?? 0;
  let completed = false;
  if (played && ratio < RESUME_MIN && (report.event === 'start' || report.event === 'progress')) played = false;
  else if (!played && ratio >= PLAYED_THRESHOLD) {
    played = true;
    playCount += 1;
    completed = true;
  }
  const prefs: ItemPrefs = { ...(prev?.prefs ?? {}) };
  if (report.speed !== undefined) prefs.speed = report.speed;
  return {
    accepted: true,
    completed,
    next: {
      positionMs,
      durationMs,
      played,
      playCount,
      lastPlayedAt: at,
      updatedAt: at,
      favorite: prev?.favorite ?? false,
      prefs,
      deviceId: report.deviceId,
    },
  };
}

/** A played row this much older than a newer unplayed one still wins (clock skew, end credits). */
export const PLAYED_WINS_WITHIN_MS = 5 * 60_000;

/**
 * Effective progress across Arclight's own row and linked media-server rows: the newest wins
 * (ties go to Arclight's row), except that a played row beats a newer unplayed one by less than
 * PLAYED_WINS_WITHIN_MS. The play count is the highest seen; favourite and prefs are
 * Arclight's own when it has a row.
 */
export function mergeProgress(own: PlaybackProgress | null, external: readonly PlaybackProgress[]): PlaybackProgress | null {
  const all = [...(own ? [own] : []), ...external];
  if (all.length === 0) return null;
  const time = (p: PlaybackProgress) => Date.parse(p.updatedAt) || 0;
  let winner = all[0]!;
  for (const p of all.slice(1)) if (time(p) > time(winner)) winner = p;
  if (!winner.played) {
    const played = all.filter((p) => p.played && time(winner) - time(p) < PLAYED_WINS_WITHIN_MS).sort((a, b) => time(b) - time(a))[0];
    if (played) winner = played;
  }
  const base = own ?? winner;
  const lastPlayed = all.map((p) => p.lastPlayedAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
  return {
    ...winner,
    playCount: Math.max(...all.map((p) => p.playCount)),
    lastPlayedAt: lastPlayed,
    favorite: base.favorite,
    prefs: base.prefs,
  };
}

function toProgress(row: PlaybackProgressRow): PlaybackProgress {
  return {
    itemKey: row.itemKey,
    positionMs: row.positionMs,
    durationMs: row.durationMs,
    played: row.played,
    playCount: row.playCount,
    lastPlayedAt: row.lastPlayedAt,
    updatedAt: row.updatedAt,
    favorite: row.favorite,
    prefs: row.prefs ?? {},
    source: 'arclight',
  };
}

function stateOf(row: PlaybackProgressRow): ProgressState {
  return {
    positionMs: row.positionMs,
    durationMs: row.durationMs,
    played: row.played,
    playCount: row.playCount,
    lastPlayedAt: row.lastPlayedAt,
    updatedAt: row.updatedAt,
    favorite: row.favorite,
    prefs: row.prefs ?? {},
    deviceId: row.deviceId,
  };
}

/** The user's linked media-server account (users.settings.mediaServerLink), if any. */
function linkOf(settings: unknown): { kind: 'jellyfin' | 'emby' | 'plex'; externalId: string } | null {
  const link = ((settings ?? {}) as Record<string, unknown>)['mediaServerLink'] as { kind?: unknown; externalId?: unknown } | undefined;
  if (!link || typeof link.externalId !== 'string') return null;
  if (link.kind !== 'jellyfin' && link.kind !== 'emby' && link.kind !== 'plex') return null;
  return { kind: link.kind, externalId: link.externalId };
}

export class ProgressStore {
  constructor(private readonly db: Db) {}

  private row(userId: number, key: string): PlaybackProgressRow | undefined {
    return this.db
      .select()
      .from(playbackProgress)
      .where(and(eq(playbackProgress.userId, userId), eq(playbackProgress.itemKey, key)))
      .get();
  }

  private write(userId: number, key: string, state: ProgressState): void {
    const values = { ...state, prefs: ItemPrefs.parse(state.prefs) };
    this.db
      .insert(playbackProgress)
      .values({ userId, itemKey: key, ...values })
      .onConflictDoUpdate({ target: [playbackProgress.userId, playbackProgress.itemKey], set: values })
      .run();
  }

  own(userId: number, key: string): PlaybackProgress | null {
    const row = this.row(userId, key);
    return row ? toProgress(row) : null;
  }

  /** Applies a report; returns the stored progress afterwards (unchanged when stale). */
  report(userId: number, key: string, report: ProgressReport, nowMs = Date.now()): { accepted: boolean; progress: PlaybackProgress } {
    const prev = this.row(userId, key);
    const outcome = applyReport(prev ? stateOf(prev) : null, report, nowMs);
    if (outcome.accepted) {
      this.db.transaction((tx) => {
        const values = { ...outcome.next, prefs: ItemPrefs.parse(outcome.next.prefs) };
        tx.insert(playbackProgress)
          .values({ userId, itemKey: key, ...values })
          .onConflictDoUpdate({ target: [playbackProgress.userId, playbackProgress.itemKey], set: values })
          .run();
        if (outcome.completed) {
          tx.insert(playbackPlays)
            .values({
              userId,
              itemKey: key,
              at: outcome.next.updatedAt,
              durationMs: outcome.next.durationMs,
              deviceId: report.deviceId,
              deviceName: report.deviceName ?? null,
              playMethod: report.playMethod ?? null,
            })
            .run();
        }
      });
    }
    return { accepted: outcome.accepted, progress: this.own(userId, key)! };
  }

  /**
   * PATCH: mark played/unplayed, favourite, prefs. Marking played counts a play. Only played /
   * unplayed moves `updatedAt` (it orders position reports): a favourite or a speed change made
   * mid-listen must not make the device's next reports look stale.
   */
  update(userId: number, key: string, patch: ProgressUpdate, nowMs = Date.now()): PlaybackProgress {
    const prev = this.row(userId, key);
    const now = new Date(nowMs).toISOString();
    // A row made by a prefs-only PATCH has no position yet: it is older than any report.
    const state: ProgressState = prev
      ? stateOf(prev)
      : { positionMs: 0, durationMs: 0, played: false, playCount: 0, lastPlayedAt: null, updatedAt: new Date(0).toISOString(), favorite: false, prefs: {}, deviceId: null };
    const movesPosition = patch.played !== undefined;
    if (patch.played === true && !state.played) {
      state.played = true;
      state.playCount += 1;
      state.positionMs = state.durationMs;
      state.lastPlayedAt = now;
    } else if (patch.played === false) {
      state.played = false;
      state.positionMs = 0;
    }
    if (patch.favorite !== undefined) state.favorite = patch.favorite;
    if (patch.prefs) state.prefs = { ...state.prefs, ...patch.prefs };
    // Newer than any report so far, but never ahead of the server clock.
    if (movesPosition) state.updatedAt = new Date(Math.max(nowMs, Date.parse(state.updatedAt) || 0)).toISOString();
    this.write(userId, key, state);
    return this.own(userId, key)!;
  }

  /** Linked media-server rows for `keys` (watch_state of the user's linked account). */
  external(userSettings: unknown, keys: readonly string[]): Map<string, PlaybackProgress[]> {
    const out = new Map<string, PlaybackProgress[]>();
    const link = linkOf(userSettings);
    if (!link || keys.length === 0) return out;
    const servers = getSection(this.db, 'mediaServers')
      .servers.filter((s) => s.kind === link.kind)
      .map((s) => s.id);
    if (servers.length === 0) return out;
    const accounts = this.db
      .select({ id: mediaServerUsers.id })
      .from(mediaServerUsers)
      .where(and(inArray(mediaServerUsers.serverId, servers), eq(mediaServerUsers.externalId, normaliseExternalId(link.externalId))))
      .all()
      .map((a) => a.id);
    if (accounts.length === 0) return out;
    const rows = this.db
      .select()
      .from(watchState)
      .where(and(inArray(watchState.mediaServerUserId, accounts), inArray(watchState.itemKey, [...keys])))
      .all();
    for (const r of rows) {
      const list = out.get(r.itemKey) ?? [];
      list.push({
        itemKey: r.itemKey,
        positionMs: r.positionMs,
        durationMs: r.durationMs ?? 0,
        played: r.played,
        playCount: r.playCount,
        lastPlayedAt: r.lastPlayedAt,
        updatedAt: r.updatedAt,
        favorite: r.favorite,
        prefs: {},
        source: link.kind,
      });
      out.set(r.itemKey, list);
    }
    return out;
  }

  /** Effective progress for `keys` (items without any row are left out). */
  effective(userId: number, userSettings: unknown, keys: readonly string[]): Map<string, PlaybackProgress> {
    const out = new Map<string, PlaybackProgress>();
    if (keys.length === 0) return out;
    const own = new Map(
      this.db
        .select()
        .from(playbackProgress)
        .where(and(eq(playbackProgress.userId, userId), inArray(playbackProgress.itemKey, [...keys])))
        .all()
        .map((r) => [r.itemKey, toProgress(r)]),
    );
    const ext = this.external(userSettings, keys);
    for (const key of keys) {
      const merged = mergeProgress(own.get(key) ?? null, ext.get(key) ?? []);
      if (merged) out.set(key, merged);
    }
    return out;
  }

  /** Unfinished items with something to resume, newest first. */
  inProgress(userId: number, limit: number, kind?: PlayableKind): PlaybackProgress[] {
    const rows = this.db
      .select()
      .from(playbackProgress)
      .where(
        and(
          eq(playbackProgress.userId, userId),
          eq(playbackProgress.played, false),
          isNotNull(playbackProgress.lastPlayedAt),
          sql`${playbackProgress.durationMs} > 0 AND ${playbackProgress.positionMs} >= ${playbackProgress.durationMs} * ${RESUME_MIN}`,
          kind ? sql`${playbackProgress.itemKey} LIKE ${`${kind}:%`}` : undefined,
        ),
      )
      .orderBy(desc(playbackProgress.lastPlayedAt))
      .limit(limit)
      .all();
    return rows.map(toProgress);
  }

  /** Item keys this user played most recently (any state), newest first. */
  recent(userId: number, limit: number, kind: PlayableKind, opts: { played?: boolean } = {}): PlaybackProgress[] {
    return this.db
      .select()
      .from(playbackProgress)
      .where(
        and(
          eq(playbackProgress.userId, userId),
          isNotNull(playbackProgress.lastPlayedAt),
          sql`${playbackProgress.itemKey} LIKE ${`${kind}:%`}`,
          opts.played === undefined ? undefined : eq(playbackProgress.played, opts.played),
        ),
      )
      .orderBy(desc(playbackProgress.lastPlayedAt))
      .limit(limit)
      .all()
      .map(toProgress);
  }
}
