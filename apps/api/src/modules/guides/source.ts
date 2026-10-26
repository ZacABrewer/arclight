import { eq } from 'drizzle-orm';
import { TRASH_GUIDES_REPO_URL, type GuideApp, type GuidesFetchStats, type GuidesSettings } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { guidesCache } from './schema.js';

// Reading a guide repository. Files come from raw-content URLs (`<repoUrl><branch>/<path>`);
// directories are listed through the GitHub contents API for GitHub-hosted repos (which also
// reports each file's git blob sha, so unchanged files are never downloaded again) or through
// a `<dir>/index.json` file name list on any other host. Every response is cached in
// `guides_cache` with its ETag for conditional requests.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GuideSourceError extends Error {
  constructor(
    readonly code: 'HTTP' | 'NETWORK' | 'PARSE',
    message: string,
  ) {
    super(message);
    this.name = 'GuideSourceError';
  }
}

export interface GuideRepositoryOptions {
  db: Db;
  fetch?: FetchLike;
  settings: Pick<GuidesSettings, 'source' | 'repoUrl' | 'branch'>;
  signal?: AbortSignal;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Parallel downloads. Default 8. */
  concurrency?: number;
  now?: () => Date;
}

export interface ListedFile {
  path: string;
  /** Git blob sha when the listing reports one. */
  sha: string | null;
}

export interface RawGuideFile {
  path: string;
  data: unknown;
}

/** Owner/repo of a GitHub-hosted repository URL (raw or web form), else null. */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'raw.githubusercontent.com' && u.hostname !== 'github.com') return null;
  const [owner, repo] = u.pathname.split('/').filter(Boolean);
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

export class GuideRepository {
  readonly stats: GuidesFetchStats = { files: 0, cached: 0, requests: 0 };
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly github: { owner: string; repo: string } | null;

  constructor(private readonly opts: GuideRepositoryOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    const repoUrl = opts.settings.source === 'trash' ? TRASH_GUIDES_REPO_URL : opts.settings.repoUrl;
    const root = repoUrl.endsWith('/') ? repoUrl : `${repoUrl}/`;
    this.github = githubRepoOf(root);
    // A github.com web URL still reads files from raw.githubusercontent.com.
    this.base = this.github
      ? `https://raw.githubusercontent.com/${this.github.owner}/${this.github.repo}/${opts.settings.branch}/`
      : `${root}${opts.settings.branch}/`;
  }

  rawUrl(path: string): string {
    return `${this.base}${path.replace(/^\/+/, '')}`;
  }

  /** GET a URL through the cache. `sha` equal to the cached one skips the request entirely. */
  async getText(url: string, sha: string | null = null): Promise<string> {
    const cached = this.opts.db.select().from(guidesCache).where(eq(guidesCache.url, url)).get();
    if (sha && cached?.sha === sha) {
      this.stats.cached++;
      return cached.body;
    }
    const headers: Record<string, string> = { 'user-agent': 'Arclight' };
    if (url.startsWith('https://api.github.com/')) headers['accept'] = 'application/vnd.github+json';
    if (cached?.etag) headers['if-none-match'] = cached.etag;

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      this.stats.requests++;
      res = await this.fetchImpl(url, { headers, signal });
    } catch (err) {
      throw new GuideSourceError('NETWORK', `${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    if (res.status === 304 && cached) {
      this.stats.cached++;
      this.opts.db.update(guidesCache).set({ fetchedAt: now, ...(sha ? { sha } : {}) }).where(eq(guidesCache.url, url)).run();
      return cached.body;
    }
    if (!res.ok) throw new GuideSourceError('HTTP', `${url}: HTTP ${res.status}`);
    const body = await res.text();
    const row = { etag: res.headers.get('etag'), sha, body, fetchedAt: now };
    this.opts.db
      .insert(guidesCache)
      .values({ url, ...row })
      .onConflictDoUpdate({ target: guidesCache.url, set: row })
      .run();
    return body;
  }

  async getJson(path: string, sha: string | null = null): Promise<unknown> {
    const url = this.rawUrl(path);
    const text = await this.getText(url, sha);
    this.stats.files++;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new GuideSourceError('PARSE', `${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** JSON files of a directory. */
  async list(dir: string): Promise<ListedFile[]> {
    const clean = dir.replace(/^\/+|\/+$/g, '');
    if (this.github) {
      const { owner, repo } = this.github;
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${clean}?ref=${encodeURIComponent(this.opts.settings.branch)}`;
      const data = parseJson(await this.getText(url), url);
      if (!Array.isArray(data)) throw new GuideSourceError('PARSE', `${url}: expected a directory listing`);
      return data
        .filter((e): e is { type: string; path: string; name: string; sha?: unknown } => isObj(e) && e.type === 'file' && typeof e.path === 'string' && typeof e.name === 'string')
        .filter((e) => e.name.toLowerCase().endsWith('.json'))
        .map((e) => ({ path: e.path, sha: typeof e.sha === 'string' ? e.sha : null }))
        .sort((a, b) => a.path.localeCompare(b.path));
    }
    const url = this.rawUrl(`${clean}/index.json`);
    const data = parseJson(await this.getText(url), url);
    if (!Array.isArray(data)) throw new GuideSourceError('PARSE', `${url}: expected an array of file names`);
    const out: ListedFile[] = [];
    for (const e of data) {
      const name = typeof e === 'string' ? e : isObj(e) && typeof e.name === 'string' ? e.name : null;
      if (!name || !name.toLowerCase().endsWith('.json') || name.includes('..') || name === 'index.json') continue;
      out.push({ path: `${clean}/${name}`, sha: isObj(e) && typeof e.sha === 'string' ? e.sha : null });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Download listed files with bounded parallelism; unreadable ones are reported, not thrown. */
  async readAll(files: ListedFile[]): Promise<{ files: RawGuideFile[]; errors: string[] }> {
    const out: RawGuideFile[] = [];
    const errors: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++]!;
        try {
          out.push({ path: f.path, data: await this.getJson(f.path, f.sha) });
        } catch (err) {
          if (err instanceof GuideSourceError && err.code !== 'PARSE') throw err;
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 8, Math.max(1, files.length)) }, worker));
    out.sort((a, b) => a.path.localeCompare(b.path));
    return { files: out, errors };
  }
}

export interface GuideDirectories {
  customFormats: string[];
  qualityProfiles: string[];
}

/** `json_paths` of the guide's metadata.json for one app. */
export function directoriesFromMetadata(metadata: unknown, app: GuideApp): GuideDirectories | null {
  if (!isObj(metadata) || !isObj(metadata.json_paths)) return null;
  const paths = metadata.json_paths[app];
  if (!isObj(paths)) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { customFormats: strings(paths.custom_formats), qualityProfiles: strings(paths.quality_profiles) };
}

export interface FetchedGuide {
  formats: Array<RawGuideFile & { app: GuideApp }>;
  profiles: Array<RawGuideFile & { app: GuideApp }>;
  warnings: string[];
}

/** Read metadata.json, then every custom-format (unless `profilesOnly`) and quality-profile file. */
export async function fetchGuide(repo: GuideRepository, apps: readonly GuideApp[], opts: { profilesOnly?: boolean } = {}): Promise<FetchedGuide> {
  const metadata = await repo.getJson('metadata.json');
  const result: FetchedGuide = { formats: [], profiles: [], warnings: [] };
  for (const app of apps) {
    const dirs = directoriesFromMetadata(metadata, app);
    if (!dirs) {
      result.warnings.push(`metadata.json has no ${app} section`);
      continue;
    }
    const groups: Array<['formats' | 'profiles', string[]]> = [['profiles', dirs.qualityProfiles]];
    if (!opts.profilesOnly) groups.unshift(['formats', dirs.customFormats]);
    for (const [kind, list] of groups) {
      for (const dir of list) {
        const listed = await repo.list(dir);
        const read = await repo.readAll(listed);
        result[kind].push(...read.files.map((f) => ({ ...f, app })));
        result.warnings.push(...read.errors);
      }
    }
  }
  return result;
}

function parseJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new GuideSourceError('PARSE', `${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
