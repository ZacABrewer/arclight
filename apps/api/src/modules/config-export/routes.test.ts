import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../db/test-utils.js';
import { rootFolders } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import { parseConfigText } from './overlay.js';
import { configRoutes } from './routes.js';
import { ConfigService } from './service.js';
import { seededDb } from './test-support.js';

async function build(db?: Db) {
  const database = db ?? (await seededDb());
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Stand-in for the auth hook: `x-role: user` is a non-admin, anything else an admin.
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { user: null, via: 'apikey', isAdmin: req.headers['x-role'] !== 'user', appAccess: [] };
  });
  const service = new ConfigService({ db: database, env: {} });
  await app.register(configRoutes(service), { prefix: '/api/v1' });
  return { app, db: database, service };
}

const BROKEN = ['rootFolders:', '  /x:', '    mediaType: comics', ''].join('\n');

describe('config routes', () => {
  it('GET /config/export serves YAML by default and JSON on request, masked', async () => {
    const { app } = await build();
    const yaml = await app.inject({ method: 'GET', url: '/api/v1/config/export' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-type']).toMatch(/application\/yaml/);
    expect(yaml.headers['content-disposition']).toMatch(/arclight-config\.yml/);
    expect(yaml.body).not.toContain('qbit-password');
    expect(parseConfigText(yaml.body)).toMatchObject({ version: 1, rootFolders: { '/tv': { mediaType: 'series' } } });
    const json = await app.inject({ method: 'GET', url: '/api/v1/config/export?format=json' });
    expect(json.json()).toMatchObject({ version: 1 });
  });

  it('exporting secrets needs the confirmation header', async () => {
    const { app } = await build();
    const refused = await app.inject({ method: 'GET', url: '/api/v1/config/export?includeSecrets=true' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('CONFIRMATION_REQUIRED');
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/config/export?includeSecrets=true',
      headers: { 'x-confirm': 'export-secrets' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('qbit-password');
  });

  it('config routes are admin only (managed keys excepted)', async () => {
    const { app } = await build();
    const headers = { 'x-role': 'user' };
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/export', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/config/validate', headers, payload: { document: {} } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/config/import', headers, payload: { document: {} } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/managed-keys', headers })).statusCode).toBe(200);
  });

  it('POST /config/import takes a raw YAML body with ?dryRun', async () => {
    const { app, db } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/config/import?dryRun=true',
      headers: { 'content-type': 'application/yaml' },
      payload: 'rootFolders:\n  /anime:\n    mediaType: series\n',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, applied: false, changes: [{ kind: 'rootFolders', key: '/anime', op: 'create' }] });
    expect(db.select().from(rootFolders).all()).toHaveLength(2);
  });

  it('POST /config/import applies a JSON envelope and answers 422 on errors', async () => {
    const { app, db } = await build(await createTestDb());
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/config/import',
      payload: { document: { rootFolders: { '/tv': { mediaType: 'series' } } } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ applied: true, summary: { create: 1 } });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/config/import', payload: { content: BROKEN } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].path).toBe('rootFolders./x.mediaType');
    expect(db.select().from(rootFolders).all()).toHaveLength(1);
    const unparsable = await app.inject({ method: 'POST', url: '/api/v1/config/import', payload: { content: 'a: [' } });
    expect(unparsable.statusCode).toBe(400);
    const empty = await app.inject({ method: 'POST', url: '/api/v1/config/import', payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it('POST /config/validate reports without writing', async () => {
    const { app, db } = await build(await createTestDb());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/config/validate',
      payload: { document: { rootFolders: { '/tv': { mediaType: 'tv' } } } },
    });
    expect(res.json()).toMatchObject({ valid: false, errors: [{ path: 'rootFolders./tv.mediaType' }] });
    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/config/validate',
      payload: { document: { rootFolders: { '/tv': { mediaType: 'series' } } } },
    });
    expect(good.json()).toEqual({ valid: true, errors: [], warnings: [] });
    expect(db.select().from(rootFolders).all()).toHaveLength(0);
  });

  it('GET /config/managed-keys reports the boot overlay', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/config/managed-keys' });
    expect(res.json()).toEqual({ file: null, appliedAt: null, settings: {}, resources: {}, env: [], errors: [] });
  });
});
