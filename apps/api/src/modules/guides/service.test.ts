import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { GuidesSettings } from '@arclight/shared';
import { customFormats, qualityProfiles } from '../../db/schema.js';
import { setSection } from '../settings/service.js';
import { guidesCronFor } from './jobs.js';
import { guidesRoutes } from './routes.js';
import { guidesCache } from './schema.js';
import { API_BASE, HD1080_PROFILE_ID, RAW_BASE, recordedRoutes, setup } from './test-support.js';

// GuidesService against the recorded TRaSH response set (fake fetch, in-memory db).

const HD_TIER_01 = 'ed27ebfef2f323e964fb1f61391bcb35';

function profileScores(db: Awaited<ReturnType<typeof setup>>['db']) {
  const p = db.select().from(qualityProfiles).where(eq(qualityProfiles.id, HD1080_PROFILE_ID)).get()!;
  const formats = db.select().from(customFormats).all();
  return new Map(p.formatItems.map((i) => [formats.find((f) => f.id === i.formatId)?.name, i.score]));
}

describe('GuidesService sync', () => {
  it('notify mode stores a pending diff and sends one notification', async () => {
    const t = await setup();
    const r = await t.service.sync();
    expect(r.mode).toBe('notify');
    expect(r.applied).toBeNull();
    expect(r.pendingCount).toBe(r.changes);
    expect(r.changes).toBe(8); // 4 formats + 4 scores
    expect(t.db.select().from(customFormats).all()).toHaveLength(0);
    expect(t.notifications).toHaveLength(1);
    expect(t.notifications[0]).toMatchObject({ type: 'applicationUpdate' });
    const status = t.service.status();
    expect(status).toMatchObject({ pendingCount: 8, lastError: null, syncedFormats: 0 });
    expect(status.lastSuccessAt).not.toBeNull();
  });

  it('does not re-notify an unchanged pending diff', async () => {
    const t = await setup();
    await t.service.sync();
    await t.service.sync();
    expect(t.notifications).toHaveLength(1);
  });

  it('apply creates linked formats and sets profile scores', async () => {
    const t = await setup();
    await t.service.sync();
    const res = t.service.apply();
    expect(res).toMatchObject({ formatsCreated: 4, scoresSet: 4, pendingCount: 0 });
    const formats = t.db.select().from(customFormats).all();
    expect(formats.every((f) => f.guideId)).toBe(true);
    expect(formats.find((f) => f.guideId === HD_TIER_01)?.name).toBe('HD Bluray Tier 01');
    expect(profileScores(t.db).get('HD Bluray Tier 01')).toBe(1800);
    expect(profileScores(t.db).get('Repack2')).toBe(6);
    expect(t.service.status().lastAppliedAt).not.toBeNull();
  });

  it('is idempotent: applying again and re-syncing finds nothing', async () => {
    const t = await setup();
    await t.service.sync();
    t.service.apply();
    const again = t.service.apply();
    expect(again.applied).toEqual([]);
    const r = await t.service.sync();
    expect(r.changes).toBe(0);
    expect(t.db.select().from(customFormats).all()).toHaveLength(4);
  });

  it('applies a subset; scores whose format is not created yet are skipped and stay pending', async () => {
    const t = await setup();
    await t.service.sync();
    const res = t.service.apply([`score:${HD1080_PROFILE_ID}:${HD_TIER_01}`, 'nope']);
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.id).sort()).toEqual(['nope', `score:${HD1080_PROFILE_ID}:${HD_TIER_01}`]);
    const both = t.service.apply([`format:${HD_TIER_01}`, `score:${HD1080_PROFILE_ID}:${HD_TIER_01}`]);
    expect(both.applied).toHaveLength(2);
    expect(both.pendingCount).toBe(6);
    expect(t.service.pendingDiff().items).toHaveLength(6);
  });

  it('apply mode applies straight away and notifies with the result', async () => {
    const t = await setup({ mode: 'apply' });
    const r = await t.service.sync();
    expect(r.applied).toMatchObject({ formatsCreated: 4, scoresSet: 4 });
    expect(r.pendingCount).toBe(0);
    expect(t.notifications[0]?.type === 'applicationUpdate' && t.notifications[0].message).toMatch(/applied 8 change/);
  });

  it('never overwrites a user format with the same name unless its adopt item is applied explicitly', async () => {
    const t = await setup({ mode: 'apply' });
    const mine = t.profiles.createCustomFormat({
      name: 'Repack2',
      includeWhenRenaming: false,
      specifications: [{ implementation: 'releaseTitle', name: 'mine', negate: false, required: false, fields: { pattern: 'mine' } }],
    });
    const r = await t.service.sync();
    expect(r.pendingCount).toBeGreaterThan(0);
    expect(t.profiles.getCustomFormat(mine.id).specifications[0]?.name).toBe('mine');
    const adopt = t.service.pendingDiff().items.find((i) => i.kind === 'adoptFormat')!;
    expect(adopt.id).toBe('format:ae43b294509409a6a13919dedd4764c4');
    t.service.apply([adopt.id]);
    const after = t.db.select().from(customFormats).where(eq(customFormats.id, mine.id)).get()!;
    expect(after.guideId).toBe('ae43b294509409a6a13919dedd4764c4');
    expect(after.includeWhenRenaming).toBe(true);
  });

  it('never deletes formats: user formats and formats the guide dropped survive a sync', async () => {
    const t = await setup({ mode: 'apply' });
    t.profiles.createCustomFormat({ name: 'Mine', includeWhenRenaming: false, specifications: [] });
    t.db.insert(customFormats).values({ name: 'Dropped upstream', includeWhenRenaming: false, specifications: [], guideId: 'gone' }).run();
    await t.service.sync();
    const names = t.db.select().from(customFormats).all().map((f) => f.name);
    expect(names).toContain('Mine');
    expect(names).toContain('Dropped upstream');
    expect(t.service.pendingDiff().staleFormats.map((f) => f.guideId)).toEqual(['gone']);
  });

  it('excluded formats are neither created nor scored', async () => {
    const t = await setup({ mode: 'apply', excludeFormats: ['WEB Tier*', 'repack*'] });
    await t.service.sync();
    expect(t.db.select().from(customFormats).all().map((f) => f.name)).toEqual(['HD Bluray Tier 01']);
    expect([...profileScores(t.db).keys()]).toEqual(['HD Bluray Tier 01']);
  });

  it('a user edit to a synced format shows as an update on the next sync', async () => {
    const t = await setup({ mode: 'apply' });
    await t.service.sync();
    const f = t.db.select().from(customFormats).where(eq(customFormats.guideId, HD_TIER_01)).get()!;
    t.profiles.updateCustomFormat(f.id, { name: f.name, includeWhenRenaming: true, specifications: f.specifications });
    setSection(t.db, 'guides', GuidesSettings.parse({ ...t.service.settings(), mode: 'notify' }));
    await t.service.sync();
    expect(t.service.pendingDiff().items).toEqual([expect.objectContaining({ kind: 'updateFormat', formatId: f.id })]);
  });
});

describe('GuidesService fetching and caching', () => {
  it('lists through the contents API and reads raw files', async () => {
    const t = await setup();
    await t.service.sync();
    const urls = t.fetch.calls.map((c) => c.url);
    expect(urls).toContain(`${RAW_BASE}metadata.json`);
    expect(urls).toContain(`${API_BASE}docs/json/radarr/cf?ref=master`);
    expect(urls).toContain(`${RAW_BASE}docs/json/radarr/cf/repack2.json`);
    expect(t.db.select().from(guidesCache).all().length).toBeGreaterThan(6);
  });

  it('second sync downloads no unchanged file (sha) and revalidates the rest with ETags', async () => {
    const t = await setup();
    await t.service.sync();
    const first = t.fetch.calls.length;
    const r = await t.service.sync();
    const second = t.fetch.calls.slice(first);
    expect(second.some((c) => c.url.includes('/cf/'))).toBe(false);
    expect(second.every((c) => c.ifNoneMatch)).toBe(true);
    expect(r.fetch.cached).toBe(r.fetch.files + 2); // + two 304 listings
  });

  it('records the error and keeps the pending diff when the guide is unreachable', async () => {
    const t = await setup();
    await t.service.sync();
    t.fetch.routes.delete(`${RAW_BASE}metadata.json`);
    t.db.delete(guidesCache).run();
    await expect(t.service.sync()).rejects.toThrow(/HTTP 404/);
    const s = t.service.status();
    expect(s.lastError).toMatch(/metadata\.json/);
    expect(s.pendingCount).toBe(8);
    expect(t.service.feedStatus()).toMatchObject({ enabled: true, intervalMs: 24 * 3_600_000, pending: 8 });
  });

  it('a custom non-GitHub source is listed through <dir>/index.json', async () => {
    const base = 'https://guides.example.test/repo/main/';
    const routes = new Map<string, { body: string }>();
    for (const [url, r] of recordedRoutes()) if (url.startsWith(RAW_BASE)) routes.set(url.replace(RAW_BASE, base), { body: r.body });
    routes.set(`${base}docs/json/radarr/cf/index.json`, { body: JSON.stringify(['repack2.json', 'br-disk.json', '../evil.json']) });
    routes.set(`${base}docs/json/radarr/quality-profiles/index.json`, { body: JSON.stringify(['hd-bluray-web.json']) });
    const t = await setup({ source: 'custom', repoUrl: 'https://guides.example.test/repo/', branch: 'main', mode: 'apply', includeFormats: ['*'] }, routes);
    await t.service.sync();
    expect(t.db.select().from(customFormats).all().map((f) => f.name).sort()).toEqual(['BR-DISK', 'Repack2']);
    expect(t.fetch.calls.some((c) => c.url.includes('evil'))).toBe(false);
  });

  it('profiles() lists what the guide offers with the current mapping', async () => {
    const t = await setup();
    const before = t.fetch.calls.length;
    const list = await t.service.profiles();
    expect(t.fetch.calls.slice(before).some((c) => c.url.includes('/cf/'))).toBe(false);
    expect(list).toEqual([expect.objectContaining({ name: 'HD Bluray + WEB', app: 'radarr', mappedTo: HD1080_PROFILE_ID, scoreSet: 'default' })]);
  });

  it('job cron follows enabled and the interval', () => {
    expect(guidesCronFor({ enabled: false, syncIntervalHours: 24 })).toBeNull();
    expect(guidesCronFor({ enabled: true, syncIntervalHours: 6 })).toBe('17 */6 * * *');
    expect(guidesCronFor({ enabled: true, syncIntervalHours: 24 })).toBe('17 4 * * *');
    expect(guidesCronFor({ enabled: true, syncIntervalHours: 72 })).toBe('17 4 */3 * *');
  });
});

describe('guides routes', () => {
  async function build(settings = {}) {
    const t = await setup(settings);
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const changed: unknown[] = [];
    await app.register(guidesRoutes(t.service, { onSettingsChanged: (s) => changed.push(s) }), { prefix: '/api/v1' });
    return { ...t, app, changed };
  }

  it('GET/PUT /settings/guides validates and calls the reschedule hook', async () => {
    const { app, changed } = await build();
    const got = await app.inject({ method: 'GET', url: '/api/v1/settings/guides' });
    expect(got.json()).toMatchObject({ enabled: true, source: 'trash', syncIntervalHours: 24, mode: 'notify' });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/guides', payload: { ...(got.json() as object), syncIntervalHours: 12 } });
    expect(put.statusCode).toBe(200);
    expect(changed).toHaveLength(1);
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings/guides', payload: { ...(got.json() as object), mode: 'yolo' } });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /guides/sync, GET /guides/diff, POST /guides/apply, GET /guides/status', async () => {
    const { app } = await build();
    const sync = await app.inject({ method: 'POST', url: '/api/v1/guides/sync' });
    expect(sync.statusCode).toBe(200);
    const diff = await app.inject({ method: 'GET', url: '/api/v1/guides/diff' });
    expect(diff.json().items).toHaveLength(8);
    const apply = await app.inject({ method: 'POST', url: '/api/v1/guides/apply', payload: {} });
    expect(apply.json()).toMatchObject({ formatsCreated: 4, pendingCount: 0 });
    const status = await app.inject({ method: 'GET', url: '/api/v1/guides/status' });
    expect(status.json()).toMatchObject({ pendingCount: 0, syncedFormats: 4 });
    const profiles = await app.inject({ method: 'GET', url: '/api/v1/guides/profiles' });
    expect(profiles.json()[0]).toMatchObject({ name: 'HD Bluray + WEB' });
  });

  it('upstream failures are 502', async () => {
    const { app, fetch } = await build();
    fetch.routes.clear();
    const res = await app.inject({ method: 'POST', url: '/api/v1/guides/sync' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('UPSTREAM');
  });
});
