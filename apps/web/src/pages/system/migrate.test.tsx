import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { MigrateStackPreview, MigrateStackStatus, MigrationPlan } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { visibleNav } from '../../nav.js';
import { createQueryClient } from '../../query-client.js';
import { SystemMigratePage, defaultAreas } from './migrate.js';
import { buildApplyRequest, DEFAULT_OPTIONS, newDraft, toSource } from './migrate-model.js';

const now = new Date().toISOString();

const sonarrPlan: MigrationPlan = {
  source: { app: 'sonarr', mode: 'api', url: 'http://sonarr:8989', apiKey: '********', pathMappings: [] },
  app: 'sonarr',
  schemaVersion: '4.0.1',
  areas: [
    { area: 'tags', label: 'Tags', mode: 'import', total: 2, create: 2, conflicts: 0, alreadyImported: 0, unsupported: 0, details: {} },
    { area: 'series', label: 'Series', mode: 'import', total: 3, create: 1, conflicts: 1, alreadyImported: 1, unsupported: 0, details: { episodes: 20 } },
    { area: 'naming', label: 'Naming', mode: 'import', total: 1, create: 0, conflicts: 0, alreadyImported: 1, unsupported: 0, details: {} },
  ],
  warnings: [{ area: 'indexers', message: '"IPT": apiKey hidden by the API (shown as ********); re-enter in Arclight after the import' }],
  conflicts: [{ area: 'series', sourceId: '7', name: 'Show A', existingId: 3, reason: 'series with TMDB id 12 exists' }],
  unsupported: [{ area: 'downloadClients', sourceId: '2', name: 'Blackhole', reason: 'TorrentBlackhole is not supported by Arclight (staged for later)' }],
  createdAt: now,
};

const qbitPlan: MigrationPlan = {
  source: { app: 'qbittorrent', mode: 'files', dbPath: '/import/qbittorrent/BT_backup', pathMappings: [] },
  app: 'qbittorrent',
  schemaVersion: null,
  areas: [{ area: 'torrents', label: 'Torrents', mode: 'import', total: 5, create: 5, conflicts: 0, alreadyImported: 0, unsupported: 0, details: {} }],
  warnings: [],
  conflicts: [],
  unsupported: [],
  torrentCategories: [
    { category: 'tv-sonarr', count: 3, complete: 3, sizeBytes: 3 * 1024 ** 3, savePath: '/data/downloads/tv', linked: 2 },
    { category: '', count: 2, complete: 1, sizeBytes: 1024 ** 3, savePath: '/data/downloads', linked: 0 },
  ],
  createdAt: now,
};

const preview: MigrateStackPreview = {
  sources: [
    { key: '0', app: 'sonarr', label: 'Sonarr', plan: sonarrPlan, error: null },
    { key: '1', app: 'qbittorrent', label: 'qBittorrent', plan: qbitPlan, error: null },
  ],
  createdAt: now,
};

const idle: MigrateStackStatus = {
  state: 'idle',
  runId: null,
  jobId: null,
  dryRun: true,
  startedAt: null,
  endedAt: null,
  backup: null,
  sources: [],
  current: null,
  progress: null,
  log: [],
  error: null,
  resumable: false,
  adoptedTorrents: 0,
};

function running(dryRun: boolean, runId: number): MigrateStackStatus {
  return {
    ...idle,
    state: 'running',
    runId,
    jobId: 9,
    dryRun,
    startedAt: now,
    sources: [
      { key: '0', app: 'sonarr', label: 'Sonarr', mode: 'api', state: 'running', result: null, error: null },
      { key: '1', app: 'qbittorrent', label: 'qBittorrent', mode: 'files', state: 'pending', result: null, error: null },
    ],
    current: 0,
    progress: { area: 'series', done: 1, total: 3, areaIndex: 2, areaCount: 3 },
    log: [{ time: now, level: 'info', area: 'tags', message: 'Sonarr: Tags: 2 created' }],
  };
}

function completed(dryRun: boolean, runId: number, extra: Partial<MigrateStackStatus> = {}): MigrateStackStatus {
  return {
    ...running(dryRun, runId),
    state: 'completed',
    endedAt: now,
    current: null,
    progress: null,
    backup: dryRun ? null : { id: 'arclight_backup_manual.zip', name: 'arclight_backup_manual.zip' },
    sources: [
      {
        key: '0',
        app: 'sonarr',
        label: 'Sonarr',
        mode: 'api',
        state: 'completed',
        error: null,
        result: {
          app: 'sonarr',
          dryRun,
          areas: [{ area: 'series', created: 4, updated: 0, skipped: 1, staged: 0, failed: 1 }],
          warnings: [],
          items: [{ area: 'series', sourceId: '9', name: 'Broken Show', outcome: 'failed', message: 'path is not under a root folder' }],
          startedAt: now,
          endedAt: now,
        },
      },
    ],
    ...extra,
  };
}

let calls: Array<{ url: string; method: string; body: unknown }>;
let statusQueue: MigrateStackStatus[];
let statusNow: MigrateStackStatus;
let testReply: { status: number; body: unknown };
let previewReply: MigrateStackPreview;

beforeEach(() => {
  calls = [];
  statusQueue = [];
  statusNow = idle;
  testReply = { status: 200, body: { ok: true, app: 'sonarr', version: '4.0.1', detected: null, message: null } };
  previewReply = preview;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = url.split('?')[0]!;
      calls.push({ url: path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (path === '/api/v1/migrate/stack/status') {
        if (statusQueue.length > 0) statusNow = statusQueue.shift()!;
        return json(statusNow);
      }
      if (path === '/api/v1/migrate/discover') {
        return json({
          files: [{ app: 'qbittorrent', dbPath: '/import/qbittorrent/BT_backup', configPath: null, origin: 'container mount' }],
          network: [{ app: 'sonarr', url: 'http://sonarr:8989', origin: 'docker network' }],
        });
      }
      if (path === '/api/v1/migrate/test') return json(testReply.body, testReply.status);
      if (path === '/api/v1/migrate/stack/preview') return json(previewReply);
      if (path === '/api/v1/migrate/stack/apply') {
        const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
        const runId = calls.filter((c) => c.url === path).length;
        statusNow = running(body.dryRun, runId);
        statusQueue = [running(body.dryRun, runId), completed(body.dryRun, runId)];
        return json(statusNow, 202);
      }
      if (path === '/api/v1/migrate/stack/resume') {
        statusNow = running(false, 7);
        return json(statusNow, 202);
      }
      if (path === '/api/v1/migrate/stack/source-cleanup') return json({ action: 'remove', done: 3, failed: [] });
      return json({ error: 'not found' }, 404);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <SystemMigratePage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const section = (name: string) => screen.getByRole('region', { name });

async function pickAndConnect() {
  renderPage();
  fireEvent.click(await screen.findByRole('checkbox', { name: /^Sonarr/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /^qBittorrent/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Connect each app' });
}

describe('System -> Import your existing stack', () => {
  it('walks pick → connect → preview → options → run → report and sends the selections', async () => {
    await pickAndConnect();
    const sonarr = section('Sonarr');
    // Network suggestion fills the URL.
    fireEvent.click(await within(sonarr).findByRole('button', { name: 'Use http://sonarr:8989' }, { timeout: 4000 }));
    expect((within(sonarr).getByLabelText('URL') as HTMLInputElement).value).toBe('http://sonarr:8989');
    fireEvent.change(within(sonarr).getByLabelText('API key'), { target: { value: 'abc123' } });
    fireEvent.click(within(sonarr).getByRole('button', { name: 'Test Sonarr' }));
    expect((await within(sonarr).findByRole('status')).textContent).toBe('Connected · version 4.0.1');
    expect(calls.find((c) => c.url === '/api/v1/migrate/test')?.body).toEqual({ app: 'sonarr', mode: 'api', pathMappings: [], url: 'http://sonarr:8989', apiKey: 'abc123' });

    const qbit = section('qBittorrent');
    fireEvent.click(within(qbit).getByRole('button', { name: 'Files' }));
    fireEvent.click(within(qbit).getByRole('button', { name: 'Use /import/qbittorrent/BT_backup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await screen.findByRole('table', { name: 'Import plan for Sonarr' }, { timeout: 4000 });
    expect(calls.find((c) => c.url === '/api/v1/migrate/stack/preview')?.body).toEqual({
      sources: [
        { app: 'sonarr', mode: 'api', pathMappings: [], url: 'http://sonarr:8989', apiKey: 'abc123' },
        { app: 'qbittorrent', mode: 'files', pathMappings: [], dbPath: '/import/qbittorrent/BT_backup' },
      ],
    });
    expect(screen.getByText(/series with TMDB id 12 exists/)).toBeTruthy();
    expect(screen.getByText(/TorrentBlackhole is not supported/)).toBeTruthy();
    expect(screen.getByText(/apiKey hidden by the API/)).toBeTruthy();
    // Areas with nothing new are not pre-selected.
    expect((screen.getByLabelText('Include Naming from Sonarr') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Include Tags from Sonarr'));
    fireEvent.change(screen.getByLabelText('When Series already exists'), { target: { value: 'merge' } });
    const categories = screen.getByRole('table', { name: 'qBittorrent categories' });
    expect(within(categories).getByText('3.0 GB')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Action for category (no category)'), { target: { value: 'external' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Options: dry run on by default; pausing in qBittorrent needs a second confirmation.
    await screen.findByRole('heading', { name: 'Options' });
    expect((screen.getByRole('switch', { name: 'Dry run' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^qBittorrent is stopped/ }));
    const start = screen.getByRole('button', { name: 'Start dry run' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /^I confirm qBittorrent is stopped/ }));
    expect(start.disabled).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: /^Trust complete torrents/ }));
    fireEvent.click(start);

    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/migrate/stack/apply')).toBe(true));
    expect(calls.find((c) => c.url === '/api/v1/migrate/stack/apply')!.body).toEqual({
      sources: [
        { source: { app: 'sonarr', mode: 'api', pathMappings: [], url: 'http://sonarr:8989', apiKey: 'abc123' }, areas: ['series'] },
        { source: { app: 'qbittorrent', mode: 'files', pathMappings: [], dbPath: '/import/qbittorrent/BT_backup' }, areas: ['torrents'] },
      ],
      conflictPolicy: 'skip',
      areaPolicies: { series: 'merge' },
      dryRun: true,
      backup: true,
      torrents: { categories: { 'tv-sonarr': 'adopt', '': 'external' }, defaultAction: 'adopt', verify: 'trust', pauseInSource: true, confirmSourceChanges: true },
    });

    expect(await screen.findByText('Sonarr: Series 1 of 3 (area 2 of 3)')).toBeTruthy();
    // The run finishes: the report replaces the progress.
    expect(await screen.findByRole('heading', { name: 'Dry run report' }, { timeout: 5000 })).toBeTruthy();
    const result = screen.getByRole('table', { name: 'Result for Sonarr' });
    expect(within(result).getByText('4')).toBeTruthy();
    expect(screen.getByText(/path is not under a root folder/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download report (JSON)' }).getAttribute('href')).toBe('/api/v1/migrate/stack/report?runId=1&download=1');

    fireEvent.click(screen.getByRole('button', { name: 'Run for real' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/v1/migrate/stack/apply')).toHaveLength(2));
    expect((calls.filter((c) => c.url === '/api/v1/migrate/stack/apply')[1]!.body as { dryRun: boolean }).dryRun).toBe(false);
    expect(await screen.findByRole('heading', { name: 'Import report' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/Backup arclight_backup_manual.zip was taken/)).toBeTruthy();
  }, 20_000);

  it('shows a source that refuses the key (HTTP 502) as a failed test, not a sign-out', async () => {
    testReply = { status: 502, body: { error: 'Sonarr rejected the API key or credentials (HTTP 401)', code: 'AUTH' } };
    await pickAndConnect();
    const sonarr = section('Sonarr');
    fireEvent.change(within(sonarr).getByLabelText('URL'), { target: { value: 'http://sonarr:8989' } });
    fireEvent.change(within(sonarr).getByLabelText('API key'), { target: { value: 'wrong' } });
    fireEvent.click(within(sonarr).getByRole('button', { name: 'Test Sonarr' }));
    expect((await within(sonarr).findByRole('alert')).textContent).toContain('rejected the API key');
    expect(screen.getByRole('heading', { name: 'Connect each app' })).toBeTruthy();
  });

  it('asks for what is missing before previewing', async () => {
    await pickAndConnect();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await within(section('Sonarr')).findByText('Enter the URL.')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/migrate/stack/preview')).toBe(false);
  });

  it('shows a source that could not be read inside the preview', async () => {
    previewReply = { sources: [{ key: '0', app: 'sonarr', label: 'Sonarr', plan: null, error: 'Sonarr could not be reached at http://sonarr:8989' }], createdAt: now };
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Sonarr/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const sonarr = await screen.findByRole('region', { name: 'Sonarr' });
    fireEvent.change(within(sonarr).getByLabelText('URL'), { target: { value: 'http://sonarr:8989' } });
    fireEvent.change(within(sonarr).getByLabelText('API key'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/could not be reached/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a second instance with its own name', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Sonarr/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add another Sonarr' }));
    expect((screen.getByLabelText('Sonarr instance 2 name') as HTMLInputElement).value).toBe('Sonarr 4K');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('region', { name: 'Sonarr 4K' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sonarr' })).toBeTruthy();
  });

  it('opens on the report of a failed run and resumes it', async () => {
    statusNow = { ...completed(false, 6), state: 'failed', error: '1 source(s) failed; see the log', resumable: true };
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Import report' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/migrate/stack/resume' && c.method === 'POST')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Import in progress' })).toBeTruthy();
  });

  it('removes adopted torrents from qBittorrent only after the confirmation', async () => {
    statusNow = completed(false, 4, { adoptedTorrents: 3 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from qBittorrent (keep files)' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove adopted torrents from qBittorrent?' });
    expect(dialog.textContent).toContain('Their files stay exactly where they are');
    expect(calls.some((c) => c.url === '/api/v1/migrate/stack/source-cleanup')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from qBittorrent (keep files)' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/migrate/stack/source-cleanup')?.body).toEqual({ action: 'remove', confirm: true }));
    expect(await screen.findByText('Removed 3 torrent(s) from qBittorrent, files kept; 0 failed.')).toBeTruthy();
  });

  it('pre-selects areas that create, conflict or stage', () => {
    const staged: MigrationPlan = {
      ...sonarrPlan,
      areas: [...sonarrPlan.areas, { area: 'collections', label: 'Collections', mode: 'stage', total: 2, create: 0, conflicts: 0, alreadyImported: 0, unsupported: 0, details: {} }],
    };
    expect(defaultAreas(staged)).toEqual(['tags', 'series', 'collections']);
  });

  it('builds sources from drafts with only the fields their mode uses', () => {
    const qbit = { ...newDraft(1, 'qbittorrent'), url: 'http://qbittorrent:8080', username: 'admin', password: 'pw', dbPath: 'ignored' };
    expect(toSource(qbit)).toEqual({ app: 'qbittorrent', mode: 'api', pathMappings: [], url: 'http://qbittorrent:8080', username: 'admin', password: 'pw' });
    const req = buildApplyRequest([newDraft(1, 'sonarr')], { sources: [{ key: '0', app: 'sonarr', label: 'Sonarr', plan: null, error: 'x' }], createdAt: now }, { areas: {}, conflictPolicy: 'skip', areaPolicies: {}, categories: {} }, DEFAULT_OPTIONS);
    expect(req.sources).toEqual([]);
    // Pausing without the confirmation is never sent.
    const unconfirmed = buildApplyRequest([], preview, { areas: {}, conflictPolicy: 'skip', areaPolicies: {}, categories: {} }, { ...DEFAULT_OPTIONS, pauseInSource: true });
    expect(unconfirmed.torrents).toMatchObject({ pauseInSource: false, confirmSourceChanges: false });
  });

  it('lists the page under System for admins only', () => {
    const system = visibleNav(true).find((s) => s.label === 'System');
    expect(system?.children?.some((c) => c.to === '/system/migrate')).toBe(true);
    expect(visibleNav(false).some((s) => s.label === 'System')).toBe(false);
  });
});
