import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ProviderError, type SubtitleQuery } from '../types.js';
import { Napisy24Provider, parseNapisy24Status, splitNapisy24Response } from './napisy24.js';

const head = readFileSync(new URL('../../fixtures/napisy24/ok2-head.txt', import.meta.url), 'utf8');

/** Minimal store-only zip with one entry. */
function storeZip(name: string, data: Uint8Array): Uint8Array {
  const n = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const localLen = 30 + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(localLen, 16);
  return new Uint8Array(Buffer.concat([local, n, data, central, n, end]));
}

const srt = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nCześć\n');
const zip = storeZip('Matrix.srt', srt);

type Route = [RegExp, (url: string, init?: RequestInit) => Response];
function fakeFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [re, h] of routes) if (re.test(url)) return h(url, init);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const make = (respond: () => Response) => {
  const f = fakeFetch([[/CheckSubAgent/, respond]]);
  return { p: new Napisy24Provider({ username: 'user', password: 'secret' }, { fetch: f.fn, sleep: async () => {} }), calls: f.calls };
};
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const okResponse = () => new Response(concat(new TextEncoder().encode(head + '||'), zip));

const movie: SubtitleQuery = {
  mediaType: 'movie',
  title: 'The Matrix',
  imdbId: 'tt0133093',
  fileName: 'The.Matrix.1999.1080p.mkv',
  filePath: '/movies/The Matrix (1999)/The.Matrix.1999.1080p.mkv',
  fileSize: 8_000_000_000,
  hashes: { opensubtitles: '8e245d9679d31e12' },
  languages: [{ tag: 'pl', forced: false, hi: 'normal' }],
};

describe('napisy24', () => {
  it('requires credentials', () => {
    try {
      new Napisy24Provider({ username: '', password: '' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).code).toBe('config');
    }
  });

  it('needs the hash, the size and Polish', () => {
    const { p } = make(okResponse);
    expect(p.supports(movie).ok).toBe(true);
    expect(p.supports({ ...movie, hashes: {} }).ok).toBe(false);
    expect(p.supports({ ...movie, fileSize: undefined }).ok).toBe(false);
    expect(p.supports({ ...movie, languages: [{ tag: 'en', forced: false, hi: 'normal' }] }).ok).toBe(false);
  });

  it('splits the status block from binary payload and parses fields', () => {
    const { head: h, body } = splitNapisy24Response(concat(new TextEncoder().encode('OK-2|imdb:1||'), new Uint8Array([0x50, 0x4b, 0x7c])));
    expect(h).toBe('OK-2|imdb:1');
    expect([...body]).toEqual([0x50, 0x4b, 0x7c]);
    expect(parseNapisy24Status(head)).toEqual({
      status: 'OK-2',
      fields: { napisId: '48213', imdb: '133093', ftitle: 'Matrix', fyear: '1999' },
    });
  });

  it('posts the CheckSub form and maps OK-2 to one hash candidate', async () => {
    const { p, calls } = make(okResponse);
    const res = await p.search(movie);
    expect(res).toHaveLength(1);
    const c = res[0]!;
    expect(c.id).toBe('8e245d9679d31e12');
    expect(c.language).toBe('pl');
    expect([...c.matches].sort()).toEqual(['hash', 'imdb_id']);
    expect(c.hashVerifiable).toBe(true);
    expect(c.token?.imdbId).toBe('tt0133093');
    const form = new URLSearchParams(String(calls[0]!.init?.body));
    expect(calls[0]!.init?.method).toBe('POST');
    expect(Object.fromEntries(form)).toEqual({
      postAction: 'CheckSub',
      ua: 'user',
      ap: 'secret',
      fs: '8000000000',
      fh: '8e245d9679d31e12',
      fn: 'The.Matrix.1999.1080p.mkv',
      n24pref: '1',
    });
  });

  it('download returns the zip held in the token without another request', async () => {
    const { p, calls } = make(okResponse);
    const [c] = await p.search(movie);
    const file = await p.download(c!);
    expect([...file.bytes]).toEqual([...zip]);
    expect(file.fileName).toBe('napisy24.zip');
    expect(calls).toHaveLength(1);
  });

  it('returns nothing for OK-0, OK-1 and OK-3', async () => {
    for (const s of ['OK-0', 'OK-1|imdb:133093', 'OK-3|x:y']) {
      const { p } = make(() => new Response(`${s}||`));
      expect(await p.search(movie)).toEqual([]);
    }
  });

  it('maps login error to auth and HTTP errors to typed errors', async () => {
    const bad = make(() => new Response('login error'));
    await expect(bad.p.search(movie)).rejects.toMatchObject({ code: 'auth' });
    await expect(bad.p.test()).rejects.toMatchObject({ code: 'auth' });
    const down = make(() => new Response('', { status: 502 }));
    await expect(down.p.search(movie)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('omits imdb_id when the returned imdb differs', async () => {
    const { p } = make(okResponse);
    const [c] = await p.search({ ...movie, imdbId: 'tt0000001' });
    expect([...c!.matches]).toEqual(['hash']);
  });
});
