import { describe, expect, it } from 'vitest';
import { appHomeOf, canRequest } from './access.js';
import { MediaServerTagSync } from './media-servers.js';
import { PlayerCapabilities, PlayerSettings, PublicPlayerAddress } from './playback.js';
import { Permission, PublicPortalSettings, addressClash } from './requests.js';

describe('player address contracts', () => {
  it('fills the player address and recap flag on old stored settings', () => {
    const s = PlayerSettings.parse({ enabled: true, segmentDetection: false });
    expect(s.address).toEqual({ paths: [], hosts: [] });
    expect(s.segmentDetectionRecaps).toBe(true);
    expect(s.segmentDetection).toBe(false);
  });

  it('normalises paths and hosts and defaults playerOnly to on', () => {
    const a = PublicPlayerAddress.parse({ paths: ['Watch/'], hosts: [{ hostname: ' Watch.Example.com ' }] });
    expect(a).toEqual({ paths: ['/watch'], hosts: [{ hostname: 'watch.example.com', playerOnly: true }] });
  });

  it('rejects reserved, malformed and duplicate entries', () => {
    expect(PublicPlayerAddress.safeParse({ paths: ['/player'] }).success).toBe(false);
    expect(PublicPlayerAddress.safeParse({ paths: ['/portal'] }).success).toBe(false);
    expect(PublicPlayerAddress.safeParse({ paths: ['/a b'] }).success).toBe(false);
    expect(PublicPlayerAddress.safeParse({ paths: ['/tv', 'TV'] }).success).toBe(false);
    expect(PublicPlayerAddress.safeParse({ hosts: [{ hostname: 'a.example.com' }, { hostname: 'A.example.com' }] }).success).toBe(false);
    expect(PublicPlayerAddress.safeParse({ hosts: [{ hostname: 'https://a.example.com' }] }).success).toBe(false);
    expect(PublicPlayerAddress.safeParse({ paths: Array.from({ length: 21 }, (_, i) => `/p${i}`) }).success).toBe(false);
  });

  it('parses capabilities from a server that predates the address fields', () => {
    const caps = PlayerCapabilities.parse({
      enabled: true, allowed: true, remote: false, canStream: true, maxBitrateKbps: 0,
      sections: { music: true, audiobooks: true, podcasts: false, books: false, video: true },
    });
    expect(caps).toMatchObject({ playerUrl: null, portalUrl: null, canRequest: false, appHome: null });
  });
});

describe('addressClash', () => {
  const portal = (paths: string[], hosts: string[]) => PublicPortalSettings.parse({ paths, hosts: hosts.map((hostname) => ({ hostname })) });

  it('finds a path both sides use', () => {
    expect(addressClash(portal(['/watch'], []), { paths: ['/watch', '/tv'], hosts: [] })).toEqual([{ field: 'paths', value: '/watch' }]);
  });

  it('finds a hostname both sides use, ignoring case and a trailing dot', () => {
    expect(addressClash(portal([], ['watch.example.com']), { paths: [], hosts: [{ hostname: 'Watch.Example.COM.', playerOnly: true }] }))
      .toEqual([{ field: 'hosts', value: 'watch.example.com' }]);
  });

  it('compares raw paths the way PortalPath stores them', () => {
    expect(addressClash({ paths: ['/watch'], hosts: [] }, { paths: ['Watch/'], hosts: [] })).toEqual([{ field: 'paths', value: '/watch' }]);
  });

  it('is empty when nothing is shared', () => {
    expect(addressClash(portal(['/requests-here'], ['requests.example.com']), { paths: ['/watch'], hosts: [{ hostname: 'watch.example.com', playerOnly: false }] })).toEqual([]);
  });
});

describe('appHomeOf and canRequest', () => {
  it('sends admins to the dashboard', () => {
    expect(appHomeOf(true, [], 0)).toBe('/');
    expect(appHomeOf(false, [], Permission.ADMIN)).toBe('/');
  });

  it('uses the first granted area in nav order', () => {
    expect(appHomeOf(false, ['wanted', 'calendar'], 0)).toBe('/calendar');
  });

  it('falls back to requests, then issues, then nothing', () => {
    expect(appHomeOf(false, [], Permission.REQUEST_VIEW)).toBe('/requests');
    expect(appHomeOf(false, [], Permission.MANAGE_ISSUES)).toBe('/issues');
    expect(appHomeOf(false, [], Permission.REQUEST | Permission.CREATE_ISSUES)).toBeNull();
  });

  it('knows who may request', () => {
    expect(canRequest(0)).toBe(false);
    expect(canRequest(Permission.CREATE_ISSUES)).toBe(false);
    for (const p of [Permission.REQUEST, Permission.REQUEST_MOVIE, Permission.REQUEST_TV, Permission.REQUEST_MUSIC, Permission.REQUEST_AUDIOBOOK, Permission.ADMIN]) {
      expect(canRequest(p)).toBe(true);
    }
  });
});

describe('MediaServerTagSync', () => {
  it('defaults to off with locked tags', () => {
    expect(MediaServerTagSync.parse({})).toEqual({ enabled: false, mode: 'all', tagIds: [], prefix: '', lockTags: true });
    expect(MediaServerTagSync.safeParse({ prefix: 'a,b' }).success).toBe(false);
  });
});
