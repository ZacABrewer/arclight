import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createQBittorrentInventory, DownloadClientError, type QBittorrentInventory, type QbtInventoryTorrent, type QbtPreferences } from '@arclight/download-clients';
import { bdecode, type BDict, type BValue } from '@arclight/torrent-engine';
import type { MigrateSource, MigrateTestResult, MigrationWarning } from '@arclight/shared';
import { MigrateError } from './errors.js';
import { remapPath } from './paths.js';
import type { ReadDeps } from './readers.js';
import type { SourceBundle, SourceItem } from './types.js';
import { torrentPlanExtras } from './areas-torrents.js';

// qBittorrent: every torrent through the WebUI API v2, or from the BT_backup folder
// (`<hash>.torrent` + `<hash>.fastresume`) when qBittorrent is stopped or gone.
//
// The plan stays cheap: in API mode one `torrents/info` (plus preferences for the global share
// limits); .torrent files are exported one by one only when a torrent is adopted. Paths are
// kept as qBittorrent sees them plus the source's path mappings; Arclight's remote path
// mappings for the qBittorrent host are applied at plan/apply time (they live in the database).

/** Live access to the qBittorrent instance behind an API-mode bundle (shared by its items). */
export interface QbtHandle {
  inventory: QBittorrentInventory;
  /** qBittorrent's host as written in the URL (remote path mappings key on it). */
  host: string;
  port: number;
  useSsl: boolean;
  urlBase: string;
}

export interface TorrentPayload {
  /** Lower-case hex v1 info-hash. */
  hash: string;
  name: string;
  /** '' when the torrent has no category. */
  category: string;
  tags: string[];
  /** Where the data is, as qBittorrent sees it (its incomplete folder while downloading, if used). */
  dataPath: string;
  /** `dataPath` after the source's path mappings (Arclight's remote path mappings still apply). */
  mappedDataPath: string;
  /** True when a source path mapping matched. */
  mapped: boolean;
  /** Bytes selected for download. */
  sizeBytes: number;
  /** 0..1 as qBittorrent reports it. */
  progress: number;
  complete: boolean;
  paused: boolean;
  state: string;
  addedAt: string | null;
  completedAt: string | null;
  uploaded: number;
  downloaded: number;
  seedingTimeMs: number;
  activeTimeMs: number;
  /** Resolved share limits: null = unlimited (qBittorrent's own or global limit, never lower). */
  ratioLimit: number | null;
  seedTimeLimitMs: number | null;
  /** qBittorrent file priorities (files mode; API mode reads them at apply). */
  filePriorities: number[] | null;
  /** Files mode: path of `<hash>.torrent`. */
  torrentFilePath: string | null;
  /** API mode: the live connection (null in files mode). */
  handle: QbtHandle | null;
}

const MS = 1000;

function iso(seconds: number | undefined | null): string | null {
  if (seconds === undefined || seconds === null || seconds <= 0) return null;
  return new Date(seconds * MS).toISOString();
}

/** qBittorrent ratio limit (-2 global, -1 none) → limit to apply, null = unlimited. */
export function resolveRatio(limit: number | undefined, prefs: Pick<QbtPreferences, 'max_ratio_enabled' | 'max_ratio'> | null): number | null {
  if (limit === undefined || limit === -2 || limit <= -1.5) {
    if (prefs?.max_ratio_enabled && prefs.max_ratio !== undefined && prefs.max_ratio >= 0) return prefs.max_ratio;
    return null;
  }
  return limit < 0 ? null : limit;
}

/** qBittorrent seeding time limit in minutes (-2 global, -1 none) → milliseconds, null = unlimited. */
export function resolveSeedTime(limitMinutes: number | undefined, prefs: Pick<QbtPreferences, 'max_seeding_time_enabled' | 'max_seeding_time'> | null): number | null {
  if (limitMinutes === undefined || limitMinutes === -2) {
    if (prefs?.max_seeding_time_enabled && prefs.max_seeding_time !== undefined && prefs.max_seeding_time >= 0) return prefs.max_seeding_time * 60 * MS;
    return null;
  }
  return limitMinutes < 0 ? null : limitMinutes * 60 * MS;
}

function errorToMigrate(err: unknown): never {
  if (err instanceof DownloadClientError) {
    if (err.code === 'auth') throw new MigrateError('AUTH', err.message);
    if (err.code === 'unreachable') throw new MigrateError('UNREACHABLE', err.message);
    throw new MigrateError('SOURCE_UNREADABLE', err.message);
  }
  throw err;
}

export function qbtHandle(source: MigrateSource, deps: ReadDeps): QbtHandle {
  if (!source.url) throw new MigrateError('VALIDATION', 'a URL is required when using the API');
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new MigrateError('VALIDATION', `${source.url} is not a valid URL`);
  }
  const useSsl = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : useSsl ? 443 : 80;
  const fetchImpl = deps.fetch;
  const inventory = createQBittorrentInventory(
    { baseUrl: source.url, username: source.username ?? '', password: source.password ?? '' },
    fetchImpl ? { fetch: (input, init) => fetchImpl(input instanceof Request ? input.url : String(input), init) } : {},
  );
  return { inventory, host: url.hostname, port, useSsl, urlBase: url.pathname.replace(/\/+$/, '') };
}

function item(p: TorrentPayload, unsupported?: string): SourceItem<TorrentPayload> {
  const out: SourceItem<TorrentPayload> = { sourceId: p.hash, name: p.name, payload: p };
  if (unsupported) out.unsupported = unsupported;
  return out;
}

function pathWarnings(items: SourceItem<TorrentPayload>[], warnings: MigrationWarning[]): void {
  const unseen = items.filter((i) => !i.unsupported && !existsSync(i.payload.mappedDataPath));
  if (unseen.length === 0) return;
  const example = unseen[0]!.payload.mappedDataPath;
  warnings.push({
    area: 'torrents',
    message: `${unseen.length} torrent(s) keep their data where Arclight cannot see it (for example ${example}), unless a remote path mapping for this host covers it. Mount the same /data share into Arclight or add a path mapping; those torrents are skipped, never re-downloaded.`,
  });
}

// ---- API mode ---------------------------------------------------------------------------------

function fromApi(t: QbtInventoryTorrent, prefs: QbtPreferences | null, source: MigrateSource, handle: QbtHandle): SourceItem<TorrentPayload> {
  const complete = t.progress >= 1 || (t.amount_left !== undefined && t.amount_left === 0 && t.progress > 0.999);
  const dataPath = !complete && t.download_path ? t.download_path : t.save_path;
  const remapped = remapPath(dataPath, source.pathMappings);
  const paused = /^(paused|stopped)/i.test(t.state);
  const completedAt = complete ? iso(t.completion_on) : null;
  return item({
    hash: t.hash.toLowerCase(),
    name: t.name,
    category: t.category ?? '',
    tags: (t.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    dataPath,
    mappedDataPath: remapped.path,
    mapped: remapped.mapped,
    sizeBytes: Math.max(0, Math.round(t.size)),
    progress: t.progress,
    complete,
    paused,
    state: t.state,
    addedAt: iso(t.added_on),
    completedAt,
    uploaded: Math.max(0, t.uploaded ?? 0),
    downloaded: Math.max(0, t.downloaded ?? 0),
    seedingTimeMs: Math.max(0, (t.seeding_time ?? 0) * MS),
    activeTimeMs: Math.max(0, (t.time_active ?? 0) * MS),
    ratioLimit: resolveRatio(t.ratio_limit, prefs),
    seedTimeLimitMs: resolveSeedTime(t.seeding_time_limit, prefs),
    filePriorities: null,
    torrentFilePath: null,
    handle,
  }, /^(metaDL|forcedMetaDL)$/i.test(t.state) ? 'no metadata yet (still fetching it from peers); nothing to adopt' : /^missingFiles$/i.test(t.state) ? 'qBittorrent reports its files missing; nothing to adopt' : undefined);
}

async function readApi(source: MigrateSource, deps: ReadDeps): Promise<SourceBundle> {
  const handle = qbtHandle(source, deps);
  const warnings: MigrationWarning[] = [];
  let version: { app: string; api: string };
  let torrents: QbtInventoryTorrent[];
  let prefs: QbtPreferences | null = null;
  try {
    version = await handle.inventory.version();
    torrents = await handle.inventory.torrents();
    prefs = await handle.inventory.preferences().catch(() => null);
  } catch (err) {
    errorToMigrate(err);
  }
  if (!prefs) warnings.push({ area: 'torrents', message: 'qBittorrent preferences could not be read; torrents that use the global share limit are adopted without a limit (they keep seeding)' });
  const [major = 0, minor = 0] = version.app.split('.').map(Number);
  if (major < 4 || (major === 4 && minor < 5)) {
    warnings.push({ area: 'torrents', message: `qBittorrent ${version.app} cannot export .torrent files (4.5 or newer can); adopting needs files mode with its BT_backup folder` });
  }
  const items = torrents.map((t) => fromApi(t, prefs, source, handle));
  pathWarnings(items, warnings);
  return bundle(items, warnings, version.app);
}

// ---- files mode (BT_backup) --------------------------------------------------------------------

/** The BT_backup folder for a path the user gave (the folder itself or a config folder above it). */
export function findBtBackup(path: string): string | null {
  const candidates = [path, join(path, 'BT_backup'), join(path, 'qBittorrent', 'BT_backup'), join(path, 'data', 'BT_backup'), join(path, 'qBittorrent', 'data', 'BT_backup')];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory() && readdirSync(c).some((f) => f.endsWith('.fastresume'))) return c;
    } catch {
      // not there
    }
  }
  return null;
}

function bstr(v: BValue | undefined): string | null {
  return Buffer.isBuffer(v) ? v.toString('utf8') : null;
}

function bint(v: BValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function fromFastresume(hash: string, d: BDict, dir: string, source: MigrateSource): SourceItem<TorrentPayload> {
  const torrentFilePath = join(dir, `${hash}.torrent`);
  const pieces = d['pieces'];
  let progress = 0;
  if (Buffer.isBuffer(pieces) && pieces.length > 0) {
    let have = 0;
    for (const b of pieces) if (b & 1) have++;
    progress = have / pieces.length;
  }
  const completedTime = bint(d['completed_time']) ?? 0;
  const complete = progress >= 1 || (completedTime > 0 && !Buffer.isBuffer(pieces));
  const savePath = bstr(d['qBt-savePath']) || bstr(d['save_path']) || '';
  const downloadPath = bstr(d['qBt-downloadPath']) ?? '';
  const dataPath = !complete && downloadPath ? downloadPath : savePath;
  const remapped = remapPath(dataPath, source.pathMappings);
  const tagsRaw = d['qBt-tags'];
  const tags = Array.isArray(tagsRaw) ? tagsRaw.map((t) => bstr(t)).filter((t): t is string => !!t) : [];
  const ratioRaw = bint(d['qBt-ratioLimit']);
  // Stored as ratio × 1000; -2000 = global limit, -1000 = none.
  const ratio = ratioRaw === null ? undefined : ratioRaw / 1000;
  const seedRaw = bint(d['qBt-seedingTimeLimit']);
  const priorities = Array.isArray(d['file_priority']) ? (d['file_priority'] as BValue[]).map((v) => Math.min(7, Math.max(0, bint(v) ?? 1))) : null;
  const paused = (bint(d['paused']) ?? 0) === 1 || (bint(d['qBt-paused']) ?? 0) === 1 || (bint(d['qBt-stopped']) ?? 0) === 1;
  const name = bstr(d['qBt-name']) || bstr(d['name']) || hash;
  const p: TorrentPayload = {
    hash,
    name,
    category: bstr(d['qBt-category']) ?? '',
    tags,
    dataPath,
    mappedDataPath: remapped.path,
    mapped: remapped.mapped,
    sizeBytes: 0,
    progress,
    complete,
    paused,
    state: paused ? 'paused' : complete ? 'seeding' : 'downloading',
    addedAt: iso(bint(d['added_time'])),
    completedAt: complete ? iso(completedTime) : null,
    uploaded: Math.max(0, bint(d['total_uploaded']) ?? 0),
    downloaded: Math.max(0, bint(d['total_downloaded']) ?? 0),
    seedingTimeMs: Math.max(0, (bint(d['seeding_time']) ?? 0) * MS),
    activeTimeMs: Math.max(0, (bint(d['active_time']) ?? 0) * MS),
    // The global limits live in qBittorrent.ini, not here: "use global" is treated as no limit
    // so nothing stops seeding early.
    ratioLimit: resolveRatio(ratio === undefined ? undefined : ratio <= -1.5 ? -2 : ratio, null),
    seedTimeLimitMs: resolveSeedTime(seedRaw ?? undefined, null),
    filePriorities: priorities,
    torrentFilePath,
    handle: null,
  };
  if (!existsSync(torrentFilePath)) return item(p, 'no metadata yet (no .torrent in BT_backup); nothing to adopt');
  try {
    p.sizeBytes = statSync(torrentFilePath).size > 0 ? sizeFromTorrent(torrentFilePath) : 0;
  } catch {
    return item(p, 'its .torrent file in BT_backup cannot be read');
  }
  if (!savePath) return item(p, 'its fastresume has no save path');
  return item(p);
}

function sizeFromTorrent(path: string): number {
  const root = bdecode(readFileSync(path)) as BDict;
  const info = root['info'] as BDict | undefined;
  if (!info) return 0;
  const length = bint(info['length']);
  if (length !== null) return length;
  const files = info['files'];
  return Array.isArray(files) ? files.reduce<number>((n, f) => n + (bint((f as BDict)['length']) ?? 0), 0) : 0;
}

function readFiles(source: MigrateSource): SourceBundle {
  const dir = findBtBackup(source.dbPath ?? '');
  if (!dir) throw new MigrateError('SOURCE_NOT_FOUND', `no BT_backup folder with .fastresume files was found at ${source.dbPath ?? '?'}`);
  const warnings: MigrationWarning[] = [];
  const items: SourceItem<TorrentPayload>[] = [];
  let unreadable = 0;
  for (const f of readdirSync(dir)) {
    const m = /^([0-9a-fA-F]{40})\.fastresume$/.exec(f);
    if (!m) continue;
    try {
      const d = bdecode(readFileSync(join(dir, f)));
      if (!d || typeof d !== 'object' || Array.isArray(d) || Buffer.isBuffer(d)) throw new Error('not a dictionary');
      items.push(fromFastresume(m[1]!.toLowerCase(), d as BDict, dir, source));
    } catch {
      unreadable++;
    }
  }
  if (unreadable > 0) warnings.push({ area: 'torrents', message: `${unreadable} .fastresume file(s) could not be read and were left out` });
  warnings.push({ area: 'torrents', message: 'Read from BT_backup: torrents that use qBittorrent\'s global share limits are adopted without a limit (they keep seeding); stop qBittorrent before adopting so only one client uses the files' });
  pathWarnings(items, warnings);
  return bundle(items, warnings, null);
}

function bundle(items: SourceItem<TorrentPayload>[], warnings: MigrationWarning[], version: string | null): SourceBundle {
  const complete = items.filter((i) => i.payload.complete).length;
  return {
    app: 'qbittorrent',
    schemaVersion: version,
    warnings,
    areas: { torrents: { mode: 'import', items, details: { complete, incomplete: items.length - complete } } },
    planExtras: (env) => ({ torrentCategories: torrentPlanExtras(env, items) }),
  };
}

export async function readQbittorrent(source: MigrateSource, deps: ReadDeps): Promise<SourceBundle> {
  return source.mode === 'api' ? readApi(source, deps) : readFiles(source);
}

/** Connection test: log in and read the version (API), or find the BT_backup folder (files). */
export async function testQbittorrent(source: MigrateSource, deps: ReadDeps): Promise<MigrateTestResult> {
  if (source.mode === 'files') {
    const dir = findBtBackup(source.dbPath ?? '');
    if (!dir) return { ok: false, app: 'qbittorrent', version: null, detected: null, message: `no BT_backup folder with .fastresume files was found at ${source.dbPath ?? '?'} (is the qBittorrent config folder mounted?)` };
    const count = readdirSync(dir).filter((f) => f.endsWith('.fastresume')).length;
    return { ok: true, app: 'qbittorrent', version: null, detected: null, message: `${count} torrent(s) found in ${dir}` };
  }
  try {
    const handle = qbtHandle(source, deps);
    const v = await handle.inventory.version();
    return { ok: true, app: 'qbittorrent', version: v.app, detected: null, message: null };
  } catch (err) {
    return { ok: false, app: 'qbittorrent', version: null, detected: null, message: err instanceof Error ? err.message : String(err) };
  }
}
