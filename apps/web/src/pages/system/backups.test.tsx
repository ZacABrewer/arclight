import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { Backup, BackupSettings, SystemStatus } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { RestartBanner } from '../../layout/restart-banner.js';
import { createToastStore, type ToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { parseBackupDraft, SystemBackupsPage } from './backups.js';

type Call = { url: string; method: string; body: unknown };

const backups: Backup[] = [
  { id: 'arclight_manual_2026.10.25_04.00.00.zip', name: 'arclight_manual_2026.10.25_04.00.00.zip', type: 'manual', size: 2_097_152, time: '2026-10-25T04:00:00.000Z' },
  { id: 'arclight_scheduled_2026.10.24_04.00.00.zip', name: 'arclight_scheduled_2026.10.24_04.00.00.zip', type: 'scheduled', size: 1024, time: '2026-10-24T04:00:00.000Z' },
];

const status = (over: Partial<SystemStatus> = {}): SystemStatus => ({
  appName: 'Arclight',
  version: '0.1.0',
  startTime: '2026-10-25T00:00:00.000Z',
  uptimeSeconds: 10,
  runtime: { node: 'v24', platform: 'linux', arch: 'x64' },
  paths: { config: '/config', database: '/config/arclight.db', logs: '/config/logs' },
  isDocker: true,
  restartRequired: false,
  ...over,
});

let calls: Call[];
let list: Backup[];
let settings: BackupSettings;
let statusBody: SystemStatus;
let overrides: Record<string, (call: Call) => Response>;

beforeEach(() => {
  calls = [];
  list = [...backups];
  settings = { folder: '', intervalDays: 1, hour: 4, retentionCount: 7, retentionDays: 28 };
  statusBody = status();
  overrides = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const raw = init?.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const call: Call = { url, method: init?.method ?? 'GET', body };
      calls.push(call);
      const key = `${call.method} ${url}`;
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (overrides[key]) return overrides[key](call);
      switch (true) {
        case key === 'GET /api/v1/system/backup':
          return json(list);
        case key === 'POST /api/v1/system/backup': {
          const b: Backup = { ...backups[0]!, id: 'arclight_manual_2026.10.25_05.00.00.zip', name: 'arclight_manual_2026.10.25_05.00.00.zip' };
          list = [b, ...list];
          return json(b, 201);
        }
        case key.startsWith('DELETE /api/v1/system/backup/'):
          list = list.filter((b) => !url.endsWith(encodeURIComponent(b.id)));
          return new Response(null, { status: 204 });
        case key.startsWith('POST /api/v1/system/backup/restore/'):
          statusBody = status({ restartRequired: true });
          return json({ restored: true, configFiles: 1, restartRequired: true });
        case key === 'GET /api/v1/settings/backup':
          return json(settings);
        case key === 'PUT /api/v1/settings/backup':
          settings = call.body as BackupSettings;
          return json(settings);
        case key === 'GET /api/v1/system/status':
          return json(statusBody);
        case key === 'POST /api/v1/system/restart':
          return json({ restarting: true }, 202);
        default:
          return json({ error: 'not found' }, 404);
      }
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode): ToastStore {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{node}</ToastProvider>
    </QueryClientProvider>,
  );
  return toasts;
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

describe('System → Backups', () => {
  it('lists backups with type, size, time and a download link', async () => {
    renderWith(<SystemBackupsPage />);
    const row = await rowOf(backups[0]!.name);
    expect(within(row).getByText('Manual')).toBeTruthy();
    expect(within(row).getByText(/2(\.0)? MB/)).toBeTruthy();
    const link = within(row).getByRole('link', { name: `Download ${backups[0]!.name}` });
    expect(link.getAttribute('href')).toBe(`/api/v1/system/backup/${backups[0]!.id}/download`);
    expect(within(await rowOf(backups[1]!.name)).getByText('Scheduled')).toBeTruthy();
  });

  it('shows an empty state without backups', async () => {
    list = [];
    renderWith(<SystemBackupsPage />);
    expect(await screen.findByText('No backups yet')).toBeTruthy();
  });

  it('creates a backup now and refreshes the list', async () => {
    renderWith(<SystemBackupsPage />);
    await rowOf(backups[0]!.name);
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText('arclight_manual_2026.10.25_05.00.00.zip')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/system/backup')).toHaveLength(1);
  });

  it('restores a stored backup after confirmation', async () => {
    const toasts = renderWith(<SystemBackupsPage />);
    const row = await rowOf(backups[1]!.name);
    fireEvent.click(within(row).getByRole('button', { name: `Restore ${backups[1]!.name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore backup' });
    expect(within(dialog).getByText(/must be restarted/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore backup' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1/system/backup/restore/${backups[1]!.id}`)).toBe(true));
    await waitFor(() => expect(toasts.list().some((t) => t.title === 'Backup restored')).toBe(true));
  });

  it('keeps the dialog open with the error when a restore is refused', async () => {
    overrides[`POST /api/v1/system/backup/restore/${backups[0]!.id}`] = () =>
      new Response(JSON.stringify({ error: 'backup is from a newer Arclight version', code: 'INVALID_BACKUP' }), { status: 400 });
    renderWith(<SystemBackupsPage />);
    const row = await rowOf(backups[0]!.name);
    fireEvent.click(within(row).getByRole('button', { name: `Restore ${backups[0]!.name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore backup' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore backup' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('newer Arclight version');
  });

  it('restores from an uploaded file as multipart form data', async () => {
    renderWith(<SystemBackupsPage />);
    await rowOf(backups[0]!.name);
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'old.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByTestId('backup-upload'), { target: { files: [file] } });
    const dialog = await screen.findByRole('dialog', { name: 'Restore backup' });
    expect(within(dialog).getByText('old.zip')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore backup' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/system/backup/restore/upload')).toBe(true));
    const upload = calls.find((c) => c.url === '/api/v1/system/backup/restore/upload')!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect(((upload.body as FormData).get('file') as File).name).toBe('old.zip');
  });

  it('deletes a backup after confirmation', async () => {
    renderWith(<SystemBackupsPage />);
    const row = await rowOf(backups[1]!.name);
    fireEvent.click(within(row).getByRole('button', { name: `Delete ${backups[1]!.name}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete backup' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete backup' }));
    await waitFor(() => expect(screen.queryByText(backups[1]!.name)).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/v1/system/backup/${backups[1]!.id}`)).toBe(true);
  });

  it('saves settings and validates them first', async () => {
    renderWith(<SystemBackupsPage />);
    const form = await screen.findByRole('form', { name: 'Backup settings' });
    const hour = within(form).getByLabelText('Hour of day');
    fireEvent.change(hour, { target: { value: '30' } });
    // Native min/max would block a click-submit; submit directly to reach our own validation.
    fireEvent.submit(form);
    expect(await within(form).findByText('Enter a whole number from 0 to 23')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.change(hour, { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Keep at most'), { target: { value: '3' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(settings).toEqual({ folder: '', intervalDays: 1, hour: 2, retentionCount: 3, retentionDays: 28 });
  });

  it('parses settings drafts', () => {
    const base = { folder: '', intervalDays: '1', hour: '4', retentionCount: '7', retentionDays: '28' };
    expect(parseBackupDraft(base)).toEqual({ value: { folder: '', intervalDays: 1, hour: 4, retentionCount: 7, retentionDays: 28 } });
    expect(parseBackupDraft({ ...base, folder: ' /data/backups ' })).toMatchObject({ value: { folder: '/data/backups' } });
    expect(parseBackupDraft({ ...base, folder: 'D:\\backups' })).toMatchObject({ value: { folder: 'D:\\backups' } });
    expect(parseBackupDraft({ ...base, folder: 'relative' })).toMatchObject({ errors: { folder: expect.any(String) } });
    expect(parseBackupDraft({ ...base, retentionDays: '1.5', intervalDays: '' })).toMatchObject({
      errors: { retentionDays: expect.any(String), intervalDays: expect.any(String) },
    });
  });
});

describe('RestartBanner', () => {
  it('stays hidden while no restart is required', async () => {
    renderWith(<RestartBanner />);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/system/status')).toBe(true));
    expect(screen.queryByText(/Restart required/)).toBeNull();
  });

  it('restarts and reloads once the api is back with a new start time', async () => {
    statusBody = status({ restartRequired: true });
    const reload = vi.fn();
    renderWith(<RestartBanner reload={reload} pollMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }));
    expect(await screen.findByText(/Restarting Arclight/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/system/restart')).toBe(true);
    // Still the old process: no reload yet.
    await new Promise((r) => setTimeout(r, 60));
    expect(reload).not.toHaveBeenCalled();
    statusBody = status({ startTime: '2026-10-25T01:00:00.000Z' });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
