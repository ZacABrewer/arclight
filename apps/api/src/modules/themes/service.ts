import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BASE_THEME_ID,
  THEME_LIMITS,
  ThemeIndex,
  ThemeSyncState,
  compareThemeVersions,
  type ThemeCatalog,
  type ThemeIndexEntry,
  type ThemeInfo,
  type ThemeSettings,
  type ThemeStatus,
  type ThemeSyncResult,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { getSection, setSection } from '../settings/service.js';
import { TRON_INFO, mergePacks, packInfo, readPack, readPacks, type PackProblem, type ThemePack } from './store.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ThemesServiceOptions {
  db: Db;
  log: Logger;
  /** Packs shipped with the app; null when there are none. */
  bundledDir: string | null;
  /** Where synced packs are written (`<config>/themes`). */
  syncedDir: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

const INDEX_MAX_BYTES = 256 * 1024;
const STATE_FILE = '.sync-state.json';

/** Theme packs: the catalogue every client reads, the files they load, and the sync from the repository. */
export class ThemesService {
  private packs = new Map<string, ThemePack>();
  private problems: PackProblem[] = [];
  private syncing: Promise<ThemeSyncResult> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly opts: ThemesServiceOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
    this.reload();
  }

  /** Re-reads both pack roots. */
  reload(): void {
    const bundled = readPacks(this.opts.bundledDir, 'bundled');
    const synced = readPacks(this.opts.syncedDir, 'synced');
    this.packs = mergePacks(bundled.packs, synced.packs);
    this.problems = [...bundled.problems, ...synced.problems];
    for (const p of this.problems) this.opts.log.warn({ theme: p.id, source: p.source, err: p.error }, 'theme pack skipped');
  }

  settings(): ThemeSettings {
    return getSection(this.opts.db, 'themes');
  }

  updateSettings(value: ThemeSettings): ThemeSettings {
    return setSection(this.opts.db, 'themes', value, this.now().toISOString());
  }

  themes(): ThemeInfo[] {
    const packs = [...this.packs.values()].map(packInfo).sort((a, b) => a.name.localeCompare(b.name));
    return [TRON_INFO, ...packs];
  }

  catalog(): ThemeCatalog {
    const s = this.settings();
    // A default that no longer exists (pack removed) falls back to the built-in look.
    const defaultTheme = s.defaultTheme === BASE_THEME_ID || this.packs.has(s.defaultTheme) ? s.defaultTheme : BASE_THEME_ID;
    return { themes: this.themes(), defaultTheme, allowUserChoice: s.allowUserChoice };
  }

  status(): ThemeStatus {
    return { settings: this.settings(), sync: this.syncState(), themes: this.themes() };
  }

  /** Absolute path of a pack file the client may load, or null. `file` is `theme.css` or `fonts/<name>.woff2`. */
  filePath(id: string, file: string): string | null {
    const pack = this.packs.get(id);
    if (!pack) return null;
    if (file !== 'theme.css' && !pack.fonts.has(file) && !pack.images.has(file)) return null;
    return join(pack.dir, file);
  }

  version(id: string): string | null {
    return this.packs.get(id)?.manifest.version ?? null;
  }

  // ---- sync ---------------------------------------------------------------------------------

  syncState(): ThemeSyncState {
    try {
      const parsed = ThemeSyncState.safeParse(JSON.parse(readFileSync(join(this.opts.syncedDir, STATE_FILE), 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // no sync yet
    }
    return { lastSyncAt: null, lastError: null, lastChanged: [] };
  }

  private writeState(state: ThemeSyncState): void {
    mkdirSync(this.opts.syncedDir, { recursive: true });
    writeFileSync(join(this.opts.syncedDir, STATE_FILE), JSON.stringify(state));
  }

  /** Downloads packs that are new or newer than the ones installed. One sync at a time. */
  sync(opts: { signal?: AbortSignal } = {}): Promise<ThemeSyncResult> {
    this.syncing ??= this.runSync(opts.signal).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(signal?: AbortSignal): Promise<ThemeSyncResult> {
    const base = this.settings().sourceUrl.replace(/\/*$/, '/');
    const changed: string[] = [];
    const skipped: ThemeSyncResult['skipped'] = [];
    let error: string | null = null;
    try {
      const index = ThemeIndex.safeParse(JSON.parse((await this.download(`${base}index.json`, INDEX_MAX_BYTES, signal)).toString('utf8')));
      if (!index.success) throw new Error(`index.json: ${index.error.issues[0]?.message ?? 'invalid'}`);
      for (const entry of index.data.themes) {
        if (entry.id === BASE_THEME_ID) continue;
        const have = this.packs.get(entry.id);
        if (have && compareThemeVersions(entry.version, have.manifest.version) <= 0) continue;
        try {
          await this.installEntry(base, entry, signal);
          changed.push(entry.id);
        } catch (err) {
          if (signal?.aborted) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          skipped.push({ id: entry.id, reason });
          this.opts.log.warn({ theme: entry.id, err: reason }, 'theme pack not installed');
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.opts.log.warn({ err: error }, 'theme sync failed');
    }
    if (changed.length > 0) this.reload();
    this.writeState({ lastSyncAt: this.now().toISOString(), lastError: error, lastChanged: changed });
    return { ok: error === null, changed, skipped, error };
  }

  /** Downloads one pack into a temporary folder, checks every file, then swaps it in. */
  private async installEntry(base: string, entry: ThemeIndexEntry, signal?: AbortSignal): Promise<void> {
    const paths = entry.files.map((f) => f.path);
    if (!paths.includes('theme.json') || !paths.includes('theme.css')) throw new Error('the pack has no theme.json or theme.css');
    if (new Set(paths).size !== paths.length) throw new Error('the pack lists a file twice');
    const total = entry.files.reduce((n, f) => n + f.size, 0);
    if (total > THEME_LIMITS.packBytes) throw new Error(`the pack is larger than ${THEME_LIMITS.packBytes} bytes`);
    mkdirSync(this.opts.syncedDir, { recursive: true });
    const tmp = join(this.opts.syncedDir, `.tmp-${entry.id}-${randomUUID()}`);
    try {
      for (const file of entry.files) {
        const max =
          file.path === 'theme.css'
            ? THEME_LIMITS.cssBytes
            : file.path === 'theme.json'
              ? 64 * 1024
              : file.path.startsWith('images/')
                ? THEME_LIMITS.imageBytes
                : THEME_LIMITS.fontBytes;
        if (file.size > max) throw new Error(`${file.path} is larger than ${max} bytes`);
        const body = await this.download(`${base}${entry.id}/${file.path}`, max, signal);
        if (body.length !== file.size) throw new Error(`${file.path}: expected ${file.size} bytes, got ${body.length}`);
        const sha = createHash('sha256').update(body).digest('hex');
        if (sha !== file.sha256) throw new Error(`${file.path}: checksum does not match the index`);
        const dest = join(tmp, file.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, body);
      }
      const pack = readPack(tmp, entry.id, 'synced');
      if (pack.manifest.version !== entry.version) throw new Error(`theme.json says ${pack.manifest.version}, the index ${entry.version}`);
      const dest = join(this.opts.syncedDir, entry.id);
      const old = `${dest}.old-${randomUUID()}`;
      if (existsSync(dest)) renameSync(dest, old);
      renameSync(tmp, dest);
      rmSync(old, { recursive: true, force: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    const res = await this.fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${url}: larger than ${maxBytes} bytes`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw new Error(`${url}: larger than ${maxBytes} bytes`);
    return body;
  }
}
