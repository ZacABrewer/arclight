import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK, type BooksLibraryAppInput } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { BooksLibraryAppsService, type FetchLike } from './library-apps.js';

// Library apps over a fake fetch: secrets are masked on reads and kept when the mask is sent
// back, the connection tests and the rescan calls hit each server's documented endpoints, and a
// failing app never throws out of `notify`.

const log = pino({ level: 'silent' });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(answer: (url: URL, init: RequestInit) => Response = () => new Response('{}')) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    calls.push({ method: init.method ?? 'GET', url: input, headers: { ...(init.headers as Record<string, string> | undefined) }, body: init.body as string | undefined });
    return answer(new URL(input), init);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const kavita = (extra: Partial<BooksLibraryAppInput> = {}): BooksLibraryAppInput => ({
  name: 'Kavita',
  implementation: 'kavita',
  enabled: true,
  url: 'http://kavita.example.com:5000/',
  apiKey: 'kavita-key',
  username: '',
  password: '',
  libraryId: '',
  kinds: ['comic'],
  ...extra,
});

describe('BooksLibraryAppsService', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('masks secrets on reads and keeps the stored one when the mask is sent back', () => {
    const svc = new BooksLibraryAppsService({ db, log });
    const created = svc.create(kavita());
    expect(created.apiKey).toBe(SECRET_MASK);
    expect(created.url).toBe('http://kavita.example.com:5000');
    svc.update(created.id, kavita({ apiKey: SECRET_MASK, name: 'Kavita 2' }));
    expect(svc.get(created.id).name).toBe('Kavita 2');
    // The stored key still signs in.
    const { calls, fetchImpl } = fakeFetch(() => json({ token: 'jwt' }));
    return new BooksLibraryAppsService({ db, log, fetchImpl }).test(kavita({ apiKey: SECRET_MASK }), created.id).then((r) => {
      expect(r.ok).toBe(true);
      expect(calls[0]!.url).toContain('apiKey=kavita-key');
    });
  });

  it('Kavita: signs in with the API key, then scans the imported folder', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === '/api/Plugin/authenticate' ? json({ token: 'jwt' }) : new Response(null, { status: 200 })));
    const svc = new BooksLibraryAppsService({ db, log, fetchImpl });
    svc.create(kavita());
    await svc.notify('comic', '/comics/Saga (2012)');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /api/Plugin/authenticate', 'POST /api/Library/scan-folder']);
    expect(calls[1]!.headers['Authorization']).toBe('Bearer jwt');
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ folderPath: '/comics/Saga (2012)' });
    // Ebook imports leave a comics-only app alone.
    await svc.notify('ebook', '/ebooks/x');
    expect(calls).toHaveLength(2);
  });

  it('Komga: scans every library when none is set, with the API key header', async () => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === '/api/v1/libraries' ? json([{ id: 'a' }, { id: 'b' }]) : new Response(null, { status: 202 })));
    const svc = new BooksLibraryAppsService({ db, log, fetchImpl });
    svc.create(kavita({ name: 'Komga', implementation: 'komga', url: 'http://komga.example.com', apiKey: 'komga-key', kinds: ['comic', 'ebook'] }));
    await svc.notify('ebook', '/ebooks/x');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /api/v1/libraries', 'POST /api/v1/libraries/a/scan', 'POST /api/v1/libraries/b/scan']);
    expect(calls[1]!.headers['X-API-Key']).toBe('komga-key');
  });

  it('Audiobookshelf: scans the configured library with a bearer key', async () => {
    const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 200 }));
    const svc = new BooksLibraryAppsService({ db, log, fetchImpl });
    svc.create(kavita({ name: 'ABS', implementation: 'audiobookshelf', url: 'http://abs.example.com', apiKey: 'abs-key', libraryId: 'lib1', kinds: ['ebook'] }));
    await svc.notify('ebook', '/ebooks/x');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://abs.example.com/api/libraries/lib1/scan');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer abs-key');
  });

  it('reports refused credentials in the test and swallows notify failures', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('no', { status: 401 }));
    const svc = new BooksLibraryAppsService({ db, log, fetchImpl });
    const result = await svc.test(kavita());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused the credentials/);
    svc.create(kavita());
    await expect(svc.notify('comic', '/comics/x')).resolves.toBeUndefined();
  });

  it('Calibre-Web: the test is a reachability check and notify calls nothing', async () => {
    const { calls, fetchImpl } = fakeFetch(() => new Response('<html></html>'));
    const svc = new BooksLibraryAppsService({ db, log, fetchImpl });
    const input = kavita({ name: 'Calibre-Web', implementation: 'calibreWeb', url: 'http://calibre.example.com', apiKey: '', kinds: ['ebook'] });
    expect((await svc.test(input)).ok).toBe(true);
    svc.create(input);
    await svc.notify('ebook', '/ebooks/x');
    expect(calls).toHaveLength(1);
  });
});
