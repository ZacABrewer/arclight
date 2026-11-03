import { describe, expect, it } from 'vitest';
import { createTestDb } from './db/test-utils.js';
import { setSection } from './modules/settings/service.js';
import { hasPlayerAddress, playerOriginOf, playerUrlOf, portalUrlOf, publicUrlOf } from './public-urls.js';

describe('publicUrlOf', () => {
  const none = { paths: [], hosts: [] };

  it('prefers the first hostname, with the Application URL scheme or else https', () => {
    const address = { paths: ['/tv'], hosts: [{ hostname: 'watch.example.com' }, { hostname: 'tv.example.com' }] };
    expect(publicUrlOf('', address, '/player')).toBe('https://watch.example.com');
    expect(publicUrlOf('http://nas.example.com:7878/', address, '/player')).toBe('http://watch.example.com');
    expect(publicUrlOf('', address, '/player', '/arclight')).toBe('https://watch.example.com/arclight');
  });

  it('then the Application URL with the first extra path, then the built-in path', () => {
    expect(publicUrlOf('https://media.example.com/', { paths: ['/tv', '/watch'], hosts: [] }, '/player')).toBe('https://media.example.com/tv');
    expect(publicUrlOf('https://media.example.com/arclight', none, '/player')).toBe('https://media.example.com/arclight/player');
  });

  it('is null without a hostname or Application URL', () => {
    expect(publicUrlOf('', { paths: ['/tv'], hosts: [] }, '/player')).toBeNull();
    expect(publicUrlOf('not a url', none, '/portal')).toBeNull();
  });
});

describe('player and portal addresses from settings', () => {
  it('reads Settings > Player and Settings > Requests', async () => {
    const db = await createTestDb();
    expect([playerUrlOf(db), portalUrlOf(db), playerOriginOf(db), hasPlayerAddress(db)]).toEqual([null, null, null, false]);
    setSection(db, 'requests', { applicationUrl: 'https://media.example.com', publicPortal: { enabled: false, paths: ['/ask'] } });
    expect(playerUrlOf(db)).toBe('https://media.example.com/player');
    // The portal has no address while it is off.
    expect(portalUrlOf(db)).toBeNull();
    setSection(db, 'requests', { applicationUrl: 'https://media.example.com', publicPortal: { enabled: true, paths: ['/ask'] } });
    expect(portalUrlOf(db)).toBe('https://media.example.com/ask');
    setSection(db, 'player', { address: { paths: ['/tv'], hosts: [{ hostname: 'watch.example.com' }] } });
    expect([playerUrlOf(db), playerOriginOf(db), hasPlayerAddress(db)]).toEqual(['https://watch.example.com', 'https://watch.example.com', true]);
    setSection(db, 'player', { address: { paths: ['/tv'] } });
    expect([playerUrlOf(db), playerOriginOf(db), hasPlayerAddress(db)]).toEqual(['https://media.example.com/tv', null, true]);
  });
});
