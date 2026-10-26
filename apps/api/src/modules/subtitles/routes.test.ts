import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@media-tron/shared';
import { subtitlesRoutes } from './routes.js';
import { EN_PROFILE, GOOD_EPISODE, SRT, WEAK_EPISODE, candidate, setup, type Fixture } from './test-support.js';

let fx: Fixture | undefined;
afterEach(async () => {
  await fx?.service.idle();
  await fx?.cleanup();
  fx = undefined;
});

async function build(opts: { admin?: boolean } = {}) {
  fx = await setup();
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Stand-in for the auth hook (installed by app.ts on the /api/v1 scope).
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { user: null, via: 'apiKey', isAdmin: opts.admin ?? true } as never;
  });
  await app.register(subtitlesRoutes(fx.service), { prefix: '/api/v1' });
  return { ...fx, app };
}

function multipart(fields: Record<string, string>, file?: { name: string; content: string }) {
  const boundary = '----mtboundary';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  if (file) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n${file.content}\r\n`);
  parts.push(`--${boundary}--\r\n`);
  return { payload: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('subtitles routes', () => {
  it('language profile CRUD with validation', async () => {
    const { app } = await build();
    const created = await app.inject({ method: 'POST', url: '/api/v1/languageprofile', payload: { ...EN_PROFILE, name: 'Spanish', languages: [{ code: 'spa' }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Spanish', languages: [{ code: 'es', forced: 'never', hi: 'also' }], cutoff: null });
    const id = created.json().id as number;
    const list = await app.inject({ method: 'GET', url: '/api/v1/languageprofile' });
    expect(list.json().map((p: { name: string }) => p.name)).toEqual(['English', 'Spanish']);
    const bad = await app.inject({ method: 'PUT', url: `/api/v1/languageprofile/${id}`, payload: { ...EN_PROFILE, cutoff: 'fr' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/languageprofile/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/v1/languageprofile/${id}` })).statusCode).toBe(404);
  });

  it('settings are masked on read and admin-only', async () => {
    const { app, service } = await build();
    const s = service.settings();
    service.updateSettings({ ...s, providers: [...s.providers, { id: 'jimaku', enabled: true, settings: { apiKey: 'top-secret' } }] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/subtitle/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(JSON.stringify(res.json())).not.toContain('top-secret');
    expect(res.json().providers.find((p: { id: string }) => p.id === 'jimaku').settings.apiKey).toBe(SECRET_MASK);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/subtitle/settings', payload: { ...body, upgrade: { enabled: false, windowDays: 3, includeManual: false } } });
    expect(put.statusCode).toBe(200);
    expect(service.settings().providers.find((p) => p.id === 'jimaku')!.settings['apiKey']).toBe('top-secret');
    expect(service.settings().upgrade.windowDays).toBe(3);
    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/subtitle/settings', payload: { ...body, upgrade: { windowDays: 99 } } });
    expect(invalid.statusCode).toBe(400);
  });

  it('non-admins are refused admin routes', async () => {
    const { app } = await build({ admin: false });
    expect((await app.inject({ method: 'GET', url: '/api/v1/subtitle/settings' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/subtitle/wanted' })).statusCode).toBe(200);
  });

  it('providers expose schema, status and test', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/subtitle/providers' });
    expect(res.json().schema.length).toBeGreaterThan(10);
    expect(res.json().status.find((p: { id: string }) => p.id === 'podnapisi')).toMatchObject({ enabled: true, throttle: null });
    const test = await app.inject({ method: 'POST', url: '/api/v1/subtitle/providers/test', payload: { id: 'podnapisi', settings: {} } });
    expect(test.json()).toMatchObject({ ok: true });
    const reset = await app.inject({ method: 'POST', url: '/api/v1/subtitle/providers/reset', payload: {} });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/subtitle/languages' })).json().some((l: { code: string }) => l.code === 'pt-BR')).toBe(true);
  });

  it('wanted pages by media type', async () => {
    const { app } = await build();
    const tv = await app.inject({ method: 'GET', url: '/api/v1/subtitle/wanted?mediaType=series&page=1&pageSize=2' });
    expect(tv.json()).toMatchObject({ page: 1, pageSize: 2, totalRecords: 3 });
    expect(tv.json().records).toHaveLength(2);
    const movies = await app.inject({ method: 'GET', url: '/api/v1/subtitle/wanted?mediaType=movie' });
    expect(movies.json().records[0]).toMatchObject({ title: 'Test Movie', episodeLabel: null });
  });

  it('upload takes multipart form data and writes the file', async () => {
    const { app, files, videos } = await build();
    const body = multipart({ mediaFileId: String(files.movie), language: 'en', forced: 'false', hi: 'false' }, { name: 'mine.srt', content: SRT });
    const res = await app.inject({ method: 'POST', url: '/api/v1/subtitle/upload', ...body });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toBe(videos.movie.replace(/\.mkv$/, '.en.srt'));
    expect(await readFile(res.json().path, 'utf8')).toContain('General Kenobi');
    const noFile = await app.inject({ method: 'POST', url: '/api/v1/subtitle/upload', ...multipart({ mediaFileId: String(files.movie), language: 'en' }) });
    expect(noFile.statusCode).toBe(400);
    const json = await app.inject({ method: 'POST', url: '/api/v1/subtitle/upload', payload: { mediaFileId: files.movie } });
    expect(json.statusCode).toBe(400);
  });

  it('manual search then download through HTTP, with an expired key mapped to 410', async () => {
    const { app, files, providers } = await build();
    providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE }), candidate('podnapisi', 'weak', { matches: WEAK_EPISODE })];
    const search = await app.inject({ method: 'GET', url: `/api/v1/subtitle/search?mediaFileId=${files.s1e1}&language=en` });
    expect(search.statusCode).toBe(200);
    const results = search.json().results as Array<{ key: string; providerSubtitleId: string; percent: number }>;
    expect(results.map((r) => r.providerSubtitleId)).toEqual(['good', 'weak']);
    const dl = await app.inject({ method: 'POST', url: '/api/v1/subtitle/download', payload: { mediaFileId: files.s1e1, key: results[1]!.key } });
    expect(dl.statusCode).toBe(200);
    expect(dl.json()).toMatchObject({ providerSubtitleId: 'weak', provider: 'podnapisi' });
    const again = await app.inject({ method: 'POST', url: '/api/v1/subtitle/download', payload: { mediaFileId: files.s1e1, key: results[1]!.key } });
    expect(again.statusCode).toBe(410);
  });

  it('file states, delete, history and blacklist routes', async () => {
    const { app, files, providers, seriesId } = await build();
    providers.podnapisi.candidates = [candidate('podnapisi', 'good', { matches: GOOD_EPISODE })];
    const cmd = await app.inject({ method: 'POST', url: '/api/v1/command/subtitlesearch', payload: { episodeIds: [fx!.ep.s1e1] } });
    expect(cmd.json()).toMatchObject({ files: 1, downloaded: 1 });
    const states = await app.inject({ method: 'GET', url: `/api/v1/subtitle/file?seriesId=${seriesId}` });
    expect(states.json().map((f: { mediaFileId: number }) => f.mediaFileId)).toEqual([files.s1e1, files.s1e2, files.s2e1]);
    const sub = states.json()[0].subtitles[0] as { id: number };
    const bl = await app.inject({ method: 'POST', url: '/api/v1/subtitle/blacklist', payload: { subtitleId: sub.id, search: false } });
    expect(bl.statusCode).toBe(201);
    const page = await app.inject({ method: 'GET', url: '/api/v1/subtitle/blacklist' });
    expect(page.json().totalRecords).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/subtitle/blacklist/${page.json().records[0].id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/subtitle/blacklist' })).statusCode).toBe(204);
    const hist = await app.inject({ method: 'GET', url: '/api/v1/subtitle/history?action=deleted' });
    expect(hist.json().records[0]).toMatchObject({ action: 'deleted', provider: 'podnapisi' });
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/subtitle/9999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/subtitle/file' })).statusCode).toBe(400);
  });

  it('scan and sync routes', async () => {
    const { app, files, service } = await build();
    const up = await service.upload({ mediaFileId: files.movie, language: 'en', forced: false, hi: false }, new TextEncoder().encode(SRT), 'a.srt');
    const scan = await app.inject({ method: 'POST', url: '/api/v1/subtitle/scan', payload: { mediaFileId: files.movie } });
    expect(scan.json()[0].subtitles[0]).toMatchObject({ id: up.id, provider: 'manual' });
    const sync = await app.inject({ method: 'POST', url: `/api/v1/subtitle/sync/${up.id}` });
    expect(sync.statusCode).toBe(200);
    // The fake runner exits 0 without writing an output file: sync reports failure, original kept.
    expect(sync.json()).toMatchObject({ ok: false, subtitle: { id: up.id } });
  });
});
