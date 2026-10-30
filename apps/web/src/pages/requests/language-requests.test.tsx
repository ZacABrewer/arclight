import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, type LanguageRequest, type LanguageRequestOptions } from '@arclight/shared';
import { authRoutes, makeTitle, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { buildLanguageRequest, EMPTY_LANGUAGE_DRAFT, unavailableReason } from '../discover/language-request-modal.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[]) => ({ pageInfo: { total: results.length, take: 20, skip: 0 }, results });

function makeLanguageRequest(over: Partial<LanguageRequest> = {}): LanguageRequest {
  return {
    id: 5,
    kind: 'subtitle',
    status: 'pending',
    mediaType: 'movie',
    movieId: 1,
    seriesId: null,
    seasonNumber: null,
    tmdbId: 603,
    title: 'The Matrix',
    year: 1999,
    poster: null,
    language: 'es',
    languageName: 'Spanish',
    forced: 'never',
    hi: 'also',
    mode: null,
    note: 'For my parents',
    requestedBy: { id: 2, username: 'amy' },
    modifiedBy: null,
    declineReason: null,
    failureReason: null,
    outcome: null,
    outcomeMessage: null,
    additionalLanguageIds: [],
    canRemove: true,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...over,
  };
}

const OPTIONS: LanguageRequestOptions = {
  inLibrary: true,
  mediaType: 'movie',
  movieId: 1,
  seriesId: null,
  seasons: [],
  audio: [{ language: 'en', present: true, added: false }],
  subtitles: [{ language: 'en', present: true, added: false }],
  openRequests: [{ id: 3, kind: 'subtitle', status: 'pending', seasonNumber: null, language: 'fr', forced: 'never', hi: 'also', mine: false }],
  canRequest: true,
};

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
];

describe('language request dialog model', () => {
  it('maps the checkboxes and scope onto the request body', () => {
    expect(buildLanguageRequest('series', 1399, { ...EMPTY_LANGUAGE_DRAFT, language: 'es', forcedOnly: true, season: '2', note: '  thanks ' })).toEqual({
      kind: 'subtitle',
      mediaType: 'series',
      tmdbId: 1399,
      language: 'es',
      seasonNumber: 2,
      forced: 'only',
      hi: 'also',
      note: 'thanks',
    });
    expect(buildLanguageRequest('movie', 603, { ...EMPTY_LANGUAGE_DRAFT, kind: 'audio', language: 'de' })).toEqual({ kind: 'audio', mediaType: 'movie', tmdbId: 603, language: 'de' });
    expect(buildLanguageRequest('movie', 603, EMPTY_LANGUAGE_DRAFT)).toBeNull();
  });

  it('refuses languages the title has or that are already requested', () => {
    expect(unavailableReason(OPTIONS, EMPTY_LANGUAGE_DRAFT, 'en')).toBe('Already has it');
    expect(unavailableReason(OPTIONS, EMPTY_LANGUAGE_DRAFT, 'fr')).toBe('Already requested');
    expect(unavailableReason(OPTIONS, EMPTY_LANGUAGE_DRAFT, 'es')).toBeNull();
    // English forced subtitles are a different entry; English audio is there.
    expect(unavailableReason(OPTIONS, { ...EMPTY_LANGUAGE_DRAFT, forcedOnly: true }, 'en')).toBeNull();
    expect(unavailableReason(OPTIONS, { ...EMPTY_LANGUAGE_DRAFT, kind: 'audio' }, 'en-GB')).toBe('Already has it');
  });
});

describe('request subtitles or audio on a title page', () => {
  const routes = (perms: number = Permission.REQUEST) => ({
    ...authRoutes(user({ permissions: perms })),
    '/api/v1/discover/movie/603': makeTitle({ libraryId: 1, mediaStatus: 'available' }),
    '/api/v1/request/language/options': OPTIONS,
    '/api/v1/request/language/languages': LANGUAGES,
  });

  it('opens the dialog, disables a present language and sends the request', async () => {
    const calls = stubApi(routes(), (url, method, body) =>
      method === 'POST' && url === '/api/v1/request/language' ? { status: 201, body: makeLanguageRequest({ ...(body as object), status: 'pending' }) } : undefined,
    );
    const { toasts } = renderAt('/discover/movie/603');
    fireEvent.click(await screen.findByRole('button', { name: 'Request subtitles or audio' }));
    const dialog = await screen.findByRole('dialog', { name: /Request subtitles or audio/ });
    expect(await within(dialog).findByText('Already on this title')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Search languages'), { target: { value: 'en' } });
    const english = within(dialog).getByRole('option', { name: /English/ }) as HTMLButtonElement;
    expect(english.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Search languages'), { target: { value: 'spa' } });
    fireEvent.click(within(dialog).getByRole('option', { name: /Spanish/ }));
    fireEvent.click(within(dialog).getByLabelText('Hearing impaired'));
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'For my parents' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/request/language')?.body).toEqual({
      kind: 'subtitle',
      mediaType: 'movie',
      tmdbId: 603,
      language: 'es',
      forced: 'never',
      hi: 'only',
      note: 'For my parents',
    }));
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Requested'));
  });

  it('shows the server message when the request is refused', async () => {
    stubApi(routes(), (url, method) =>
      method === 'POST' && url === '/api/v1/request/language' ? { status: 409, body: { error: 'already has Spanish subtitles', code: 'CONFLICT' } } : undefined,
    );
    renderAt('/discover/movie/603');
    fireEvent.click(await screen.findByRole('button', { name: 'Request subtitles or audio' }));
    const dialog = await screen.findByRole('dialog', { name: /Request subtitles or audio/ });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Audio language' }));
    fireEvent.change(await within(dialog).findByLabelText('Search languages'), { target: { value: 'spa' } });
    fireEvent.click(within(dialog).getByRole('option', { name: /Spanish/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request' }));
    expect(await within(dialog).findByText('already has Spanish subtitles')).toBeTruthy();
  });

  it('hides the button for titles not in the library and for users without the permission', async () => {
    stubApi({ ...routes(Permission.CREATE_ISSUES) });
    renderAt('/discover/movie/603');
    await screen.findByRole('button', { name: 'Report issue' });
    expect(screen.queryByRole('button', { name: 'Request subtitles or audio' })).toBeNull();
  });

  it('is offered with only the language permission', async () => {
    stubApi({ ...routes(Permission.REQUEST_LANGUAGE) });
    renderAt('/discover/movie/603');
    expect(await screen.findByRole('button', { name: 'Request subtitles or audio' })).toBeTruthy();
  });
});

describe('language requests on the Requests page', () => {
  it('lists them from the media filter, approves audio with a mode and declines with a reason', async () => {
    const audio = makeLanguageRequest({ id: 6, kind: 'audio', language: 'de', languageName: 'German', title: 'Heat', tmdbId: 949, note: null });
    const calls = stubApi(
      { '/api/v1/request': page([]), '/api/v1/request/language': page([makeLanguageRequest(), audio]) },
      (url, method, body) => {
        if (method === 'POST' && url === '/api/v1/request/language/6/approve') return { body: { ...audio, status: 'approved', mode: (body as { mode: string }).mode } };
        if (method === 'POST' && url === '/api/v1/request/language/5/decline') return { body: makeLanguageRequest({ status: 'declined' }) };
        return undefined;
      },
    );
    renderAt('/requests');
    await screen.findByText('No requests');
    fireEvent.change(screen.getByLabelText('Media type filter'), { target: { value: 'language' } });
    expect(await screen.findByRole('link', { name: 'Heat' })).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith('/api/v1/request/language?'))?.url).toContain('filter=pending');
    expect(screen.getByText(/Note: For my parents/)).toBeTruthy();
    expect(screen.getAllByText('Subtitles').length).toBeGreaterThan(0);

    const rows = screen.getAllByRole('row');
    const heatRow = rows.find((r) => within(r).queryByRole('link', { name: 'Heat' }))!;
    fireEvent.click(within(heatRow).getByRole('button', { name: 'Approve' }));
    const approve = await screen.findByRole('dialog', { name: 'Approve German audio for Heat' });
    fireEvent.click(within(approve).getByLabelText(/Add a version/));
    fireEvent.click(within(approve).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/request/language/6/approve')?.body).toEqual({ mode: 'version' }));

    const matrixRow = screen.getAllByRole('row').find((r) => within(r).queryByRole('link', { name: 'The Matrix' }))!;
    fireEvent.click(within(matrixRow).getByRole('button', { name: 'Decline' }));
    const decline = await screen.findByRole('dialog', { name: /Decline/ });
    fireEvent.change(within(decline).getByLabelText(/Reason/), { target: { value: 'No provider has it' } });
    fireEvent.click(within(decline).getByRole('button', { name: 'Decline request' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/request/language/5/decline')?.body).toEqual({ reason: 'No provider has it' }));
  });

  it('bulk-approves selected language requests', async () => {
    const calls = stubApi(
      { '/api/v1/request': page([]), '/api/v1/request/language': page([makeLanguageRequest(), makeLanguageRequest({ id: 6, title: 'Heat', tmdbId: 949 })]) },
      (url, method) => (method === 'POST' && url === '/api/v1/request/language/bulk/approve' ? { body: { ok: [5, 6], failed: [] } } : undefined),
    );
    renderAt('/requests');
    await screen.findByText('No requests');
    fireEvent.change(screen.getByLabelText('Media type filter'), { target: { value: 'language' } });
    await screen.findByRole('link', { name: 'Heat' });
    fireEvent.click(screen.getByLabelText('Select all rows'));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/request/language/bulk/approve')?.body).toEqual({ ids: [5, 6] }));
  });

  it('shows them in My requests', async () => {
    const calls = stubApi({
      ...authRoutes(user({ permissions: Permission.REQUEST })),
      '/api/v1/request': page([]),
      '/api/v1/request/language': page([makeLanguageRequest({ status: 'failed', failureReason: 'No subtitle provider is set up' })]),
    });
    renderAt('/requests/mine');
    const media = await screen.findByRole('group', { name: 'Media type' });
    fireEvent.click(within(media).getByRole('button', { name: 'Subtitles & languages' }));
    expect(await screen.findByRole('link', { name: /The Matrix/ })).toBeTruthy();
    expect(screen.getByText(/No subtitle provider is set up/)).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith('/api/v1/request/language?'))?.url).toContain('requestedBy=2');
  });
});
