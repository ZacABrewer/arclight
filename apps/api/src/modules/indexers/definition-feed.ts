import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { NotificationEvent } from '@arclight/notifications';
import { parseDefinitionYaml } from '@arclight/indexers';
import {
  DEFAULT_DEFINITION_FEED_URL,
  DEFINITION_FEED_SCHEMA_VERSION,
  DefinitionFeedIndex,
  type DefinitionFeedRejection,
  type DefinitionFeedSettings,
  type DefinitionFeedStatus,
  type DefinitionFeedSyncResult,
} from '@arclight/shared';
import type { FeedStatusReport } from '../../feeds.js';
import type { DefinitionStore } from './definitions.js';

// Definition feed: a remote `index.json` ({ schemaVersion, definitions: [{ id, version, file,
// sha256 }] }) plus the YAML files it names. Changed files are downloaded into
// `<config>/definitions/feed/`, verified (sha256 over the LF-normalised text, then the package
// parser, then the id) and the catalogue is reloaded. Feed definitions override builtin ones
// by id; user definitions in `<config>/definitions` override both. The version a sync
// replaces is kept in `feed/.previous/` and POST .../rollback/:id restores it (and holds the
// rolled-back version off until the feed publishes a different one).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DefinitionFeedError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'UPSTREAM',
    message: string,
  ) {
    super(message);
    this.name = 'DefinitionFeedError';
  }
}

interface InstalledEntry {
  version: string;
  sha256: string;
  file: string;
  installedAt: string;
  previous: { version: string; sha256: string } | null;
  /** Set by a rollback: the feed version (sha) the user rolled back from, skipped until it changes. */
  heldBack?: string;
}

interface FeedStateFile {
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  schemaVersion: number | null;
  indexEtag: string | null;
  installed: Record<string, InstalledEntry>;
  rejected: DefinitionFeedRejection[];
  /**
   * When the default feed's index answered 404 (the repository is not published yet): an info
   * condition, not a failure, so the feed is neither an error nor stale.
   */
  notPublishedAt?: string | null;
}

/** Shown while the default feed's index is a 404. */
export const FEED_NOT_PUBLISHED = 'feed not published yet';

const EMPTY_STATE: FeedStateFile = {
  lastSyncAt: null,
  lastSuccessAt: null,
  lastError: null,
  schemaVersion: null,
  indexEtag: null,
  installed: {},
  rejected: [],
};

const STATE_FILE = '.state.json';
const PREVIOUS_DIR = '.previous';

/** sha256 hex of a definition file: UTF-8 text with CRLF normalised to LF. */
export function definitionSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export interface DefinitionFeedOptions {
  store: DefinitionStore;
  /** `<config>/definitions/feed`; must be the store's feedDir. */
  feedDir: string;
  settings: () => DefinitionFeedSettings;
  fetch?: FetchLike;
  log?: Logger;
  notify?: (event: NotificationEvent) => Promise<unknown>;
  now?: () => Date;
  timeoutMs?: number;
}

export class DefinitionFeed {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private running: Promise<DefinitionFeedSyncResult> | undefined;
  private cache: FeedStateFile | undefined;

  constructor(private readonly opts: DefinitionFeedOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
  }

  // ---- state ----------------------------------------------------------------------------

  private async readState(): Promise<FeedStateFile> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(join(this.opts.feedDir, STATE_FILE), 'utf8')) as Partial<FeedStateFile>;
      this.cache = { ...EMPTY_STATE, ...parsed, installed: parsed.installed ?? {}, rejected: parsed.rejected ?? [] };
    } catch {
      this.cache = structuredClone(EMPTY_STATE);
    }
    return this.cache;
  }

  private async writeState(state: FeedStateFile): Promise<void> {
    this.cache = state;
    await mkdir(this.opts.feedDir, { recursive: true });
    await atomicWrite(join(this.opts.feedDir, STATE_FILE), JSON.stringify(state, null, 2));
  }

  async status(): Promise<DefinitionFeedStatus> {
    const state = await this.readState();
    return {
      settings: this.opts.settings(),
      lastSyncAt: state.lastSyncAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      schemaVersion: state.schemaVersion,
      installed: Object.entries(state.installed)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, e]) => ({
          id,
          version: e.version,
          sha256: e.sha256,
          installedAt: e.installedAt,
          previousVersion: e.previous?.version ?? null,
          active: this.opts.store.source(id) === 'feed',
        })),
      rejected: state.rejected,
    };
  }

  /** Report for the feeds registry. */
  async feedStatus(): Promise<FeedStatusReport> {
    const s = this.opts.settings();
    const state = await this.readState();
    const count = Object.keys(state.installed).length;
    if (state.notPublishedAt && state.lastSuccessAt === null) {
      return {
        enabled: s.enabled,
        intervalMs: s.mode === 'auto' ? s.intervalHours * 3_600_000 : null,
        lastSyncAt: state.lastSyncAt,
        lastSuccessAt: null,
        lastError: null,
        pending: null,
        notPublished: true,
        detail: `${FEED_NOT_PUBLISHED} (${s.url}index.json returned 404); builtin definitions are used`,
      };
    }
    return {
      enabled: s.enabled,
      intervalMs: s.mode === 'auto' ? s.intervalHours * 3_600_000 : null,
      lastSyncAt: state.lastSyncAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      pending: null,
      detail: `${count} definition${count === 1 ? '' : 's'} from ${s.url}${state.rejected.length ? `, ${state.rejected.length} rejected` : ''}`,
    };
  }

  // ---- sync -----------------------------------------------------------------------------

  /** Concurrent calls share one run. */
  sync(opts: { signal?: AbortSignal } = {}): Promise<DefinitionFeedSyncResult> {
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
        headers: { 'user-agent': 'Arclight', ...headers },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new DefinitionFeedError('UPSTREAM', `${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runSync(signal?: AbortSignal): Promise<DefinitionFeedSyncResult> {
    const settings = this.opts.settings();
    const base = settings.url.endsWith('/') ? settings.url : `${settings.url}/`;
    const state = structuredClone(await this.readState());
    const startedAt = this.now().toISOString();
    const fail = async (message: string): Promise<never> => {
      state.lastSyncAt = startedAt;
      state.lastError = message;
      await this.writeState(state);
      this.opts.log?.warn({ url: base }, `definition feed sync failed: ${message}`);
      throw new DefinitionFeedError('UPSTREAM', message);
    };

    // ---- index
    const indexUrl = `${base}index.json`;
    const filesPresent = await this.allInstalledPresent(state);
    const res = await this.get(indexUrl, signal, state.indexEtag && filesPresent ? { 'if-none-match': state.indexEtag } : {}).catch((err: unknown) =>
      fail(err instanceof Error ? err.message : String(err)),
    );
    const result: DefinitionFeedSyncResult = { notModified: false, added: [], updated: [], removed: [], unchanged: 0, rejected: [] };
    if (res.status === 304) {
      state.lastSyncAt = startedAt;
      state.lastSuccessAt = startedAt;
      state.lastError = null;
      await this.writeState(state);
      return { ...result, notModified: true, unchanged: Object.keys(state.installed).length };
    }
    if (res.status === 404 && base === DEFAULT_DEFINITION_FEED_URL) {
      // The default feed is this repository's own folder on GitHub raw; until the repository is
      // published that is a 404. Info, not a stale-feed warning: the builtins are current anyway.
      state.lastSyncAt = startedAt;
      state.lastError = null;
      state.notPublishedAt = startedAt;
      await this.writeState(state);
      this.opts.log?.info({ url: indexUrl }, FEED_NOT_PUBLISHED);
      return { ...result, unchanged: Object.keys(state.installed).length };
    }
    if (!res.ok) return fail(`${indexUrl}: HTTP ${res.status}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await res.text()) as unknown;
    } catch {
      return fail(`${indexUrl}: not JSON`);
    }
    const parsed = DefinitionFeedIndex.safeParse(raw);
    if (!parsed.success) return fail(`${indexUrl}: invalid index (${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''})`.trim());
    const index = parsed.data;
    if (index.schemaVersion > DEFINITION_FEED_SCHEMA_VERSION || index.schemaVersion < 1) {
      return fail(`${indexUrl}: schemaVersion ${index.schemaVersion} is not supported (this build reads ${DEFINITION_FEED_SCHEMA_VERSION})`);
    }

    // ---- entries
    await mkdir(join(this.opts.feedDir, PREVIOUS_DIR), { recursive: true });
    const seen = new Set<string>();
    for (const entry of index.definitions) {
      if (seen.has(entry.id)) {
        result.rejected.push({ id: entry.id, version: entry.version, reason: 'listed twice in the index' });
        continue;
      }
      seen.add(entry.id);
      const current = state.installed[entry.id];
      const present = current ? await exists(this.currentPath(entry.id)) : false;
      if (current && present && (current.sha256 === entry.sha256 || current.heldBack === entry.sha256)) {
        result.unchanged++;
        continue;
      }
      const fileUrl = new URL(entry.file, base).toString();
      let text: string;
      try {
        const fr = await this.get(fileUrl, signal);
        if (!fr.ok) throw new Error(`HTTP ${fr.status}`);
        text = await fr.text();
      } catch (err) {
        result.rejected.push({ id: entry.id, version: entry.version, reason: `download failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const sha = definitionSha256(text);
      if (sha !== entry.sha256) {
        result.rejected.push({ id: entry.id, version: entry.version, reason: `sha256 mismatch (index ${entry.sha256.slice(0, 12)}, file ${sha.slice(0, 12)})` });
        continue;
      }
      try {
        const def = parseDefinitionYaml(text, { fileKey: entry.id });
        if (def.id !== entry.id) throw new Error(`file declares id "${def.id}"`);
      } catch (err) {
        result.rejected.push({ id: entry.id, version: entry.version, reason: `invalid definition: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      if (current && present) await copyFile(this.currentPath(entry.id), this.previousPath(entry.id));
      await atomicWrite(this.currentPath(entry.id), text);
      state.installed[entry.id] = {
        version: entry.version,
        sha256: entry.sha256,
        file: entry.file,
        installedAt: startedAt,
        previous: current && present ? { version: current.version, sha256: current.sha256 } : null,
      };
      (current && present ? result.updated : result.added).push(entry.id);
    }

    // ---- removals: no longer published; the file moves to .previous
    for (const id of Object.keys(state.installed)) {
      if (seen.has(id)) continue;
      if (await exists(this.currentPath(id))) await rename(this.currentPath(id), this.previousPath(id));
      delete state.installed[id];
      result.removed.push(id);
    }

    state.lastSyncAt = startedAt;
    state.lastSuccessAt = startedAt;
    state.lastError = null;
    state.notPublishedAt = null;
    state.schemaVersion = index.schemaVersion;
    state.indexEtag = res.headers.get('etag');
    state.rejected = result.rejected;
    // A rejected entry must be retried next time even if the index is unchanged.
    if (result.rejected.length) state.indexEtag = null;
    await this.writeState(state);

    const changed = result.added.length + result.updated.length + result.removed.length;
    if (changed > 0) {
      await this.opts.store.reload();
      await this.announce(result);
    }
    for (const r of result.rejected) this.opts.log?.warn({ id: r.id, version: r.version }, `feed definition rejected: ${r.reason}`);
    this.opts.log?.info(
      { added: result.added.length, updated: result.updated.length, removed: result.removed.length, rejected: result.rejected.length },
      'definition feed synced',
    );
    return result;
  }

  private async announce(r: DefinitionFeedSyncResult): Promise<void> {
    if (!this.opts.notify) return;
    const parts = [
      r.added.length ? `added ${r.added.join(', ')}` : '',
      r.updated.length ? `updated ${r.updated.join(', ')}` : '',
      r.removed.length ? `removed ${r.removed.join(', ')}` : '',
    ].filter(Boolean);
    try {
      await this.opts.notify({
        type: 'applicationUpdate',
        instanceName: 'Arclight',
        timestamp: this.now().toISOString(),
        previousVersion: 'indexer definitions',
        newVersion: 'indexer definitions (feed)',
        message: `Indexer definition feed: ${parts.join('; ')}.`,
      });
    } catch (err) {
      this.opts.log?.warn({ err }, 'definition feed notification failed');
    }
  }

  // ---- rollback -------------------------------------------------------------------------

  /** Swap a feed definition with its kept previous version and reload. */
  async rollback(id: string): Promise<DefinitionFeedStatus> {
    const state = structuredClone(await this.readState());
    const entry = state.installed[id];
    if (!entry) throw new DefinitionFeedError('NOT_FOUND', `"${id}" is not installed from the feed`);
    if (!entry.previous || !(await exists(this.previousPath(id)))) {
      throw new DefinitionFeedError('VALIDATION', `"${id}" has no previous version to roll back to`);
    }
    const previousText = await readFile(this.previousPath(id), 'utf8');
    try {
      parseDefinitionYaml(previousText, { fileKey: id });
    } catch (err) {
      throw new DefinitionFeedError('VALIDATION', `previous version of "${id}" no longer parses: ${err instanceof Error ? err.message : String(err)}`);
    }
    const currentText = (await exists(this.currentPath(id))) ? await readFile(this.currentPath(id), 'utf8') : null;
    await atomicWrite(this.currentPath(id), previousText);
    if (currentText !== null) await atomicWrite(this.previousPath(id), currentText);
    state.installed[id] = {
      version: entry.previous.version,
      sha256: entry.previous.sha256,
      file: entry.file,
      installedAt: this.now().toISOString(),
      previous: { version: entry.version, sha256: entry.sha256 },
      heldBack: entry.sha256,
    };
    await this.writeState(state);
    await this.opts.store.reload();
    this.opts.log?.info({ id, version: entry.previous.version }, 'feed definition rolled back');
    return this.status();
  }

  private currentPath(id: string): string {
    return join(this.opts.feedDir, `${id}.yml`);
  }

  private previousPath(id: string): string {
    return join(this.opts.feedDir, PREVIOUS_DIR, `${id}.yml`);
  }

  private async allInstalledPresent(state: FeedStateFile): Promise<boolean> {
    for (const id of Object.keys(state.installed)) if (!(await exists(this.currentPath(id)))) return false;
    return true;
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
