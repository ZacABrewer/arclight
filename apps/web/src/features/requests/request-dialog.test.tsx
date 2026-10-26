import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createToastStore } from '../../lib/toast.js';
import { RequestDialog, seasonBlocker } from './request-dialog.js';
import { defaultSettings, makeRequest, makeTitle, renderWithClient, season, stubApi } from './test-utils.js';

afterEach(() => vi.unstubAllGlobals());

const series = makeTitle({
  mediaType: 'series',
  tmdbId: 1399,
  title: 'Dragons',
  seasons: [season(0), season(1, { status: 'available' }), season(2, { requestStatus: 'pending' }), season(3), season(4)],
});

function setup(title = series, settings = defaultSettings(), postResponse: { status: number; body: unknown } = { status: 201, body: makeRequest() }) {
  const calls = stubApi(
    { '/api/v1/settings/requests': settings, '/api/v1/rootfolder': [{ id: 1, path: '/tv', mediaType: 'series', accessible: true }], '/api/v1/qualityprofile': [], '/api/v1/tag': [] },
    (url, method) => (method === 'POST' && url === '/api/v1/request' ? postResponse : undefined),
  );
  const toasts = createToastStore();
  const onClose = vi.fn();
  renderWithClient(<RequestDialog title={title} open onClose={onClose} />, toasts);
  return { calls, toasts, onClose };
}

describe('request dialog', () => {
  it('disables seasons that are available or already requested and hides specials by default', async () => {
    setup();
    const s1 = (await screen.findByLabelText('Season 1')) as HTMLInputElement;
    expect(s1.disabled).toBe(true);
    expect((screen.getByLabelText('Season 2') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Season 3') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByLabelText('Specials')).toBeNull();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('Pending approval')).toBeTruthy();
    expect(seasonBlocker(season(5, { requestStatus: 'declined' }), false)).toBeNull();
  });

  it('sends the picked seasons, or "all" with the all-seasons box', async () => {
    const { calls, onClose } = setup();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/settings/requests')).toBe(true));
    fireEvent.click(await screen.findByLabelText('Season 4'));
    fireEvent.click(screen.getByRole('button', { name: 'Request 1 season' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ mediaType: 'series', tmdbId: 1399, is4k: false, seasons: [4] });
  });

  it('toasts the message of a 202 answer and closes', async () => {
    const { toasts, onClose, calls } = setup(series, defaultSettings(), { status: 202, body: { message: 'Every season is already requested' } });
    fireEvent.click(await screen.findByLabelText('All seasons'));
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ seasons: 'all' });
    expect(toasts.list().map((t) => t.title)).toContain('Every season is already requested');
  });

  it('shows the 4K toggle only when the user may and 4K is enabled for the type', async () => {
    const movie = makeTitle({ canRequest4k: true });
    setup(movie, defaultSettings({ movie4k: { enabled: true, rootFolderPath: null, qualityProfileId: null, tags: [] } }));
    expect(await screen.findByLabelText('Request in 4K')).toBeTruthy();
  });

  it('hides the 4K toggle when 4K is off in settings, and the advanced section without canRequestAdvanced', async () => {
    const { calls } = setup(makeTitle({ canRequest4k: true }), defaultSettings());
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/settings/requests')).toBe(true));
    await screen.findByRole('button', { name: 'Request' });
    expect(screen.queryByLabelText('Request in 4K')).toBeNull();
    expect(screen.queryByTestId('request-advanced')).toBeNull();
  });

  it('offers root folder, profile and tags to advanced requesters and sends them', async () => {
    const { calls, onClose } = setup(makeTitle({ mediaType: 'series', tmdbId: 5, seasons: [season(1)], canRequestAdvanced: true }));
    expect(await screen.findByTestId('request-advanced')).toBeTruthy();
    await screen.findByRole('option', { name: '/tv' });
    fireEvent.change(screen.getByLabelText('Root folder'), { target: { value: '/tv' } });
    fireEvent.click(screen.getByLabelText('All seasons'));
    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ mediaType: 'series', tmdbId: 5, is4k: false, seasons: 'all', rootFolderPath: '/tv' });
  });
});
