import { describe, expect, it, vi } from 'vitest';
import { accountLinks, openInBrowser } from './account-links';

// The phone account sheet's "Request portal" and "Open Arclight" links.

const server = 'https://nas.example.com/arclight/';
const caps = { portalUrl: 'https://requests.example.com', canRequest: true, appHome: '/', appUrl: 'https://nas.example.com/arclight' };

describe('accountLinks', () => {
  it('gives an admin owner both links on the signed-in server', () => {
    expect(accountLinks(caps, true, server)).toEqual({ portal: 'https://requests.example.com', app: 'https://nas.example.com/arclight/' });
    expect(accountLinks({ ...caps, appHome: '/requests' }, true, server).app).toBe('https://nas.example.com/arclight/requests');
  });

  it('opens Arclight where the server says it answers, and hides it without an address', () => {
    // Signed in on a player hostname: the server names the Application URL instead.
    expect(accountLinks({ ...caps, appUrl: 'https://media.example.com/' }, true, 'https://watch.example.com').app).toBe('https://media.example.com/');
    expect(accountLinks({ ...caps, appUrl: null }, true, 'https://watch.example.com').app).toBeNull();
  });

  it('gives a request-only account only the portal', () => {
    expect(accountLinks({ ...caps, appHome: null }, true, server)).toEqual({ portal: 'https://requests.example.com', app: null });
  });

  it('falls back to the built-in portal, and hides it from accounts that may not request', () => {
    expect(accountLinks({ ...caps, portalUrl: null }, true, server).portal).toBe('https://nas.example.com/arclight/portal');
    expect(accountLinks({ ...caps, canRequest: false }, true, server).portal).toBeNull();
  });

  it('shows nothing on another profile, before the server answers, or for an older server', () => {
    expect(accountLinks(caps, false, server)).toEqual({ portal: null, app: null });
    expect(accountLinks(undefined, true, server)).toEqual({ portal: null, app: null });
    expect(accountLinks({}, true, server)).toEqual({ portal: null, app: null });
  });
});

describe('openInBrowser', () => {
  it('asks for the system browser', () => {
    const open = vi.fn();
    openInBrowser('https://requests.example.com', open);
    expect(open).toHaveBeenCalledWith('https://requests.example.com', '_system');
  });
});
