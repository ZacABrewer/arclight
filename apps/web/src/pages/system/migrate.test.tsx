import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { MigrateStatus, MigrationPlan } from '@media-tron/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { visibleNav } from '../../nav.js';
import { createQueryClient } from '../../query-client.js';
import { SystemMigratePage, defaultAreas } from './migrate.js';

const now = new Date().toISOString();

const plan: MigrationPlan = {
  source: { app: 'sonarr', dbPath: '/config/sonarr.db', pathMappings: [] },
  app: 'sonarr',
  schemaVersion: '210',
  areas: [
    { area: 'tags', label: 'Tags', mode: 'import', total: 2, create: 2, conflicts: 0, alreadyImported: 0, unsupported: 0, details: {} },
    { area: 'series', label: 'Series', mode: 'import', total: 3, create: 1, conflicts: 1, alreadyImported: 1, unsupported: 0, details: { episodes: 20 } },
    { area: 'naming', label: 'Naming', mode: 'import', total: 1, create: 0, conflicts: 0, alreadyImported: 1, unsupported: 0, details: {} },
  ],
  warnings: [{ area: 'customFormats', message: 'Unknown specification FooSpecification skipped' }],
  conflicts: [{ area: 'series', sourceId: '7', name: 'Show A', existingId: 3, reason: 'tmdbId already in library' }],
  unsupported: [{ area: 'downloadClients', sourceId: '2', name: 'SAB', reason: 'SABnzbd is not supported yet' }],
  createdAt: now,
};

const idle: MigrateStatus = { state: 'idle', app: null, jobId: null, startedAt: null, endedAt: null, progress: null, log: [], result: null, error: null };
const runningStatus: MigrateStatus = {
  ...idle,
  state: 'running',
  app: 'sonarr',
  jobId: 9,
  startedAt: now,
  progress: { area: 'series', done: 1, total: 3, areaIndex: 1, areaCount: 2 },
  log: [{ time: now, level: 'info', area: 'tags', message: 'created 2 tags' }],
};
const completedStatus: MigrateStatus = {
  ...runningStatus,
  state: 'completed',
  endedAt: now,
  progress: null,
  result: {
    app: 'sonarr',
    dryRun: false,
    areas: [{ area: 'series', created: 4, updated: 0, skipped: 1, staged: 0, failed: 0 }],
    warnings: [],
    startedAt: now,
    endedAt: now,
  },
};

let calls: Array<{ url: string; method: string; body: unknown }>;
let statusResponse: MigrateStatus;
let planResponse: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  statusResponse = idle;
  planResponse = { status: 200, body: plan };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/migrate/sources') {
        return json([{ app: 'radarr', dbPath: '/config/radarr/radarr.db', configPath: '/config/radarr/config.xml', origin: 'container mount' }]);
      }
      if (url === '/api/v1/migrate/plan') return json(planResponse.body, planResponse.status);
      if (url === '/api/v1/migrate/apply') {
        statusResponse = runningStatus;
        return json(runningStatus, 202);
      }
      if (url === '/api/v1/migrate/status') return json(statusResponse);
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

async function analyze(path = '/config/sonarr.db') {
  fireEvent.change(screen.getByLabelText('Database path'), { target: { value: path } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
  await screen.findByRole('table', { name: 'Import plan' });
}

describe('System -> Import from existing apps', () => {
  it('fills the form from a detected installation', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Radarr: \/config\/radarr\/radarr\.db/ }));
    expect((screen.getByLabelText('Application') as HTMLSelectElement).value).toBe('radarr');
    expect((screen.getByLabelText('Database path') as HTMLInputElement).value).toBe('/config/radarr/radarr.db');
    expect((screen.getByLabelText('Config file (optional)') as HTMLInputElement).value).toBe('/config/radarr/config.xml');
  });

  it('adds and removes path mapping rows', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    expect(screen.getByLabelText('Mapping 2 from')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 1' }));
    expect(screen.queryByLabelText('Mapping 2 from')).toBeNull();
    expect(screen.getByLabelText('Mapping 1 from')).toBeTruthy();
  });

  it('posts the source with path mappings and renders the plan, warnings, conflicts and unsupported items', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    fireEvent.change(screen.getByLabelText('Mapping 1 from'), { target: { value: '/tv' } });
    fireEvent.change(screen.getByLabelText('Mapping 1 to'), { target: { value: '/data/tv' } });
    await analyze();
    const post = calls.find((c) => c.url === '/api/v1/migrate/plan')!;
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({ app: 'sonarr', dbPath: '/config/sonarr.db', pathMappings: [{ from: '/tv', to: '/data/tv' }] });
    const table = screen.getByRole('table', { name: 'Import plan' });
    expect(within(table).getByText('Series')).toBeTruthy();
    expect(within(table).getByText('20 episodes')).toBeTruthy();
    expect(screen.getByText('Unknown specification FooSpecification skipped')).toBeTruthy();
    expect(screen.getByText(/tmdbId already in library/)).toBeTruthy();
    expect(screen.getByText(/SABnzbd is not supported yet/)).toBeTruthy();
  });

  it('shows the error when the database cannot be analysed', async () => {
    planResponse = { status: 400, body: { error: 'not a Sonarr database', code: 'INVALID_SOURCE' } };
    renderPage();
    fireEvent.change(screen.getByLabelText('Database path'), { target: { value: '/nope.db' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(await screen.findByText(/not a Sonarr database/)).toBeTruthy();
  });

  it('sends selected areas, conflict policy and dry run in the apply body and shows progress', async () => {
    renderPage();
    await analyze();
    // Defaults: tags and series (naming has nothing new).
    expect((screen.getByLabelText('Include Tags') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Include Naming') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Include Tags'));
    fireEvent.change(screen.getByLabelText('When an item already exists'), { target: { value: 'overwrite' } });
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/migrate/apply')).toBe(true));
    const body = calls.find((c) => c.url === '/api/v1/migrate/apply')!.body;
    expect(body).toEqual({
      source: { app: 'sonarr', dbPath: '/config/sonarr.db', pathMappings: [] },
      areas: ['series'],
      conflictPolicy: 'overwrite',
      dryRun: true,
    });
    expect(await screen.findByText('Area 2 of 2: series (1/3)')).toBeTruthy();
    expect(screen.getByText(/created 2 tags/)).toBeTruthy();
  });

  it('renders the result table once the run completes', async () => {
    statusResponse = completedStatus;
    renderPage();
    const table = await screen.findByRole('table', { name: 'Import result' });
    expect(within(table).getByText('series')).toBeTruthy();
    expect(within(table).getByText('4')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('pre-selects areas that create, conflict or stage', () => {
    const staged: MigrationPlan = {
      ...plan,
      areas: [...plan.areas, { area: 'subtitleProfiles', label: 'Subtitle profiles', mode: 'stage', total: 2, create: 0, conflicts: 0, alreadyImported: 0, unsupported: 0, details: {} }],
    };
    expect(defaultAreas(staged)).toEqual(['tags', 'series', 'subtitleProfiles']);
  });

  it('lists the page under System for admins only', () => {
    const system = visibleNav(true).find((s) => s.label === 'System');
    expect(system?.children?.some((c) => c.to === '/system/migrate')).toBe(true);
    expect(visibleNav(false).some((s) => s.label === 'System')).toBe(false);
  });
});
