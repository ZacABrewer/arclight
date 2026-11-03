import { describe, expect, it } from 'vitest';
import { appHref } from './app-href.js';

// "Open Arclight": a path on this address, but never the root of a player hostname.

describe('appHref', () => {
  const host = { mode: 'host', playerOnly: true } as const;

  it('is a path on this address off player hostnames', () => {
    expect(appHref('/', null, null, 'https://nas.example.com', '')).toBe('/');
    expect(appHref('/requests', { mode: 'path', base: '/watch' }, null, 'https://nas.example.com', '/arclight')).toBe('/arclight/requests');
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
});
