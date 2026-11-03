import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyHost } from './address';
import { isInsecureTransportError, request, setFetch } from './api';
import { memoryStore, readJson } from './kv';
import { setSession } from './session';
import { confirmationMatches, confirmationName, transportOf, transportPolicy, TransportPolicy } from './transport';
import { fakeFetch } from '../test/fetch';

describe('classifyHost', () => {
  it.each([
    ['localhost', 'loopback'],
    ['app.localhost', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.0.0.9', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.10.1', 'private'],
    ['100.64.0.7', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'private'],
    ['::ffff:192.168.1.20', 'private'],
    ['::ffff:c0a8:0114', 'private'],
    ['nas', 'private'],
    ['nas.local', 'private'],
    ['media.lan', 'private'],
    ['NAS.Home.Arpa.', 'private'],
    ['box.tailnet-name.ts.net', 'private'],
    ['music.example.com', 'public'],
    ['203.0.113.7', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['2001:db8::1', 'public'],
    ['::ffff:203.0.113.7', 'public'],
    ['999.1.1.1', 'public'],
    ['1234', 'public'],
    ['local.example.com', 'public'],
  ])('%s is %s', (host, want) => {
    expect(classifyHost(host)).toBe(want);
  });
});

describe('transportOf', () => {
  it('sorts URLs by scheme and host', () => {
    expect(transportOf('https://203.0.113.7')).toBe('https');
    expect(transportOf('http://192.168.1.20:7878')).toBe('http-private');
    expect(transportOf('http://[::1]:7878')).toBe('http-private');
    expect(transportOf('http://music.example.com:7878')).toBe('http-public');
    expect(transportOf('not a url')).toBe('http-public');
  });

  it('matches the typed host name loosely, the host itself strictly', () => {
    const url = 'http://Music.Example.com:7878/arclight';
    expect(confirmationName(url)).toBe('music.example.com');
    expect(confirmationMatches(url, '  MUSIC.example.com. ')).toBe(true);
    expect(confirmationMatches(url, 'music.example.com:7878')).toBe(false);
    expect(confirmationMatches(url, 'example.com')).toBe(false);
    expect(confirmationMatches(url, '')).toBe(false);
  });
});

describe('TransportPolicy', () => {
  it('allows https and the home network, and asks for a typed confirmation on the internet', async () => {
    const policy = new TransportPolicy();
    expect(policy.allowsCredentials('https://music.example.com')).toBe(true);
    expect(policy.need('https://music.example.com')).toBe('none');
    expect(policy.allowsCredentials('http://192.168.1.20:7878')).toBe(true);
    expect(policy.need('http://192.168.1.20:7878')).toBe('notice');
    expect(policy.allowsCredentials('http://music.example.com:7878')).toBe(false);
    expect(policy.need('http://music.example.com:7878')).toBe('confirm');

    await policy.noticed('http://192.168.1.20:7878');
    expect(policy.need('http://192.168.1.20:9000')).toBe('none');

    await policy.confirm('http://music.example.com:7878');
    expect(policy.allowsCredentials('http://music.example.com:7878')).toBe(true);
    expect(policy.need('http://music.example.com')).toBe('none');
    expect(policy.allowsCredentials('http://other.example.com')).toBe(false);
  });

  it('keeps answers across restarts', async () => {
    const kv = memoryStore();
    const first = new TransportPolicy(kv);
    await first.confirm('http://music.example.com:7878');
    await first.pinHttps('https://secure.example.com');
    expect(await readJson(kv, 'arclight.transport')).toMatchObject({ version: 1 });

    const second = new TransportPolicy();
    await second.load(kv);
    expect(second.allowsCredentials('http://music.example.com:7878')).toBe(true);
    expect(second.isPinnedHttps('https://secure.example.com')).toBe(true);
  });

  it('ignores a damaged record', async () => {
    const policy = new TransportPolicy();
    await policy.load(memoryStore({ 'arclight.transport': '{"hosts":null}' }));
    expect(policy.need('http://music.example.com')).toBe('confirm');
  });

  it('pins a host to https once it worked, and asks again before going back to http', async () => {
    const policy = new TransportPolicy();
    await policy.confirm('http://music.example.com:7878');
    await policy.pinHttps('https://music.example.com');
    expect(policy.allowsCredentials('http://music.example.com:7878')).toBe(false);
    expect(policy.need('http://music.example.com:7878')).toBe('confirm');
    await policy.confirm('http://music.example.com:7878');
    expect(policy.allowsCredentials('http://music.example.com:7878')).toBe(true);
    // A later https success does not drop the new answer.
    await policy.pinHttps('https://music.example.com');
    expect(policy.allowsCredentials('http://music.example.com:7878')).toBe(true);

    await policy.pinHttps('https://nas.local');
    expect(policy.need('http://nas.local:7878')).toBe('confirm');
  });

  it('only pins https addresses', async () => {
    const policy = new TransportPolicy();
    await policy.pinHttps('http://192.168.1.20:7878');
    expect(policy.isPinnedHttps('http://192.168.1.20:7878')).toBe(false);
  });
});

describe('request and the cleartext policy', () => {
  const routes = {
    'GET /user/me': { json: { ok: true } },
    'POST /app/sign-in': { json: { ok: true } },
    'GET /system/ping': { json: { ok: true } },
  };
  const Ok = z.object({ ok: z.boolean() });

  beforeEach(() => transportPolicy.load(memoryStore()));
  afterEach(() => {
    setFetch(null);
    setSession(null);
  });

  const signedIn = (serverUrl: string) => setSession({ accountId: 'a_1', serverUrl, token: 'alt_token', deviceId: 3 });

  it('never sends the token over plain http to an internet host the user has not allowed', async () => {
    const { impl, calls } = fakeFetch(routes);
    setFetch(impl);
    signedIn('http://music.example.com:7878');
    const err = await request('/user/me', Ok).catch((e: unknown) => e);
    expect(isInsecureTransportError(err)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('never sends a password or pair code there either, even without a token', async () => {
    const { impl, calls } = fakeFetch(routes);
    setFetch(impl);
    const err = await request('/app/sign-in', Ok, {
      method: 'POST',
      json: { username: 'u', password: 'p' },
      target: { serverUrl: 'http://music.example.com', token: null },
    }).catch((e: unknown) => e);
    expect(isInsecureTransportError(err)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('still reaches public endpoints without credentials', async () => {
    const { impl, calls } = fakeFetch(routes);
    setFetch(impl);
    await request('/system/ping', Ok, { target: { serverUrl: 'http://music.example.com', token: null } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has('authorization')).toBe(false);
  });

  it('sends the token once the user typed the host name', async () => {
    const { impl, calls } = fakeFetch(routes);
    setFetch(impl);
    await transportPolicy.confirm('http://music.example.com:7878');
    signedIn('http://music.example.com:7878');
    await request('/user/me', Ok);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer alt_token');
  });

  it('sends the token over http on the home network and over https anywhere', async () => {
    const { impl, calls } = fakeFetch(routes);
    setFetch(impl);
    signedIn('http://192.168.1.20:7878');
    await request('/user/me', Ok);
    signedIn('https://music.example.com');
    await request('/user/me', Ok);
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer alt_token', 'Bearer alt_token']);
  });

  it('pins a host after an https answer, so plain http to it is refused', async () => {
    const { impl, calls } = fakeFetch(routes);
    setFetch(impl);
    signedIn('https://nas.local');
    await request('/user/me', Ok);
    await new Promise((r) => setTimeout(r, 0));
    expect(transportPolicy.isPinnedHttps('https://nas.local')).toBe(true);
    signedIn('http://nas.local:7878');
    const err = await request('/user/me', Ok).catch((e: unknown) => e);
    expect(isInsecureTransportError(err)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
