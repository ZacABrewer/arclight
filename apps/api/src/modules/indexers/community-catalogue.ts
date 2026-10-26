import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { limitingWarnings } from '@arclight/indexers';
import {
  DefinitionFeedIndex,
  type CatalogueUnsupportedReason,
  type CommunityCatalogueSettings,
  type CommunityCatalogueStatus,
  type CommunityCatalogueSyncResult,
} from '@arclight/shared';
import type { FeedStatusReport } from '../../feeds.js';
import { STALE_INTERVALS } from '../../feeds.js';
import { definitionSha256, type FetchLike } from './definition-feed.js';
import type { DefinitionStore } from './definitions.js';

// Community catalogue: the Cardigann definitions the Prowlarr/Jackett community maintains,
// fetched at runtime (never bundled) into `<config>/definitions/community/`.
//
// A sync reads one listing URL. Two layouts are understood:
//   - a GitHub contents API array `[{ name, type, sha, size, download_url }]`, where `sha` is the
//     git blob hash of the file (the default source, Prowlarr/Indexers `definitions/v11`);
//   - an Arclight feed `index.json` `{ schemaVersion, definitions: [{ id, file, sha256 }] }`.
// (The GitHub contents API lists at most 1000 entries per folder; v11 has under 600. A larger
// catalogue would need the git trees API or a published index.)
// Unchanged files (same hash as the manifest of the current copy) are copied, changed ones are
// downloaded and verified, into a staging folder; the staging folder then replaces the live one
// in two renames and the replaced copy is kept as `.community-previous` for rollback. A failed
// sync leaves the live folder alone. Every file is loaded by the definition store; files that do
// not load are listed by the catalogue as "not supported yet", they are never dropped here.

export class CommunityCatalogueError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'UPSTREAM' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'CommunityCatalogueError';
  }
}

/** One file of a listing, normalised. */
export interface ListingFile {
  name: string;
  url: string;
  hash: string;
  hashKind: 'git-sha1' | 'sha256';
  size?: number;
}

interface Manifest {
  sourceUrl: string;
  syncedAt: string;
  files: Record<string, { hash: string; hashKind: ListingFile['hashKind'] }>;
}

interface StateFile {
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** ETag of the listing the live copy came from (or was rolled back under), and its URL. */
  etag: string | null;
  etagUrl: string | null;
}

const EMPTY_STATE: StateFile = { lastSyncAt: null, lastSuccessAt: null, lastError: null, etag: null, etagUrl: null };

const MANIFEST = '.manifest.json';
const FILE_NAME = /^[A-Za-z0-9._-]+\.ya?ml$/;
/** Upper bounds that keep a broken or hostile listing from filling the disk. */
export const MAX_LISTING_FILES = 5000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 8;

/** Git blob id of a file: sha1 over `blob <bytes>\0<content>`. */
export function gitBlobSha1(data: Uint8Array): string {
  return createHash('sha1').update(`blob ${data.byteLength}\0`).update(data).digest('hex');
}

/** Normalise a listing response (GitHub contents array or feed index) to files. Throws on a bad shape. */
export function parseListing(raw: unknown, listingUrl: string): ListingFile[] {
  if (Array.isArray(raw)) {
    const files: ListingFile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (e['type'] !== undefined && e['type'] !== 'file') continue;
      const name = typeof e['name'] === 'string' ? e['name'] : '';
      if (!FILE_NAME.test(name)) continue;
      const sha = typeof e['sha'] === 'string' ? e['sha'].toLowerCase() : '';
      const url = typeof e['download_url'] === 'string' ? e['download_url'] : '';
      if (!/^[0-9a-f]{40}$/.test(sha) || !/^https?:\/\//i.test(url)) continue;
      files.push({ name, url, hash: sha, hashKind: 'git-sha1', ...(typeof e['size'] === 'number' ? { size: e['size'] } : {}) });
    }
    return files;
  }
  const index = DefinitionFeedIndex.safeParse(raw);
  if (!index.success) throw new CommunityCatalogueError('UPSTREAM', 'listing is neither a contents array nor a definition index');
  return index.data.definitions.map((d) => ({
    name: `${d.id}.yml`,
    url: new URL(d.file, listingUrl).toString(),
    hash: d.sha256,
    hashKind: 'sha256' as const,
  }));
}

function hashOf(kind: ListingFile['hashKind'], data: Uint8Array): string {
  return kind === 'git-sha1' ? gitBlobSha1(data) : definitionSha256(new TextDecoder().decode(data));
}

/** A reason with ids and quoted values blanked, so equal causes group together. */
export function reasonKey(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\s*\(at [^)]*\)\s*$/, '')
    .trim();
}

export interface CommunityCatalogueOptions {
  store: DefinitionStore;
  /** `<config>/definitions/community`; must be the store's communityDir. */
  dir: string;
  settings: () => CommunityCatalogueSettings;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => Date;
  timeoutMs?: number;
}

export class CommunityCatalogue {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private running: Promise<CommunityCatalogueSyncResult> | undefined;
  private cache: StateFile | undefined;
  readonly previousDir: string;
  readonly stagingDir: string;
  private readonly stateFile: string;

  constructor(private readonly opts: CommunityCatalogueOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
    const parent = dirname(opts.dir);
    this.previousDir = join(parent, '.community-previous');
    this.stagingDir = join(parent, '.community-staging');
    this.stateFile = join(parent, '.community-state.json');
  }

  // ---- state ----------------------------------------------------------------------------

  private async readState(): Promise<StateFile> {
    if (this.cache) return this.cache;
    try {
      this.cache = { ...EMPTY_STATE, ...(JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<StateFile>) };
    } catch {
      this.cache = { ...EMPTY_STATE };
    }
    return this.cache;
  }

  private async writeState(state: StateFile): Promise<void> {
    this.cache = state;
    await mkdir(dirname(this.stateFile), { recursive: true });
    await atomicWrite(this.stateFile, JSON.stringify(state, null, 2));
  }

  private async readManifest(dir: string): Promise<Manifest | null> {
    try {
      const m = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Manifest;
      return m && typeof m === 'object' && m.files ? m : null;
    } catch {
      return null;
    }
  }

  /** Last sync times, for the catalogue header and the health check. */
  async lastSync(): Promise<Pick<StateFile, 'lastSyncAt' | 'lastSuccessAt' | 'lastError'>> {
    const s = await this.readState();
    return { lastSyncAt: s.lastSyncAt, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError };
  }

  /** Enabled, never synced or overdue: the startup kick runs a sync. */
  async due(): Promise<boolean> {
    const settings = this.opts.settings();
    if (!settings.enabled) return false;
    const s = await this.readState();
    if (!s.lastSuccessAt) return true;
    return this.now().getTime() - Date.parse(s.lastSuccessAt) >= settings.intervalHours * 3_600_000;
  }

  async status(): Promise<CommunityCatalogueStatus> {
    const settings = this.opts.settings();
    const state = await this.readState();
    const store = this.opts.store;
    const manifest = await this.readManifest(this.opts.dir);
    const previous = await this.readManifest(this.previousDir);
    const loaded = store.communityDefinitions();
    const failed = store.allCommunityFailures();
    const reasons = new Map<string, number>();
    let limited = 0;
    for (const def of loaded) {
      const warnings = limitingWarnings(def);
      if (warnings.length === 0) continue;
      limited++;
      const key = reasonKey(warnings[0] as string);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const f of failed) {
      const key = reasonKey(f.message);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    const ids = new Set([...loaded.map((d) => d.id), ...failed.map((f) => f.id)]);
    let overridden = 0;
    for (const id of ids) if (store.source(id) !== undefined && store.source(id) !== 'community') overridden++;
    const topReasons: CatalogueUnsupportedReason[] = [...reasons]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }));
    const staleAfter = settings.intervalHours * 3_600_000 * STALE_INTERVALS;
    const stale =
      settings.enabled &&
      ((state.lastSuccessAt === null && state.lastSyncAt !== null) ||
        (state.lastSuccessAt !== null && this.now().getTime() - Date.parse(state.lastSuccessAt) > staleAfter));
    return {
      settings,
      lastSyncAt: state.lastSyncAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      sourceUrl: manifest?.sourceUrl ?? null,
      files: manifest ? Object.keys(manifest.files).length : await countYaml(this.opts.dir),
      supported: settings.enabled ? loaded.length : 0,
      limited: settings.enabled ? limited : 0,
      unsupported: settings.enabled ? failed.length : 0,
      overridden: settings.enabled ? overridden : 0,
      topReasons: settings.enabled ? topReasons : [],
      previousAvailable: previous !== null,
      previousSyncedAt: previous?.syncedAt ?? null,
      stale,
    };
  }

  /** Report for the feeds registry (FeedStale health check, System → Feeds). */
  async feedStatus(): Promise<FeedStatusReport> {
    const s = this.opts.settings();
    const state = await this.readState();
    const st = await this.status();
    return {
      enabled: s.enabled,
      intervalMs: s.intervalHours * 3_600_000,
      lastSyncAt: state.lastSyncAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      pending: null,
      detail: `${st.supported} of ${st.files} definitions load${st.unsupported ? `, ${st.unsupported} not supported yet` : ''}`,
    };
  }

  // ---- sync -----------------------------------------------------------------------------

  /** Concurrent calls share one run. */
  sync(opts: { signal?: AbortSignal } = {}): Promise<CommunityCatalogueSyncResult> {
    if (this.running) return this.running;
    const run = this.runSync(opts.signal).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async get(url: string, signal: AbortSignal | undefined, headers: Record<string, string> = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    try {
      return await this.fetchImpl(url, {
        headers: { 'user-agent': 'Arclight', accept: 'application/json, text/plain, */*', ...headers },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new CommunityCatalogueError('UPSTREAM', `${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runSync(signal?: AbortSignal): Promise<CommunityCatalogueSyncResult> {
    const settings = this.opts.settings();
    if (!settings.enabled) throw new CommunityCatalogueError('VALIDATION', 'the community catalogue is turned off');
    const url = settings.url;
    const state = { ...(await this.readState()) };
    const startedAt = this.now().toISOString();
    const fail = async (message: string): Promise<never> => {
      state.lastSyncAt = startedAt;
      state.lastError = message;
      await this.writeState(state);
      this.opts.log?.warn({ url }, `community catalogue sync failed: ${message}`);
      throw new CommunityCatalogueError('UPSTREAM', message);
    };

    const live = await this.readManifest(this.opts.dir);
    const sameSource = live !== null && live.sourceUrl === url;
    const conditional = sameSource && state.etag && state.etagUrl === url ? { 'if-none-match': state.etag } : {};
    const res = await this.get(url, signal, conditional).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    const total = live ? Object.keys(live.files).length : 0;
    if (res.status === 304) {
      state.lastSyncAt = startedAt;
      state.lastSuccessAt = startedAt;
      state.lastError = null;
      await this.writeState(state);
      return { notModified: true, added: 0, updated: 0, removed: 0, unchanged: total, failed: [], total };
    }
    if (!res.ok) return fail(`${url}: HTTP ${res.status}${rateLimitHint(res)}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await res.text()) as unknown;
    } catch {
      return fail(`${url}: not JSON`);
    }
    let listing: ListingFile[];
    try {
      listing = parseListing(raw, url);
    } catch (err) {
      return fail(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (listing.length > MAX_LISTING_FILES) return fail(`${url}: ${listing.length} files is more than the ${MAX_LISTING_FILES} allowed`);
    if (listing.length === 0) return fail(`${url}: the listing has no definition files`);

    // ---- stage
    await rm(this.stagingDir, { recursive: true, force: true });
    await mkdir(this.stagingDir, { recursive: true });
    const result: CommunityCatalogueSyncResult = { notModified: false, added: 0, updated: 0, removed: 0, unchanged: 0, failed: [], total: 0 };
    const manifest: Manifest = { sourceUrl: url, syncedAt: startedAt, files: {} };
    const toDownload: ListingFile[] = [];
    const seen = new Set<string>();
    for (const f of listing) {
      const key = f.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const current = sameSource ? live?.files[f.name] : undefined;
      if (current && current.hash === f.hash && (await exists(join(this.opts.dir, f.name)))) {
        await copyFile(join(this.opts.dir, f.name), join(this.stagingDir, f.name));
        manifest.files[f.name] = current;
        result.unchanged++;
      } else {
        toDownload.push(f);
      }
    }
    let downloaded = 0;
    const queue = [...toDownload];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (signal?.aborted) return;
        const outcome = await this.download(f, signal);
        if (outcome.ok) {
          await writeFile(join(this.stagingDir, f.name), outcome.data);
          manifest.files[f.name] = { hash: f.hash, hashKind: f.hashKind };
          downloaded++;
          if (live?.files[f.name] && (await exists(join(this.opts.dir, f.name)))) result.updated++;
          else result.added++;
        } else {
          result.failed.push({ file: f.name, reason: outcome.reason });
          // Keep the copy we have; it is retried on the next sync.
          const old = live?.files[f.name];
          if (old && (await exists(join(this.opts.dir, f.name)))) {
            await copyFile(join(this.opts.dir, f.name), join(this.stagingDir, f.name));
            manifest.files[f.name] = { hash: `stale:${old.hash}`, hashKind: old.hashKind };
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    if (signal?.aborted) {
      await rm(this.stagingDir, { recursive: true, force: true });
      return fail('sync cancelled');
    }
    if (toDownload.length > 0 && downloaded === 0) {
      await rm(this.stagingDir, { recursive: true, force: true });
      return fail(`every download failed (${result.failed[0]?.file}: ${result.failed[0]?.reason}); the current catalogue is kept`);
    }
    if (live) for (const name of Object.keys(live.files)) if (!seen.has(name.toLowerCase())) result.removed++;
    result.total = Object.keys(manifest.files).length;
    await atomicWrite(join(this.stagingDir, MANIFEST), JSON.stringify(manifest, null, 2));

    // ---- swap: live -> previous, staging -> live
    await rm(this.previousDir, { recursive: true, force: true });
    if (await exists(this.opts.dir)) await rename(this.opts.dir, this.previousDir);
    try {
      await rename(this.stagingDir, this.opts.dir);
    } catch (err) {
      // Put the old copy back so the catalogue never ends up empty.
      if (await exists(this.previousDir)) await rename(this.previousDir, this.opts.dir).catch(() => undefined);
      return fail(`could not install the new catalogue: ${err instanceof Error ? err.message : String(err)}`);
    }

    state.lastSyncAt = startedAt;
    state.lastSuccessAt = startedAt;
    state.lastError = null;
    // Failed files must be retried next time even if the listing is unchanged.
    state.etag = result.failed.length ? null : res.headers.get('etag');
    state.etagUrl = url;
    await this.writeState(state);
    await this.opts.store.reload();
    this.opts.log?.info(
      { added: result.added, updated: result.updated, removed: result.removed, unchanged: result.unchanged, failed: result.failed.length },
      'community catalogue synced',
    );
    return result;
  }

  private async download(f: ListingFile, signal: AbortSignal | undefined): Promise<{ ok: true; data: Uint8Array } | { ok: false; reason: string }> {
    if (f.size !== undefined && f.size > MAX_FILE_BYTES) return { ok: false, reason: `larger than ${MAX_FILE_BYTES} bytes` };
    try {
      const res = await this.get(f.url, signal);
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.byteLength > MAX_FILE_BYTES) return { ok: false, reason: `larger than ${MAX_FILE_BYTES} bytes` };
      const hash = hashOf(f.hashKind, data);
      if (hash !== f.hash) return { ok: false, reason: `hash mismatch (listing ${f.hash.slice(0, 12)}, file ${hash.slice(0, 12)})` };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- rollback -------------------------------------------------------------------------

  /**
   * Swap the live catalogue with the copy the last sync replaced. The listing's ETag is kept,
   * so the rolled-back copy stays until the source publishes something new.
   */
  async rollback(): Promise<CommunityCatalogueStatus> {
    if ((await this.readManifest(this.previousDir)) === null) {
      throw new CommunityCatalogueError('NOT_FOUND', 'there is no previous catalogue to roll back to');
    }
    const parked = `${this.opts.dir}.rollback`;
    await rm(parked, { recursive: true, force: true });
    const hadLive = await exists(this.opts.dir);
    if (hadLive) await rename(this.opts.dir, parked);
    try {
      await rename(this.previousDir, this.opts.dir);
    } catch (err) {
      if (hadLive) await rename(parked, this.opts.dir).catch(() => undefined);
      throw new CommunityCatalogueError('UPSTREAM', `rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (hadLive) await rename(parked, this.previousDir);
    await this.opts.store.reload();
    this.opts.log?.info('community catalogue rolled back to the previous sync');
    return this.status();
  }
}

function rateLimitHint(res: Response): string {
  if (res.status !== 403 && res.status !== 429) return '';
  if (res.headers.get('x-ratelimit-remaining') !== '0') return '';
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(reset) || reset <= 0) return ' (rate limited)';
  return ` (rate limited until ${new Date(reset * 1000).toISOString()})`;
}

async function countYaml(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).length;
  } catch {
    return 0;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
