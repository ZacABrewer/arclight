import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SECRET_MASK, type ConfigImportResult, type ConfigManagedKeys } from '@arclight/shared';
import { configExportUrl, configFileName } from '../../../api/config.js';
import { isResourceManaged, isSectionManaged, managedSectionKeys } from '../../../hooks/config.js';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { canApply, changeFields, importSummaryText, managedCount } from './config-as-code.js';

afterEach(() => vi.unstubAllGlobals());

const managed: ConfigManagedKeys = {
  file: '/config/arclight.yml',
  appliedAt: '2026-10-25T08:00:00.000Z',
  settings: { metadata: ['language', 'region'] },
  resources: { indexers: ['Nyaa', 'Prowlarr'] },
  env: ['ARCLIGHT_SETTING__METADATA__REGION'],
  errors: [],
};

const result = (over: Partial<ConfigImportResult> = {}): ConfigImportResult => ({
  dryRun: true,
  applied: false,
  changes: [
    { kind: 'indexers', key: 'Nyaa', op: 'create' },
    { kind: 'settings', key: 'metadata', op: 'update', fields: [{ path: 'language', before: 'en-US', after: 'fr-FR' }] },
  ],
  summary: { create: 1, update: 1, delete: 0, unchanged: 12 },
  errors: [],
  warnings: [],
  ...over,
});

function routes(extra: Record<string, unknown> = {}) {
  return {
    '/api/v1/settings/metadata': { tmdbApiKey: SECRET_MASK, language: 'en-US', region: 'US' },
    '/api/v1/settings/security': { method: 'forms', requireForLocal: true, sessionDays: 30, apiKey: 'abc' },
    '/api/v1/settings/metrics': { allowAnonymous: false },
    'PUT /api/v1/settings/metrics': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
    'POST /api/v1/config/import': (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
      return body.dryRun ? result() : result({ dryRun: false, applied: true });
    },
    ...extra,
  };
}

describe('config as code helpers', () => {
  it('summarises a dry run and decides when Apply is allowed', () => {
    expect(importSummaryText(result())).toBe('1 to create · 1 to update · 0 to delete · 12 unchanged');
    expect(canApply(result())).toBe(true);
    expect(canApply(null)).toBe(false);
    expect(canApply(result({ errors: [{ path: 'indexers.Nyaa', message: 'bad' }] }))).toBe(false);
    expect(canApply(result({ changes: [] }))).toBe(false);
    expect(canApply(result({ dryRun: false }))).toBe(false);
  });

  it('lists changed fields and counts managed keys', () => {
    expect(changeFields({ kind: 'settings', key: 'metadata', op: 'update', fields: [{ path: 'a', before: 1, after: 2 }, { path: 'b.c', before: 1, after: 2 }] })).toBe('a, b.c');
    expect(changeFields({ kind: 'indexers', key: 'Nyaa', op: 'delete' })).toBe('—');
    expect(managedCount(managed)).toBe(4);
    expect(managedCount(undefined)).toBe(0);
  });

  it('answers which sections and resources are managed', () => {
    expect(isSectionManaged(managed, 'metadata')).toBe(true);
    expect(isSectionManaged(managed, 'guides')).toBe(false);
    expect(isSectionManaged(undefined, 'metadata')).toBe(false);
    expect(managedSectionKeys(managed, 'metadata')).toEqual(['language', 'region']);
    expect(isResourceManaged(managed, 'indexers', 'Nyaa')).toBe(true);
    expect(isResourceManaged(managed, 'indexers', 'Other')).toBe(false);
  });

  it('builds export links and file names', () => {
    expect(configExportUrl('yaml', false)).toBe('/api/v1/config/export?format=yaml');
    expect(configExportUrl('json', true)).toBe('/api/v1/config/export?format=json&includeSecrets=true');
    expect(configFileName('yaml')).toBe('arclight-config.yml');
    expect(configFileName('json')).toBe('arclight-config.json');
  });
});

describe('Settings → General → Config as code', () => {
  it('previews an import as a diff, then applies it', async () => {
    const api = stubApi(routes());
    renderAt('/settings/general');
    const box = await screen.findByLabelText('Or paste');
    fireEvent.change(box, { target: { value: 'version: 1\n' } });
    const apply = screen.getByRole('button', { name: 'Apply changes' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    expect(within(preview).getByText('1 to create · 1 to update · 0 to delete · 12 unchanged')).toBeTruthy();
    expect(within(preview).getByText('Nyaa')).toBeTruthy();
    expect(within(preview).getByText('Create')).toBeTruthy();
    expect(within(preview).getByText('language')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/v1/config/import')?.body).toEqual({ content: 'version: 1\n', dryRun: true, prune: false });

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(await screen.findByText(/^Applied\./)).toBeTruthy();
    expect(api.calls.filter((c) => c.path === '/api/v1/config/import').at(-1)?.body).toEqual({ content: 'version: 1\n', dryRun: false, prune: false });
  });

  it('lists errors and warnings and keeps Apply disabled', async () => {
    stubApi(
      routes({
        'POST /api/v1/config/import': result({ errors: [{ path: 'indexers.Nyaa.settings', message: 'baseUrl is required' }], warnings: [{ path: 'tags', message: 'unused tag' }] }),
      }),
    );
    renderAt('/settings/general');
    fireEvent.change(await screen.findByLabelText('Or paste'), { target: { value: 'x: 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(await screen.findByText('baseUrl is required')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Warnings' }).textContent).toContain('unused tag');
    expect(screen.getByRole('button', { name: 'Apply changes' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the 422 body of a failed apply as the preview', async () => {
    stubApi(
      routes({
        'POST /api/v1/config/import': (init: RequestInit | undefined) => {
          const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
          if (body.dryRun) return result();
          return new Response(JSON.stringify(result({ dryRun: false, errors: [{ path: 'indexers.Nyaa', message: 'proxy not found' }] })), { status: 422 });
        },
      }),
    );
    renderAt('/settings/general');
    fireEvent.change(await screen.findByLabelText('Or paste'), { target: { value: 'x: 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await screen.findByRole('region', { name: 'Import preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(await screen.findByText('proxy not found')).toBeTruthy();
    expect(screen.queryByText(/^Applied\./)).toBeNull();
  });

  it('sends prune and reads an uploaded file', async () => {
    const api = stubApi(routes());
    renderAt('/settings/general');
    const file = new File(['{"version":1}'], 'arclight-config.json', { type: 'application/json' });
    fireEvent.change(await screen.findByLabelText('Import file'), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByLabelText('Or paste') as HTMLTextAreaElement).value).toBe('{"version":1}'));
    fireEvent.click(screen.getByRole('switch', { name: /Delete what the document does not list/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/config/import')?.body).toEqual({ content: '{"version":1}', dryRun: true, prune: true }));
  });

  it('exports as a link, switching format changes it', async () => {
    stubApi(routes());
    renderAt('/settings/general');
    const link = await screen.findByRole('link', { name: 'Export config' });
    expect(link.getAttribute('href')).toBe('/api/v1/config/export?format=yaml');
    expect(link.getAttribute('download')).toBe('arclight-config.yml');
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByRole('link', { name: 'Export config' }).getAttribute('href')).toBe('/api/v1/config/export?format=json');
  });

  it('confirms before exporting secrets and sends the confirmation header', async () => {
    stubApi(routes({ '/api/v1/config/export': () => new Response('version: 1\n', { status: 200, headers: { 'content-type': 'application/yaml' } }) }));
    const createObjectURL = vi.fn(() => 'blob:x');
    const urlStatics = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    const saved = { create: urlStatics.createObjectURL, revoke: urlStatics.revokeObjectURL };
    urlStatics.createObjectURL = createObjectURL;
    urlStatics.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      urlStatics.createObjectURL = saved.create;
      urlStatics.revokeObjectURL = saved.revoke;
    });
    renderAt('/settings/general');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include secrets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Include secrets in the export?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Include secrets' }));
    expect((screen.getByRole('checkbox', { name: 'Include secrets' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Export config' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).startsWith('/api/v1/config/export'));
    expect(String(call?.[0])).toBe('/api/v1/config/export?format=yaml&includeSecrets=true');
    expect((call?.[1]?.headers as Record<string, string>)['x-confirm']).toBe('export-secrets');
  });

  it('cancelling the secrets confirm leaves secrets out', async () => {
    stubApi(routes());
    renderAt('/settings/general');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include secrets' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((screen.getByRole('checkbox', { name: 'Include secrets' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('link', { name: 'Export config' })).toBeTruthy();
  });

  it('locks a section the config file manages', async () => {
    stubApi(routes({ '/api/v1/config/managed-keys': managed }));
    renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'Metadata' });
    expect(await within(section).findByText('Managed by config file')).toBeTruthy();
    const language = await within(section).findByLabelText(/Metadata language/);
    expect((language as HTMLInputElement).matches(':disabled')).toBe(true);
    expect(screen.getByText('/config/arclight.yml')).toBeTruthy();
    expect(screen.getByText('ARCLIGHT_SETTING__METADATA__REGION')).toBeTruthy();
  });

  it('toggles anonymous metrics', async () => {
    const api = stubApi(routes());
    renderAt('/settings/general');
    const toggle = await screen.findByRole('switch', { name: /Allow \/metrics without credentials/ });
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/settings/metrics')?.body).toEqual({ allowAnonymous: true }));
  });
});
