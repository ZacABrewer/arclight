import { describe, expect, it } from 'vitest';
import { appHref, playerOffLink } from './app-href.js';

// "Open Arclight": a path on this address, but never the root of a player hostname.

describe('appHref', () => {
  const host = { mode: 'host', playerOnly: true } as const;

  it('is a path on this address off player hostnames', () => {
    expect(appHref('/', null, undefined, 'https://nas.example.com', '')).toBe('/');
    expect(appHref('/', null, 'https://nas.example.com', 'https://nas.example.com', '')).toBe('/');
    expect(appHref('/requests', { mode: 'path', base: '/watch' }, undefined, 'https://nas.example.com', '/arclight')).toBe('/arclight/requests');
    expect(appHref(null, null, 'https://nas.example.com', 'https://nas.example.com', '')).toBeNull();
  });

  it('uses the Application URL on a player hostname and hides the link without one', () => {
    expect(appHref('/', host, 'https://media.example.com', 'https://watch.example.com', '')).toBe('https://media.example.com/');
    expect(appHref('/requests', host, 'https://media.example.com/arclight/', 'https://watch.example.com', '/arclight')).toBe('https://media.example.com/arclight/requests');
    expect(appHref('/', host, null, 'https://watch.example.com', '')).toBeNull();
    expect(appHref('/', host, undefined, 'https://watch.example.com', '')).toBeNull();
    expect(appHref('/', { mode: 'host', playerOnly: false }, 'https://watch.example.com', 'https://watch.example.com', '')).toBeNull();
    expect(appHref('/', host, 'not a url', 'https://watch.example.com', '')).toBeNull();
  });

  it('follows another origin from the server on a page without the player mapping', () => {
    // The "player is off" page on a player hostname: its root would only redirect back.
    expect(appHref('/', null, 'https://media.example.com', 'https://watch.example.com', '')).toBe('https://media.example.com/');
    expect(appHref('/requests', null, 'https://media.example.com/arclight/', 'https://watch.example.com', '/arclight')).toBe('https://media.example.com/arclight/requests');
    expect(appHref('/', null, 'https://nas.example.com/arclight', 'https://nas.example.com', '/arclight')).toBe('/arclight/');
    expect(appHref('/', null, 'not a url', 'https://watch.example.com', '')).toBe('/');
  });

  it('hides the link on a page without the player mapping when the server names no address', () => {
    // The "player is off" page on a player hostname without an Application URL: "/" would loop.
    expect(appHref('/', null, null, 'https://watch.example.com', '')).toBeNull();
    expect(appHref('/requests', null, null, 'https://watch.example.com', '/arclight')).toBeNull();
  });
});

describe('playerOffLink', () => {
  it('prefers Back to Arclight, then the portal', () => {
    expect(playerOffLink('https://media.example.com/', '/discover', 'https://media.example.com', 'https://watch.example.com')).toEqual({ href: 'https://media.example.com/', kind: 'app' });
    expect(playerOffLink(null, '/discover', 'https://nas.example.com', 'https://nas.example.com')).toEqual({ href: '/discover', kind: 'portal' });
    expect(playerOffLink(null, '/discover', undefined, 'https://nas.example.com')).toEqual({ href: '/discover', kind: 'portal' });
  });

  it('on a player hostname without another address, links only a portal on another origin', () => {
    expect(playerOffLink(null, '/discover', null, 'https://watch.example.com')).toBeNull();
    expect(playerOffLink(null, 'https://watch.example.com/discover', null, 'https://watch.example.com')).toBeNull();
    expect(playerOffLink(null, 'https://requests.example.com', null, 'https://watch.example.com')).toEqual({ href: 'https://requests.example.com', kind: 'portal' });
  });
});
