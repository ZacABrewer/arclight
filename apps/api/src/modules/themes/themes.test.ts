import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ThemeIndex, ThemeSettings, checkThemeCss, type ThemeManifest } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { setSection } from '../settings/service.js';
import { themesRoutes } from './routes.js';
import { ThemesService, type FetchLike } from './service.js';

// Theme packs: the stylesheet checks, bundled + synced packs, and the sync against a fake source.

const SOURCE = 'https://themes.test/themes/';
const css = (id: string) => `@font-face { font-family: X; src: url(fonts/x.woff2) format("woff2"); }\n[data-theme="${id}"] { --al-void: #fff; }\n`;
const manifest = (id: string, version: string): ThemeManifest => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  version,
  description: '',
  author: 'test',
  colorScheme: 'light',
  backdrop: 'shapes',
  swatches: ['#ffffff', '#ff8fa3'],
});

function writePack(root: string, id: string, version: string, body = css(id)) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'theme.json'), JSON.stringify(manifest(id, version)));
  writeFileSync(join(dir, 'theme.css'), body);
  writeFileSync(join(dir, 'fonts', 'x.woff2'), Buffer.from([1, 2, 3]));
}

/** A fake theme source serving `packs` (id → files) with a matching index.json. */
function source(packs: Record<string, { version: string; files: Record<string, Buffer> }>, tamper?: (path: string, body: Buffer) => Buffer) {
  const files = new Map<string, Buffer>();
  const themes = Object.entries(packs).map(([id, p]) => {
    const list = Object.entries(p.files).map(([path, body]) => {
      files.set(`${SOURCE}${id}/${path}`, body);
      return { path, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    });
    return { ...manifest(id, p.version), files: list };
  });
  files.set(`${SOURCE}index.json`, Buffer.from(JSON.stringify(ThemeIndex.parse({ schema: 1, themes }))));
  const requests: string[] = [];
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    const body = files.get(url);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(tamper ? tamper(url, body) : body);
  };
  return { fetch, requests };
}

const packFiles = (id: string, version: string, body = css(id)) => ({
  version,
  files: { 'theme.json': Buffer.from(JSON.stringify(manifest(id, version))), 'theme.css': Buffer.from(body), 'fonts/x.woff2': Buffer.from([1, 2, 3]) },
});

async function setup(fetch?: FetchLike) {
  const db = await createTestDb();
  setSection(db, 'themes', ThemeSettings.parse({ sourceUrl: SOURCE }));
  const tmp = mkdtempSync(join(tmpdir(), 'arclight-themes-'));
  const bundledDir = join(tmp, 'bundled');
  const syncedDir = join(tmp, 'synced');
  mkdirSync(bundledDir);
  const make = () => new ThemesService({ db, log: pino({ level: 'silent' }), bundledDir, syncedDir, ...(fetch ? { fetch } : {}) });
  return { db, bundledDir, syncedDir, make };
}

describe('checkThemeCss', () => {
  const fonts = new Set(['fonts/a.woff2']);
  it('accepts scoped rules, font faces, keyframes and media blocks', () => {
    const ok = `@font-face { font-family: A; src: url("fonts/a.woff2"); }
      @keyframes sb-drift { from { opacity: 0 } to { opacity: 1 } }
      [data-theme="sorbet"] { --al-void: #fff; }
      html[data-theme="sorbet"] .al-pane, [data-theme="sorbet"] .al-btn:hover { border-radius: 26px; }
      @media (max-width: 600px) { [data-theme="sorbet"] .al-rail { width: 0; } }
      [data-theme="sorbet"] .al-chip::before { content: "—"; }`;
    expect(checkThemeCss(ok, 'sorbet', fonts)).toEqual([]);
  });

  it('rejects unscoped rules, imports, foreign urls, escapes and other at-rules', () => {
    expect(checkThemeCss('.al-pane { color: red }', 'sorbet', fonts)[0]).toMatch(/not scoped/);
    expect(checkThemeCss('[data-theme="sorbet"] .a, .b { color: red }', 'sorbet', fonts)[0]).toMatch(/not scoped/);
    expect(checkThemeCss('[data-theme="other"] .a { color: red }', 'sorbet', fonts)[0]).toMatch(/not scoped/);
    expect(checkThemeCss('@import "x.css";', 'sorbet', fonts)[0]).toMatch(/@import/);
    expect(checkThemeCss('[data-theme="sorbet"] { background: url(https://evil.test/x.png) }', 'sorbet', fonts)[0]).toMatch(/url/);
    expect(checkThemeCss('[data-theme="sorbet"] { background: url(fonts/b.woff2) }', 'sorbet', fonts)[0]).toMatch(/url/);
    expect(checkThemeCss('[data-theme="sorbet"] { background: u\\72l(x) }', 'sorbet', fonts)[0]).toMatch(/escape/);
    expect(checkThemeCss('@property --x { syntax: "*"; inherits: false; }', 'sorbet', fonts)[0]).toMatch(/@property/);
    expect(checkThemeCss('@media screen { .x { color: red } }', 'sorbet', fonts)[0]).toMatch(/not scoped/);
  });

  it('ignores comments', () => {
    expect(checkThemeCss('/* .x { url(http://a) } @import */ [data-theme="s"] { color: red }', 's', new Set())).toEqual([]);
  });
});

describe('ThemesService', () => {
  it('lists Tron first, then the valid bundled packs, and skips broken ones', async () => {
    const t = await setup();
    writePack(t.bundledDir, 'sorbet', '1.0.0');
    writePack(t.bundledDir, 'broken', '1.0.0', '.al-pane { color: red }');
    const service = t.make();
    expect(service.themes().map((x) => [x.id, x.source])).toEqual([
      ['tron', 'builtin'],
      ['sorbet', 'bundled'],
    ]);
    expect(service.catalog()).toMatchObject({ defaultTheme: 'tron', allowUserChoice: true });
    expect(service.filePath('sorbet', 'theme.css')).toBe(join(t.bundledDir, 'sorbet', 'theme.css'));
    expect(service.filePath('sorbet', 'fonts/x.woff2')).not.toBeNull();
    expect(service.filePath('sorbet', 'fonts/../theme.json')).toBeNull();
    expect(service.filePath('sorbet', 'theme.json')).toBeNull();
    expect(service.filePath('broken', 'theme.css')).toBeNull();
  });

  it('falls back to Tron when the default theme is not installed', async () => {
    const t = await setup();
    setSection(t.db, 'themes', ThemeSettings.parse({ defaultTheme: 'gone' }));
    expect(t.make().catalog().defaultTheme).toBe('tron');
  });

  it('syncs new and newer packs, keeps up-to-date ones, and serves the synced copy', async () => {
    const src = source({ sorbet: packFiles('sorbet', '1.1.0'), mint: packFiles('mint', '1.0.0'), old: packFiles('old', '1.0.0') });
    const t = await setup(src.fetch);
    writePack(t.bundledDir, 'sorbet', '1.0.0');
    writePack(t.bundledDir, 'old', '2.0.0');
    const service = t.make();
    const r = await service.sync();
    expect(r).toEqual({ ok: true, changed: ['sorbet', 'mint'], skipped: [], error: null });
    expect(src.requests.some((u) => u.includes('/old/'))).toBe(false);
    const byId = new Map(service.themes().map((x) => [x.id, x]));
    expect(byId.get('sorbet')).toMatchObject({ version: '1.1.0', source: 'synced', css: 'theme/sorbet/theme.css?v=1.1.0' });
    expect(byId.get('mint')?.source).toBe('synced');
    expect(byId.get('old')).toMatchObject({ version: '2.0.0', source: 'bundled' });
    expect(service.filePath('sorbet', 'theme.css')).toBe(join(t.syncedDir, 'sorbet', 'theme.css'));
    expect(service.syncState()).toMatchObject({ lastError: null, lastChanged: ['sorbet', 'mint'] });
    // A second sync has nothing to do, and a restart reads the synced packs back.
    expect((await service.sync()).changed).toEqual([]);
    expect(t.make().themes().find((x) => x.id === 'mint')?.source).toBe('synced');
  });

  it('refuses a pack whose files do not match the index or fail the checks', async () => {
    const tampered = source({ sorbet: packFiles('sorbet', '1.0.0') }, (url, body) => (url.endsWith('theme.css') ? Buffer.from(body.toString().replace('#fff', '#000')) : body));
    const t1 = await setup(tampered.fetch);
    const r1 = await t1.make().sync();
    expect(r1.ok).toBe(true);
    expect(r1.skipped[0]).toMatchObject({ id: 'sorbet', reason: expect.stringMatching(/checksum/) });
    expect(existsSync(join(t1.syncedDir, 'sorbet'))).toBe(false);

    const unscoped = source({ sorbet: packFiles('sorbet', '1.0.0', 'body { display: none }') });
    const t2 = await setup(unscoped.fetch);
    const r2 = await t2.make().sync();
    expect(r2.skipped[0]?.reason).toMatch(/not scoped/);
    expect(readFileSync(join(t2.syncedDir, '.sync-state.json'), 'utf8')).toContain('"lastError":null');
  });

  it('records an unreachable source as the sync error', async () => {
    const t = await setup(async () => new Response('nope', { status: 503 }));
    const r = await t.make().sync();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 503/);
  });
});

describe('theme routes', () => {
  it('serves the catalogue, the stylesheet with its cache policy, and fonts', async () => {
    const t = await setup();
    writePack(t.bundledDir, 'sorbet', '1.0.0');
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(themesRoutes(t.make()));
    const cat = await app.inject({ url: '/theme' });
    expect(cat.json().themes.map((x: { id: string }) => x.id)).toEqual(['tron', 'sorbet']);
    const fresh = await app.inject({ url: '/theme/sorbet/theme.css?v=1.0.0' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers['content-type']).toMatch(/text\/css/);
    expect(fresh.headers['cache-control']).toMatch(/immutable/);
    expect(fresh.body).toContain('[data-theme="sorbet"]');
    expect((await app.inject({ url: '/theme/sorbet/theme.css?v=0.9.0' })).headers['cache-control']).toBe('no-cache');
    const font = await app.inject({ url: '/theme/sorbet/fonts/x.woff2' });
    expect(font.headers['content-type']).toBe('font/woff2');
    expect((await app.inject({ url: '/theme/sorbet/fonts/..%2Ftheme.json' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/theme/nope/theme.css' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('pack images', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  const withImage = (id: string) => `${css(id)}[data-theme="${id}"] .al-backdrop { background-image: url(images/bg.webp); }\n`;

  it('serves a background image, refuses a fake one and urls to images the pack lacks', async () => {
    const t = await setup();
    writePack(t.bundledDir, 'frost', '1.0.0', withImage('frost'));
    mkdirSync(join(t.bundledDir, 'frost', 'images'));
    writeFileSync(join(t.bundledDir, 'frost', 'images', 'bg.webp'), webp);
    writePack(t.bundledDir, 'fake', '1.0.0', withImage('fake'));
    mkdirSync(join(t.bundledDir, 'fake', 'images'));
    writeFileSync(join(t.bundledDir, 'fake', 'images', 'bg.webp'), Buffer.from('<svg onload="x()"></svg>'));
    writePack(t.bundledDir, 'missing', '1.0.0', withImage('missing'));
    const service = t.make();
    expect(service.themes().map((x) => x.id)).toEqual(['tron', 'frost']);
    expect(service.filePath('frost', 'images/bg.webp')).toBe(join(t.bundledDir, 'frost', 'images', 'bg.webp'));
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(themesRoutes(service));
    const img = await app.inject({ url: '/theme/frost/images/bg.webp' });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ url: '/theme/frost/images/other.webp' })).statusCode).toBe(404);
    await app.close();
  });

  it('syncs a pack with an image', async () => {
    const p = packFiles('frost', '1.0.0', withImage('frost'));
    const src = source({ frost: { ...p, files: { ...p.files, 'images/bg.webp': webp } } });
    const t = await setup(src.fetch);
    const service = t.make();
    expect((await service.sync()).changed).toEqual(['frost']);
    expect(service.filePath('frost', 'images/bg.webp')).toBe(join(t.syncedDir, 'frost', 'images', 'bg.webp'));
  });
});
