import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError, type SubtitleQuery } from '../types.js';
import { Addic7edProvider, addic7edLanguageFromName, addic7edLanguageName, sanitizeName } from './addic7ed.js';

const fx = (name: string) => readFileSync(new URL(`../../fixtures/addic7ed/${name}`, import.meta.url), 'utf8');

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
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const panelOk: Route = [/panel\.php/, () => html('<html>panel</html>')];

const episode: SubtitleQuery = {
  mediaType: 'episode',
  title: 'The Big Bang Theory',
  season: 1,
  episode: 1,
  languages: [
    { tag: 'en', forced: false, hi: 'normal' },
    { tag: 'pt-BR', forced: false, hi: 'normal' },
    { tag: 'fr', forced: false, hi: 'normal' },
  ],
};

function provider(routes: Route[], config: ConstructorParameters<typeof Addic7edProvider>[0] = { cookies: 'wikisubtitlesuser=1; wikisubtitlespass=x' }, now = () => 1_700_000_000_000) {
  const f = fakeFetch(routes);
  return { p: new Addic7edProvider(config, { fetch: f.fn, sleep: async () => {}, now }), calls: f.calls };
}

describe('addic7ed', () => {
  it('requires cookies or credentials', () => {
    expect(() => new Addic7edProvider({})).toThrow(ProviderError);
    try {
      new Addic7edProvider({ username: 'u' });
    } catch (e) {
      expect((e as ProviderError).code).toBe('config');
    }
  });

  it('maps site language spellings', () => {
    expect(addic7edLanguageFromName('Català')).toBe('ca');
    expect(addic7edLanguageFromName('Portuguese (Brazilian)')).toBe('pt-BR');
    expect(addic7edLanguageFromName('Chinese (Traditional)')).toBe('zh');
    expect(addic7edLanguageFromName('Spanish (Latin America)')).toBe('es');
    expect(addic7edLanguageFromName('Serbian (Latin)')).toBe('sr-Latn');
    expect(addic7edLanguageName('eu')).toBe('Euskera');
    expect(addic7edLanguageName('gl')).toBe('Galego');
    expect(sanitizeName("Marvel's Agents: S.H.I.E.L.D.")).toBe('marvels agents s h i e l d');
  });

  it('refuses forced-only and season-less queries', () => {
    const { p } = provider([]);
    expect(p.supports({ ...episode, languages: [{ tag: 'en', forced: true, hi: 'normal' }] }).ok).toBe(false);
    expect(p.supports({ ...episode, season: undefined }).ok).toBe(false);
    expect(p.supports(episode).ok).toBe(true);
  });

  it('parses the season page into episode candidates', async () => {
    const { p, calls } = provider([panelOk, [/shows\.php/, () => html(fx('shows.html'))], [/ajax_loadShow/, () => html(fx('season.html'))]]);
    const res = await p.search(episode);
    // English x2, pt-BR; French in progress skipped; Català not wanted; episode 2 skipped.
    expect(res.map((c) => c.id)).toEqual(['updated/1/40001/0', 'original/40002/0', 'original/40003/0']);
    expect(res[0]!.language).toBe('en');
    expect(res[0]!.hi).toBe(false);
    expect(res[1]!.hi).toBe(true);
    expect(res[1]!.releaseInfo).toBe('DIMENSION');
    expect(res[2]!.language).toBe('pt-BR');
    expect([...res[0]!.matches].sort()).toEqual(['episode', 'season', 'series']);
    expect(res[0]!.downloadUrl).toBe('https://www.addic7ed.com/updated/1/40001/0');
    expect(res[0]!.pageUrl).toBe('https://www.addic7ed.com/serie/The_Big_Bang_Theory/1/1/Pilot');
    const ajax = calls.find((c) => /ajax_loadShow/.test(c.url))!;
    expect(ajax.url).toContain('show=130&season=1');
    expect((ajax.init?.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest');
    expect((ajax.init?.headers as Record<string, string>).Cookie).toContain('wikisubtitlesuser');
  });

  it('resolves shows by year suffix, & and alternative titles', async () => {
    const { p } = provider([panelOk, [/shows\.php/, () => html(fx('shows.html'))]]);
    expect(await p.resolveShowId('Doctor Who', 2005)).toEqual({ id: 5240, withYear: true });
    expect(await p.resolveShowId('The Office')).toEqual({ id: 77, withYear: false });
    expect(await p.resolveShowId('Law and Order')).toEqual({ id: 901, withYear: false });
    expect(await p.resolveShowId('Nope')).toBeUndefined();
  });

  it('adds year when the show resolved with its year', async () => {
    const { p } = provider([panelOk, [/shows\.php/, () => html(fx('shows.html'))], [/ajax_loadShow/, () => html(fx('season.html'))]]);
    const res = await p.search({ ...episode, title: 'Unknown Name', alternativeTitles: ['Doctor Who'], year: 2005 });
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.matches.has('year')).toBe(true);
  });

  it('parses movie pages', async () => {
    const { p } = provider([
      panelOk,
      [/srch\.php/, () => html(fx('movie-search.html'))],
      [/movie\/2222/, () => html(fx('movie.html'))],
    ]);
    const res = await p.search({
      mediaType: 'movie',
      title: 'Inception',
      year: 2010,
      languages: [{ tag: 'en', forced: false, hi: 'normal' }, { tag: 'es', forced: false, hi: 'normal' }],
    });
    expect(res.map((c) => [c.id, c.language, c.hi, c.releaseInfo, c.uploader])).toEqual([
      ['original/90001/0', 'en', false, 'BluRay.x264-SPARKS', 'subber'],
      ['original/90002/0', 'en', true, 'WEB-DL.AMZN-NTb', 'other'],
    ]);
  });

  it('throws captcha when the login page has a reCAPTCHA', async () => {
    const { p } = provider([[/com\/login\.php/, () => html(fx('login-captcha.html'))]], { username: 'u', password: 'p' });
    await expect(p.test()).rejects.toMatchObject({ code: 'captcha' });
  });

  it('logs in with a password and keeps the session cookie', async () => {
    const { p, calls } = provider(
      [
        [/com\/login\.php/, () => html('<form></form>')],
        [/dologin\.php/, () => new Response('', { status: 302, headers: { location: '/', 'set-cookie': 'wikisubtitlesuser=9; path=/' } })],
        [/shows\.php/, () => html(fx('shows.html'))],
        [/ajax_loadShow/, () => html(fx('season.html'))],
      ],
      { username: 'u', password: 'p' },
    );
    await p.search(episode);
    const ajax = calls.find((c) => /ajax_loadShow/.test(c.url))!;
    expect((ajax.init?.headers as Record<string, string>).Cookie).toBe('wikisubtitlesuser=9');
  });

  it('maps login failures', async () => {
    const wrong = provider([[/com\/login\.php/, () => html('')], [/dologin/, () => html('Wrong password')]], { username: 'u', password: 'p' });
    await expect(wrong.p.test()).rejects.toMatchObject({ code: 'auth' });
    const slow = provider([[/com\/login\.php/, () => html('')], [/dologin/, () => html('relax, slow down')]], { username: 'u', password: 'p' });
    await expect(slow.p.test()).rejects.toMatchObject({ code: 'rate-limited' });
  });

  it('rejects expired cookies', async () => {
    const { p } = provider([[/panel\.php/, () => new Response('', { status: 302, headers: { location: '/login.php' } })]]);
    await expect(p.test()).rejects.toMatchObject({ code: 'auth' });
  });

  it('downloads with referer and maps quota responses', async () => {
    let mode: 'ok' | 'html' | '304' = 'ok';
    const { p, calls } = provider([
      panelOk,
      [
        /original\/1/,
        () =>
          mode === 'ok'
            ? new Response('1\n00:00:01,000 --> 00:00:02,000\nHi\n', { headers: { 'content-type': 'application/octet-stream' } })
            : mode === 'html'
              ? html('<html>Daily Download count exceeded</html>')
              : new Response(null, { status: 304 }),
      ],
    ]);
    const cand = {
      provider: 'addic7ed' as const,
      id: 'original/1/0',
      language: 'en',
      forced: false,
      hi: false,
      releaseInfo: 'LOL',
      matches: new Set<never>(),
      score: 0,
      scoreWithoutHash: 0,
      hashVerifiable: false,
      hiVerifiable: true,
      downloadUrl: 'https://www.addic7ed.com/original/1/0',
      pageUrl: 'https://www.addic7ed.com/serie/x/1/1/y',
    };
    const file = await p.download(cand);
    expect(file.format).toBe('srt');
    const dl = calls.find((c) => /original\/1/.test(c.url))!;
    expect((dl.init?.headers as Record<string, string>).Referer).toBe(cand.pageUrl);
    mode = 'html';
    await expect(p.download(cand)).rejects.toMatchObject({ code: 'daily-limit' });
    mode = '304';
    await expect(p.download(cand)).rejects.toMatchObject({ code: 'rate-limited' });
  });

  it('enforces the local 24h download cap', async () => {
    let t = 1_700_000_000_000;
    const { p } = provider(
      [panelOk, [/original/, () => new Response('1\n00:00:01,000 --> 00:00:02,000\nHi\n')]],
      { cookies: 'a=b' },
      () => t,
    );
    const cand = {
      provider: 'addic7ed' as const, id: 'x', language: 'en', forced: false, hi: false, releaseInfo: '',
      matches: new Set<never>(), score: 0, scoreWithoutHash: 0, hashVerifiable: false, hiVerifiable: true,
      downloadUrl: 'https://www.addic7ed.com/original/2/0',
    };
    for (let i = 0; i < 40; i++) await p.download(cand);
    await expect(p.download(cand)).rejects.toMatchObject({ code: 'daily-limit' });
    t += 24 * 3600 * 1000 + 1;
    await expect(p.download(cand)).resolves.toBeTruthy();
  });
});
