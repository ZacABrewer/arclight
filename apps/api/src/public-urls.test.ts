import { describe, expect, it } from 'vitest';
import { createTestDb } from './db/test-utils.js';
import { setSection } from './modules/settings/service.js';
import { appUrlOf, hasPlayerAddress, playerOriginOf, playerUrlOf, portalUrlOf, publicUrlOf } from './public-urls.js';

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

describe('appUrlOf ("Open Arclight")', () => {
  const here = 'https://watch.example.com';

  it('is the request address on any hostname but a player one', async () => {
    const db = await createTestDb();
    setSection(db, 'player', { enabled: true, address: { paths: ['/tv'], hosts: [{ hostname: 'watch.example.com', playerOnly: true }] } });
    expect(appUrlOf(db, 'nas.example.com:7878', 'http://nas.example.com:7878/arclight')).toBe('http://nas.example.com:7878/arclight');
  });

  it('is the Application URL on a player hostname, and null without one', async () => {
    const db = await createTestDb();
    setSection(db, 'player', { enabled: true, address: { paths: [], hosts: [{ hostname: 'watch.example.com', playerOnly: false }] } });
    expect(appUrlOf(db, 'Watch.Example.com:443', here)).toBeNull();
    setSection(db, 'requests', { applicationUrl: 'https://media.example.com/arclight/' });
    expect(appUrlOf(db, 'watch.example.com', here)).toBe('https://media.example.com/arclight');
    // An Application URL on the player hostname itself would only open the player again.
    setSection(db, 'requests', { applicationUrl: 'https://watch.example.com' });
    expect(appUrlOf(db, 'watch.example.com', here)).toBeNull();
  });

  it('keeps a player hostname one while the player is off', async () => {
    const db = await createTestDb();
    setSection(db, 'requests', { applicationUrl: 'https://media.example.com' });
    setSection(db, 'player', { enabled: false, address: { paths: [], hosts: [{ hostname: 'watch.example.com', playerOnly: true }] } });
    // Its root redirects to the "player is off" page, so the request address would loop.
    expect(appUrlOf(db, 'watch.example.com', here)).toBe('https://media.example.com');
    expect(appUrlOf(db, 'nas.example.com', 'https://nas.example.com')).toBe('https://nas.example.com');
  });
});
