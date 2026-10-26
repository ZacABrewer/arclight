import type { IndexerProxy, IndexerProxyCreate, IndexerProxyTestResult, IndexerProxyType } from '@arclight/shared';
import { INDEXER_PROXY_SECRET_MASK, IndexerProxyTestResult as IndexerProxyTestResultSchema } from '@arclight/shared';
import { request } from '../../../api/client.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import type { TestOutcome } from '../../../components/forms/test-result.js';
import { t } from '../../../i18n/index.js';

// Indexer proxies (FlareSolverr / HTTP / SOCKS5): editor fields and body mapping.

export const PROXY_TYPE_LABELS: Record<IndexerProxyType, string> = {
  get flaresolverr() {
    return t('settings.indexerProxies.proxy.flaresolverr');
  },
  get http() {
    return t('settings.indexerProxies.proxy.http');
  },
  get socks5() {
    return t('settings.indexerProxies.proxy.socks5');
  },
};

export const DEFAULT_PORTS: Record<IndexerProxyType, number> = { flaresolverr: 8191, http: 8080, socks5: 1080 };

export function proxyFields(type: IndexerProxyType): FieldDefinition[] {
  const fields: FieldDefinition[] = [
    { name: 'name', label: t('common.name'), type: 'text', required: true },
    {
      name: 'type',
      label: t('common.type'),
      type: 'select',
      required: true,
      options: (Object.keys(PROXY_TYPE_LABELS) as IndexerProxyType[]).map((item) => ({ value: item, label: PROXY_TYPE_LABELS[item] })),
    },
    {
      name: 'host',
      label: t('common.host'),
      type: 'text',
      required: true,
      placeholder: type === 'flaresolverr' ? 'http://flaresolverr' : 'proxy.example',
    },
    { name: 'port', label: t('common.port'), type: 'number', required: true, min: 1, max: 65535 },
  ];
  if (type !== 'flaresolverr') {
    fields.push({ name: 'username', label: t('common.username'), type: 'text' }, { name: 'password', label: t('common.password'), type: 'password' });
  }
  fields.push(
    { name: 'requestTimeout', label: t('settings.indexerProxies.proxy.requestTimeout'), type: 'number', min: 1, max: 600, unit: 's', advanced: true },
    { name: 'tags', label: t('common.tags'), type: 'text', helpText: t('settings.indexerProxies.proxy.appliesToIndexersWithA') },
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
    message: r.ok ? t('settings.indexerProxies.proxy.messageDurationmsMs', { message: r.message, durationMs: r.durationMs }) : undefined,
    warnings: [],
    errors: r.ok ? [] : [r.message],
  };
}

export function proxyAddress(p: Pick<IndexerProxy, 'host' | 'port'>): string {
  return `${p.host}:${p.port}`;
}

export const hasStoredPassword = (p: Pick<IndexerProxy, 'password'>) => p.password === INDEXER_PROXY_SECRET_MASK;

/** Test a saved proxy with its stored password (POST /indexerproxy/:id/test). */
export function testSavedProxy(id: number): Promise<IndexerProxyTestResult> {
  return request(`/indexerproxy/${id}/test`, IndexerProxyTestResultSchema, { method: 'POST', json: {} });
}

/** Names ProxyAutoDetect gives the proxies it creates (apps/api/src/modules/solver/autodetect.ts). */
export const MANAGED_PROXY_NAMES = ['FlareSolverr (bundled)', 'Built-in solver', 'Built-in solver (Arclight)'] as const;

/** Created (and, for the built-in solver, kept in sync) by Arclight rather than the user. */
export function isManagedProxy(p: Pick<IndexerProxy, 'name'> & { managed?: boolean | undefined }): boolean {
  return p.managed === true || (MANAGED_PROXY_NAMES as readonly string[]).includes(p.name);
}

/** At least one FlareSolverr-type proxy (bundled, external or the built-in solver) exists. */
export function hasSolverProxy(proxies: ReadonlyArray<Pick<IndexerProxy, 'type'>> | undefined): boolean {
  return (proxies ?? []).some((p) => p.type === 'flaresolverr');
}
