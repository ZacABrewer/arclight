import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TitleDetail } from '@arclight/shared';
import { ApiError } from '../../core/api';

// The discover title page's buttons: Request (a show: all seasons) sends the request and says so,
// a quota refusal reads as a sentence, a title in the library offers Open in library, and one
// already asked for shows its status instead of Request.

const state = vi.hoisted(() => ({ create: vi.fn(), openTitle: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Navigate: () => null,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock('@web/api/requests', () => ({
  kindOf: (m: 'movie' | 'series') => (m === 'movie' ? 'movie' : 'tv'),
  discoverApi: { trending: vi.fn(), movies: vi.fn(), tv: vi.fn(), upcoming: vi.fn(), search: vi.fn(), title: vi.fn() },
  requestsApi: { list: vi.fn(), create: (body: unknown) => state.create(body), remove: vi.fn() },
}));
vi.mock('@web/features/player/api', () => ({ usePlaybackCapabilities: () => ({ data: { canRequest: true } }) }));
vi.mock('../actions', () => ({ useVideoActions: () => ({ openTitle: state.openTitle }) }));

const { TitleActions } = await import('./discover');

const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${Object.values(vars).join(',')}` : key);

function title(over: Partial<TitleDetail> = {}): TitleDetail {
  return {
    mediaType: 'series',
    tmdbId: 500,
    title: 'Example Show',
    year: 2026,
    overview: 'An example.',
    posterUrl: null,
    backdropUrl: null,
    mediaStatus: 'unknown',
    mediaStatus4k: 'unknown',
    requestId: null,
    requestStatus: null,
    libraryId: null,
    genres: [],
    seasons: [],
    requests: [],
    canRequest: true,
    ...over,
  } as TitleDetail;
}

function show(d: TitleDetail) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TitleActions title={d} t={t} />
    </QueryClientProvider>,
  );
}

const key = (k: string) => document.querySelector<HTMLElement>(`[data-tv-key="${k}"]`);

beforeEach(() => {
  state.create.mockReset();
  state.openTitle.mockReset();
});

describe('TitleActions', () => {
  it('requests every season of a show and says it was sent', async () => {
    state.create.mockResolvedValue({ kind: 'created', request: {} });
    show(title());
    const btn = key('dsc-request')!;
    expect(btn.textContent).toContain('app.tv.request.allSeasons');
    expect(btn.hasAttribute('data-tv-autofocus')).toBe(true);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('app.tv.request.sent'));
    expect(state.create).toHaveBeenCalledWith({ mediaType: 'series', tmdbId: 500, seasons: 'all' });
    expect(key('dsc-request')).toBeNull();
  });

  it('shows a quota refusal as a readable message', async () => {
    state.create.mockRejectedValue(new ApiError(403, 'Series Quota exceeded.', '/request', 'FORBIDDEN'));
    show(title());
    fireEvent.click(key('dsc-request')!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.tv.request.quota'));
  });

  it('offers Open in library for a title the library has', () => {
    show(title({ mediaType: 'movie', mediaStatus: 'available', libraryId: 7 }));
    expect(key('dsc-request')).toBeNull();
    fireEvent.click(key('dsc-open')!);
    expect(state.openTitle).toHaveBeenCalledWith('movie', 7);
  });

  it('shows the status of a title already requested, with no Request button', () => {
    show(title({ mediaType: 'movie', requestStatus: 'pending', requestId: 3 }));
    expect(key('dsc-request')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('app.tv.discover.state.requested');
    expect(key('dsc-my')!.hasAttribute('data-tv-autofocus')).toBe(true);
  });

  it('offers the missing seasons of a show partly in the library, beside Open', () => {
    show(title({ mediaStatus: 'partiallyAvailable', libraryId: 11 }));
    expect(key('dsc-open')).not.toBeNull();
    expect(key('dsc-request')!.textContent).toContain('app.tv.request.missing');
  });

  it('says so when the account may not request this title', () => {
    show(title({ canRequest: false }));
    expect(key('dsc-request')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('app.tv.request.notAllowed');
  });
});
