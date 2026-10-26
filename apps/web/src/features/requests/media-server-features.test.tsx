import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { Permission, UserRequestSettings } from '@arclight/shared';
import { ApiError } from '../../api/client.js';
import { loginErrorMessage, loginMethodOptions } from '../../pages/login.js';
import { deepLinkBlocker, parseRequestActionSearch } from '../../pages/requests/request-deep-link.js';
import { applicationUrlError, digestHourLabel } from '../../pages/settings/requests/requests-settings-page.js';
import { REQUEST_TRIGGERS, supportedRequestTriggers } from '../../pages/settings/notifications/notifications-page.js';
import { linkKindFor } from './media-server-link.js';
import { usePlexPinFlow } from './plex-pin.js';
import { authRoutes, defaultSettings, makeRequest, renderAt, stubApi, user } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const admin = user({ id: 1, username: 'root', role: 'admin', permissions: Permission.ADMIN });
const page = (results: unknown[]) => ({ pageInfo: { total: results.length, take: 20, skip: 0 }, results });
const signedOut = (extra: object = {}) => ({ needsSetup: false, authMethod: 'forms', authenticated: false, session: null, ...extra });
const reqSettings = (over: Partial<UserRequestSettings> = {}): UserRequestSettings => ({ ...UserRequestSettings.parse({}), ...over });

describe('helpers', () => {
  it('offers login methods for the configured server kind', () => {
    expect(loginMethodOptions(null).map((o) => o.value)).toEqual(['local']);
    expect(loginMethodOptions('plex').map((o) => o.value)).toEqual(['local']);
    expect(loginMethodOptions('jellyfin')).toEqual([
      { value: 'local', label: 'Local' },
      { value: 'jellyfin', label: 'Jellyfin' },
    ]);
    expect(loginErrorMessage(new ApiError(401, 'x', '/auth/login'), 'emby')).toMatch(/media server/);
    expect(loginErrorMessage(new ApiError(401, 'x', '/auth/login'))).toBe('Incorrect username or password.');
  });

  it('parses deep-link actions and explains blocked ones', () => {
    expect(parseRequestActionSearch({ action: 'approve' })).toEqual({ action: 'approve' });
    expect(parseRequestActionSearch({ action: 'nuke' })).toEqual({});
    expect(deepLinkBlocker({ status: 'pending' }, 'approve', true)).toBeNull();
    expect(deepLinkBlocker({ status: 'pending' }, undefined, false)).toBeNull();
    expect(deepLinkBlocker({ status: 'pending' }, 'approve', false)).toMatch(/permission/);
    expect(deepLinkBlocker({ status: 'approved' }, 'decline', true)).toBe('This request is already approved. Nothing to decline.');
  });

  it('validates the application URL and formats digest hours', () => {
    expect(applicationUrlError('')).toBeNull();
    expect(applicationUrlError('https://arclight.example.com')).toBeNull();
    expect(applicationUrlError('arclight.local')).toMatch(/full address/);
    expect(applicationUrlError('ftp://x')).toMatch(/http/);
    expect(digestHourLabel(7)).toBe('07:00');
  });

  it('lists the request/issue triggers an agent supports', () => {
    const all = Object.fromEntries(REQUEST_TRIGGERS.map((t) => [t, false]));
    expect(supportedRequestTriggers(all)).toEqual([...REQUEST_TRIGGERS]);
    expect(supportedRequestTriggers({ ...all, supportsOnRequestCreated: true, supportsOnIssueCreated: false })).not.toContain('onIssueCreated');
    expect(supportedRequestTriggers({ onGrab: true })).toEqual([]);
    expect(linkKindFor(undefined, 'emby')).toBe('emby');
    expect(linkKindFor({ kind: 'plex', externalId: '1', username: 'a', linkedAt: '2026-01-01T00:00:00.000Z' }, 'emby')).toBe('plex');
    expect(linkKindFor(undefined, null)).toBeNull();
  });

  it('runs the Plex PIN flow until the poll answers', async () => {
    const open = vi.fn();
    let polls = 0;
    const done = vi.fn();
    const { result } = renderHook(() =>
      usePlexPinFlow({
        createPin: async () => ({ id: 42, code: 'ABCD', authUrl: 'https://app.plex.tv/auth#?code=ABCD' }),
        poll: async () => (++polls < 3 ? null : 'session'),
        onDone: done,
        intervalMs: 5,
        openWindow: open,
      }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(done).toHaveBeenCalledWith('session'));
    expect(open).toHaveBeenCalledWith('https://app.plex.tv/auth#?code=ABCD');
    expect(polls).toBe(3);
    expect(result.current.state.phase).toBe('done');
  });

  it('stops polling when cancelled', async () => {
    const poll = vi.fn(async () => null);
    const { result } = renderHook(() =>
      usePlexPinFlow({ createPin: async () => ({ id: 1, code: 'X', authUrl: 'u' }), poll, onDone: vi.fn(), intervalMs: 5, openWindow: vi.fn() }),
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.phase).toBe('waiting'));
    act(() => result.current.cancel());
    const seen = poll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(poll.mock.calls.length).toBeLessThanOrEqual(seen + 1);
    expect(result.current.state.phase).toBe('idle');
  });
});

describe('login page', () => {
  it('shows only local sign-in without a media server', async () => {
    stubApi({ '/api/v1/auth/status': signedOut() });
    renderAt('/login');
    expect(await screen.findByLabelText('Username')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Sign in with' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in with Plex' })).toBeNull();
  });

  it('signs in against Jellyfin when that method is chosen', async () => {
    const calls = stubApi({ '/api/v1/auth/status': signedOut({ mediaServerLogin: { kind: 'jellyfin' } }) }, (url, method) =>
      method === 'POST' && url === '/api/v1/auth/login' ? { status: 401, body: { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } } : undefined,
    );
    renderAt('/login');
    fireEvent.click(await screen.findByRole('button', { name: 'Jellyfin' }));
    fireEvent.change(screen.getByLabelText('Jellyfin username'), { target: { value: 'amy' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/auth/login')?.body).toMatchObject({ method: 'jellyfin', username: 'amy', password: 'pw' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/media server did not accept/);
  });

  it('starts the Plex PIN flow in a popup', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const calls = stubApi({ '/api/v1/auth/status': signedOut({ mediaServerLogin: { kind: 'plex' } }) }, (url, method) => {
      if (method === 'POST' && url === '/api/v1/auth/plex/pin') return { body: { id: 7, code: 'WXYZ', authUrl: 'https://app.plex.tv/auth#?code=WXYZ' } };
      if (method === 'POST' && url === '/api/v1/auth/plex/poll') return { status: 202, body: { pending: true } };
      return undefined;
    });
    renderAt('/login');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Plex' }));
    expect(await screen.findByText('WXYZ')).toBeTruthy();
    expect(open).toHaveBeenCalledWith('https://app.plex.tv/auth#?code=WXYZ', 'plex-auth', expect.any(String));
    expect(calls.some((c) => c.url === '/api/v1/auth/plex/pin')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Plex sign-in' }));
    expect(await screen.findByRole('button', { name: 'Sign in with Plex' })).toBeTruthy();
  });
});

describe('profile → media server account', () => {
  const profileRoutes = (settings: UserRequestSettings, statusExtra: object = {}) => {
    const amy = user();
    const auth = authRoutes(amy);
    return {
      ...auth,
      '/api/v1/auth/status': { ...(auth['/api/v1/auth/status'] as object), ...statusExtra },
      '/api/v1/user/2/requestsettings': settings,
    };
  };

  it('shows the linked account and unlinks it', async () => {
    const linked = reqSettings({ mediaServerLink: { kind: 'jellyfin', externalId: 'abc', username: 'amy-jf', accessToken: '********', linkedAt: '2026-10-01T10:00:00.000Z' } });
    const calls = stubApi(profileRoutes(linked), (url, method) => (method === 'DELETE' && url === '/api/v1/user/2/mediaserver/link' ? { body: reqSettings() } : undefined));
    renderAt('/profile');
    const pane = await screen.findByRole('region', { name: 'Media server account' });
    expect(await within(pane).findByText('amy-jf')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Unlink Jellyfin account' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/user/2/mediaserver/link')).toBe(true));
    expect(await within(pane).findByText(/No media server is set up/)).toBeTruthy();
  });

  it('links a Jellyfin account with username and password', async () => {
    const calls = stubApi(profileRoutes(reqSettings(), { mediaServerLogin: { kind: 'emby' } }), (url, method) =>
      method === 'POST' && url === '/api/v1/user/2/mediaserver/link'
        ? { body: reqSettings({ mediaServerLink: { kind: 'emby', externalId: 'e1', username: 'amy', linkedAt: '2026-10-26T10:00:00.000Z' } }) }
        : undefined,
    );
    renderAt('/profile');
    const pane = await screen.findByRole('region', { name: 'Media server account' });
    fireEvent.change(await within(pane).findByLabelText('Emby username'), { target: { value: 'amy' } });
    fireEvent.change(within(pane).getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Link account' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/user/2/mediaserver/link')?.body).toEqual({ username: 'amy', password: 'pw' }));
    expect(await within(pane).findByRole('button', { name: 'Unlink Emby account' })).toBeTruthy();
  });

  it('saves the request-from-watchlist toggle', async () => {
    const calls = stubApi(profileRoutes(reqSettings()), (url, method, body) =>
      method === 'PUT' && url === '/api/v1/user/2/requestsettings' ? { body } : undefined,
    );
    renderAt('/profile');
    const toggle = (await screen.findByRole('switch', { name: 'Request from watchlist' })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    const form = screen.getByTestId('request-settings-form');
    fireEvent.click(within(form).getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ autoRequestFromWatchlist: false }));
    expect(screen.getByText(/No media server is set up for sign-in/)).toBeTruthy();
  });
});

describe('settings → requests notifications', () => {
  it('saves the application URL and digest, and sends a digest now', async () => {
    const calls = stubApi(
      { ...authRoutes(admin), '/api/v1/settings/requests': defaultSettings(), '/api/v1/discoverslider': [], '/api/v1/overriderule': [], '/api/v1/rootfolder': [], '/api/v1/qualityprofile': [], '/api/v1/tag': [] },
      (url, method, body) => {
        if (method === 'PUT' && url === '/api/v1/settings/requests') return { body };
        if (method === 'POST' && url === '/api/v1/request/digest') return { body: { sent: true, pendingRequests: 3, openIssues: 1 } };
        return undefined;
      },
    );
    const { toasts } = renderAt('/settings/requests');
    const url = await screen.findByLabelText('Application URL');
    fireEvent.change(url, { target: { value: 'arclight.local' } });
    expect(await screen.findByText(/Enter a full address/)).toBeTruthy();
    fireEvent.change(url, { target: { value: 'https://arclight.example.com' } });
    const hour = screen.getByLabelText('Digest time') as HTMLSelectElement;
    expect(hour.disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Daily digest' }));
    fireEvent.change(hour, { target: { value: '18' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ applicationUrl: 'https://arclight.example.com', digestEnabled: true, digestHour: 18 }));

    fireEvent.click(screen.getByRole('button', { name: 'Send digest now' }));
    await waitFor(() => expect(toasts.list().map((t) => t.message)).toContain('3 pending requests · 1 open issue'));
  });
});

describe('settings → notifications triggers', () => {
  it('shows supported request and issue triggers and saves them', async () => {
    const triggers = Object.fromEntries(REQUEST_TRIGGERS.map((t) => [t, false]));
    const conn = {
      id: 1,
      name: 'Discord',
      implementation: 'discord',
      tags: [],
      settings: {},
      onGrab: true,
      ...triggers,
      supportsOnGrab: true,
      supportsOnRequestCreated: true,
      supportsOnRequestApproved: true,
      supportsOnRequestDeclined: true,
      supportsOnRequestAvailable: true,
      supportsOnIssueCreated: true,
      supportsOnIssueUpdated: false,
    };
    const schema = [{ implementation: 'discord', implementationName: 'Discord', fields: [], template: { name: '', implementation: 'discord', tags: [], settings: {}, onGrab: false, ...triggers } }];
    const calls = stubApi({ ...authRoutes(admin), '/api/v1/notification': [conn], '/api/v1/notification/schema': schema, '/api/v1/tag': [] }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/notification/1' ? { body: { id: 1, ...(body as object) } } : undefined,
    );
    renderAt('/settings/notifications');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Discord' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Discord' });
    const group = within(dialog).getByRole('group', { name: 'Request and issue events' });
    expect(within(group).getByLabelText('New request')).toBeTruthy();
    expect(within(group).queryByLabelText('Issue updated')).toBeNull();
    expect(within(within(dialog).getByRole('group', { name: 'Events' })).queryByLabelText(/request created/i)).toBeNull();
    fireEvent.click(within(group).getByLabelText('Request approved'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ onRequestApproved: true, onRequestCreated: false }));
  });
});

describe('requests admin deep links', () => {
  it('opens the approve dialog for ?action=approve', async () => {
    stubApi({ ...authRoutes(admin), '/api/v1/request/5': makeRequest({ id: 5 }), '/api/v1/rootfolder': [], '/api/v1/qualityprofile': [], '/api/v1/tag': [] });
    renderAt('/requests/5?action=approve');
    expect(await screen.findByRole('dialog', { name: 'Approve The Matrix' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Request details' })).toBeTruthy();
  });

  it('opens the decline dialog and declines', async () => {
    const calls = stubApi({ ...authRoutes(admin), '/api/v1/request/5': makeRequest({ id: 5 }) }, (url, method) =>
      method === 'POST' && url === '/api/v1/request/5/decline' ? { body: makeRequest({ id: 5, status: 'declined' }) } : undefined,
    );
    renderAt('/requests/5?action=decline');
    const dialog = await screen.findByRole('dialog', { name: 'Decline The Matrix?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline request' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/request/5/decline')).toBe(true));
  });

  it('explains why an already handled request opens no dialog', async () => {
    stubApi({ ...authRoutes(admin), '/api/v1/request/5': makeRequest({ id: 5, status: 'approved', mediaStatus: 'available', availableOn: 'Living room' }) });
    renderAt('/requests/5?action=approve');
    expect(await screen.findByText('This request is already approved. Nothing to approve.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Available on Living room')).toBeTruthy();
  });

  it('says when the request does not exist', async () => {
    stubApi({ ...authRoutes(admin) });
    renderAt('/requests/99');
    expect(await screen.findByText('Request not found')).toBeTruthy();
  });

  it('badges requests that a media server reports as available', async () => {
    stubApi({
      ...authRoutes(admin),
      '/api/v1/request': page([makeRequest({ id: 3, status: 'completed', mediaStatus: 'available', availableOn: 'Jellyfin' }), makeRequest({ id: 4, mediaTitle: 'Alien' })]),
    });
    renderAt('/requests');
    expect((await screen.findAllByText('Available on Jellyfin')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Available on /)).toHaveLength(screen.getAllByText('Available on Jellyfin').length);
  });
});
