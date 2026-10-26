import type { IndexerProxy, IndexerProxyCreate, IndexerProxyTestResult, IndexerProxyType } from '@arclight/shared';
import { INDEXER_PROXY_SECRET_MASK } from '@arclight/shared';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import type { TestOutcome } from '../../../components/forms/test-result.js';

// Indexer proxies (FlareSolverr / HTTP / SOCKS5): editor fields and body mapping.

export const PROXY_TYPE_LABELS: Record<IndexerProxyType, string> = {
  flaresolverr: 'FlareSolverr',
  http: 'HTTP',
  socks5: 'SOCKS5',
};

export const DEFAULT_PORTS: Record<IndexerProxyType, number> = { flaresolverr: 8191, http: 8080, socks5: 1080 };

export function proxyFields(type: IndexerProxyType): FieldDefinition[] {
  const fields: FieldDefinition[] = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    {
      name: 'type',
      label: 'Type',
      type: 'select',
      required: true,
      options: (Object.keys(PROXY_TYPE_LABELS) as IndexerProxyType[]).map((t) => ({ value: t, label: PROXY_TYPE_LABELS[t] })),
    },
    {
      name: 'host',
      label: 'Host',
      type: 'text',
      required: true,
      placeholder: type === 'flaresolverr' ? 'http://flaresolverr' : 'proxy.example',
    },
    { name: 'port', label: 'Port', type: 'number', required: true, min: 1, max: 65535 },
  ];
  if (type !== 'flaresolverr') {
    fields.push({ name: 'username', label: 'Username', type: 'text' }, { name: 'password', label: 'Password', type: 'password' });
  }
  fields.push(
    { name: 'requestTimeout', label: 'Request timeout', type: 'number', min: 1, max: 600, unit: 's', advanced: true },
    { name: 'tags', label: 'Tags', type: 'text', helpText: 'Applies to indexers with a matching tag (unless an indexer picks a proxy explicitly).' },
  );
  return fields;
}

export function newProxy(type: IndexerProxyType = 'flaresolverr'): FormValues {
  return { name: '', type, host: type === 'flaresolverr' ? 'http://localhost' : '', port: DEFAULT_PORTS[type], tags: [] };
}

/** Form values -> create/update body. The mask round-trips so the stored password is kept. */
export function toProxyBody(values: FormValues): IndexerProxyCreate {
  const v = values as Partial<IndexerProxy>;
  const type = v.type ?? 'flaresolverr';
  const body: IndexerProxyCreate = {
    name: String(v.name ?? '').trim(),
    type,
    host: String(v.host ?? '').trim(),
    port: Number(v.port ?? DEFAULT_PORTS[type]),
    tags: v.tags ?? [],
  };
  if (type !== 'flaresolverr') {
    if (v.username) body.username = v.username;
    if (v.password !== undefined && v.password !== '') body.password = v.password;
  }
  if (typeof v.requestTimeout === 'number') body.requestTimeout = v.requestTimeout;
  return body;
}

export function proxyTestOutcome(r: IndexerProxyTestResult): TestOutcome {
  return {
    ok: r.ok,
    message: r.ok ? `${r.message} (${r.durationMs} ms)` : undefined,
    warnings: [],
    errors: r.ok ? [] : [r.message],
  };
}

export function proxyAddress(p: Pick<IndexerProxy, 'host' | 'port'>): string {
  return `${p.host}:${p.port}`;
}

export const hasStoredPassword = (p: Pick<IndexerProxy, 'password'>) => p.password === INDEXER_PROXY_SECRET_MASK;
