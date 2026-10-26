import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DiscordLinkCode, UserRequestSettings } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from './test-utils.js';
import { codeExpired, linkedDiscordId } from './discord-link.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reqSettings = (over: Partial<UserRequestSettings> = {}): UserRequestSettings => ({ ...UserRequestSettings.parse({}), ...over });

function profileRoutes(u = user(), statusExtra: object = {}) {
  const auth = authRoutes(u);
  return {
    ...auth,
    '/api/v1/auth/status': { ...(auth['/api/v1/auth/status'] as object), ...statusExtra },
    '/api/v1/user/2/requestsettings': reqSettings(),
  };
}

describe('profile → Discord link', () => {
  it('reads the link from user settings and knows when a code expired', () => {
    expect(linkedDiscordId({ settings: { discordUserId: '123456789012' } })).toBe('123456789012');
    expect(linkedDiscordId({ settings: {} })).toBeNull();
    expect(linkedDiscordId(null)).toBeNull();
    expect(codeExpired({ expiresAt: '2026-10-26T10:00:00.000Z' }, Date.parse('2026-10-26T10:00:01.000Z'))).toBe(true);
    expect(codeExpired({ expiresAt: '2026-10-26T10:10:00.000Z' }, Date.parse('2026-10-26T10:00:00.000Z'))).toBe(false);
  });

  it('creates a link code, shows it with its expiry and copies the /link command', async () => {
    const code = DiscordLinkCode.parse({ code: 'K7Q2ZP4M', expiresAt: new Date(Date.now() + 600_000).toISOString(), linkedDiscordUserId: null });
    const calls = stubApi(profileRoutes(), (url, method) => (method === 'POST' && url === '/api/v1/user/me/discord/link-code' ? { body: code } : undefined));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt('/profile');
    const pane = await screen.findByRole('region', { name: 'Discord' });
    expect(within(pane).getByText('Not linked')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Create link code' }));
    expect((await within(pane).findByTestId('discord-code')).textContent).toBe('/link K7Q2ZP4M');
    expect(within(pane).getByRole('status', { name: 'Discord link code' }).textContent).toMatch(/Expires .*in 10 minutes/);
    fireEvent.click(within(pane).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/link K7Q2ZP4M'));
    expect(await within(pane).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(calls.filter((c) => c.url === '/api/v1/user/me/discord/link-code')).toHaveLength(1);
  });

  it('shows the linked Discord account and unlinks it', async () => {
    const linked = user({ settings: { discordUserId: '998877665544' } });
    const calls = stubApi(profileRoutes(linked), (url, method) => (method === 'DELETE' && url === '/api/v1/user/me/discord/link' ? { status: 204 } : undefined));
    const { toasts } = renderAt('/profile');
    const pane = await screen.findByRole('region', { name: 'Discord' });
    expect(await within(pane).findByText('998877665544')).toBeTruthy();
    expect(within(pane).getByText('Linked')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Unlink Discord' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/user/me/discord/link')).toBe(true));
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Discord account unlinked'));
  });
});

describe('profile → Plex link via PIN', () => {
  it('creates a PIN, opens Plex, polls and shows the linked account', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const linkedSettings = reqSettings({ mediaServerLink: { kind: 'plex', externalId: '42', username: 'amy-plex', linkedAt: '2026-10-26T10:00:00.000Z' } });
    let polls = 0;
    const calls = stubApi(profileRoutes(user(), { mediaServerLogin: { kind: 'plex' } }), (url, method) => {
      if (method === 'POST' && url === '/api/v1/user/me/mediaserver/plex/pin') return { body: { id: 77, code: 'PQRS', authUrl: 'https://app.plex.tv/auth#?code=PQRS' } };
      if (method === 'POST' && url === '/api/v1/user/me/mediaserver/plex/poll') {
        polls += 1;
        return { body: linkedSettings };
      }
      return undefined;
    });
    renderAt('/profile');
    const pane = await screen.findByRole('region', { name: 'Media server account' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Link Plex account' }));
    expect((await within(pane).findByRole('status')).textContent).toContain('PQRS');
    expect(open).toHaveBeenCalledWith('https://app.plex.tv/auth#?code=PQRS', 'plex-auth', expect.any(String));
    expect(within(pane).getByRole('link', { name: 'Open Plex again' }).getAttribute('href')).toBe('https://app.plex.tv/auth#?code=PQRS');
    expect(await within(pane).findByText('amy-plex', {}, { timeout: 6000 })).toBeTruthy();
    expect(polls).toBe(1);
    expect(calls.find((c) => c.url === '/api/v1/user/me/mediaserver/plex/poll')?.body).toEqual({ id: 77 });
    expect(calls.some((c) => c.url.startsWith('/api/v1/auth/plex/'))).toBe(false);
    expect(calls.some((c) => c.url === '/api/v1/user/2/mediaserver/link')).toBe(false);
  });

  it('keeps waiting while Plex answers pending and stops on cancel', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    stubApi(profileRoutes(user(), { mediaServerLogin: { kind: 'plex' } }), (url, method) => {
      if (method === 'POST' && url === '/api/v1/user/me/mediaserver/plex/pin') return { body: { id: 5, code: 'WAIT', authUrl: 'https://app.plex.tv/auth#?code=WAIT' } };
      if (method === 'POST' && url === '/api/v1/user/me/mediaserver/plex/poll') return { status: 202, body: { pending: true } };
      return undefined;
    });
    renderAt('/profile');
    const pane = await screen.findByRole('region', { name: 'Media server account' });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Link Plex account' }));
    expect((await within(pane).findByRole('status')).textContent).toContain('WAIT');
    fireEvent.click(within(pane).getByRole('button', { name: 'Cancel' }));
    expect(await within(pane).findByRole('button', { name: 'Link Plex account' })).toBeTruthy();
    expect(within(pane).queryByText('WAIT')).toBeNull();
  });
});
