import { describe, expect, it } from 'vitest';
import { portalHref } from './portal-href.js';

// "Request portal" links: the portal's public address, a path on this page's own origin.

describe('portalHref', () => {
  const here = 'https://nas.example.com';

  it('stays a path on this origin and is the full address on another hostname', () => {
    expect(portalHref('https://nas.example.com/portal', here, null, '')).toBe('/portal');
    expect(portalHref('https://nas.example.com/arclight/requests-here/', here, null, '/arclight')).toBe('/arclight/requests-here');
    expect(portalHref('https://requests.example.com', here, null, '')).toBe('https://requests.example.com');
    expect(portalHref('https://requests.example.com/arclight/', here, null, '')).toBe('https://requests.example.com/arclight');
    expect(portalHref('http://nas.example.com/portal', here, null, '')).toBe('http://nas.example.com/portal');
  });

  it('falls back to the built-in portal, mapped like the page is', () => {
    expect(portalHref(null, here, null, '')).toBe('/portal');
    expect(portalHref(undefined, here, null, '/arclight')).toBe('/arclight/portal');
    expect(portalHref('not a url', here, null, '')).toBe('/portal');
    expect(portalHref(null, here, { mode: 'path', base: '/requests-here' }, '')).toBe('/requests-here');
  });
});
