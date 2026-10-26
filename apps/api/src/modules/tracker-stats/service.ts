import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { announceHosts, seedRulePending, type SeedRule, type SeedRuleProvider } from '@arclight/download-clients';
import type { AccountStats } from '@arclight/indexers';
import type { Session } from '@arclight/torrent-engine';
import {
  indexerFlagsFromVolumeFactors,
  TrackerAccountSettings,
  type HealthCheck,
  type Indexer,
  type ReleaseResource,
  type TrackerAccountSettingsInput,
  type TrackerRatioStatus,
  type TrackerStatsResource,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { trackedDownloads } from '../../db/schema.js';
import { trackerAccounts, trackerStats, type TrackerStatsRow } from './schema.js';

// Private-tracker helpers. Every engine torrent is attributed to an indexer (cross-seed
// records, then the grab snapshot of its tracked download, then its announce hosts), which
// gives per-tracker seeding totals, the hit-and-run rules the built-in client enforces, and
// a freeleech-only release filter for the decision engine. Account pages are scraped through
// the definition's optional `account` block.

export type TrackerStatsErrorCode = 'NOT_FOUND' | 'VALIDATION';

export class TrackerStatsError extends Error {
  override readonly name = 'TrackerStatsError';
  constructor(
    readonly code: TrackerStatsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the module needs from the indexers module (IndexersService satisfies it). */
export interface TrackerIndexersPort {
  list(): Array<Pick<Indexer, 'id' | 'name' | 'protocol'>>;
  siteHosts(id: number): string[];
  hasAccountPage(id: number): boolean;
  accountStats(id: number, signal?: AbortSignal): Promise<AccountStats>;
}

/** Maps an info-hash to the indexer it came from (e.g. the cross-seed module's records). */
export type InfoHashResolver = (infoHash: string) => number | undefined;

/** A decision-engine style rejection: `null` accepts the release. */
export interface ReleaseFilterResult {
  reason: string;
  message: string;
}

export interface TrackerStatsServiceOptions {
  db: Db;
  indexers: TrackerIndexersPort;
  /** The built-in engine's Session (null while stopped). */
  session?: () => Session | null;
  log?: Logger;
  now?: () => Date;
  /** How long the rule snapshot used by the H&R guard is reused. Default 10 s. */
  snapshotTtlMs?: number;
}

interface Snapshot {
  at: number;
  names: Map<number, string>;
  accounts: Map<number, TrackerAccountSettings>;
  hosts: Map<number, string[]>;
  tracked: Map<string, number>;
}

interface Totals {
  hosts: string[];
  torrents: number;
  seeding: number;
  uploaded: number;
  downloaded: number;
  seedingTimeMs: number;
  hnrPending: number;
}

/** Hosts compare without `www.`; a subdomain of a site host matches (tracker.site.org ~ site.org). */
export function hostMatches(announce: string, site: string): boolean {
  const a = announce.toLowerCase().replace(/^www\./, '');
  const b = site.toLowerCase().replace(/^www\./, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Freeleech: flagged by the indexer or a download volume factor of 0. */
export function isFreeleech(release: Pick<ReleaseResource, 'downloadVolumeFactor' | 'uploadVolumeFactor' | 'indexerFlags'>): boolean {
  if (release.indexerFlags?.includes('freeleech')) return true;
  return indexerFlagsFromVolumeFactors(release).includes('freeleech');
}

/** The account's hit-and-run rule as a `SeedRule`, null when it sets nothing. */
export function ruleOf(account: TrackerAccountSettings, label: string): SeedRule | null {
  const { minSeedHours, minRatio } = account.hnrRule;
  if (!account.enabled || (minSeedHours === undefined && minRatio === undefined)) return null;
  return { ...(minSeedHours !== undefined ? { minSeedHours } : {}), ...(minRatio !== undefined ? { minRatio } : {}), label };
}

export function ratioStatusOf(ratio: number | null, required: number | undefined): TrackerRatioStatus {
  if (ratio === null) return 'unknown';
  if (required === undefined) return 'ok';
  if (ratio < required) return 'low';
  if (ratio < required * 1.1) return 'warning';
  return 'ok';
}

export class TrackerStatsService {
  private readonly db: Db;
  private readonly indexers: TrackerIndexersPort;
  private readonly session: () => Session | null;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly snapshotTtlMs: number;
  private readonly resolvers = new Set<InfoHashResolver>();
  private snapshotValue: Snapshot | null = null;

  constructor(opts: TrackerStatsServiceOptions) {
    this.db = opts.db;
    this.indexers = opts.indexers;
    this.session = opts.session ?? (() => null);
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.snapshotTtlMs = opts.snapshotTtlMs ?? 10_000;
  }

  // ---- account settings ----------------------------------------------------------------

  private requireTorrentIndexer(id: number): Pick<Indexer, 'id' | 'name' | 'protocol'> {
    const indexer = this.indexers.list().find((i) => i.id === id);
    if (!indexer) throw new TrackerStatsError('NOT_FOUND', `indexer ${id} not found`);
    if (indexer.protocol !== 'torrent') throw new TrackerStatsError('VALIDATION', `${indexer.name} is not a torrent indexer`);
    return indexer;
  }

  /** The indexer's tracker account settings (defaults when never saved). */
  getAccount(indexerId: number): TrackerAccountSettings {
    this.requireTorrentIndexer(indexerId);
    return this.accountRow(indexerId) ?? TrackerAccountSettings.parse({});
  }

  private accountRow(indexerId: number): TrackerAccountSettings | undefined {
    const row = this.db.select().from(trackerAccounts).where(eq(trackerAccounts.indexerId, indexerId)).get();
    if (!row) return undefined;
    const parsed = TrackerAccountSettings.safeParse(row.settings);
    return parsed.success ? parsed.data : TrackerAccountSettings.parse({});
  }

  setAccount(indexerId: number, input: TrackerAccountSettingsInput): TrackerAccountSettings {
    this.requireTorrentIndexer(indexerId);
    const parsed = TrackerAccountSettings.safeParse(input);
    if (!parsed.success) throw new TrackerStatsError('VALIDATION', z.prettifyError(parsed.error));
    const settings = parsed.data;
    const updatedAt = this.now().toISOString();
    this.db
      .insert(trackerAccounts)
      .values({ indexerId, settings, updatedAt })
      .onConflictDoUpdate({ target: trackerAccounts.indexerId, set: { settings, updatedAt } })
      .run();
    this.invalidate();
    return settings;
  }

  /** Every saved account of an existing indexer. */
  accounts(): Map<number, TrackerAccountSettings> {
    return this.snapshot(true).accounts;
  }

  // ---- attribution -------------------------------------------------------------------------

  /** Add a resolver consulted first when attributing a torrent. Returns unsubscribe. */
  registerInfoHashResolver(resolver: InfoHashResolver): () => void {
    this.resolvers.add(resolver);
    this.invalidate();
    return () => {
      this.resolvers.delete(resolver);
      this.invalidate();
    };
  }

  /** Drop the cached snapshot (settings changed, a grab or cross-seed was recorded). */
  invalidate(): void {
    this.snapshotValue = null;
  }

  private snapshot(fresh = false): Snapshot {
    const nowMs = this.now().getTime();
    const cached = this.snapshotValue;
    if (!fresh && cached && nowMs - cached.at < this.snapshotTtlMs) return cached;
    const list = this.indexers.list().filter((i) => i.protocol === 'torrent');
    const names = new Map(list.map((i) => [i.id, i.name]));
    const accounts = new Map<number, TrackerAccountSettings>();
    for (const row of this.db.select().from(trackerAccounts).all()) {
      if (!names.has(row.indexerId)) continue;
      const parsed = TrackerAccountSettings.safeParse(row.settings);
      if (parsed.success) accounts.set(row.indexerId, parsed.data);
    }
    const hosts = new Map<number, string[]>();
    for (const i of list) {
      const account = accounts.get(i.id);
      let own: string[] = [];
      if (account && account.announceHosts.length > 0) own = account.announceHosts;
      else {
        try {
          own = this.indexers.siteHosts(i.id);
        } catch {
          own = [];
        }
      }
      hosts.set(i.id, own);
    }
    const tracked = new Map<string, number>();
    const rows = this.db
      .select({ downloadId: trackedDownloads.downloadId, grabbedRelease: trackedDownloads.grabbedRelease })
      .from(trackedDownloads)
      .where(eq(trackedDownloads.protocol, 'torrent'))
      .all();
    for (const r of rows) {
      const g = r.grabbedRelease;
      if (typeof g === 'object' && g !== null && 'indexerId' in g && typeof g.indexerId === 'number') {
        tracked.set(r.downloadId.toLowerCase(), g.indexerId);
      }
    }
    const snap: Snapshot = { at: nowMs, names, accounts, hosts, tracked };
    this.snapshotValue = snap;
    return snap;
  }

  /**
   * The indexer a torrent belongs to: a registered resolver (cross-seeds), the grab snapshot
   * of its tracked download, else the indexer whose (announce or site) hosts match one of its
   * announce hosts. Explicit `announceHosts` win over site hosts.
   */
  indexerForTorrent(infoHash: string, hosts: readonly string[], snap: Snapshot = this.snapshot()): number | undefined {
    const id = infoHash.toLowerCase();
    for (const resolve of this.resolvers) {
      const hit = resolve(id);
      if (hit !== undefined && snap.names.has(hit)) return hit;
    }
    const tracked = snap.tracked.get(id);
    if (tracked !== undefined && snap.names.has(tracked)) return tracked;
    if (hosts.length === 0) return undefined;
    // Explicit announce hosts are exact; site hosts also match subdomains.
    for (const [indexerId, account] of snap.accounts) {
      if (account.announceHosts.some((h) => hosts.includes(h))) return indexerId;
    }
    for (const [indexerId, own] of snap.hosts) {
      if (snap.accounts.get(indexerId)?.announceHosts.length) continue;
      if (own.some((site) => hosts.some((a) => hostMatches(a, site)))) return indexerId;
    }
    return undefined;
  }

  // ---- hooks for other modules ---------------------------------------------------------------

  /** Hit-and-run rules for the built-in client (attach with `TorrentService.setSeedRuleProvider`). */
  seedRuleProvider(): SeedRuleProvider {
    return (hosts, infoHash) => {
      const snap = this.snapshot();
      const indexerId = this.indexerForTorrent(infoHash, hosts, snap);
      if (indexerId === undefined) return null;
      const account = snap.accounts.get(indexerId);
      return account ? ruleOf(account, snap.names.get(indexerId) ?? `indexer ${indexerId}`) : null;
    };
  }

  /**
   * Decision-engine hook: rejects a release from an indexer in freeleech-only mode unless it
   * is freeleech. Null accepts. Cheap enough to call per release (cached snapshot).
   */
  releaseFilter(
    indexerId: number,
    release: Pick<ReleaseResource, 'downloadVolumeFactor' | 'uploadVolumeFactor' | 'indexerFlags'>,
  ): ReleaseFilterResult | null {
    const snap = this.snapshot();
    const account = snap.accounts.get(indexerId);
    if (!account?.enabled || !account.freeleechOnly || isFreeleech(release)) return null;
    const name = snap.names.get(indexerId) ?? `Indexer ${indexerId}`;
    return { reason: 'notFreeleech', message: `${name} is in freeleech-only mode and this release is not freeleech` };
  }

  // ---- sync ------------------------------------------------------------------------------------

  /** TrackerStatsSync: engine totals per tracker, then the account pages. Returns a summary. */
  async sync(signal?: AbortSignal): Promise<string> {
    const snap = this.snapshot(true);
    const at = this.now().toISOString();
    const totals = new Map<number, Totals>();
    const session = this.session();
    let attributed = 0;
    if (session) {
      for (const t of session.getTorrents()) {
        const hosts = announceHosts(t);
        const indexerId = this.indexerForTorrent(t.infoHashHex, hosts, snap);
        if (indexerId === undefined) continue;
        attributed++;
        const s = t.getStats();
        const sum = totals.get(indexerId) ?? { hosts: [], torrents: 0, seeding: 0, uploaded: 0, downloaded: 0, seedingTimeMs: 0, hnrPending: 0 };
        for (const h of hosts) if (!sum.hosts.includes(h)) sum.hosts.push(h);
        sum.torrents++;
        if (s.state === 'seeding') sum.seeding++;
        sum.uploaded += Math.round(s.uploaded);
        sum.downloaded += Math.round(s.downloaded);
        sum.seedingTimeMs += Math.round(s.seedingTimeMs);
        const account = snap.accounts.get(indexerId);
        const rule = account ? ruleOf(account, '') : null;
        if (rule && t.isComplete && seedRulePending(rule, s) !== null) sum.hnrPending++;
        totals.set(indexerId, sum);
      }
    }
    const existing = new Map(this.db.select().from(trackerStats).all().map((r) => [r.indexerId, r]));
    // Drop rows of deleted indexers.
    for (const id of existing.keys()) if (!snap.names.has(id)) this.db.delete(trackerStats).where(eq(trackerStats.indexerId, id)).run();
    const ids = new Set<number>([...totals.keys(), ...[...snap.accounts].filter(([, a]) => a.enabled).map(([id]) => id)]);
    for (const id of existing.keys()) if (snap.names.has(id)) ids.add(id);
    for (const id of ids) {
      const sum = totals.get(id);
      const engine = {
        hosts: sum?.hosts.length ? sum.hosts.sort() : (snap.hosts.get(id) ?? []),
        torrents: sum?.torrents ?? 0,
        seeding: sum?.seeding ?? 0,
        uploaded: sum?.uploaded ?? 0,
        downloaded: sum?.downloaded ?? 0,
        seedingTimeMs: sum?.seedingTimeMs ?? 0,
        hnrPending: sum?.hnrPending ?? 0,
        engineUpdatedAt: session ? at : (existing.get(id)?.engineUpdatedAt ?? null),
      };
      this.db
        .insert(trackerStats)
        .values({ indexerId: id, ...engine })
        .onConflictDoUpdate({ target: trackerStats.indexerId, set: engine })
        .run();
    }

    let scraped = 0;
    let failed = 0;
    for (const [id, account] of snap.accounts) {
      if (!account.enabled || !account.scrapeAccount) continue;
      let hasPage = false;
      try {
        hasPage = this.indexers.hasAccountPage(id);
      } catch {
        hasPage = false;
      }
      if (!hasPage) continue;
      if (signal?.aborted) break;
      try {
        const stats = await this.indexers.accountStats(id, signal);
        const set = {
          accountRatio: stats.ratio ?? null,
          accountUploaded: stats.uploaded === undefined ? null : Math.round(stats.uploaded),
          accountDownloaded: stats.downloaded === undefined ? null : Math.round(stats.downloaded),
          accountBuffer: stats.buffer === undefined ? null : Math.round(stats.buffer),
          accountHnrCount: stats.hnrCount ?? null,
          accountSeedBonus: stats.seedBonus ?? null,
          accountUpdatedAt: this.now().toISOString(),
          accountError: null,
        };
        this.db.update(trackerStats).set(set).where(eq(trackerStats.indexerId, id)).run();
        scraped++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        this.log?.warn({ err, indexerId: id }, 'tracker account page could not be read');
        this.db.update(trackerStats).set({ accountError: message }).where(eq(trackerStats.indexerId, id)).run();
      }
    }
    return `${ids.size} tracker(s), ${attributed} torrent(s) attributed, ${scraped} account page(s) read${failed ? `, ${failed} failed` : ''}`;
  }

  // ---- reading -----------------------------------------------------------------------------------

  /** Stats for every tracker with saved settings or gathered statistics. */
  list(): TrackerStatsResource[] {
    const snap = this.snapshot(true);
    const rows = new Map(this.db.select().from(trackerStats).all().map((r) => [r.indexerId, r]));
    const ids = [...new Set([...snap.accounts.keys(), ...rows.keys()])].filter((id) => snap.names.has(id)).sort((a, b) => a - b);
    return ids.map((id) => this.toResource(id, snap, rows.get(id)));
  }

  private toResource(id: number, snap: Snapshot, row: TrackerStatsRow | undefined): TrackerStatsResource {
    const account = snap.accounts.get(id) ?? TrackerAccountSettings.parse({});
    const uploaded = row?.uploaded ?? 0;
    const downloaded = row?.downloaded ?? 0;
    const accountRatio = row?.accountRatio ?? null;
    const ratio = accountRatio ?? (downloaded > 0 ? uploaded / downloaded : null);
    let buffer = row?.accountBuffer ?? null;
    const required = account.ratioRequired;
    if (buffer === null && account.bufferTracking && required !== undefined && required > 0) {
      const up = row?.accountUploaded ?? uploaded;
      const down = row?.accountDownloaded ?? downloaded;
      buffer = Math.round(up / required - down);
    }
    return {
      indexerId: id,
      indexerName: snap.names.get(id) ?? `Indexer ${id}`,
      account,
      hosts: row?.hosts?.length ? row.hosts : (snap.hosts.get(id) ?? []),
      torrents: row?.torrents ?? 0,
      seeding: row?.seeding ?? 0,
      uploaded,
      downloaded,
      seedingTimeMs: row?.seedingTimeMs ?? 0,
      hnrPending: row?.hnrPending ?? 0,
      engineUpdatedAt: row?.engineUpdatedAt ?? null,
      accountRatio,
      accountUploaded: row?.accountUploaded ?? null,
      accountDownloaded: row?.accountDownloaded ?? null,
      accountBuffer: row?.accountBuffer ?? null,
      accountHnrCount: row?.accountHnrCount ?? null,
      accountSeedBonus: row?.accountSeedBonus ?? null,
      accountUpdatedAt: row?.accountUpdatedAt ?? null,
      accountError: row?.accountError ?? null,
      buffer,
      ratio,
      ratioStatus: ratioStatusOf(ratio, required),
    };
  }

  /** Findings of the `TrackerRatioLow` health check (enabled accounts only). */
  healthFindings(): Array<Omit<HealthCheck, 'wikiUrl'>> {
    const out: Array<Omit<HealthCheck, 'wikiUrl'>> = [];
    const fmt = (n: number) => n.toFixed(2);
    for (const s of this.list()) {
      const a = s.account;
      if (!a.enabled) continue;
      const source = 'TrackerRatioLow';
      if (s.ratio !== null && a.ratioRequired !== undefined) {
        if (s.ratioStatus === 'low') {
          out.push({ source, status: 'error', message: `${s.indexerName}: ratio ${fmt(s.ratio)} is below the required ${fmt(a.ratioRequired)}` });
        } else if (s.ratioStatus === 'warning') {
          out.push({ source, status: 'warning', message: `${s.indexerName}: ratio ${fmt(s.ratio)} is close to the required ${fmt(a.ratioRequired)}` });
        }
      }
      if (a.bufferTracking && a.minBufferBytes !== undefined && s.buffer !== null && s.buffer < a.minBufferBytes) {
        const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
        out.push({ source, status: 'warning', message: `${s.indexerName}: upload buffer ${gib(s.buffer)} is below ${gib(a.minBufferBytes)}` });
      }
      if (s.accountHnrCount !== null && s.accountHnrCount > 0) {
        out.push({ source, status: 'warning', message: `${s.indexerName} reports ${s.accountHnrCount} hit-and-run(s) on your account` });
      }
    }
    return out;
  }
}
