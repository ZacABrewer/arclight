// The two remote sources of an update check: GitHub releases of the repo (versions and
// notes) and the GHCR tag list of `ghcr.io/<repo>` (which versions have an image yet).
// Both are anonymous, read-only requests.

export const GITHUB_API = 'https://api.github.com';
export const GHCR = 'https://ghcr.io';

export class UpdateSourceError extends Error {
  readonly code = 'UPDATE_SOURCE';
  constructor(message: string) {
    super(message);
    this.name = 'UpdateSourceError';
  }
}

export interface GithubRelease {
  tag: string;
  name?: string;
  body: string;
  url?: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt?: string;
}

export interface UpdateSourceOptions {
  fetchImpl?: typeof fetch;
  userAgent: string;
  githubApi?: string;
  ghcr?: string;
  timeoutMs?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

async function getJson(url: string, opts: UpdateSourceOptions, headers: Record<string, string>): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { 'user-agent': opts.userAgent, ...headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new UpdateSourceError(`${new URL(url).host} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new UpdateSourceError(`${new URL(url).host} has no such repository (404)`);
  if (res.status === 403 || res.status === 429) throw new UpdateSourceError(`${new URL(url).host} rate-limited the update check (${res.status}); it retries later`);
  if (!res.ok) throw new UpdateSourceError(`${new URL(url).host} answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new UpdateSourceError(`${new URL(url).host} returned unreadable JSON`);
  }
}

/** Newest-first releases of `repo` (one page of 30 is plenty for a changelog). */
export async function fetchGithubReleases(repo: string, opts: UpdateSourceOptions): Promise<GithubRelease[]> {
  const body = await getJson(`${opts.githubApi ?? GITHUB_API}/repos/${repo}/releases?per_page=30`, opts, {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  });
  if (!Array.isArray(body)) throw new UpdateSourceError('GitHub returned an unexpected releases list');
  const out: GithubRelease[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const tag = str(r['tag_name']);
    if (!tag) continue;
    const name = str(r['name']);
    const url = str(r['html_url']);
    const publishedAt = str(r['published_at']);
    out.push({
      tag,
      body: typeof r['body'] === 'string' ? r['body'] : '',
      draft: r['draft'] === true,
      prerelease: r['prerelease'] === true,
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return out;
}

/** Tags of `ghcr.io/<repo>` via an anonymous pull token. */
export async function fetchGhcrTags(repo: string, opts: UpdateSourceOptions): Promise<string[]> {
  const base = opts.ghcr ?? GHCR;
  const image = repo.toLowerCase();
  const tokenBody = await getJson(`${base}/token?scope=${encodeURIComponent(`repository:${image}:pull`)}`, opts, { accept: 'application/json' });
  const token = tokenBody && typeof tokenBody === 'object' ? str((tokenBody as Record<string, unknown>)['token']) : undefined;
  if (!token) throw new UpdateSourceError('GHCR did not issue a pull token');
  const body = await getJson(`${base}/v2/${image}/tags/list?n=1000`, opts, { accept: 'application/json', authorization: `Bearer ${token}` });
  const tags = body && typeof body === 'object' ? (body as Record<string, unknown>)['tags'] : undefined;
  if (!Array.isArray(tags)) throw new UpdateSourceError('GHCR returned an unexpected tag list');
  return tags.filter((t): t is string => typeof t === 'string');
}
