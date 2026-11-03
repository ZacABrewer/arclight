import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, within } from '@testing-library/react';
import { Permission, type User } from '@arclight/shared';
import { renderAt, stubApi, user } from '../../requests/test-utils.js';
import { emptyBookHome } from '../browse/test-utils.js';

// The player's account menu: "Request portal" for people who may request, "Open Arclight"
// only for accounts with app pages, neither on a profile that is not the owner.

// The first test also loads the lazy player pages.
configure({ asyncUtilTimeout: 15_000 });
afterEach(() => vi.unstubAllGlobals());

const caps = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  allowed: true,
  remote: false,
  canStream: true,
  maxBitrateKbps: 0,
  sections: { music: false, audiobooks: true, podcasts: false, books: false, video: false },
  playerUrl: `${location.origin}/player`,
  portalUrl: `${location.origin}/portal`,
  ...over,
});

const profile = { id: 2, name: 'Sam', color: '#3a8fd9', initial: 'S', isOwner: false };

function open(u: User, opts: { isAdmin?: boolean; caps?: Record<string, unknown>; activeProfile?: typeof profile } = {}) {
  const session = { user: u, via: 'session', isAdmin: opts.isAdmin ?? u.role === 'admin', activeProfile: opts.activeProfile ?? null };
  stubApi({
    '/api/v1/auth/status': { needsSetup: false, adminExists: true, authMethod: 'forms', authenticated: true, session },
    '/api/v1/auth/me': session,
    '/api/v1/playback/me': caps(opts.caps),
    '/api/v1/playback/audiobooks/home': emptyBookHome,
  });
  renderAt('/player');
}

async function menu() {
  fireEvent.click(await screen.findByRole('button', { name: /^Profile menu, / }));
  return screen.getByRole('button', { name: 'Sign out' }).closest('.rd-menu__list') as HTMLElement;
}

describe('player account menu', { timeout: 30_000 }, () => {
  it('shows both links to an admin', async () => {
    open(user({ role: 'admin', permissions: Permission.ADMIN }));
    const list = await menu();
    expect(within(list).getByRole('link', { name: 'Open Arclight' }).getAttribute('href')).toBe('/');
    expect(within(list).getByRole('link', { name: 'Request portal' }).getAttribute('href')).toBe('/portal');
  });

  it('shows only the portal to a request-only account', async () => {
    open(user({ permissions: Permission.REQUEST }));
    const list = await menu();
    expect(within(list).getByRole('link', { name: 'Request portal' })).toBeTruthy();
    expect(within(list).queryByRole('link', { name: 'Open Arclight' })).toBeNull();
  });

  it('opens the requests page for an account that may view requests', async () => {
    open(user({ permissions: Permission.REQUEST | Permission.REQUEST_VIEW }));
    const list = await menu();
    expect(within(list).getByRole('link', { name: 'Open Arclight' }).getAttribute('href')).toBe('/requests');
  });

  it('shows neither to an account that may not request and has no app pages', async () => {
    open(user({ permissions: 0 }));
    const list = await menu();
    expect(within(list).queryByRole('link', { name: 'Request portal' })).toBeNull();
    expect(within(list).queryByRole('link', { name: 'Open Arclight' })).toBeNull();
  });

  it('shows neither on a profile that is not the owner', async () => {
    open(user({ role: 'admin', permissions: Permission.ADMIN }), { activeProfile: profile });
    const list = await menu();
    expect(within(list).queryByRole('link', { name: 'Request portal' })).toBeNull();
    expect(within(list).queryByRole('link', { name: 'Open Arclight' })).toBeNull();
  });

  it('goes to the built-in portal when the server gives no portal address', async () => {
    open(user({ permissions: Permission.REQUEST }), { caps: { portalUrl: null } });
    expect(within(await menu()).getByRole('link', { name: 'Request portal' }).getAttribute('href')).toBe('/portal');
  });

  it('links a portal hostname with its full address', async () => {
    open(user({ permissions: Permission.REQUEST }), { caps: { portalUrl: 'https://requests.example.com' } });
    expect(within(await menu()).getByRole('link', { name: 'Request portal' }).getAttribute('href')).toBe('https://requests.example.com');
  });
});
