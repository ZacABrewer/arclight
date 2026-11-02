import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { Permission } from '@arclight/shared';
import { authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { requestsModuleWith } from '../requests/index.js';
import { addUser, setup } from '../requests/test-support.js';
import { themesServiceFor } from '../themes/index.js';
import { watchHistoryModule } from '../watch-history/index.js';
import { FakeJellyfin } from '../watch-history/test-support.js';
import { jellyfinPluginModule } from './index.js';
import { fontFaces, generateJellyfinCss, parseThemeTokens, safeTokenValue, THEME_CSS_GENERATOR_VERSION, themeCssEtag, type ThemePackForCss } from './theme-css.js';

// Public packs from the repository's themes/ folder only (private packs never go into tests).
const THEMES_DIR = [resolve('themes'), resolve('../../themes')].find((d) => {
  try {
    readFileSync(join(d, 'abyss', 'theme.json'));
    return true;
  } catch {
    return false;
  }
})!;

function pack(id: string): ThemePackForCss {
  const manifest = JSON.parse(readFileSync(join(THEMES_DIR, id, 'theme.json'), 'utf8')) as { name: string; version: string; colorScheme: 'dark' | 'light' };
  const css = readFileSync(join(THEMES_DIR, id, 'theme.css'), 'utf8');
  return { id, name: manifest.name, version: manifest.version, colorScheme: manifest.colorScheme, source: 'bundled', css, hasFont: (f) => css.includes(`fonts/${f}`) };
}

/** Properties that would change layout or hide things; the generator must never emit them. */
const LAYOUT = /(^|[;{\s])(display|visibility|position|width|height|min-width|min-height|max-width|max-height|margin(-[a-z]+)?|padding(-[a-z]+)?|content|top|left|right|bottom|inset|flex(-[a-z]+)?|grid(-[a-z]+)?|transform|overflow|z-index|float)\s*:/;

function balanced(css: string): boolean {
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

describe('theme CSS generator', () => {
  for (const [id, scheme] of [
    ['abyss', 'dark'],
    ['paper', 'light'],
  ] as const) {
    it(`maps the ${scheme} pack "${id}" onto Jellyfin Web`, () => {
      const p = pack(id);
      expect(p.colorScheme).toBe(scheme);
      const css = generateJellyfinCss(p);
      expect(balanced(css)).toBe(true);
      expect(css).toContain(`color-scheme: ${scheme};`);
      // the pack's own tokens are copied (abyss and paper both define the accent)
      const tokens = parseThemeTokens(p.css, id);
      expect(tokens.get('--al-cyan')).toBeTruthy();
      expect(css).toContain(`--al-cyan: ${tokens.get('--al-cyan')};`);
      for (const v of ['--arclight-accent', '--arclight-surface', '--arclight-on-surface', '--arclight-radius']) expect(css).toContain(v);
      for (const sel of ['.skinHeader', '.mainDrawer', '.cardScalable', '.button-submit', '.emby-input', '.dialog', '.actionSheet', '.videoOsdBottom', '.itemProgressBarForeground', '::-webkit-scrollbar-thumb', ':focus-visible']) {
        expect(css).toContain(sel);
      }
      // colours, fonts, radii only
      for (const rule of css.split('\n')) expect(rule, rule).not.toMatch(LAYOUT);
      expect(css).not.toMatch(/opacity\s*:\s*0/);
      // fonts only from the pack, through the local route; no remote URLs at all
      const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(u).toMatch(new RegExp(`^"theme-fonts/${id}/[A-Za-z0-9._%-]+\\.woff2"$`));
      expect(css).not.toMatch(/https?:\/\//);
    });
  }

  it('drops unsafe token values and faces for fonts the pack does not ship', () => {
    const css = `
      @font-face { font-family: "Ok"; src: url(fonts/ok.woff2) format("woff2"); }
      @font-face { font-family: "Missing"; src: url(fonts/missing.woff2) format("woff2"); }
      @font-face { font-family: "Remote"; src: url(https://fonts.example.com/x.woff2); }
      [data-theme="t"] { --al-cyan: #123456; --al-backdrop: url(images/x.png); --al-text-1: red}body{display:none; --al-void: #000; --not-al: 1; }
      [data-theme="other"] { --al-cyan: #ffffff; }`;
    const tokens = parseThemeTokens(css, 't');
    expect(tokens.get('--al-cyan')).toBe('#123456');
    expect(tokens.has('--al-backdrop')).toBe(false);
    expect(tokens.has('--not-al')).toBe(false);
    const faces = fontFaces(css, { id: 't', hasFont: (f) => f === 'ok.woff2' }, 'theme-fonts/');
    expect(faces).toHaveLength(1);
    expect(faces[0]).toContain('url("theme-fonts/t/ok.woff2")');
    expect(safeTokenValue('#fff')).toBe(true);
    expect(safeTokenValue('red}body{display:none')).toBe(false);
    expect(safeTokenValue('url(x)')).toBe(false);
  });

  it('ETag follows pack id, version, source and generator version', () => {
    const a = themeCssEtag({ id: 'abyss', version: '1.0.0', source: 'bundled' });
    expect(a).toMatch(/^"[0-9a-f]{32}"$/);
    expect(themeCssEtag({ id: 'abyss', version: '1.0.1', source: 'bundled' })).not.toBe(a);
    expect(themeCssEtag({ id: 'abyss', version: '1.0.0', source: 'synced' })).not.toBe(a);
    expect(THEME_CSS_GENERATOR_VERSION).toBeGreaterThan(0);
  });
});

const ALICE = 'aaaaaaaa1111aaaa1111aaaaaaaaaaaa';

async function build() {
  const h = await setup();
  const fake = new FakeJellyfin();
  const servers = new MediaServersService({ db: h.db, fetch: fake.fetch, newId: () => 'jf1' });
  setMediaServersService(h.ctx, servers);
  servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: fake.apiKey, loginEnabled: true });
  const themes = themesServiceFor(h.ctx, { bundledDir: THEMES_DIR, syncedDir: mkdtempSync(join(tmpdir(), 'al-jf-themes-')) });
  addUser(h.db, { role: 'admin', username: 'owner' });
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (api) => {
      installAuth(api, h.ctx);
      await api.register(requestsModuleWith({})(h.ctx));
      await api.register(watchHistoryModule(h.ctx));
      await api.register(jellyfinPluginModule(h.ctx));
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  const auth = authServiceFor(h.ctx);
  const key = auth.createPluginKey('test').key;
  const link = { mediaServerLink: { kind: 'jellyfin', externalId: ALICE, username: 'alice', linkedAt: '2026-01-01T00:00:00.000Z' } };
  const alice = addUser(h.db, { username: 'alice', permissions: Permission.REQUEST, settings: link });
  const as = (user?: string) => ({ 'x-api-key': key, ...(user ? { 'x-arclight-jellyfin-user': user } : {}) });
  return { ...h, app, themes, key, alice, as, adminKey: auth.apiKey(), cookieFor: (id: number) => `${SESSION_COOKIE}=${auth.createSession(id).token}` };
}

describe('Jellyfin plugin API: themes', () => {
  it('lists installed packs with the server default', async () => {
    const t = await build();
    t.themes.updateSettings({ ...t.themes.settings(), defaultTheme: 'abyss' });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/themes', headers: t.as() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { defaultTheme: string | null; themes: Array<{ id: string; name: string; version: string; dark: boolean }> };
    expect(body.defaultTheme).toBe('abyss');
    expect(body.themes.find((x) => x.id === 'abyss')).toMatchObject({ dark: true, name: expect.any(String), version: expect.any(String) });
    expect(body.themes.find((x) => x.id === 'paper')).toMatchObject({ dark: false });
    expect(body.themes.some((x) => x.id === 'tron')).toBe(false);
  });

  it('serves generated CSS with an ETag and 304, 404 for unknown packs and Tron', async () => {
    const t = await build();
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/theme/abyss.css', headers: t.as() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const etag = res.headers['etag'] as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.body).toContain('.skinHeader');
    const again = await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/theme/abyss.css', headers: { ...t.as(), 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    for (const url of ['/api/v1/jellyfin/theme/nope.css', '/api/v1/jellyfin/theme/tron.css', '/api/v1/jellyfin/theme/abyss.txt', '/api/v1/jellyfin/theme/..%2Fsecrets.css']) {
      const r = await t.app.inject({ method: 'GET', url, headers: t.as() });
      expect(r.statusCode, url).toBe(404);
    }
  });

  it('serves pack fonts and rejects anything else', async () => {
    const t = await build();
    const css = (await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/theme/abyss.css', headers: t.as() })).body;
    const font = /url\("theme-fonts\/abyss\/([^"]+)"\)/.exec(css)![1]!;
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/jellyfin/theme-fonts/abyss/${font}`, headers: t.as() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('font/woff2');
    expect(res.rawPayload.length).toBeGreaterThan(1000);
    for (const url of [
      '/api/v1/jellyfin/theme-fonts/abyss/..%2Ftheme.css',
      '/api/v1/jellyfin/theme-fonts/abyss/OFL.txt',
      '/api/v1/jellyfin/theme-fonts/abyss/nope.woff2',
      '/api/v1/jellyfin/theme-fonts/..%2Fabyss/x.woff2',
    ]) {
      expect((await t.app.inject({ method: 'GET', url, headers: t.as() })).statusCode, url).toBe(404);
    }
  });

  it('resolves the account theme: own pick, default, choice disabled', async () => {
    const t = await build();
    const get = async () => (await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/userconfig', headers: t.as(ALICE) })).json() as Record<string, unknown>;
    // no pick, default Tron
    expect(await get()).toMatchObject({ theme: null, canRequestMovies: true, canRequestSeries: true, canRequest4k: false, canViewAllRequests: false });
    t.themes.updateSettings({ ...t.themes.settings(), defaultTheme: 'abyss', allowUserChoice: true });
    expect((await get())['theme']).toBe('abyss');
    t.db.run(`UPDATE users SET settings = json_set(settings, '$.theme', 'paper') WHERE id = ${t.alice.id}`);
    expect((await get())['theme']).toBe('paper');
    t.themes.updateSettings({ ...t.themes.settings(), allowUserChoice: false });
    expect((await get())['theme']).toBe('abyss');
    // a pick that is not installed falls back to the default
    t.themes.updateSettings({ ...t.themes.settings(), allowUserChoice: true });
    t.db.run(`UPDATE users SET settings = json_set(settings, '$.theme', 'gone') WHERE id = ${t.alice.id}`);
    expect((await get())['theme']).toBe('abyss');
    // the request type filter is respected
    t.db.run(`UPDATE users SET settings = json_set(settings, '$.requestTypes', json('{"movie":true,"series":false,"music":true,"audiobook":true,"subtitles":true,"audioLanguages":true}')) WHERE id = ${t.alice.id}`);
    expect(await get()).toMatchObject({ canRequestMovies: true, canRequestSeries: false });
    // unlinked users and missing headers
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/userconfig', headers: t.as('ffffffffffffffffffffffffffffffff') })).json()).toMatchObject({ code: 'not_linked' });
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/userconfig', headers: t.as() })).statusCode).toBe(400);
  });

  it('plugin key and admin API key may call the routes; portal users may not', async () => {
    const t = await build();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/themes', headers: { 'x-api-key': t.adminKey } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/theme/paper.css', headers: { 'x-api-key': t.adminKey } })).statusCode).toBe(200);
    const cookie = t.cookieFor(t.alice.id);
    for (const url of ['/api/v1/jellyfin/themes', '/api/v1/jellyfin/theme/paper.css', '/api/v1/jellyfin/userconfig']) {
      expect((await t.app.inject({ method: 'GET', url, headers: { cookie, 'x-arclight-jellyfin-user': ALICE } })).statusCode, url).toBe(403);
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/jellyfin/themes' })).statusCode).toBe(401);
  });
});
