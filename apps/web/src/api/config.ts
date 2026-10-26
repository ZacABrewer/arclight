import { ConfigImportResult, ConfigManagedKeys, ConfigValidateResult } from '@arclight/shared';
import { ApiError, buildUrl, request } from './client.js';

// Config as code (apps/api/src/modules/config-export; docs/API.md "config").

export type ConfigFormat = 'yaml' | 'json';

export interface ConfigImportBody {
  content: string;
  dryRun: boolean;
  prune: boolean;
}

export const CONFIG_EXPORT_CONFIRM = 'export-secrets';

export function configFileName(format: ConfigFormat): string {
  return format === 'yaml' ? 'arclight-config.yml' : 'arclight-config.json';
}

export function configExportUrl(format: ConfigFormat, includeSecrets: boolean): string {
  return buildUrl('/config/export', { format, includeSecrets: includeSecrets ? 'true' : undefined });
}

async function apiErrorFrom(res: Response, path: string, data?: unknown): Promise<ApiError> {
  let body = data;
  if (body === undefined) body = await res.json().catch(() => null);
  const err = (body ?? {}) as { error?: string; code?: string };
  return new ApiError(res.status, err.error ?? `${res.status} ${res.statusText}`.trim(), path, err.code);
}

/** Fetch the export as text. Secrets need the `X-Confirm: export-secrets` header. */
async function exportText(format: ConfigFormat, includeSecrets: boolean): Promise<string> {
  const headers: Record<string, string> = {};
  if (includeSecrets) headers['x-confirm'] = CONFIG_EXPORT_CONFIRM;
  const res = await fetch(configExportUrl(format, includeSecrets), { credentials: 'same-origin', headers });
  if (!res.ok) throw await apiErrorFrom(res, '/config/export');
  return res.text();
}

/**
 * Import answers 422 with a full ConfigImportResult when an apply has errors: that body is
 * returned as the result (not thrown) so the preview can list the problems.
 */
async function importConfig(body: ConfigImportBody): Promise<ConfigImportResult> {
  const res = await fetch(buildUrl('/config/import'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  const parsed = ConfigImportResult.safeParse(data);
  if (parsed.success && (res.ok || res.status === 422)) return parsed.data;
  throw await apiErrorFrom(res, '/config/import', data);
}

export const configApi = {
  exportText,
  import: importConfig,
  validate: (content: string) => request('/config/validate', ConfigValidateResult, { method: 'POST', json: { content } }),
  managedKeys: () => request('/config/managed-keys', ConfigManagedKeys),
};

/** Save text as a file through a temporary object URL. */
export function downloadText(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
