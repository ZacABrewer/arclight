import { asc, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { NotificationEvent } from '@arclight/notifications';
import { validateCustomFormat } from '@arclight/profiles-engine';
import type {
  GuideProfileInfo,
  GuidesApplyResult,
  GuidesDiff,
  GuidesDiffItem,
  GuidesSettings,
  GuidesStatus,
  GuidesSyncResult,
  ProfileFormatItem,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { customFormats, qualityProfiles } from '../../db/schema.js';
import type { FeedStatusReport } from '../../feeds.js';
import { getSection, setSection } from '../settings/service.js';
import { buildDiff, revisionOf, type GuideData, type LocalState } from './diff.js';
import { parseGuideFormat, parseGuideProfile, type GuideProfile } from './parse.js';
import { guidesState } from './schema.js';
import { fetchGuide, GuideRepository, type FetchedGuide, type FetchLike } from './source.js';

// Guides sync: fetch the guide, diff it against local custom formats and profile scores,
// then apply (mode `apply`) or keep the diff pending and notify (mode `notify`). A sync never
// deletes a format and never touches a format without a guideId unless the user explicitly
// applies its `adoptFormat` item.

export class GuidesError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'UPSTREAM',
    message: string,
  ) {
    super(message);
    this.name = 'GuidesError';
  }
}

export interface GuidesServiceOptions {
  db: Db;
  log?: Logger;
  fetch?: FetchLike;
  /** Delivers notifications (the notifications module's dispatch). */
  notify?: (event: NotificationEvent) => Promise<unknown>;
  now?: () => Date;
}

type StateRow = typeof guidesState.$inferSelect;
type FormatItem = Exclude<GuidesDiffItem, { kind: 'setScore' }>;

const STATE_ID = 1;

export class GuidesService {
  private readonly db: Db;
  private readonly now: () => Date;
  private running: Promise<GuidesSyncResult> | undefined;
  /** Profiles the guide offered at the last fetch (served by GET /guides/profiles). */
  private guideProfiles: GuideProfile[] | undefined;

  constructor(private readonly opts: GuidesServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- settings -------------------------------------------------------------------------

  settings(): GuidesSettings {
    return getSection(this.db, 'guides');
  }

  updateSettings(value: GuidesSettings): GuidesSettings {
    return setSection(this.db, 'guides', value, this.now().toISOString());
  }

  // ---- state ----------------------------------------------------------------------------

  private state(): StateRow {
    const row = this.db.select().from(guidesState).where(eq(guidesState.id, STATE_ID)).get();
    if (row) return row;
    return this.db.insert(guidesState).values({ id: STATE_ID }).returning().get();
  }

  private patchState(patch: Partial<Omit<StateRow, 'id'>>): void {
    this.state();
    this.db.update(guidesState).set(patch).where(eq(guidesState.id, STATE_ID)).run();
  }

  status(): GuidesStatus {
    const s = this.settings();
    const st = this.state();
    const synced = this.db.select({ id: customFormats.id }).from(customFormats).where(isNotNull(customFormats.guideId)).all().length;
    return {
      enabled: s.enabled,
      mode: s.mode,
      source: s.source,
      repoUrl: s.repoUrl,
      branch: s.branch,
      syncIntervalHours: s.syncIntervalHours,
      lastSyncAt: st.lastSyncAt,
      lastSuccessAt: st.lastSuccessAt,
      lastError: st.lastError,
      lastAppliedAt: st.lastAppliedAt,
      pendingCount: st.pendingDiff?.items.length ?? 0,
      pendingSince: st.pendingSince,
      lastFetch: st.lastFetch ?? null,
      syncedFormats: synced,
    };
  }

  /** Report for the feeds registry. */
  feedStatus(): FeedStatusReport {
    const s = this.settings();
    const st = this.state();
    return {
      enabled: s.enabled,
      intervalMs: s.syncIntervalHours * 3_600_000,
      lastSyncAt: st.lastSyncAt,
      lastSuccessAt: st.lastSuccessAt,
      lastError: st.lastError,
      pending: st.pendingDiff?.items.length ?? 0,
      detail: `${this.status().syncedFormats} synced formats, mode ${s.mode}`,
    };
  }

  /** The stored pending diff (empty when nothing is pending). */
  pendingDiff(): GuidesDiff {
    return (
      this.state().pendingDiff ?? { generatedAt: this.now().toISOString(), revision: revisionOf([]), items: [], staleFormats: [], warnings: [] }
    );
  }

  // ---- fetching -------------------------------------------------------------------------

  private repository(settings: GuidesSettings, signal?: AbortSignal): GuideRepository {
    return new GuideRepository({
      db: this.db,
      settings,
      now: this.now,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Parse fetched files; unusable files become warnings. */
  static parse(fetched: FetchedGuide): GuideData {
    const data: GuideData = { formats: [], profiles: [], warnings: [...fetched.warnings] };
    for (const f of fetched.formats) {
      const r = parseGuideFormat(f.data, f.app, f.path);
      if (typeof r === 'string') data.warnings.push(r);
      else data.formats.push(r);
    }
    for (const p of fetched.profiles) {
      const r = parseGuideProfile(p.data, p.app, p.path);
      if (typeof r === 'string') data.warnings.push(r);
      else data.profiles.push(r);
    }
    return data;
  }

  private local(): LocalState {
    return {
      formats: this.db.select().from(customFormats).orderBy(asc(customFormats.id)).all(),
      profiles: this.db.select().from(qualityProfiles).orderBy(asc(qualityProfiles.id)).all(),
    };
  }

  /** What the guide offers. Uses the last sync's data; fetches only the profile files when there is none. */
  async profiles(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<GuideProfileInfo[]> {
    const settings = this.settings();
    if (!this.guideProfiles || opts.refresh) {
      const repo = this.repository(settings, opts.signal);
      let fetched: FetchedGuide;
      try {
        fetched = await fetchGuide(repo, settings.apps, { profilesOnly: true });
      } catch (err) {
        throw new GuidesError('UPSTREAM', `could not read the guide: ${errorMessage(err)}`);
      }
      this.guideProfiles = GuidesService.parse(fetched).profiles;
    }
    return this.guideProfiles.map((p) => {
      const mapping = settings.profiles.find(
        (m) => m.guideProfileName.toLowerCase() === p.name.toLowerCase() && (m.app === undefined || m.app === p.app),
      );
      return {
        app: p.app,
        trashId: p.trashId,
        name: p.name,
        description: p.description,
        scoreSet: p.scoreSet,
        formats: p.formatItems,
        mappedTo: mapping?.localQualityProfileId ?? null,
      };
    });
  }

  // ---- sync -----------------------------------------------------------------------------

  /** Fetch, diff, then apply or store pending. Concurrent calls share one run. */
  sync(opts: { signal?: AbortSignal } = {}): Promise<GuidesSyncResult> {
    if (this.running) return this.running;
    const run = this.runSync(opts.signal).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async runSync(signal?: AbortSignal): Promise<GuidesSyncResult> {
    const settings = this.settings();
    const startedAt = this.now().toISOString();
    const repo = this.repository(settings, signal);
    let guide: GuideData;
    try {
      guide = GuidesService.parse(await fetchGuide(repo, settings.apps));
    } catch (err) {
      const message = errorMessage(err);
      this.patchState({ lastSyncAt: startedAt, lastError: message, lastFetch: { ...repo.stats } });
      this.opts.log?.warn({ err }, 'guides sync failed');
      throw new GuidesError('UPSTREAM', `guides sync failed: ${message}`);
    }
    this.guideProfiles = guide.profiles;

    const diff = buildDiff(guide, this.local(), settings, this.now());
    const previous = this.state();
    this.storePending(diff, previous);
    const applied: GuidesApplyResult | null = settings.mode === 'apply' ? this.apply() : null;
    this.patchState({ lastSyncAt: startedAt, lastSuccessAt: this.now().toISOString(), lastError: null, lastFetch: { ...repo.stats } });

    const pending = this.state().pendingDiff;
    const pendingCount = pending?.items.length ?? 0;
    await this.announce(pending, applied, previous.notifiedRevision);
    this.opts.log?.info(
      { changes: diff.items.length, applied: applied?.applied.length ?? 0, pending: pendingCount, fetch: repo.stats },
      'guides sync finished',
    );
    return { mode: settings.mode, changes: diff.items.length, applied, pendingCount, warnings: diff.warnings, fetch: { ...repo.stats } };
  }

  private storePending(diff: GuidesDiff, previous: StateRow): void {
    if (diff.items.length === 0) {
      this.patchState({ pendingDiff: diff.staleFormats.length || diff.warnings.length ? diff : null, pendingSince: null });
      return;
    }
    const since = previous.pendingDiff?.items.length ? (previous.pendingSince ?? diff.generatedAt) : diff.generatedAt;
    this.patchState({ pendingDiff: diff, pendingSince: since });
  }

  private async announce(pending: GuidesDiff | null, applied: GuidesApplyResult | null, notified: string | null): Promise<void> {
    if (!this.opts.notify) return;
    const pendingItems = pending?.items ?? [];
    const revision = pending && pendingItems.length ? pending.revision : revisionOf([]);
    let message: string | null = null;
    if (applied && applied.applied.length > 0) {
      message =
        `Guide sync applied ${applied.applied.length} change(s): ${applied.formatsCreated} format(s) created, ` +
        `${applied.formatsUpdated} updated, ${applied.scoresSet} score(s) set.` +
        (pendingItems.length ? ` ${pendingItems.length} change(s) need review (${summarize(pendingItems)}).` : '');
    } else if (pendingItems.length > 0 && revision !== notified) {
      message = `Guide sync found ${pendingItems.length} pending change(s) (${summarize(pendingItems)}). Review them under Settings → Guides.`;
    }
    if (!message) return;
    const event: NotificationEvent = {
      type: 'applicationUpdate',
      instanceName: 'Arclight',
      timestamp: this.now().toISOString(),
      previousVersion: `guides ${notified ?? 'none'}`,
      newVersion: `guides ${revision}`,
      message,
    };
    this.patchState({ notifiedRevision: revision });
    try {
      await this.opts.notify(event);
    } catch (err) {
      this.opts.log?.warn({ err }, 'guides notification failed');
    }
  }

  // ---- apply ----------------------------------------------------------------------------

  /**
   * Apply the pending diff, or the items with the given ids. Without ids every item except
   * `adoptFormat` is applied. Unapplied items stay pending. Idempotent: an item whose change
   * is already in place counts as applied without writing.
   */
  apply(ids?: readonly string[]): GuidesApplyResult {
    const pending = this.state().pendingDiff;
    const items = pending?.items ?? [];
    const result: GuidesApplyResult = { applied: [], skipped: [], formatsCreated: 0, formatsUpdated: 0, scoresSet: 0, pendingCount: 0 };
    const wanted = ids ? new Set(ids) : null;
    if (wanted) {
      for (const id of wanted) if (!items.some((i) => i.id === id)) result.skipped.push({ id, reason: 'not in the pending diff' });
    }
    const chosen = items.filter((i) => (wanted ? wanted.has(i.id) : i.kind !== 'adoptFormat'));
    const nowIso = this.now().toISOString();

    this.db.transaction((tx) => {
      for (const item of chosen) {
        if (item.kind === 'setScore') continue;
        const reason = this.applyFormat(tx as unknown as Db, item, result);
        if (reason) result.skipped.push({ id: item.id, reason });
        else result.applied.push(item.id);
      }
      const profiles = new Map<number, ProfileFormatItem[]>();
      for (const item of chosen) {
        if (item.kind !== 'setScore') continue;
        const format = tx.select({ id: customFormats.id }).from(customFormats).where(eq(customFormats.guideId, item.guideId)).get();
        if (!format) {
          result.skipped.push({ id: item.id, reason: `format "${item.formatName}" does not exist yet; apply format:${item.guideId} too` });
          continue;
        }
        let formatItems = profiles.get(item.profileId);
        if (!formatItems) {
          const profile = tx.select().from(qualityProfiles).where(eq(qualityProfiles.id, item.profileId)).get();
          if (!profile) {
            result.skipped.push({ id: item.id, reason: `quality profile ${item.profileId} no longer exists` });
            continue;
          }
          formatItems = profile.formatItems.map((f) => ({ ...f }));
          profiles.set(item.profileId, formatItems);
        }
        const entry = formatItems.find((f) => f.formatId === format.id);
        if (entry?.score === item.after) {
          result.applied.push(item.id);
          continue;
        }
        if (entry) entry.score = item.after;
        else formatItems.push({ formatId: format.id, score: item.after });
        result.scoresSet++;
        result.applied.push(item.id);
      }
      for (const [id, formatItems] of profiles) tx.update(qualityProfiles).set({ formatItems }).where(eq(qualityProfiles.id, id)).run();

      const appliedIds = new Set(result.applied);
      const remaining = items.filter((i) => !appliedIds.has(i.id));
      result.pendingCount = remaining.length;
      const nextPending: GuidesDiff | null = pending
        ? remaining.length || pending.staleFormats.length
          ? { ...pending, items: remaining, revision: revisionOf(remaining) }
          : null
        : null;
      tx.update(guidesState)
        .set({
          pendingDiff: nextPending,
          ...(remaining.length === 0 ? { pendingSince: null } : {}),
          ...(result.applied.length ? { lastAppliedAt: nowIso } : {}),
        })
        .where(eq(guidesState.id, STATE_ID))
        .run();
    });
    if (result.applied.length) this.opts.log?.info({ applied: result.applied.length, skipped: result.skipped.length }, 'guide changes applied');
    return result;
  }

  /** Returns a skip reason, or null when applied. */
  private applyFormat(tx: Db, item: FormatItem, result: GuidesApplyResult): string | null {
    const issues = validateCustomFormat(item.after);
    if (issues.length) return `invalid format: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`;
    const values = { name: item.after.name, includeWhenRenaming: item.after.includeWhenRenaming, specifications: item.after.specifications };
    const linked = tx.select().from(customFormats).where(eq(customFormats.guideId, item.guideId)).get();
    const nameHolder = tx.select().from(customFormats).where(eq(customFormats.name, item.after.name)).get();

    if (item.kind === 'adoptFormat') {
      if (linked) return `already linked to format ${linked.id}`;
      const target = item.formatId === null ? undefined : tx.select().from(customFormats).where(eq(customFormats.id, item.formatId)).get();
      if (!target) return `format ${item.formatId} no longer exists`;
      if (target.guideId !== null) return `format ${target.id} is already synced from ${target.guideId}`;
      if (nameHolder && nameHolder.id !== target.id) return `name "${item.after.name}" is taken by format ${nameHolder.id}`;
      tx.update(customFormats).set({ ...values, guideId: item.guideId }).where(eq(customFormats.id, target.id)).run();
      result.formatsUpdated++;
      return null;
    }

    // create and update both resolve by guideId, so applying twice is harmless.
    if (linked) {
      if (nameHolder && nameHolder.id !== linked.id) return `name "${item.after.name}" is taken by format ${nameHolder.id}`;
      const same =
        linked.name === values.name &&
        linked.includeWhenRenaming === values.includeWhenRenaming &&
        JSON.stringify(linked.specifications) === JSON.stringify(values.specifications);
      if (!same) {
        tx.update(customFormats).set(values).where(eq(customFormats.id, linked.id)).run();
        result.formatsUpdated++;
      }
      return null;
    }
    if (item.kind === 'updateFormat') return `format ${item.formatId} is no longer linked to the guide`;
    if (nameHolder) return `name "${item.after.name}" is taken by format ${nameHolder.id}`;
    tx.insert(customFormats).values({ ...values, guideId: item.guideId }).run();
    result.formatsCreated++;
    return null;
  }
}

function summarize(items: readonly GuidesDiffItem[]): string {
  const count = (k: GuidesDiffItem['kind']) => items.filter((i) => i.kind === k).length;
  const parts = [
    [count('createFormat'), 'new format(s)'],
    [count('updateFormat'), 'updated format(s)'],
    [count('adoptFormat'), 'format(s) to adopt'],
    [count('setScore'), 'score change(s)'],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
