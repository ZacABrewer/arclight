import { describe, expect, it } from 'vitest';
import { AddressError, candidateUrls, isInsecurePublic, isPrivateHost, normalizeBaseUrl, parseAddress } from './address.js';

describe('parseAddress', () => {
  it('parses host, port, scheme and path', () => {
    expect(parseAddress('192.168.1.20:7878')).toMatchObject({ hostname: '192.168.1.20', port: 7878, scheme: null, path: '', isIp: true, isPrivate: true });
    expect(parseAddress(' HTTPS://Arclight.Example.com/media/ ')).toMatchObject({ hostname: 'arclight.example.com', port: null, scheme: 'https', path: '/media', isPrivate: false });
    expect(parseAddress('nas')).toMatchObject({ hostname: 'nas', isPrivate: true, isIp: false });
    expect(parseAddress('[fe80::1]:7878')).toMatchObject({ host: '[fe80::1]', port: 7878, isIp: true, isPrivate: true });
    expect(parseAddress('::1')).toMatchObject({ host: '[::1]', port: null, isIp: true });
    expect(parseAddress('example.com/?x=1#y')).toMatchObject({ path: '' });
  });

  it('rejects junk with a readable message', () => {
    for (const bad of ['', '   ', 'ftp://x', 'a b', 'host:abc', 'host:70000', 'user:pw@host', 'exa_mple.com', '[::1']) {
      expect(() => parseAddress(bad), bad).toThrow(AddressError);
    }
  });
});

describe('isPrivateHost', () => {
  it.each([
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.10', true],
    ['127.0.0.1', true],
    ['100.101.102.103', true],
    ['8.8.8.8', false],
    ['fd12:3456::1', true],
    ['2001:db8::1', false],
    ['nas.local', true],
    ['nas.home.arpa', true],
    ['box.tail1234.ts.net', true],
    ['arclight', true],
    ['arclight.example.com', false],
  ])('%s is private: %s', (host, expected) => expect(isPrivateHost(host)).toBe(expected));
});

describe('candidateUrls', () => {
  it('LAN IP with port: https first, then http', () => {
    expect(candidateUrls('192.168.1.20:7878')).toEqual(['https://192.168.1.20:7878', 'http://192.168.1.20:7878']);
  });

  it('LAN IP without port: default ports first, then 7878', () => {
    expect(candidateUrls('192.168.1.20')).toEqual(['https://192.168.1.20', 'http://192.168.1.20', 'https://192.168.1.20:7878', 'http://192.168.1.20:7878']);
  });

  it('public host: https only (plain http must be typed)', () => {
    expect(candidateUrls('arclight.example.com')).toEqual(['https://arclight.example.com', 'https://arclight.example.com:7878']);
    expect(candidateUrls('arclight.example.com:8443/arc/')).toEqual(['https://arclight.example.com:8443/arc']);
  });

  it('public bare IP also gets the http fallback', () => {
    expect(candidateUrls('203.0.113.7:7878')).toEqual(['https://203.0.113.7:7878', 'http://203.0.113.7:7878']);
  });

  it('respects a typed scheme and drops default ports', () => {
    expect(candidateUrls('http://nas')).toEqual(['http://nas', 'http://nas:7878']);
    expect(candidateUrls('https://arclight.example.com:443')).toEqual(['https://arclight.example.com']);
    expect(candidateUrls('http://192.168.1.20:80/x')).toEqual(['http://192.168.1.20/x']);
  });

  it('tries https first even when http:// was typed for a public host', () => {
    expect(candidateUrls('http://example.com:80/x')).toEqual(['https://example.com:80/x', 'http://example.com/x']);
    expect(candidateUrls('http://arclight.example.com')).toEqual(['https://arclight.example.com', 'http://arclight.example.com', 'https://arclight.example.com:7878', 'http://arclight.example.com:7878']);
  });
});

describe('helpers', () => {
  it('normalizes base URLs', () => {
    expect(normalizeBaseUrl('HTTP://NAS:80/arc/')).toBe('http://nas/arc');
    expect(normalizeBaseUrl('https://a.example.com:443')).toBe('https://a.example.com');
  });
  it('flags plain http outside the LAN', () => {
    expect(isInsecurePublic('http://arclight.example.com')).toBe(true);
    expect(isInsecurePublic('http://192.168.1.2:7878')).toBe(false);
    expect(isInsecurePublic('https://arclight.example.com')).toBe(false);
  });
});
