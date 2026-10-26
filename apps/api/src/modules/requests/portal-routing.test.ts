import { describe, expect, it } from 'vitest';
import { PublicPortalSettings, RESERVED_PORTAL_SEGMENTS } from '@arclight/shared';
import { injectPortalDocument, normalizeHostname, spaDecision } from './portal-routing.js';

const settings = (over: Partial<PublicPortalSettings> = {}) =>
  PublicPortalSettings.parse({
    enabled: true,
    paths: ['/watch', 'ajkdlfjla'],
    hosts: [
      { hostname: 'requests.example.com', portalOnly: true },
      { hostname: 'family.example.org', portalOnly: false },
    ],
    ...over,
  });

describe('portal paths and hostnames', () => {
  it('normalises and validates portal paths', () => {
    expect(settings().paths).toEqual(['/watch', '/ajkdlfjla']);
    expect(PublicPortalSettings.safeParse({ paths: ['/Watch/'] }).data?.paths).toEqual(['/watch']);
    for (const bad of ['/api', '/settings', '/library', '/assets', '/a/b', '/', 'with space', '/sw.js']) {
      expect(PublicPortalSettings.safeParse({ paths: [bad] }).success, bad).toBe(false);
    }
    expect(PublicPortalSettings.safeParse({ paths: ['/watch', '/WATCH'] }).success).toBe(false);
    expect(RESERVED_PORTAL_SEGMENTS).toContain('portal');
  });

  it('validates hostnames', () => {
    expect(PublicPortalSettings.parse({ hosts: [{ hostname: ' Requests.Example.COM ' }] }).hosts).toEqual([{ hostname: 'requests.example.com', portalOnly: true }]);
    for (const bad of ['https://x.example.com', 'x.example.com:8080', 'x.example.com/path', '-bad.example.com']) {
      expect(PublicPortalSettings.safeParse({ hosts: [{ hostname: bad }] }).success, bad).toBe(false);
    }
  });

  it('serves the portal below /portal and every portal path, on any hostname', () => {
    const s = settings();
    expect(spaDecision(s, 'nas.local:7878', '/portal')).toEqual({ kind: 'serve', portal: { mode: 'path', base: '/portal' } });
    expect(spaDecision(s, 'nas.local', '/watch/movie/603')).toEqual({ kind: 'serve', portal: { mode: 'path', base: '/watch' } });
    expect(spaDecision(s, 'nas.local', '/AJKDLFJLA')).toEqual({ kind: 'serve', portal: { mode: 'path', base: '/ajkdlfjla' } });
    expect(spaDecision(s, 'nas.local', '/watchlist')).toEqual({ kind: 'serve', portal: null });
    expect(spaDecision(s, 'nas.local', '/library/movies')).toEqual({ kind: 'serve', portal: null });
  });

  it('serves the portal at the root of portal hostnames and keeps portal-only hosts out of admin pages', () => {
    const s = settings();
    expect(spaDecision(s, 'requests.example.com', '/')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: true } });
    expect(spaDecision(s, 'REQUESTS.example.com:443', '/movie/603')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: true } });
    expect(spaDecision(s, 'requests.example.com', '/login')).toMatchObject({ kind: 'serve' });
    expect(spaDecision(s, 'requests.example.com', '/settings/general')).toEqual({ kind: 'redirect', location: '/' });
    expect(spaDecision(s, 'requests.example.com', '/library')).toEqual({ kind: 'redirect', location: '/' });
    // Not portal-only: admin pages stay reachable.
    expect(spaDecision(s, 'family.example.org', '/settings')).toEqual({ kind: 'serve', portal: { mode: 'host', portalOnly: false } });
  });

  it('does nothing while the portal is off', () => {
    const s = settings({ enabled: false });
    expect(spaDecision(s, 'requests.example.com', '/settings')).toEqual({ kind: 'serve', portal: null });
    expect(spaDecision(s, 'nas.local', '/watch')).toEqual({ kind: 'serve', portal: null });
  });

  it('normalises Host headers', () => {
    expect(normalizeHostname('Example.COM:8080')).toBe('example.com');
    expect(normalizeHostname('example.com.')).toBe('example.com');
    expect(normalizeHostname('[::1]:7878')).toBe('[::1]');
    expect(normalizeHostname(undefined)).toBe('');
  });

  it('writes the mapping into index.html as an escaped meta tag', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    expect(injectPortalDocument(html, null)).toBe(html);
    const out = injectPortalDocument(html, { mode: 'path', base: '/watch' });
    expect(out).toContain('<meta name="arclight-portal" content="{&quot;mode&quot;:&quot;path&quot;,&quot;base&quot;:&quot;/watch&quot;}" />');
    expect(out.indexOf('arclight-portal')).toBeLessThan(out.indexOf('</head>'));
  });
});
