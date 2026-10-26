import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { completeResumeData } from '@arclight/download-clients';
import { parseTorrent, type Metainfo, type Session } from '@arclight/torrent-engine';
import type { MigrateSource, MigrateSourceCleanupResult, MigrateTorrentAction, MigrateTorrentCategory, MigrateTorrentOptions } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { mapRemoteToLocal } from '../download-clients/remote-paths.js';
import { SkipItem, type AreaEnv, type AsyncHandlers, type AsyncOutcome, type Existing } from './areas.js';
import type { MigrateDeps } from './deps.js';
import { MigrateError } from './errors.js';
import { qbtHandle, type QbtHandle, type TorrentPayload } from './qbittorrent-reader.js';
import { migrateImported } from './schema.js';
import type { SourceItem } from './types.js';

// qBittorrent torrents: adopted into the built-in engine with the data in place, or kept in
// qBittorrent behind an external download client; linked to tracked downloads by info-hash.
//
// Adoption never re-downloads and never moves or deletes data:
// - before adding, every wanted file is looked up at the (mapped) save path; a torrent
//   qBittorrent calls complete whose files are not all there with the right size, or a partial
//   torrent with no data found at all, is skipped with the reason (adding it would download it
//   again);
// - `recheck` (default): the engine hashes the existing data before using it (a resume record
//   with no bitfield forces the check), so a complete torrent comes up seeding and a partial one
//   downloads only its missing pieces;
// - `trust`: complete torrents whose files all match in size get a full bitfield plus the
//   current file sizes/mtimes, which the engine's fast-resume accepts without hashing;
// - the resume record carries qBittorrent's upload/download totals, seeding and active time,
//   added/completed dates, category and tags, so ratios and hit-and-run clocks continue, and
//   qBittorrent's share limits (never lower; "global" resolves to qBittorrent's global limit or
//   none) go on the engine torrent.
// Only one client may use a torrent's files: the engine copy is added paused unless the user
// confirmed pausing it in qBittorrent first (API mode), or confirmed qBittorrent is stopped
// (files mode); then it keeps qBittorrent's running/paused state.

/** migrate_imported area marking a torrent adopted into the engine (sourceId = info-hash). */
export const ADOPTED_AREA = 'torrents.adopted';

const BUILTIN_NAME = 'Built-in';

export function actionFor(options: MigrateTorrentOptions, category: string): MigrateTorrentAction {
  return options.categories[category] ?? options.defaultAction;
}

/** Where Arclight finds the data: source path mappings first, then Arclight's remote path mappings for the qBittorrent host. */
export function localDataPath(db: Db, p: TorrentPayload): string {
  if (p.mapped || !p.handle) return p.mappedDataPath;
  const rows = db.select().from(t.remotePathMappings).all();
  return mapRemoteToLocal(rows, p.handle.host, p.dataPath).replace(/[\\/]+$/, '') || p.dataPath;
}

function lowerHistoryIds(db: Db): { grabbed: Set<string>; imported: Set<string> } {
  const rows = db
    .select({ id: sql<string>`lower(${t.history.downloadId})`, eventType: t.history.eventType })
    .from(t.history)
    .where(sql`${t.history.downloadId} is not null`)
    .all();
  const grabbed = new Set<string>();
  const imported = new Set<string>();
  for (const r of rows) {
    if (r.eventType === 'grabbed') grabbed.add(r.id);
    if (r.eventType === 'downloadFolderImported') imported.add(r.id);
  }
  return { grabbed, imported };
}

/** Per-category summary for the plan (count, completeness, size, usual save path, history links). */
export function torrentPlanExtras(env: AreaEnv, items: readonly SourceItem<TorrentPayload>[]): MigrateTorrentCategory[] {
  const { grabbed } = lowerHistoryIds(env.db);
  const by = new Map<string, { count: number; complete: number; size: number; linked: number; paths: Map<string, number> }>();
  for (const i of items) {
    const p = i.payload;
    const c = by.get(p.category) ?? { count: 0, complete: 0, size: 0, linked: 0, paths: new Map() };
    c.count++;
    if (p.complete) c.complete++;
    c.size += p.sizeBytes;
    if (grabbed.has(p.hash)) c.linked++;
    const local = localDataPath(env.db, p);
    c.paths.set(local, (c.paths.get(local) ?? 0) + 1);
    by.set(p.category, c);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, c]) => ({
      category,
      count: c.count,
      complete: c.complete,
      sizeBytes: c.size,
      savePath: [...c.paths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      linked: c.linked,
    }));
}

// ---- download clients ---------------------------------------------------------------------

function builtinClient(env: AreaEnv): { id: number; category: string } | null {
  const row = env.db.select().from(t.downloadClients).where(eq(t.downloadClients.implementation, 'builtin')).get();
  return row ? { id: row.id, category: typeof row.settings['category'] === 'string' ? row.settings['category'] : 'arclight' } : null;
}

function uniqueClientName(env: AreaEnv, base: string): string {
  const names = new Set(env.db.select({ name: t.downloadClients.name }).from(t.downloadClients).all().map((r) => r.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** The built-in engine's download client row, created when missing (tracked downloads reference it). */
function ensureBuiltinClient(env: AreaEnv): { id: number; category: string } {
  const existing = builtinClient(env);
  if (existing) return existing;
  const created = env.services.downloadClients.create({ name: uniqueClientName(env, BUILTIN_NAME), implementation: 'builtin', enable: true, settings: {} });
  return { id: created.id, category: typeof created.settings['category'] === 'string' ? (created.settings['category'] as string) : 'arclight' };
}

function sameHost(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** An Arclight qBittorrent client for this instance and category (null in a dry run when one would be created). */
function externalClient(env: AreaEnv, handle: QbtHandle | null, category: string): { id: number | null; created: boolean; category: string } {
  const rows = env.db.select().from(t.downloadClients).where(eq(t.downloadClients.implementation, 'qbittorrent')).all();
  const onHost = handle ? rows.filter((r) => sameHost(r.settings['host'], handle.host) && Number(r.settings['port'] ?? 8080) === handle.port) : rows;
  const exact = onHost.find((r) => r.settings['category'] === category);
  if (exact) return { id: exact.id, created: false, category };
  if (!handle) {
    throw new SkipItem('keeping it in qBittorrent needs the qBittorrent URL (API mode) or an Arclight qBittorrent client for this category');
  }
  if (category === '') {
    // A client without a category would list every torrent in qBittorrent as an Arclight download.
    const any = onHost[0];
    if (any) return { id: any.id, created: false, category: String(any.settings['category'] ?? '') };
    throw new SkipItem('torrents without a category are left in qBittorrent untouched (give them a category to track them in Arclight)');
  }
  if (env.dryRun) return { id: null, created: true, category };
  const s = env.source;
  const created = env.services.downloadClients.create({
    name: uniqueClientName(env, `qBittorrent (${category})`),
    implementation: 'qbittorrent',
    enable: true,
    // Lowest priority: new grabs keep going to the built-in engine or the clients already set up.
    priority: 50,
    settings: {
      host: handle.host,
      port: handle.port,
      useSsl: handle.useSsl,
      ...(handle.urlBase ? { urlBase: handle.urlBase } : {}),
      username: s.username ?? '',
      password: s.password ?? '',
      category,
    },
  });
  return { id: created.id, created: true, category };
}

// ---- tracked downloads ----------------------------------------------------------------------

interface GrabLink {
  title: string;
  mediaType: 'series' | 'movie';
  seriesId: number | null;
  movieId: number | null;
  episodeIds: number[];
  imported: boolean;
}

function grabLink(db: Db, hash: string): GrabLink | null {
  const rows = db.select().from(t.history).where(sql`lower(${t.history.downloadId}) = ${hash}`).all();
  const grabs = rows.filter((r) => r.eventType === 'grabbed');
  const first = grabs[0];
  if (!first) return null;
  const episodeIds = [...new Set(grabs.map((g) => g.episodeId).filter((e): e is number => e !== null))];
  return {
    title: first.sourceTitle,
    mediaType: first.mediaType,
    seriesId: first.seriesId,
    movieId: first.movieId,
    episodeIds,
    imported: rows.some((r) => r.eventType === 'downloadFolderImported'),
  };
}

/** Attaches the torrent to its Sonarr/Radarr grab as a tracked download (idempotent). Null when there is no grab. */
function linkTracked(env: AreaEnv, clientId: number, downloadId: string, p: TorrentPayload, outputPath: string, category: string, link: GrabLink): number {
  const existing = env.db
    .select({ id: t.trackedDownloads.id })
    .from(t.trackedDownloads)
    .where(and(eq(t.trackedDownloads.clientId, clientId), eq(t.trackedDownloads.downloadId, downloadId)))
    .get();
  if (existing) return existing.id;
  const size = p.sizeBytes;
  return env.db
    .insert(t.trackedDownloads)
    .values({
      downloadId,
      clientId,
      title: link.title,
      // Imported downloads only keep seeding; the rest go through the normal import pipeline
      // once the queue sees them complete.
      state: link.imported ? 'imported' : 'downloading',
      trackedStatus: 'ok',
      clientStatus: 'unknown',
      statusMessages: [],
      protocol: 'torrent',
      category,
      size,
      sizeLeft: p.complete ? 0 : Math.max(0, Math.round(size * (1 - p.progress))),
      progress: p.progress,
      outputPath,
      addedAt: p.addedAt ?? env.now,
      updatedAt: env.now,
      mediaType: link.mediaType,
      seriesId: link.seriesId,
      episodeIds: link.episodeIds,
      movieId: link.movieId,
    })
    .returning({ id: t.trackedDownloads.id })
    .get().id;
}

// ---- adoption ---------------------------------------------------------------------------------

interface FileCheck {
  foundBytes: number;
  missing: string[];
  qbIncomplete: number;
}

async function checkFiles(meta: Metainfo, savePath: string, priorities: number[] | null): Promise<FileCheck> {
  const out: FileCheck = { foundBytes: 0, missing: [], qbIncomplete: 0 };
  for (const f of meta.files) {
    if (f.padding || (priorities?.[f.index] ?? 1) === 0) continue;
    const path = join(savePath, ...f.pathSegments);
    try {
      const s = await stat(path);
      if (s.isFile() && s.size === f.length) out.foundBytes += f.length;
      else {
        if (s.isFile()) out.foundBytes += Math.min(s.size, f.length);
        out.missing.push(f.path);
      }
    } catch {
      out.missing.push(f.path);
      try {
        // qBittorrent's "append .!qB to incomplete files": the engine would not find them.
        if ((await stat(`${path}.!qB`)).isFile()) out.qbIncomplete++;
      } catch {
        // absent
      }
    }
  }
  return out;
}

async function torrentBytes(env: AreaEnv, p: TorrentPayload): Promise<Uint8Array> {
  if (p.torrentFilePath) return readFile(p.torrentFilePath);
  if (!p.handle) throw new SkipItem('no .torrent file is available for it');
  try {
    return await p.handle.inventory.exportTorrent(p.hash);
  } catch (err) {
    throw new Error(`exporting its .torrent from qBittorrent failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function filePriorities(p: TorrentPayload, meta: Metainfo): Promise<number[] | null> {
  if (p.filePriorities) return p.filePriorities.length === meta.files.length ? p.filePriorities : null;
  if (!p.handle) return null;
  try {
    const files = await p.handle.inventory.files(p.hash);
    if (files.length !== meta.files.length) return null;
    const out = new Array<number>(files.length).fill(1);
    files.forEach((f, i) => {
      out[f.index ?? i] = Math.min(7, Math.max(0, f.priority ?? 1));
    });
    return out.every((x) => x > 0) ? null : out;
  } catch {
    return null;
  }
}

function markAdopted(env: AreaEnv, hash: string, trackedId: number | null): void {
  env.db
    .insert(migrateImported)
    .values({ instance: env.instance, sourceApp: env.app, area: ADOPTED_AREA, sourceId: hash, targetId: trackedId, importedAt: env.now })
    .onConflictDoUpdate({ target: [migrateImported.instance, migrateImported.area, migrateImported.sourceId], set: { targetId: trackedId, importedAt: env.now } })
    .run();
}

function percent(x: number): string {
  return `${Math.floor(x * 1000) / 10}%`;
}

async function adopt(env: AreaEnv, item: SourceItem<TorrentPayload>, existing: Existing | null): Promise<AsyncOutcome> {
  const p = item.payload;
  const session: Session | null = env.deps.torrentSession?.() ?? null;
  if (!session) throw new Error('the built-in torrent engine is not running (turn it on under Settings > Torrent engine, or keep this category in qBittorrent)');
  const local = localDataPath(env.db, p);
  const link = grabLink(env.db, p.hash);

  if (existing) {
    if (env.dryRun) return { kind: 'skipped', id: null, message: 'already in the built-in engine' };
    const client = ensureBuiltinClient(env);
    const engineTorrent = session.getTorrent(p.hash);
    const trackedId = link ? linkTracked(env, client.id, p.hash, p, local, engineTorrent?.category ?? p.category, link) : null;
    markAdopted(env, p.hash, trackedId);
    return { kind: 'skipped', id: trackedId, message: 'already in the built-in engine; linked' };
  }

  const bytes = await torrentBytes(env, p);
  let meta: Metainfo;
  try {
    meta = parseTorrent(bytes);
  } catch (err) {
    throw new Error(`its .torrent cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (meta.infoHashHex !== p.hash) throw new Error(`the exported .torrent has info-hash ${meta.infoHashHex}, not ${p.hash} (v2-only torrents cannot be adopted)`);
  if (meta.version === 'v2') throw new SkipItem('v2-only torrents cannot be adopted yet; it stays in qBittorrent');

  const priorities = await filePriorities(p, meta);
  const check = await checkFiles(meta, local, priorities);
  if (check.qbIncomplete > 0) throw new SkipItem(`qBittorrent keeps ${check.qbIncomplete} unfinished file(s) as *.!qB; let it finish there or turn that option off, otherwise the engine would download them again`);
  if (p.complete && check.missing.length > 0) {
    throw new SkipItem(`${check.missing.length} file(s) are missing, renamed or a different size at ${local} (e.g. ${check.missing[0]}); adopting would download them again`);
  }
  if (p.progress > 0 && check.foundBytes === 0) throw new SkipItem(`no data was found at ${local}; adopting would download it again (check the path mapping)`);

  const confirmed = env.options.torrents.pauseInSource && env.options.torrents.confirmSourceChanges;
  const verify = env.options.torrents.verify;
  if (env.dryRun) {
    const how = p.complete ? (verify === 'trust' ? 'taken as complete' : 'verified then seeding') : `${percent(p.progress)} done, continues downloading`;
    return { kind: 'created', id: null, message: `would adopt from ${local} (${how}${confirmed ? '' : ', paused until qBittorrent lets go of it'})` };
  }

  // Hand-over: only one client may use the files.
  let pausedInSource = false;
  if (confirmed && p.handle && !p.paused) {
    await p.handle.inventory.pause([p.hash]);
    pausedInSource = true;
  }
  const enginePaused = confirmed ? p.paused : true;
  const client = ensureBuiltinClient(env);
  // A grab Arclight still has to import must be visible to the queue (it lists the client's category).
  const needsImport = link !== null && !link.imported;
  const category = needsImport && client.category ? client.category : p.category;

  let resume = verify === 'trust' && p.complete ? await completeResumeData(meta, local, { category, paused: enginePaused }) : undefined;
  const trusted = resume !== undefined;
  resume ??= {
    version: 1,
    infoHash: meta.infoHashHex,
    name: meta.name,
    // No bitfield: the engine hashes the existing data before using it.
    bitfield: '',
    pieceCount: 0,
    uploaded: 0,
    downloaded: 0,
    seedingTimeMs: 0,
    activeTimeMs: 0,
    addedAt: env.now,
    completedAt: null,
    savePath: local,
    category,
    tags: p.tags,
    filePriorities: priorities ?? [],
    paused: enginePaused,
    sequential: false,
    fileStats: [],
    magnet: null,
    seedRatioLimit: p.ratioLimit,
    seedTimeLimitMs: p.seedTimeLimitMs,
  };
  Object.assign(resume, {
    uploaded: p.uploaded,
    downloaded: p.downloaded,
    seedingTimeMs: p.seedingTimeMs,
    activeTimeMs: Math.max(p.activeTimeMs, p.seedingTimeMs),
    addedAt: p.addedAt ?? env.now,
    completedAt: p.completedAt,
    tags: p.tags,
    seedRatioLimit: p.ratioLimit,
    seedTimeLimitMs: p.seedTimeLimitMs,
  });

  let torrent;
  try {
    torrent = await session.addTorrent(
      {
        torrent: bytes,
        savePath: local,
        category,
        tags: p.tags,
        paused: enginePaused,
        ...(priorities ? { filePriorities: priorities } : {}),
        seedRatioLimit: p.ratioLimit,
        seedTimeLimitMs: p.seedTimeLimitMs,
      },
      resume,
    );
  } catch (err) {
    if (pausedInSource && p.handle) await p.handle.inventory.resume([p.hash]).catch(() => undefined);
    throw new Error(`the engine refused it: ${err instanceof Error ? err.message : String(err)}`);
  }

  const stats = torrent.getStats();
  const trackedId = link ? linkTracked(env, client.id, p.hash, p, local, category, link) : null;
  markAdopted(env, p.hash, trackedId);
  const parts = [
    trusted ? 'taken as complete (sizes match, not hashed)' : torrent.isComplete ? 'verified 100%, seeding' : `verified ${percent(stats.progress)}, downloads only the rest`,
    enginePaused && !p.paused ? 'paused in Arclight until qBittorrent stops using it' : enginePaused ? 'paused (as in qBittorrent)' : pausedInSource ? 'paused in qBittorrent' : null,
    category !== p.category ? `category ${client.category} so Arclight imports it` : null,
    link ? (link.imported ? 'linked to its import' : 'linked to its grab') : null,
  ].filter(Boolean);
  return { kind: 'created', id: trackedId, message: `adopted from ${local}: ${parts.join('; ')}` };
}

async function keepExternal(env: AreaEnv, item: SourceItem<TorrentPayload>): Promise<AsyncOutcome> {
  const p = item.payload;
  const client = externalClient(env, p.handle, p.category);
  const link = grabLink(env.db, p.hash);
  if (env.dryRun) {
    return { kind: 'created', id: null, message: `stays in qBittorrent${client.created ? `; a qBittorrent download client for "${p.category}" would be added` : ''}${link ? '; linked to its grab' : ''}` };
  }
  let trackedId: number | null = null;
  // The queue only lists the client's category; other links would vanish again, so only the
  // imported ones (never re-listed) and same-category ones are tracked.
  if (link && client.id !== null && (link.imported || client.category === p.category)) {
    trackedId = linkTracked(env, client.id, p.hash, p, p.dataPath, p.category, link);
  }
  return { kind: 'created', id: trackedId, message: `stays in qBittorrent${client.created ? `; added the download client "qBittorrent (${p.category})"` : ''}${trackedId !== null ? '; linked to its grab' : ''}` };
}

export const TORRENT_HANDLERS: AsyncHandlers = {
  torrents: {
    find: (env, item) => {
      const p = item.payload as TorrentPayload;
      const session = env.deps.torrentSession?.() ?? null;
      return session?.getTorrent(p.hash) ? { id: null, reason: 'already in the built-in engine' } : null;
    },
    apply: async (env, item, existing) => {
      const it = item as SourceItem<TorrentPayload>;
      const action = actionFor(env.options.torrents, it.payload.category);
      if (action === 'skip') throw new SkipItem(`category "${it.payload.category || '(none)'}" is set to skip`);
      return action === 'external' ? keepExternal(env, it) : adopt(env, it, existing);
    },
  },
};

/** Info-hashes (lower-case hex) that real runs adopted from this qBittorrent instance into the built-in engine. */
export function adoptedHashes(db: Db, instance: string): string[] {
  return db
    .select({ hash: migrateImported.sourceId })
    .from(migrateImported)
    .where(and(eq(migrateImported.instance, instance), eq(migrateImported.area, ADOPTED_AREA)))
    .all()
    .map((r) => r.hash);
}

/**
 * The optional clean-up step: pause, or remove keeping the files, the given torrents in
 * qBittorrent. Only called after an explicit confirmation; only torrents the engine has.
 */
export async function cleanupSourceTorrents(source: MigrateSource, hashes: readonly string[], action: 'pause' | 'remove', deps: MigrateDeps): Promise<MigrateSourceCleanupResult> {
  if (source.mode !== 'api') throw new MigrateError('VALIDATION', 'qBittorrent was read from its files; pause or remove the torrents in qBittorrent itself');
  const session = deps.torrentSession?.() ?? null;
  if (!session) throw new MigrateError('VALIDATION', 'the built-in torrent engine is not running, so it cannot be confirmed that it has the torrents');
  const owned = hashes.filter((h) => session.getTorrent(h.toLowerCase()) !== undefined);
  const result: MigrateSourceCleanupResult = { action, done: 0, failed: [] };
  if (owned.length === 0) return result;
  const handle = qbtHandle(source, deps);
  for (let i = 0; i < owned.length; i += 50) {
    const chunk = owned.slice(i, i + 50);
    try {
      if (action === 'pause') await handle.inventory.pause(chunk);
      else await handle.inventory.removeKeepFiles(chunk);
      result.done += chunk.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const hash of chunk) result.failed.push({ hash, message });
    }
  }
  return result;
}

