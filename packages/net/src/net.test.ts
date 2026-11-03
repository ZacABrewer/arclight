import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createSafeFetch, isOwnOutboundSocket, OUTBOUND_HEADER, trackOutboundSockets, isBlockedAddress, isPrivateHostname, parseIpv6, readLimited, resolveAllowed, SafeFetchError } from './index.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '198.18.0.1', '198.19.255.1', '224.0.0.1', '255.255.255.255', '192.0.2.5',
    '::', '::1', '[::1]', '::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1',
    '::ffff:127.0.0.1', '::127.0.0.1', '::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1',
    '2002:c0a8:0101::1', '::ffff:8.8.8.8', 'not-an-ip', '',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '64:ff9b::808:808', '2002:0808:0808::1'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it('parses every IPv6 spelling to the same groups', () => {
    expect(parseIpv6('::ffff:127.0.0.1')).toEqual(parseIpv6('0:0:0:0:0:ffff:7f00:1'));
    expect(parseIpv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('isPrivateHostname', () => {
  it.each(['localhost', 'a.localhost', 'nas', 'nas.lan', 'box.local', 'router.home.arpa', '127.1', '0x7f.1', '0177.0.0.1', '[::ffff:7f00:1]', '2130706433'])(
    'treats %s as private',
    (h) => {
      expect(isPrivateHostname(h)).toBe(true);
    },
  );
  it('allows public names', () => {
    expect(isPrivateHostname('example.com')).toBe(false);
    expect(isPrivateHostname('8.8.8.8')).toBe(false);
  });
});

describe('resolveAllowed', () => {
  it('rejects a public-looking name that resolves to loopback', async () => {
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(resolveAllowed('127.0.0.1.nip.example', { resolve })).rejects.toThrow(/local or reserved/);
  });
  it('rejects a name with any private answer', async () => {
    const resolve = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    await expect(resolveAllowed('mixed.example', { resolve })).rejects.toThrow();
  });
  it('allows private answers for admin-configured targets', async () => {
    const resolve = async () => [{ address: '192.168.1.10', family: 4 }];
    await expect(resolveAllowed('nas.example', { resolve, allowPrivate: true })).resolves.toHaveLength(1);
  });
});

// Local stub servers. "Public" is simulated with the allowAddress seam: the name public.test
// maps to 127.0.0.1 and is the only host allowed; anything else on loopback stays blocked.
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: http.RequestListener): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

const publicOnly = {
  resolve: async (host: string) => (host === 'public.test' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
  allowAddress: (_addr: string, host: string) => host === 'public.test',
};

describe('createSafeFetch', () => {
  it('refuses literal loopback and mapped IPv6 without sending anything', async () => {
    const target = await serve((_q, s) => s.end('secret'));
    const f = createSafeFetch();
    await expect(f(`http://127.0.0.1:${target.port}/`)).rejects.toBeInstanceOf(SafeFetchError);
    await expect(f(`http://[::ffff:127.0.0.1]:${target.port}/`)).rejects.toMatchObject({ code: 'blocked' });
    expect(target.hits()).toBe(0);
  });

  it('refuses a name resolving to loopback', async () => {
    const target = await serve((_q, s) => s.end('secret'));
    const f = createSafeFetch({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    await expect(f(`http://rebind.example:${target.port}/`)).rejects.toMatchObject({ code: 'blocked' });
    expect(target.hits()).toBe(0);
  });

  it('vets every redirect hop: a public 307 to loopback never reaches loopback', async () => {
    const inner = await serve((_q, s) => s.end('internal'));
    const outer = await serve((_q, s) => {
      s.writeHead(307, { location: `http://127.0.0.1:${inner.port}/api` });
      s.end();
    });
    const f = createSafeFetch(publicOnly);
    await expect(f(`http://public.test:${outer.port}/r`)).rejects.toMatchObject({ code: 'blocked' });
    await expect(f(`http://public.test:${outer.port}/r`, { method: 'POST', body: 'x' })).rejects.toBeInstanceOf(SafeFetchError);
    expect(outer.hits()).toBe(2);
    expect(inner.hits()).toBe(0);
  });

  it('drops credentials and refuses bodies on cross-origin redirects', async () => {
    let seen: http.IncomingHttpHeaders | undefined;
    const b = await serve((q, s) => {
      seen = q.headers;
      s.end('ok');
    });
    const a = await serve((_q, s) => {
      s.writeHead(302, { location: `http://127.0.0.1:${b.port}/` });
      s.end();
    });
    const f = createSafeFetch({ allowPrivate: true, sensitiveHeaders: ['x-api-key'] });
    const res = await f(`http://localhost:${a.port}/`, { headers: { authorization: 'Bearer t', cookie: 'c=1', 'x-api-key': 'k', 'x-keep': '1' } });
    expect(await res.text()).toBe('ok');
    expect(res.redirected).toBe(true);
    expect(seen?.authorization).toBeUndefined();
    expect(seen?.cookie).toBeUndefined();
    expect(seen?.['x-api-key']).toBeUndefined();
    expect(seen?.['x-keep']).toBe('1');

    const c = await serve((_q, s) => {
      s.writeHead(307, { location: `http://127.0.0.1:${b.port}/` });
      s.end();
    });
    await expect(f(`http://localhost:${c.port}/`, { method: 'POST', body: 'payload' })).rejects.toMatchObject({ code: 'redirect' });
  });

  it('returns redirects as is with redirect: manual', async () => {
    const a = await serve((_q, s) => {
      s.writeHead(301, { location: 'http://example.com/' });
      s.end();
    });
    const res = await createSafeFetch({ allowPrivate: true })(`http://127.0.0.1:${a.port}/`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://example.com/');
  });

  it('caps the body of an endless stream', async () => {
    const a = await serve((_q, s) => {
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => {
        while (s.write(chunk));
      };
      s.on('drain', pump);
      pump();
    });
    const res = await createSafeFetch({ allowPrivate: true, maxBytes: 256 * 1024 })(`http://127.0.0.1:${a.port}/`);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('caps the decoded size of a gzip bomb', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024));
    const a = await serve((_q, s) => {
      s.writeHead(200, { 'content-encoding': 'gzip' });
      s.end(bomb);
    });
    const res = await createSafeFetch({ allowPrivate: true, maxBytes: 1024 * 1024 })(`http://127.0.0.1:${a.port}/`);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('decodes gzip like fetch', async () => {
    const a = await serve((_q, s) => {
      s.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      s.end(zlib.gzipSync('hello'));
    });
    const res = await createSafeFetch({ allowPrivate: true })(`http://127.0.0.1:${a.port}/`);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('keeps the timeout running while the body is read', async () => {
    const a = await serve((_q, s) => {
      s.writeHead(200);
      s.write('a'); // then never finish
    });
    const res = await createSafeFetch({ allowPrivate: true, timeoutMs: 300 })(`http://127.0.0.1:${a.port}/`);
    const started = Date.now();
    await expect(res.text()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('sends bodies and methods', async () => {
    let got = '';
    const a = await serve((q, s) => {
      q.setEncoding('utf8');
      q.on('data', (d: string) => (got += d));
      q.on('end', () => s.end(`${q.method} ${q.headers['content-type']}`));
    });
    const res = await createSafeFetch({ allowPrivate: true })(`http://127.0.0.1:${a.port}/`, { method: 'PUT', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
    expect(await res.text()).toBe('PUT application/json');
    expect(got).toBe('{"a":1}');
  });
});

describe('readLimited', () => {
  it('rejects at the cap', async () => {
    const res = new Response('x'.repeat(2000));
    await expect(readLimited(res, 1000)).rejects.toMatchObject({ code: 'tooLarge' });
    expect((await readLimited(new Response('abc'), 10)).toString()).toBe('abc');
  });
});

describe('self-request marking (DATA-01)', () => {
  it('stamps the outbound header and recognises our own sockets', async () => {
    trackOutboundSockets();
    let header: string | string[] | undefined;
    let ours = false;
    const a = await serve((q, s) => {
      header = q.headers[OUTBOUND_HEADER];
      ours = isOwnOutboundSocket(q.socket.remoteAddress, q.socket.remotePort);
      s.end('ok');
    });
    await (await createSafeFetch({ allowPrivate: true })(`http://127.0.0.1:${a.port}/`)).text();
    expect(header).toBe('1');
    expect(ours).toBe(true);
    await fetch(`http://127.0.0.1:${a.port}/`).then((r) => r.text());
    expect(ours).toBe(true);
    expect(isOwnOutboundSocket('127.0.0.1', 1)).toBe(false);
  });
});
