import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, type MediaServerResource, type MediaServerUser } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../../../features/requests/test-utils.js';
import { flagRowsFor, importSummary, importableIds, probeOutcome, serverUses, validateServer, withKind } from './media-servers-page.js';

afterEach(() => vi.unstubAllGlobals());

const admin = user({ id: 1, username: 'root', role: 'admin', permissions: Permission.ADMIN });

const server = (over: Partial<MediaServerResource> = {}): MediaServerResource => ({
  id: 'jf1',
  kind: 'jellyfin',
  name: 'Living room',
  url: 'http://jellyfin.lan:8096',
  apiKey: '********',
  enabled: true,
  usedForAvailability: true,
  usedForRetention: true,
  usedForRefresh: false,
  loginEnabled: true,
  createUsersOnLogin: true,
  ...over,
});

const signIn = { kind: 'jellyfin', url: 'http://jellyfin.lan:8096', apiKey: '********', name: 'Living room', loginEnabled: true, createUsersOnLogin: true };

const accounts: MediaServerUser[] = [
  { externalId: 'u1', username: 'amy', email: 'amy@example.com', isAdmin: false, isDisabled: false, linkedUserId: null },
  { externalId: 'u2', username: 'bob', isAdmin: false, isDisabled: false, linkedUserId: 5 },
  { externalId: 'u3', username: 'cat', isAdmin: false, isDisabled: true, linkedUserId: null },
];

function routes(extra: Record<string, unknown> = {}) {
  return {
    ...authRoutes(admin),
    '/api/v1/mediaserver': [server(), server({ id: 'px', kind: 'plex', name: 'Den', url: 'http://plex.lan:32400', enabled: false, usedForAvailability: false, usedForRetention: false, loginEnabled: false, createUsersOnLogin: false })],
    '/api/v1/settings/mediaserver': signIn,
    ...extra,
  };
}

describe('media server helpers', () => {
  it('names what a server is used for', () => {
    expect(serverUses(server())).toEqual(['Availability', 'Retention', 'Sign-in']);
    expect(serverUses(server({ usedForAvailability: false, usedForRetention: false, loginEnabled: false }))).toEqual([]);
  });

  it('turns probe results into test outcomes', () => {
    expect(probeOutcome({ ok: true, serverName: 'Living room', version: '10.9.1', libraries: [{ id: '1', name: 'Movies', type: 'movie' }] })).toEqual({
      ok: true,
      message: 'Living room · 10.9.1 · 1 library',
      warnings: [],
      errors: [],
    });
    expect(probeOutcome({ ok: true, libraries: [] }).warnings).toHaveLength(1);
    expect(probeOutcome({ ok: false, message: 'Bad key', code: 'unauthorized' }).errors).toEqual(['Bad key (unauthorized)']);
  });

  it('validates the editor form', () => {
    const base = { kind: 'jellyfin' as const, name: 'A', url: 'jellyfin.lan:8096', apiKey: 'k' };
    expect(validateServer(base, true)).toEqual({});
    expect(validateServer({ ...base, name: ' ', url: '' }, true)).toEqual({ name: 'Enter a name.', url: 'Enter the server address.' });
    expect(validateServer({ ...base, url: 'ftp://x' }, true).url).toMatch(/http/);
    expect(validateServer({ ...base, apiKey: '' }, true).apiKey).toBe('Enter an API key.');
    expect(validateServer({ ...base, kind: 'plex', apiKey: '' }, true).apiKey).toMatch(/X-Plex-Token/);
    expect(validateServer({ ...base, apiKey: '' }, false)).toEqual({});
  });

  it('picks importable accounts and summarises an import', () => {
    expect(importableIds(accounts)).toEqual(['u1']);
    expect(importSummary({ created: [{ id: 9, username: 'amy', externalId: 'u1' }], skipped: [] })).toBe('1 user imported');
    expect(importSummary({ created: [], skipped: [{ externalId: 'u2', reason: 'linked' }] })).toBe('0 users imported · 1 skipped');
  });
});

describe('Settings → Media servers', () => {
  it('lists servers with their kind, URL and uses', async () => {
    stubApi(routes());
    renderAt('/settings/mediaservers');
    const card = (await screen.findByRole('button', { name: 'Living room' })).closest('.al-item-card') as HTMLElement;
    expect(within(card).getByText('Jellyfin')).toBeTruthy();
    expect(within(card).getByText('http://jellyfin.lan:8096')).toBeTruthy();
    expect(within(card).getByText('Retention')).toBeTruthy();
    expect(within(card).getByText('Sign-in')).toBeTruthy();
    const den = screen.getByRole('button', { name: 'Den' }).closest('.al-item-card') as HTMLElement;
    expect(within(den).getByText('Disabled')).toBeTruthy();
    expect(within(den).getByText('Not used')).toBeTruthy();
  });

  it('validates and creates a server', async () => {
    const calls = stubApi(routes(), (url, method, body) =>
      method === 'POST' && url === '/api/v1/mediaserver' ? { status: 201, body: { ...server({ id: 'new' }), ...(body as object), apiKey: '********' } } : undefined,
    );
    renderAt('/settings/mediaservers');
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add media server' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'emby' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Office' } });
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: 'http://emby.lan:8096' } });
    fireEvent.change(within(dialog).getByLabelText('API key'), { target: { value: 'secret' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Retention' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ kind: 'emby', name: 'Office', url: 'http://emby.lan:8096', apiKey: 'secret', usedForRetention: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add media server' })).toBeNull());
  });

  it('edits a server keeping the masked key and tests the unsaved form', async () => {
    const calls = stubApi(routes(), (url, method, body) => {
      if (method === 'PUT' && url === '/api/v1/mediaserver/jf1') return { body: { ...server(), ...(body as object) } };
      if (method === 'POST' && url === '/api/v1/mediaserver/test') return { body: { ok: true, serverName: 'Living room', version: '10.9.1', libraries: [] } };
      return undefined;
    });
    renderAt('/settings/mediaservers');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Living room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Living room' });
    expect((within(dialog).getByRole('switch', { name: 'Create users on sign-in' }) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Sign-in' }));
    expect((within(dialog).getByRole('switch', { name: 'Create users on sign-in' }) as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect(await within(dialog).findByText('Test passed')).toBeTruthy();
    expect(within(dialog).getByText('Living room · 10.9.1 · 0 libraries')).toBeTruthy();
    expect(calls.find((c) => c.url === '/api/v1/mediaserver/test')?.body).toMatchObject({ id: 'jf1', apiKey: '********' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ apiKey: '********', loginEnabled: false, name: 'Living room' });
  });

  it('tests a saved server from its card and shows its accounts', async () => {
    stubApi(
      routes({
        '/api/v1/mediaserver/jf1/users': [
          { id: 'a', name: 'amy', isAdmin: true, isDisabled: false, lastActivityAt: '2026-10-25T10:00:00.000Z' },
          { id: 'b', name: 'bob', isAdmin: false, isDisabled: true, lastActivityAt: null },
        ],
      }),
      (url, method) => (method === 'POST' && url === '/api/v1/mediaserver/jf1/test' ? { body: { ok: false, message: 'Unauthorized', code: 'unauthorized' } } : undefined),
    );
    renderAt('/settings/mediaservers');
    const card = (await screen.findByRole('button', { name: 'Living room' })).closest('.al-item-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await within(card).findByText('Unauthorized (unauthorized)')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Accounts on Living room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accounts on Living room' });
    expect(await within(dialog).findByText('amy')).toBeTruthy();
    expect(within(dialog).getByText('Admin')).toBeTruthy();
    expect(within(dialog).getByText('Disabled')).toBeTruthy();
  });

  it('imports selected users from the sign-in server', async () => {
    const calls = stubApi(routes({ '/api/v1/user/import/mediaserver': accounts }), (url, method) =>
      method === 'POST' && url === '/api/v1/user/import/mediaserver'
        ? { body: { created: [{ id: 9, username: 'amy', externalId: 'u1' }], skipped: [] } }
        : undefined,
    );
    const { toasts } = renderAt('/settings/mediaservers');
    const section = await screen.findByRole('region', { name: 'Sign-in and user import' });
    expect(await within(section).findByText('Created on first sign-in')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Import users' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import users' });
    const amy = (await within(dialog).findByLabelText('Select amy')) as HTMLInputElement;
    expect((within(dialog).getByLabelText('Select bob') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText('Select cat') as HTMLInputElement).disabled).toBe(true);
    const importBtn = within(dialog).getByRole('button', { name: /Import selected/ }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    fireEvent.click(amy);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import selected (1)' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/user/import/mediaserver')?.body).toEqual({ externalIds: ['u1'] }));
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('1 user imported'));
  });

  it('explains when no sign-in server is configured', async () => {
    stubApi(routes({ '/api/v1/mediaserver': [], '/api/v1/settings/mediaserver': { ...signIn, kind: null, url: '', name: '' } }));
    renderAt('/settings/mediaservers');
    const section = await screen.findByRole('region', { name: 'Sign-in and user import' });
    expect(await within(section).findByText(/No server is set up for sign-in/)).toBeTruthy();
    expect((within(section).getByRole('button', { name: 'Import users' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Add media server/ })).toBeTruthy();
  });

  it('adds an Audiobookshelf server: masked token, no sign-in options, libraries after the test, refresh flag', async () => {
    const calls = stubApi(routes(), (url, method, body) => {
      if (method === 'POST' && url === '/api/v1/mediaserver/test')
        return { body: { ok: true, serverName: 'Shelf', version: '2.17.0', libraries: [{ id: 'lib1', name: 'Audiobooks', type: 'audiobook' }, { id: 'lib2', name: 'Podcasts', type: 'other' }] } };
      if (method === 'POST' && url === '/api/v1/mediaserver') return { status: 201, body: { ...server({ id: 'abs' }), ...(body as object), apiKey: '********' } };
      return undefined;
    });
    renderAt('/settings/mediaservers');
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add media server' });
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'audiobookshelf' } });
    const token = within(dialog).getByLabelText('API token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect((within(dialog).getByLabelText('URL') as HTMLInputElement).placeholder).toBe('http://audiobookshelf.lan:13378');
    expect(within(dialog).queryByRole('switch', { name: 'Sign-in' })).toBeNull();
    expect(within(dialog).queryByRole('switch', { name: 'Create users on sign-in' })).toBeNull();
    expect(within(dialog).queryByRole('switch', { name: 'Availability' })).toBeNull();
    expect((within(dialog).getByRole('switch', { name: 'Refresh after imports' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Shelf' } });
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: 'http://audiobookshelf.lan:13378' } });
    fireEvent.change(token, { target: { value: 'token-123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    const libraries = await within(dialog).findByRole('list', { name: 'Libraries' });
    expect(within(libraries).getByText('Audiobooks', { selector: '.al-ms-libraries__name' })).toBeTruthy();
    expect(within(libraries).getByText('Podcasts')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver')?.body).toMatchObject({
      kind: 'audiobookshelf',
      apiKey: 'token-123',
      usedForRefresh: true,
      usedForAvailability: false,
      loginEnabled: false,
      createUsersOnLogin: false,
    });
  });

  it('shows Audiobookshelf cards without an accounts button', async () => {
    stubApi(routes({ '/api/v1/mediaserver': [server({ id: 'abs', kind: 'audiobookshelf', name: 'Shelf', usedForAvailability: false, usedForRetention: false, usedForRefresh: true, loginEnabled: false, createUsersOnLogin: false })] }));
    renderAt('/settings/mediaservers');
    const card = (await screen.findByRole('button', { name: 'Shelf' })).closest('.al-item-card') as HTMLElement;
    expect(within(card).getByText('Audiobookshelf')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Accounts on Shelf' })).toBeNull();
  });
});

describe('Audiobookshelf helpers', () => {
  it('limits the flags and resets video-only uses', () => {
    expect(flagRowsFor('audiobookshelf').map((f) => f.key)).toEqual(['enabled', 'usedForRefresh']);
    expect(flagRowsFor('jellyfin')).toHaveLength(6);
    expect(withKind({ kind: 'jellyfin', name: 'A', url: 'x', loginEnabled: true, usedForAvailability: true }, 'audiobookshelf')).toMatchObject({
      kind: 'audiobookshelf',
      loginEnabled: false,
      usedForAvailability: false,
      usedForRefresh: true,
    });
    expect(validateServer({ kind: 'audiobookshelf', name: 'A', url: 'http://x', apiKey: '' }, true).apiKey).toBe('Enter an API token.');
    expect(probeOutcome({ ok: true, libraries: [] }, 'audiobookshelf').warnings).toEqual(['The server reports no book libraries.']);
  });
});
