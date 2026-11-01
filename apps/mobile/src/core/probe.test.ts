import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest } from './http.js';
import { classifyNetworkError } from './http.js';
import { connect, probeServer } from './probe.js';

const authStatus = { needsSetup: false, adminExists: true, authMethod: 'forms', authenticated: false, session: null };

type Route = { status: number; data: unknown; url?: string } | Error;

/** Fake network: URL -> response or thrown error; unknown URLs are unreachable. */
function fakeHttp(routes: Record<string, Route>): HttpClient & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const fn = (async (req: HttpRequest) => {
    calls.push(req);
    const r = routes[req.url];
    if (!r) throw new Error('Could not connect to the server.');
    if (r instanceof Error) throw r;
    return { status: r.status, data: r.data, url: r.url ?? req.url };
  }) as HttpClient & { calls: HttpRequest[] };
  fn.calls = calls;
  return fn;
}

const arclightAt = (base: string): Record<string, Route> => ({
  [`${base}/api/v1/system/ping`]: { status: 200, data: { status: 'ok' } },
  [`${base}/api/v1/auth/status`]: { status: 200, data: authStatus },
});

describe('probeServer', () => {
  it('recognises Arclight and whether sign-in is needed', async () => {
    const r = await probeServer(fakeHttp(arclightAt('http://192.168.1.20:7878')), 'http://192.168.1.20:7878/');
    expect(r).toEqual({ ok: true, url: 'http://192.168.1.20:7878', needsSignIn: true, needsSetup: false, insecure: false });
  });

  it('accepts JSON delivered as a string', async () => {
    const http = fakeHttp({
      'https://a.example.com/api/v1/system/ping': { status: 200, data: '{"status":"ok"}' },
      'https://a.example.com/api/v1/auth/status': { status: 200, data: JSON.stringify({ ...authStatus, authenticated: true }) },
    });
    expect(await probeServer(http, 'https://a.example.com')).toMatchObject({ ok: true, needsSignIn: false });
  });

  it('follows redirects to the final base URL', async () => {
    const http = fakeHttp({
      'http://a.example.com/api/v1/system/ping': { status: 200, data: { status: 'ok' }, url: 'https://a.example.com/api/v1/system/ping' },
      'https://a.example.com/api/v1/auth/status': { status: 200, data: authStatus },
    });
    expect(await probeServer(http, 'http://a.example.com')).toMatchObject({ ok: true, url: 'https://a.example.com', insecure: false });
  });

  it('says not-arclight for other servers', async () => {
    const http = fakeHttp({
      'http://nas:8989/api/v1/system/ping': { status: 200, data: { status: 'OK' } },
      'http://nas:8989/api/v1/auth/status': { status: 404, data: '<html>' },
    });
    expect(await probeServer(http, 'http://nas:8989')).toMatchObject({ ok: false, reason: 'not-arclight' });
    expect(await probeServer(fakeHttp({ 'http://nas/api/v1/system/ping': { status: 200, data: '<html>router</html>' } }), 'http://nas')).toMatchObject({ ok: false, reason: 'not-arclight' });
  });

  it('classifies TLS and timeout errors', async () => {
    const tls = fakeHttp({ 'https://nas/api/v1/system/ping': new Error('The certificate for this server is invalid. (NSURLErrorDomain -1202)') });
    expect(await probeServer(tls, 'https://nas')).toMatchObject({ ok: false, reason: 'tls' });
    const timeout = fakeHttp({ 'https://nas/api/v1/system/ping': new Error('The request timed out.') });
    expect(await probeServer(timeout, 'https://nas')).toMatchObject({ ok: false, reason: 'timeout' });
    expect(classifyNetworkError(new Error('javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found.'))).toBe('tls');
    expect(classifyNetworkError(new Error('Failed to connect to /10.0.0.2:7878'))).toBe('unreachable');
  });
});

describe('connect', () => {
  it('picks the first working candidate in order (bare LAN IP -> http on 7878)', async () => {
    const r = await connect(fakeHttp(arclightAt('http://192.168.1.20:7878')), '192.168.1.20');
    expect(r).toMatchObject({ ok: true, url: 'http://192.168.1.20:7878' });
    expect(r.tried).toEqual(['https://192.168.1.20', 'http://192.168.1.20', 'https://192.168.1.20:7878', 'http://192.168.1.20:7878']);
  });

  it('prefers https when both answer', async () => {
    const http = fakeHttp({ ...arclightAt('https://nas.local:7878'), ...arclightAt('http://nas.local:7878') });
    expect(await connect(http, 'nas.local:7878')).toMatchObject({ ok: true, url: 'https://nas.local:7878' });
  });

  it('flags plain http to a public host', async () => {
    expect(await connect(fakeHttp(arclightAt('http://arclight.example.com')), 'http://arclight.example.com')).toMatchObject({ ok: true, insecure: true });
  });

  it('reports the most telling failure', async () => {
    const http = fakeHttp({ 'https://arclight.example.com/api/v1/system/ping': new Error('SSL handshake failed') });
    expect(await connect(http, 'arclight.example.com')).toMatchObject({ ok: false, reason: 'tls' });
    expect(await connect(fakeHttp({}), 'arclight.example.com')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await connect(fakeHttp({}), 'ftp://x')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
