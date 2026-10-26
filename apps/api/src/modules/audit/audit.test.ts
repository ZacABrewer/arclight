import Fastify from 'fastify';
import pino from 'pino';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../app.js';
import { createTestDb } from '../../db/test-utils.js';
import type { Db } from '../../db/index.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { authServiceFor } from '../auth/context.js';
import { authModule, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { setSection } from '../settings/service.js';
import { describeAction, isSkipped } from './actions.js';
import { auditModule, installAudit } from './index.js';
import { audit, AuditRecorder, auditRecorderFor, registerAuditRecorder, sanitizeDetails, unregisterAuditRecorder } from './recorder.js';
import { auditEvents } from './schema.js';
import { AuditService, csvCell } from './service.js';

const auditDb = () => createTestDb({ auditEvents });

function rows(db: Db) {
  return db.select().from(auditEvents).all();
}

describe('audit action names', () => {
  it('derives resource.verb from the route pattern', () => {
    expect(describeAction('POST', '/series', {})).toEqual({ action: 'series.create', target: null });
    expect(describeAction('DELETE', '/series/:id', { id: 5 })).toEqual({ action: 'series.delete', target: '5' });
    expect(describeAction('PUT', '/qualityprofile/:id', { id: '2' })).toEqual({ action: 'qualityprofile.update', target: '2' });
    expect(describeAction('POST', '/request/:id/approve', { id: '9' })).toEqual({ action: 'request.approve', target: '9' });
    expect(describeAction('DELETE', '/subtitle/blacklist/:id', { id: '1' })).toEqual({ action: 'subtitle.blacklist.delete', target: '1' });
    expect(describeAction('POST', '/user', {})).toEqual({ action: 'user.create', target: null });
  });

  it('names every settings page settings.update with the section as target', () => {
    expect(describeAction('PUT', '/settings/metadata', {})).toEqual({ action: 'settings.update', target: 'metadata' });
    expect(describeAction('PUT', '/subtitle/settings', {})).toEqual({ action: 'settings.update', target: 'subtitle' });
    expect(describeAction('PUT', '/user/:id/requestsettings', { id: 3 }).action).toBe('user.requestsettings.update');
  });

  it('uses overrides and skips noisy or read-only routes', () => {
    expect(describeAction('POST', '/auth/logout', {}).action).toBe('logout');
    expect(describeAction('POST', '/command', {}).action).toBe('command.run');
    expect(isSkipped('POST', '/auth/login')).toBe(true);
    expect(isSkipped('POST', '/indexer/testall')).toBe(true);
    expect(isSkipped('POST', '/mediaserver/:id/test')).toBe(true);
    expect(isSkipped('POST', '/indexer')).toBe(false);
  });
});

describe('audit recorder', () => {
  it('writes events with masked secrets and stringified targets', async () => {
    const db = await auditDb();
    new AuditRecorder(db).record({ action: 'user.create', target: 7, username: 'admin', details: { body: { username: 'bob', password: 'hunter2' } } });
    const [row] = rows(db);
    expect(row).toMatchObject({ action: 'user.create', target: '7', username: 'admin' });
    expect(row!.details).toEqual({ body: { username: 'bob', password: '********' } });
  });

  it('records nothing while audit.enabled is false', async () => {
    const db = await auditDb();
    setSection(db, 'audit', { enabled: false, retentionDays: 90 });
    new AuditRecorder(db).record({ action: 'x.create' });
    expect(rows(db)).toHaveLength(0);
  });

  it('audit(ctx) is a no-op until a recorder is registered, then writes', async () => {
    const db = await auditDb();
    audit(db).record({ action: 'early' });
    expect(rows(db)).toHaveLength(0);
    registerAuditRecorder(db, new AuditRecorder(db));
    audit({ db }).record({ action: 'late' });
    expect(rows(db).map((r) => r.action)).toEqual(['late']);
    unregisterAuditRecorder(db);
  });

  it('never throws, even without its table', async () => {
    const db = await createTestDb();
    expect(() => new AuditRecorder(db).record({ action: 'x' })).not.toThrow();
  });

  it('summarises oversized details', () => {
    const out = sanitizeDetails({ durationMs: 3, body: { items: 'x'.repeat(10_000) } });
    expect(out).toEqual({ truncated: true, size: expect.any(Number), durationMs: 3, body: { keys: ['items'] } });
  });
});

describe('audit service', () => {
  async function seeded() {
    const db = await auditDb();
    const r = new AuditRecorder(db);
    r.record({ action: 'settings.update', userId: 1, username: 'Admin', time: '2026-01-01T10:00:00.000Z' });
    r.record({ action: 'series.delete', userId: 2, username: 'bob', time: '2026-01-02T10:00:00.000Z' });
    r.record({ action: 'settings.updated_by_hand', username: 'bob', time: '2026-01-03T10:00:00.000Z' });
    r.record({ action: 'login.failed', username: 'mallory', ip: '10.0.0.9', time: '2026-01-04T10:00:00.000Z' });
    return { db, service: new AuditService(db, () => new Date('2026-01-05T00:00:00.000Z')) };
  }

  it('pages newest first and filters by user, action prefix and time range', async () => {
    const { service } = await seeded();
    const all = service.list({ page: 1, pageSize: 2 });
    expect(all.totalRecords).toBe(4);
    expect(all.records.map((r) => r.action)).toEqual(['login.failed', 'settings.updated_by_hand']);
    expect(service.list({ page: 2, pageSize: 2 }).records.map((r) => r.action)).toEqual(['series.delete', 'settings.update']);
    expect(service.list({ page: 1, pageSize: 50, user: 'admin' }).records.map((r) => r.userId)).toEqual([1]);
    expect(service.list({ page: 1, pageSize: 50, user: '2' }).records.map((r) => r.username)).toEqual(['bob']);
    expect(service.list({ page: 1, pageSize: 50, action: 'settings' }).totalRecords).toBe(2);
    expect(service.list({ page: 1, pageSize: 50, action: 'settings.update' }).totalRecords).toBe(1);
    expect(service.list({ page: 1, pageSize: 50, action: 'login.failed' }).totalRecords).toBe(1);
    expect(
      service.list({ page: 1, pageSize: 50, from: '2026-01-02T00:00:00Z', to: '2026-01-04T00:00:00Z' }).records.map((r) => r.action),
    ).toEqual(['settings.updated_by_hand', 'series.delete']);
  });

  it('exports CSV with quoting and a formula guard', async () => {
    const { db, service } = await seeded();
    new AuditRecorder(db).record({ action: 'x.create', target: '=HYPERLINK("evil")', details: { a: 'b,c' }, time: '2026-01-04T11:00:00.000Z' });
    const csv = service.csv({});
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('time,username,userId,ip,action,target,method,route,statusCode,details');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(lines[1]).toContain('"{""a"":""b,c""}"');
    expect(csvCell(null)).toBe('');
    expect(csvCell('-1')).toBe("'-1");
  });

  it('prunes events older than the retention, keeps all at 0', async () => {
    const { db, service } = await seeded();
    setSection(db, 'audit', { enabled: true, retentionDays: 0 });
    expect(service.prune()).toBe(0);
    setSection(db, 'audit', { enabled: true, retentionDays: 2 });
    expect(service.prune()).toBe(2);
    expect(rows(db).map((r) => r.action)).toEqual(['settings.updated_by_hand', 'login.failed']);
  });
});

// ---- the hook and routes inside a real /api/v1 scope -----------------------------------------

async function build() {
  const db = await auditDb();
  const log = pino({ level: 'silent' });
  const bus = new EventBus();
  const ctx: AppContext = {
    config: { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null },
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: new Date(),
  };
  const auth = authServiceFor(ctx);
  const app = Fastify({ trustProxy: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (api) => {
      installAuth(api, ctx);
      installAudit(api, ctx);
      await api.register(authModule(ctx));
      await api.register(auditModule(ctx));
      await api.register(async (probe) => {
        probe.post('/series', async () => ({ ok: true }));
        probe.delete('/series/:id', async () => ({ ok: true }));
        probe.get('/series', async () => []);
        probe.post('/queue/refresh', { config: { audit: false } }, async () => ({ ok: true }));
        probe.post('/indexer/test', async () => ({ ok: true }));
      });
    },
    { prefix: '/api/v1' },
  );
  const apiKey = auth.ensureApiKey();
  const admin = await auth.createUser({ username: 'admin', password: 'correct-horse-battery', role: 'admin' });
  return { app, db, ctx, auth, apiKey, admin };
}

describe('audit hook', () => {
  it('records mutating requests with actor, ip, route and status; skips reads', async () => {
    const { app, db, apiKey, auth } = await build();
    const login = await auth.login('admin', 'correct-horse-battery', { ip: '192.168.1.5' });
    const cookie = `${SESSION_COOKIE}=${login.token}`;
    await app.inject({ method: 'POST', url: '/api/v1/series', headers: { cookie }, payload: { title: 'X' } });
    await app.inject({ method: 'DELETE', url: '/api/v1/series/42', headers: { 'x-api-key': apiKey } });
    await app.inject({ method: 'GET', url: '/api/v1/series', headers: { 'x-api-key': apiKey } });
    await app.inject({ method: 'POST', url: '/api/v1/nope', headers: { 'x-api-key': apiKey } });
    const events = rows(db).filter((r) => !r.action.startsWith('login.'));
    expect(events.map((e) => e.action)).toEqual(['series.create', 'series.delete']);
    expect(events[0]).toMatchObject({ username: 'admin', method: 'POST', route: '/series', statusCode: 200 });
    expect(events[0]!.details).toMatchObject({ body: { title: 'X' } });
    expect(events[1]).toMatchObject({ username: '(apikey)', userId: null, target: '42', ip: '127.0.0.1' });
  });

  it('honours per-route opt-out and the skip list, and masks secrets and the api key', async () => {
    const { app, db, apiKey } = await build();
    await app.inject({ method: 'POST', url: '/api/v1/queue/refresh', headers: { 'x-api-key': apiKey } });
    await app.inject({ method: 'POST', url: '/api/v1/indexer/test', headers: { 'x-api-key': apiKey } });
    await app.inject({ method: 'POST', url: `/api/v1/user?apikey=${apiKey}`, payload: { username: 'eve', password: 'p4ssword-long', role: 'user' } });
    const events = rows(db);
    expect(events.map((e) => e.action)).toEqual(['user.create']);
    expect(JSON.stringify(events[0]!.details)).not.toContain(apiKey);
    expect(events[0]!.details).toMatchObject({ body: { username: 'eve', password: '********' } });
  });

  it('records failed requests too (403 from a non-admin)', async () => {
    const { app, db, auth } = await build();
    await auth.createUser({ username: 'bob', password: 'bobs-long-password', role: 'user' });
    const login = await auth.login('bob', 'bobs-long-password');
    await app.inject({ method: 'DELETE', url: '/api/v1/series/1', headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
    expect(rows(db).find((r) => r.action === 'series.delete')).toMatchObject({ username: 'bob', statusCode: 403 });
  });

  it('login success and failure come from the auth service', async () => {
    const { app, db } = await build();
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'wrong-password', method: 'local' } });
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'correct-horse-battery', method: 'local' } });
    const events = rows(db);
    expect(events.map((e) => e.action)).toEqual(['login.failed', 'login.success']);
    expect(events[0]).toMatchObject({ username: 'admin', userId: null });
    expect(events[1]!.userId).not.toBeNull();
  });
});

describe('audit routes', () => {
  it('GET /audit pages events for admins only, 400 on bad dates', async () => {
    const { app, db, apiKey, auth } = await build();
    auditRecorderFor(db).record({ action: 'series.delete', username: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?action=series', headers: { 'x-api-key': apiKey } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ page: 1, totalRecords: 1, records: [{ action: 'series.delete' }] });
    const bad = await app.inject({ method: 'GET', url: '/api/v1/audit?from=yesterday', headers: { 'x-api-key': apiKey } });
    expect(bad.statusCode).toBe(400);
    await auth.createUser({ username: 'bob', password: 'bobs-long-password', role: 'user' });
    const login = await auth.login('bob', 'bobs-long-password');
    const denied = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
    expect(denied.statusCode).toBe(403);
  });

  it('GET/PUT /settings/audit reads and validates the section', async () => {
    const { app, apiKey } = await build();
    const headers = { 'x-api-key': apiKey };
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/audit', headers })).json()).toEqual({ enabled: true, retentionDays: 90 });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/audit', headers, payload: { enabled: true, retentionDays: 30 } });
    expect(put.json()).toEqual({ enabled: true, retentionDays: 30 });
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings/audit', headers, payload: { enabled: true, retentionDays: -1 } });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /audit/export returns CSV and /audit/actions the distinct names', async () => {
    const { app, db, apiKey } = await build();
    auditRecorderFor(db).record({ action: 'series.delete' });
    auditRecorderFor(db).record({ action: 'settings.update' });
    const csv = await app.inject({ method: 'GET', url: '/api/v1/audit/export?action=series', headers: { 'x-api-key': apiKey } });
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/arclight-audit-/);
    expect(csv.body.trim().split('\r\n')).toHaveLength(2);
    const actions = await app.inject({ method: 'GET', url: '/api/v1/audit/actions', headers: { 'x-api-key': apiKey } });
    expect(actions.json()).toEqual(['series.delete', 'settings.update']);
  });
});
