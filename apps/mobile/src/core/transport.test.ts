import { describe, expect, it } from 'vitest';
import { memoryStore } from './kv.js';
import { TransportStore, classifyHost, confirmsHost, httpsAlternatives, verdictFor } from './transport.js';

describe('classifyHost', () => {
  it.each([
    ['localhost', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['[::1]', 'loopback'],
    ['192.168.1.20', 'private'],
    ['10.0.0.5', 'private'],
    ['172.16.4.4', 'private'],
    ['169.254.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['nas', 'private'],
    ['nas.lan', 'private'],
    ['nas.local', 'private'],
    ['box.home.arpa', 'private'],
    ['fd12:3456::1', 'private'],
    ['arclight.example.com', 'public'],
    ['203.0.113.7', 'public'],
    ['100.128.0.1', 'public'],
    ['2001:db8::1', 'public'],
  ])('%s is %s', (host, cls) => expect(classifyHost(host)).toBe(cls));
});

describe('verdictFor', () => {
  const empty = { version: 1 as const, acks: {}, httpsHosts: [] };

  it('allows https and loopback http', () => {
    expect(verdictFor('https://arclight.example.com', empty)).toEqual({ kind: 'ok' });
    expect(verdictFor('http://localhost:7878', empty)).toEqual({ kind: 'ok' });
  });

  it('asks for a one-time notice on the home network', () => {
    expect(verdictFor('http://192.168.1.20:7878', empty)).toEqual({ kind: 'notice', host: '192.168.1.20' });
    expect(verdictFor('http://192.168.1.20:7878', { ...empty, acks: { 'http://192.168.1.20:7878': 'notice' } })).toEqual({ kind: 'ok' });
  });

  it('needs a typed confirmation for a public host; a notice is not enough', () => {
    expect(verdictFor('http://arclight.example.com', empty)).toEqual({ kind: 'confirm', host: 'arclight.example.com', reason: 'public' });
    expect(verdictFor('http://arclight.example.com', { ...empty, acks: { 'http://arclight.example.com': 'notice' } }).kind).toBe('confirm');
    expect(verdictFor('http://arclight.example.com/sub', { ...empty, acks: { 'http://arclight.example.com': 'confirmed' } })).toEqual({ kind: 'ok' });
  });

  it('is per origin: another port needs its own answer', () => {
    expect(verdictFor('http://arclight.example.com:8080', { ...empty, acks: { 'http://arclight.example.com': 'confirmed' } }).kind).toBe('confirm');
  });

  it('never downgrades a host pinned to https silently, even on the home network', () => {
    const pinned = { ...empty, httpsHosts: ['nas.lan'], acks: { 'http://nas.lan:7878': 'notice' as const } };
    expect(verdictFor('http://nas.lan:7878', pinned)).toEqual({ kind: 'confirm', host: 'nas.lan', reason: 'downgrade' });
    expect(verdictFor('http://nas.lan:7878', { ...pinned, acks: { 'http://nas.lan:7878': 'confirmed' } })).toEqual({ kind: 'ok' });
  });
});

describe('confirmsHost / httpsAlternatives', () => {
  it('matches the typed host loosely', () => {
    expect(confirmsHost('  Arclight.Example.com ', 'arclight.example.com')).toBe(true);
    expect(confirmsHost('arclight.example', 'arclight.example.com')).toBe(false);
  });

  it('lists https forms of an http address', () => {
    expect(httpsAlternatives('http://arclight.example.com:7878/sub/')).toEqual(['https://arclight.example.com/sub', 'https://arclight.example.com:7878/sub']);
    expect(httpsAlternatives('http://arclight.example.com')).toEqual(['https://arclight.example.com']);
    expect(httpsAlternatives('https://arclight.example.com')).toEqual([]);
  });
});

describe('TransportStore', () => {
  it('records answers and pins, and filters the origins handed to the native layer', async () => {
    const t = new TransportStore(memoryStore());
    const urls = ['https://a.example.com', 'http://192.168.1.20:7878', 'http://b.example.com'];
    expect(await t.allowedOrigins(urls)).toEqual(['https://a.example.com']);
    await t.accept('http://192.168.1.20:7878', await t.verdict('http://192.168.1.20:7878'));
    expect(await t.allowedOrigins(urls)).toEqual(['https://a.example.com', 'http://192.168.1.20:7878']);
    await t.accept('http://b.example.com', await t.verdict('http://b.example.com'));
    expect(await t.allowedOrigins(urls)).toHaveLength(3);
    await t.pinHttps('https://b.example.com');
    expect((await t.verdict('http://b.example.com')).kind).toBe('ok'); // confirmed before the pin
    await t.pinHttps('https://192.168.1.20');
    expect(await t.verdict('http://192.168.1.20:7878')).toEqual({ kind: 'confirm', host: '192.168.1.20', reason: 'downgrade' });
  });
});
