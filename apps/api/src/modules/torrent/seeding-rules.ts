import { isAbsolute, relative, resolve } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { announceHosts, seedRulePending, type SeedRuleProvider } from '@arclight/download-clients';
import type { Session, Torrent } from '@arclight/torrent-engine';
import type { SeedingRule } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { downloadClients, history, movies, rootFolders, series, trackedDownloads } from '../../db/schema.js';

// Seeding rules for the built-in engine: per category / indexer / tracker, stop seeding at a
// ratio or after a seeding time, then pause or remove the torrent. Safety comes first:
//
// - a private tracker's hit-and-run requirement (the provider attached for the H&R guard)
//   holds back both actions until it is met;
// - only downloads Arclight has imported are removed (tracked download `imported`, or an
//   import in the history for the info-hash);
// - files are deleted only when the download folder copy cannot be library data: its path
//   must not overlap a root folder, a series or movie folder, or another torrent's data (a
//   cross-seed shares the files). Imports copy or hard-link while a torrent seeds, so the
//   library keeps its own copy; otherwise the torrent is removed and the files are kept.

/** What a rule matches against. */
export interface SeedingSubject {
  category: string;
  /** Lowercase announce host names. */
  hosts: readonly string[];
  indexerId?: number | undefined;
}

/** `host` is `pattern` or one of its subdomains. */
export function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\*?\./, '');
  return host === p || host.endsWith(`.${p}`);
}

/** The first enabled rule whose non-empty filters all match. */
export function matchSeedingRule(rules: readonly SeedingRule[], s: SeedingSubject): SeedingRule | null {
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.categories.length > 0 && !r.categories.includes(s.category)) continue;
    if (r.indexerIds.length > 0 && (s.indexerId === undefined || !r.indexerIds.includes(s.indexerId))) continue;
    if (r.trackers.length > 0 && !s.hosts.some((h) => r.trackers.some((p) => hostMatches(h, p)))) continue;
    return r;
  }
  return null;
}

/** The ratio or the seeding time is reached (either one when both are set). */
export function seedingRuleReached(rule: Pick<SeedingRule, 'ratio' | 'seedTimeMinutes'>, stats: { ratio: number; seedingTimeMs: number }): boolean {
  const ratio = rule.ratio !== null && stats.ratio >= rule.ratio;
  const time = rule.seedTimeMinutes !== null && stats.seedingTimeMs >= rule.seedTimeMinutes * 60_000;
  return ratio || time;
}

function normalize(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** a is b, or one contains the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return inside(x, y) || inside(y, x);
}

export interface SeedingRulesPorts {
  /** Imported by Arclight (so the download folder copy is no longer needed for an import). */
  imported(infoHash: string): boolean;
  /** Root folders and series/movie folders. */
  libraryPaths(): string[];
  /** Writes the action to the download's timeline (no-op when Arclight does not track it). */
  record(infoHash: string, type: 'paused' | 'removed', message: string, data: Record<string, string | number | boolean>): void;
}

export interface SeedingRulesDeps extends SeedingRulesPorts {
  session: Session;
  rules: readonly SeedingRule[];
  hitAndRun: SeedRuleProvider | null;
  indexerFor?: ((infoHash: string, hosts: readonly string[]) => number | undefined) | undefined;
}

export interface SeedingRulesResult {
  checked: number;
  paused: string[];
  removed: string[];
  /** Torrents a rule wanted to act on but that were held back, with the reason. */
  held: Array<{ infoHash: string; reason: string }>;
}

function ruleSummary(rule: SeedingRule, stats: { ratio: number; seedingTimeMs: number }): string {
  const days = stats.seedingTimeMs / 86_400_000;
  const seeded = days >= 1 ? `${days.toFixed(1)} d` : `${(stats.seedingTimeMs / 3_600_000).toFixed(1)} h`;
  return `seeding rule "${rule.name}" (ratio ${stats.ratio.toFixed(2)}, seeded ${seeded})`;
}

/** One pass over the engine's finished torrents. */
export async function applySeedingRules(deps: SeedingRulesDeps): Promise<SeedingRulesResult> {
  const result: SeedingRulesResult = { checked: 0, paused: [], removed: [], held: [] };
  if (deps.rules.every((r) => !r.enabled)) return result;
  const torrents = deps.session.getTorrents();
  let library: string[] | null = null;
  for (const t of torrents) {
    if (!t.isComplete || t.state === 'checking' || t.state === 'error') continue;
    result.checked++;
    const hosts = announceHosts(t);
    const rule = matchSeedingRule(deps.rules, { category: t.category, hosts, indexerId: deps.indexerFor?.(t.infoHashHex, hosts) });
    if (!rule) continue;
    const stats = t.getStats();
    if (!seedingRuleReached(rule, stats)) continue;
    const hnrRule = deps.hitAndRun?.(hosts, t.infoHashHex) ?? null;
    const hnr = hnrRule ? seedRulePending(hnrRule, stats) : null;
    if (hnr !== null) {
      result.held.push({ infoHash: t.infoHashHex, reason: hnr });
      continue;
    }
    const what = ruleSummary(rule, stats);
    const data = { reason: 'seedingRule', rule: rule.name, ratio: Number(stats.ratio.toFixed(2)), seedingTimeMs: Math.round(stats.seedingTimeMs) };
    if (rule.action === 'pause') {
      if (t.isPaused) continue;
      await deps.session.pauseTorrent(t.infoHashHex);
      result.paused.push(t.infoHashHex);
      deps.record(t.infoHashHex, 'paused', `Seeding stopped by ${what}.`, data);
      continue;
    }
    if (!deps.imported(t.infoHashHex)) {
      result.held.push({ infoHash: t.infoHashHex, reason: 'Not imported yet; the download stays until Arclight has imported it.' });
      continue;
    }
    let deleteFiles = false;
    let kept = '';
    if (rule.deleteFiles) {
      library ??= deps.libraryPaths();
      const content = stats.contentPath;
      const libraryHit = library.find((p) => pathsOverlap(content, p));
      const shared = torrents.find((o: Torrent) => o !== t && pathsOverlap(content, o.getStats().contentPath));
      if (libraryHit) kept = ` Files kept: they are inside the library (${libraryHit}).`;
      else if (shared) kept = ` Files kept: another torrent (${shared.name}) uses them.`;
      else deleteFiles = true;
    }
    await deps.session.removeTorrent(t.infoHashHex, deleteFiles);
    result.removed.push(t.infoHashHex);
    const files = deleteFiles ? ' Download folder copy deleted.' : kept || ' Files kept.';
    deps.record(t.infoHashHex, 'removed', `Removed by ${what}.${files}`, { ...data, deleteFiles });
  }
  return result;
}

// ---- database-backed ports -------------------------------------------------------------------

/** Imported by Arclight: a tracked download of a built-in client in `imported`, or an import in history. */
export function importedInDb(db: Db, infoHash: string): boolean {
  const id = infoHash.toLowerCase();
  const builtin = db.select({ id: downloadClients.id }).from(downloadClients).where(eq(downloadClients.implementation, 'builtin')).all().map((r) => r.id);
  if (builtin.length > 0) {
    const tracked = db
      .select({ id: trackedDownloads.id })
      .from(trackedDownloads)
      .where(and(inArray(trackedDownloads.clientId, builtin), eq(trackedDownloads.downloadId, id), eq(trackedDownloads.state, 'imported')))
      .get();
    if (tracked) return true;
  }
  const imported = db
    .select({ id: history.id })
    .from(history)
    .where(and(eq(history.eventType, 'downloadFolderImported'), sql`lower(${history.downloadId}) = ${id}`))
    .limit(1)
    .get();
  return imported !== undefined;
}

/** Root folders plus every series and movie folder. */
export function libraryPathsInDb(db: Db): string[] {
  return [
    ...db.select({ path: rootFolders.path }).from(rootFolders).all(),
    ...db.select({ path: series.path }).from(series).all(),
    ...db.select({ path: movies.path }).from(movies).all(),
  ]
    .map((r) => r.path)
    .filter((p) => p.trim() !== '');
}
