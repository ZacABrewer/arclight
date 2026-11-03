import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD_MASK, type Indexer, type IndexerDefinitionSummary } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { DefinitionStore } from './definitions.js';
import { indexersRoutes } from './routes.js';
import { indexers } from './schema.js';
import { IndexersService, restoreIndexerSecrets } from './service.js';

// The native indexer API never returns a stored secret (Torznab/Newznab API key, definition
// password/cookie/passkey fields); the mask sent back keeps the stored value.

const LOGIN_DEF = `
id: loginsite
name: LoginSite
description: Private test tracker
language: en-US
type: private
links:
  - https://loginsite.example/
settings:
  - {name: username, type: text, label: Username}
  - {name: pw, type: password, label: Password}
  - {name: cookie, type: text, label: Cookie}
  - {name: freeleech, type: checkbox, label: Freeleech only, default: false}
caps:
  categorymappings:
    - {id: 1, cat: Movies/HD, desc: "Movies HD"}
  modes:
    search: [q]
login:
  method: cookie
search:
  paths:
    - path: browse.php
  rows:
    selector: "table#t > tbody > tr"
  fields:
    category: {selector: "td.cat"}
    title: {selector: "td.name a"}
    download: {selector: "a.dl", attribute: href}
    date: {text: "2026-10-20T10:00:00Z"}
`;

let db: Db;
let dir: string;
let service: IndexersService;
let app: FastifyInstance;
const calls: URL[] = [];

beforeEach(async () => {
  calls.length = 0;
  db = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), 'al-idx-secrets-'));
  await writeFile(join(dir, 'loginsite.yml'), LOGIN_DEF, 'utf8');
  const store = new DefinitionStore({ customDir: dir });
  service = new IndexersService({
    db,
    definitions: store,
    sleep: async () => {},
    indexerTimeoutMs: 1_000,
    // No network in tests: record the request and fail it.
    fetch: async (input) => {
      calls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
      throw new TypeError('fetch failed');
    },
  });
  await store.ready();
  app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(indexersRoutes(service));
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const torznab = { name: 'Tz', implementation: 'torznab', settings: { baseUrl: 'http://tz.example', apiKey: 'tz-secret-key', categories: [2000] } };
const definition = {
  name: 'Site',
  implementation: 'definition',
  settings: { definitionId: 'loginsite', fields: { username: 'me', pw: 'hunter2-pw', cookie: 'uid=1; pass=abc', freeleech: true } },
};

function storedSettings(id: number) {
  return db.select().from(indexers).all().find((r) => r.id === id)!.settings;
}

describe('indexer secrets on the native API', () => {
  it('GET /indexer and GET /indexer/:id mask the API key and secret definition fields', async () => {
    expect((await app.inject({ method: 'POST', url: '/indexer', payload: torznab })).statusCode).toBe(201);
    const created = await app.inject({ method: 'POST', url: '/indexer', payload: definition });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('hunter2-pw');

    const list = await app.inject({ method: 'GET', url: '/indexer' });
    expect(list.body).not.toContain('tz-secret-key');
    expect(list.body).not.toContain('hunter2-pw');
    expect(list.body).not.toContain('uid=1');
    const [tz, site] = list.json<Indexer[]>();
    expect(tz!.settings.apiKey).toBe(PASSWORD_MASK);
    expect(site!.settings.fields).toEqual({ username: 'me', pw: PASSWORD_MASK, cookie: PASSWORD_MASK, freeleech: true });

    const one = await app.inject({ method: 'GET', url: '/indexer/2' });
    expect(one.json<Indexer>().settings.fields?.['pw']).toBe(PASSWORD_MASK);
    // In-process callers still see the stored values.
    expect(service.get(1).settings.apiKey).toBe('tz-secret-key');
  });

  it('PUT with the mask keeps the stored secrets; a typed value replaces them', async () => {
    await app.inject({ method: 'POST', url: '/indexer', payload: torznab });
    await app.inject({ method: 'POST', url: '/indexer', payload: definition });
    const [tz, site] = (await app.inject({ method: 'GET', url: '/indexer' })).json<Indexer[]>();

    const putTz = await app.inject({ method: 'PUT', url: '/indexer/1', payload: { ...tz, priority: 5 } });
    expect(putTz.statusCode).toBe(200);
    expect(putTz.json<Indexer>().settings.apiKey).toBe(PASSWORD_MASK);
    expect(storedSettings(1).apiKey).toBe('tz-secret-key');

    const fields = { ...site!.settings.fields, username: 'other' };
    const putSite = await app.inject({ method: 'PUT', url: '/indexer/2', payload: { settings: { ...site!.settings, fields } } });
    expect(putSite.statusCode).toBe(200);
    expect(storedSettings(2).fields).toEqual({ username: 'other', pw: 'hunter2-pw', cookie: 'uid=1; pass=abc', freeleech: true });

    await app.inject({ method: 'PUT', url: '/indexer/2', payload: { settings: { ...site!.settings, fields: { ...fields, pw: 'new-pw' } } } });
    expect(storedSettings(2).fields?.['pw']).toBe('new-pw');
  });

  it('never stores the mask itself when nothing is stored behind it', async () => {
    const res = await app.inject({ method: 'POST', url: '/indexer', payload: { ...torznab, settings: { ...torznab.settings, apiKey: PASSWORD_MASK } } });
    expect(res.statusCode).toBe(201);
    expect(storedSettings(1).apiKey).toBeUndefined();
  });

  it('POST /indexer/test with an id tests the stored secrets, not the mask', async () => {
    await app.inject({ method: 'POST', url: '/indexer', payload: torznab });
    const [tz] = (await app.inject({ method: 'GET', url: '/indexer' })).json<Indexer[]>();
    const { id, ...body } = tz!;
    const res = await app.inject({ method: 'POST', url: '/indexer/test', payload: { ...body, id } });
    expect(res.statusCode).toBe(200);
    expect(calls.some((u) => u.searchParams.get('apikey') === 'tz-secret-key')).toBe(true);
    expect(calls.some((u) => u.searchParams.get('apikey') === PASSWORD_MASK)).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/indexer/test', payload: { ...body, id: 99 } })).statusCode).toBe(404);
  });

  it('serves secret-named text settings as password fields to the editor', async () => {
    const res = await app.inject({ method: 'GET', url: '/indexer/definition/loginsite' });
    const fields = res.json<IndexerDefinitionSummary>().settingsFields;
    expect(fields.find((f) => f.name === 'cookie')?.type).toBe('password');
    expect(fields.find((f) => f.name === 'username')?.type).toBe('text');
  });

  it('restoreIndexerSecrets drops masks with nothing stored', () => {
    expect(restoreIndexerSecrets({ apiKey: PASSWORD_MASK, fields: { pw: PASSWORD_MASK, a: 'b' } }, undefined)).toEqual({ fields: { a: 'b' } });
  });
});
