// Image references and remote manifest digests (Docker Hub, GHCR, lscr.io, any v2 registry)
// with the anonymous bearer-token flow: request the manifest, follow the 401's
// WWW-Authenticate challenge to the realm for a pull token, retry.

export interface ImageRef {
  /** Registry host, `registry-1.docker.io` for Docker Hub. */
  registry: string;
  /** Repository path, `library/nginx` for official Docker Hub images. */
  repository: string;
  tag: string;
  /** Pinned digest (`image@sha256:…`): never updated. */
  digest?: string;
}

export const DOCKER_HUB = 'registry-1.docker.io';

export function parseImageRef(raw: string): ImageRef {
  let rest = raw.trim();
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const slash = rest.indexOf('/');
  const first = slash >= 0 ? rest.slice(0, slash) : '';
  let registry = DOCKER_HUB;
  if (slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first === 'docker.io' || first === 'index.docker.io' ? DOCKER_HUB : first;
    rest = rest.slice(slash + 1);
  }
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (registry === DOCKER_HUB && !rest.includes('/')) rest = `library/${rest}`;
  return { registry, repository: rest, tag, ...(digest ? { digest } : {}) };
}

/** Name to pull with the Engine API (`fromImage`). */
export function pullName(ref: ImageRef): string {
  return ref.registry === DOCKER_HUB ? ref.repository.replace(/^library\//, '') : `${ref.registry}/${ref.repository}`;
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

export interface RegistryOptions {
  fetchImpl?: typeof fetch;
  /** Base URL for a registry host (tests point registries at a local server). */
  baseUrl?: (registry: string) => string;
  timeoutMs?: number;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/** Parses `Bearer realm="…",service="…",scope="…"`. */
export function parseChallenge(header: string | null): { realm: string; params: Record<string, string> } | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[m[1]!.toLowerCase()] = m[2]!;
  const realm = params['realm'];
  if (!realm) return null;
  delete params['realm'];
  return { realm, params };
}

/** Digest of the manifest (or index) `ref` currently points to. */
export async function remoteDigest(ref: ImageRef, opts: RegistryOptions = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl?.(ref.registry) ?? `https://${ref.registry}`;
  const url = `${base}/v2/${ref.repository}/manifests/${ref.tag}`;
  const timeout = () => AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const head = (token?: string) =>
    doFetch(url, { method: 'HEAD', headers: { accept: MANIFEST_ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: timeout() });

  let res: Response;
  try {
    res = await head();
    if (res.status === 401) {
      const challenge = parseChallenge(res.headers.get('www-authenticate'));
      if (!challenge) throw new RegistryError(`${ref.registry} wants credentials this check does not have`);
      const tokenUrl = new URL(challenge.realm);
      for (const [k, v] of Object.entries(challenge.params)) tokenUrl.searchParams.set(k, v);
      if (!challenge.params['scope']) tokenUrl.searchParams.set('scope', `repository:${ref.repository}:pull`);
      const tokenRes = await doFetch(tokenUrl.toString(), { headers: { accept: 'application/json' }, signal: timeout() });
      if (!tokenRes.ok) throw new RegistryError(`${ref.registry} refused an anonymous token (${tokenRes.status})`);
      const body = (await tokenRes.json()) as { token?: string; access_token?: string };
      const token = body.token ?? body.access_token;
      if (!token) throw new RegistryError(`${ref.registry} returned no token`);
      res = await head(token);
    }
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryError(`${ref.registry} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new RegistryError(`${pullName(ref)}:${ref.tag} is not in ${ref.registry}`);
  if (!res.ok) throw new RegistryError(`${ref.registry} answered ${res.status} for ${pullName(ref)}:${ref.tag}`);
  const digest = res.headers.get('docker-content-digest');
  if (!digest) throw new RegistryError(`${ref.registry} sent no Docker-Content-Digest`);
  return digest;
}
