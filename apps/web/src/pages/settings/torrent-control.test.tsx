import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SeedingRulesSettings, TorrentSpeedSettings } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi } from '../../test/route-harness.js';
import { fromRuleDraft, newRuleDraft, ruleProblem, SeedingRulesPane, SpeedSchedulePane, toRuleDraft, toSpeedDraft, toSpeedUpdate } from './torrent-control.js';

function wrap(children: ReactNode) {
  const toasts = createToastStore();
  return render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{children}</ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const speedSettings = TorrentSpeedSettings.parse({ schedule: [{ days: [5, 1], start: '09:00', end: '17:00' }] });

describe('speed schedule drafts', () => {
  it('round-trips settings and treats empty limits as unlimited', () => {
    const draft = toSpeedDraft(speedSettings);
    expect(toSpeedUpdate(draft)).toEqual({ ...speedSettings, schedule: [{ days: [1, 5], start: '09:00', end: '17:00' }] });
    expect(toSpeedUpdate({ ...draft, altDownloadLimitKbps: '', schedule: [{ days: [], start: '01:00', end: '02:00' }] })).toMatchObject({ altDownloadLimitKbps: 0, schedule: [] });
  });
});

describe('seeding rule drafts', () => {
  const { rules } = SeedingRulesSettings.parse({
    rules: [
      { id: 'tv', name: 'TV', categories: ['tv', 'tv-hd'], trackers: ['tracker.example'], ratio: 1.5, seedTimeMinutes: 7 * 1440, action: 'remove', deleteFiles: true },
      { id: 'mv', name: 'Movies', seedTimeMinutes: 90 },
    ],
  });

  it('shows whole days in days, other times in hours, and converts back', () => {
    const tv = toRuleDraft(rules[0]!);
    expect(tv).toMatchObject({ categories: 'tv, tv-hd', ratio: '1.5', seedTime: '7', seedTimeUnit: 'days' });
    expect(fromRuleDraft(tv)).toEqual({ ...rules[0], enabled: true, indexerIds: [] });
    const mv = toRuleDraft(rules[1]!);
    expect(mv).toMatchObject({ ratio: '', seedTime: '1.5', seedTimeUnit: 'hours' });
    expect(fromRuleDraft(mv).seedTimeMinutes).toBe(90);
  });

  it('drops delete-files for pause rules and validates name and limits', () => {
    const d = { ...newRuleDraft('x'), name: 'X', action: 'pause' as const, deleteFiles: true };
    expect(fromRuleDraft(d).deleteFiles).toBe(false);
    expect(ruleProblem(d)).toBeNull();
    expect(ruleProblem({ ...d, name: ' ' })).toBe('Give the rule a name.');
    expect(ruleProblem({ ...d, ratio: '', seedTime: '' })).toBe('Set a ratio, a seeding time or both.');
  });
});

describe('panes', () => {
  it('edits the schedule and saves the speed settings', async () => {
    const api = stubApi({
      '/api/v1/settings/torrent/speed': speedSettings,
      'PUT /api/v1/settings/torrent/speed': (init: RequestInit | undefined) => ({ ...speedSettings, ...(JSON.parse(String(init?.body)) as object) }),
    });
    wrap(<SpeedSchedulePane />);
    const window1 = await screen.findByRole('group', { name: 'Window 1' });
    const sunday = within(window1).getAllByRole('button').find((b) => b.getAttribute('aria-pressed') === 'false')!;
    fireEvent.click(sunday);
    fireEvent.click(screen.getByRole('switch', { name: 'Use the schedule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add window' }));
    expect(screen.getByRole('group', { name: 'Window 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove window 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save speed schedule' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ scheduleEnabled: true, schedule: [{ days: [0, 1, 5], start: '09:00', end: '17:00' }] });
  });

  it('adds a rule, refuses to save it without a name, then saves the list', async () => {
    const api = stubApi({
      '/api/v1/settings/torrent/seedingrules': { rules: [] },
      '/api/v1/indexer': [],
      'PUT /api/v1/settings/torrent/seedingrules': (init: RequestInit | undefined) => SeedingRulesSettings.parse(JSON.parse(String(init?.body))),
    });
    wrap(<SeedingRulesPane />);
    expect(await screen.findByText('No seeding rules')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('alert').textContent).toBe('Give the rule a name.');
    const save = screen.getByRole('button', { name: 'Save rules' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'TV' } });
    fireEvent.change(screen.getByLabelText('Categories'), { target: { value: 'tv, anime' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Then' })).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Delete files' }));
    fireEvent.click(save);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = api.calls.find((c) => c.method === 'PUT')?.body as { rules: Array<Record<string, unknown>> };
    expect(body.rules[0]).toMatchObject({ name: 'TV', categories: ['tv', 'anime'], ratio: 2, seedTimeMinutes: 14 * 1440, action: 'remove', deleteFiles: true });
  });
});
