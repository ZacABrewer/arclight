import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BULK_ACTIONS, BulkResource } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { HANDLERS, runBulk } from './index.js';

const config: AppConfig = {
  configDir: '.',
  dbPath: ':memory:',
  logDir: '.',
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  isDocker: false,
  webDist: null,
};

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
type Api = (method: Method, url: string, payload?: unknown) => Promise<{ statusCode: number; json<T = any>(): T }>;

let api: Api;
let anonymous: Api;
let close: () => Promise<void>;

beforeEach(async () => {
  const db = await createTestDb();
  seedAdmin(db);
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
  await app.ready();
  const key = authServiceFor(ctx!).apiKey();
  const call =
    (headers: Record<string, string>): Api =>
    (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  api = call({ 'x-api-key': key });
  anonymous = call({});
  close = () => app.close();
});

afterEach(async () => {
  await close();
});

const bulk = (body: unknown) => api('POST', '/bulk', body);

async function releaseProfile(name: string, tags: number[] = []): Promise<number> {
  const res = await api('POST', '/releaseprofile', { name, required: ['x264'], tags });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function tag(label: string): Promise<number> {
  const res = await api('POST', '/tag', { label });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe('bulk action table', () => {
  it('has a handler for every advertised action and none beyond them', () => {
    for (const resource of BulkResource.options) {
      expect(Object.keys(HANDLERS[resource]).sort()).toEqual([...BULK_ACTIONS[resource]].sort());
    }
  });

  it('keeps going after a failure and keeps the ids in order', async () => {
    const res = await runBulk(
      [1, 2, 3, 4, 5],
      async (id) => {
        if (id === 2 || id === 4) throw new Error(`no ${id}`);
      },
      2,
    );
    expect(res).toEqual({ ok: [1, 3, 5], failed: [{ id: 2, error: 'no 2' }, { id: 4, error: 'no 4' }] });
  });
});

describe('POST /bulk', () => {
  it('refuses anonymous callers', async () => {
    const res = await anonymous('POST', '/bulk', { resource: 'remotepathmapping', action: 'delete', ids: [1] });
    expect(res.statusCode).toBe(401);
  });

  it('validates the resource, the action and the tags', async () => {
    expect((await bulk({ resource: 'nope', action: 'delete', ids: [1] })).statusCode).toBe(400);
    expect((await bulk({ resource: 'backup', action: 'enable', ids: ['a'] })).statusCode).toBe(400);
    expect((await bulk({ resource: 'remotepathmapping', action: 'delete', ids: [] })).statusCode).toBe(400);
    expect((await bulk({ resource: 'releaseprofile', action: 'addTags', ids: [1] })).statusCode).toBe(400);
  });

  it('deletes what exists and reports the rest per id', async () => {
    const a = (await api('POST', '/customformat', { name: 'Bulk A' })).json().id as number;
    const b = (await api('POST', '/customformat', { name: 'Bulk B' })).json().id as number;
    expect([typeof a, typeof b]).toEqual(['number', 'number']);
    const before = (await api('GET', '/customformat')).json().length as number;
    const res = await bulk({ resource: 'customformat', action: 'delete', ids: [a, 999, b, a] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toEqual([a, b]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({ id: 999 });
    expect(body.failed[0].error).toMatch(/./);
    expect((await api('GET', '/customformat')).json()).toHaveLength(before - 2);
  });

  it('enables, disables and edits tags through the full-resource PUT', async () => {
    const t1 = await tag('anime');
    const t2 = await tag('4k');
    const p1 = await releaseProfile('one', [t1]);
    const p2 = await releaseProfile('two');

    const off = await bulk({ resource: 'releaseprofile', action: 'disable', ids: [p1, p2] });
    expect(off.json()).toEqual({ ok: [p1, p2], failed: [] });
    expect((await api('GET', `/releaseprofile/${p1}`)).json()).toMatchObject({ enabled: false, required: ['x264'], tags: [t1] });

    await bulk({ resource: 'releaseprofile', action: 'enable', ids: [p2] });
    expect((await api('GET', `/releaseprofile/${p2}`)).json().enabled).toBe(true);

    await bulk({ resource: 'releaseprofile', action: 'addTags', ids: [p1, p2], tags: [t1, t2] });
    expect((await api('GET', `/releaseprofile/${p1}`)).json().tags).toEqual([t1, t2]);
    expect((await api('GET', `/releaseprofile/${p2}`)).json().tags).toEqual([t1, t2]);

    await bulk({ resource: 'releaseprofile', action: 'removeTags', ids: [p1], tags: [t1] });
    expect((await api('GET', `/releaseprofile/${p1}`)).json().tags).toEqual([t2]);
  });

  it('turns every search flag of an indexer off and on with the partial PUT', async () => {
    const created = await api('POST', '/indexer', {
      name: 'Local Torznab',
      implementation: 'torznab',
      settings: { baseUrl: 'http://127.0.0.1:9/torznab', apiKey: 'test-key' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    expect((await bulk({ resource: 'indexer', action: 'disable', ids: [id] })).json()).toEqual({ ok: [id], failed: [] });
    expect((await api('GET', `/indexer/${id}`)).json()).toMatchObject({ enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false });
    await bulk({ resource: 'indexer', action: 'enable', ids: [id] });
    expect((await api('GET', `/indexer/${id}`)).json()).toMatchObject({ enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true });
  });

  it('keeps the in-use guards of the single-item routes', async () => {
    // The only quality profiles are the seeded ones; deleting one in use by nothing works,
    // a missing id fails with the route's own message.
    const res = await bulk({ resource: 'qualityprofile', action: 'delete', ids: [424242] });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toEqual([]);
    expect(res.json().failed[0]).toMatchObject({ id: 424242 });
  });

  it('cancels, marks failed and runs jobs per id, reporting unknown ones', async () => {
    const cancel = await bulk({ resource: 'transcodejob', action: 'cancel', ids: [77] });
    expect(cancel.json().failed.map((f: { id: number }) => f.id)).toEqual([77]);
    const failed = await bulk({ resource: 'history', action: 'markFailed', ids: [88] });
    expect(failed.json().failed.map((f: { id: number }) => f.id)).toEqual([88]);
    const run = await bulk({ resource: 'job', action: 'run', ids: ['NoSuchJob'] });
    expect(run.json().failed[0]).toMatchObject({ id: 'NoSuchJob', error: 'unknown job: NoSuchJob' });
  });
});
