import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permission as P, RequestsSettings, UserApprovalPolicy, type ApprovalBudget, type ApprovalWindow } from '@arclight/shared';
import { users } from '../../db/schema.js';
import { authServiceFor } from '../auth/index.js';
import { evaluatePolicy, GB, needsSizeEstimate, nextOpening, windowActive, type PolicyFacts } from './policy.js';
import { mediaRequests } from './schema.js';
import { addUser, buildApp, NOW, setup } from './test-support.js';

// Windows are in server local time, so every window is built around NOW's local day/hour.
const DAY = NOW.getDay();
const HOUR = NOW.getHours();
const hourAt = (offset: number) => (HOUR + offset + 24) % 24;

function facts(over: Partial<PolicyFacts> & { budgets?: ApprovalBudget[]; windows?: ApprovalWindow[]; threshold?: number | null; policy?: Partial<UserApprovalPolicy> } = {}): PolicyFacts {
  return {
    settings: { approvalBudgets: over.budgets ?? [], approvalWindows: over.windows ?? [], autoApproveIfSizeBelowGb: over.threshold ?? null },
    user: { id: 7, role: 'user', policy: UserApprovalPolicy.parse(over.policy ?? {}) },
    type: over.type ?? 'movie',
    seasonCount: over.seasonCount ?? 0,
    estimatedSizeBytes: over.estimatedSizeBytes ?? null,
    usage: over.usage ?? (() => ({ movieBytes: 0, seasons: 0 })),
    now: over.now ?? NOW,
  };
}

const budget = (b: Partial<ApprovalBudget>): ApprovalBudget => ({ scope: 'user', periodDays: 7, autoApproveUnder: {}, ...b });

describe('approval windows', () => {
  it('matches a same-day window by local day and hour (end exclusive)', () => {
    expect(windowActive({ days: [DAY], startHour: HOUR, endHour: HOUR + 1, action: 'autoApprove' }, NOW)).toBe(true);
    const before = { days: [DAY], startHour: 0, endHour: HOUR, action: 'hold' as const };
    expect(windowActive(before, NOW)).toBe(false);
    expect(windowActive({ days: [(DAY + 1) % 7], startHour: 0, endHour: 24, action: 'hold' }, NOW)).toBe(false);
  });

  it('a window past midnight belongs to the day it starts on', () => {
    const late = new Date(2026, 5, 2, 23, 0, 0); // local Tuesday 23:00
    const early = new Date(2026, 5, 3, 2, 0, 0); // local Wednesday 02:00
    const w: ApprovalWindow = { days: [late.getDay()], startHour: 22, endHour: 6, action: 'autoApprove' };
    expect(windowActive(w, late)).toBe(true);
    expect(windowActive(w, early)).toBe(true);
    expect(windowActive(w, new Date(2026, 5, 3, 23, 0, 0))).toBe(false);
  });

  it('nextOpening finds the next hour a window opens', () => {
    const at = new Date(2026, 5, 2, 10, 30, 0);
    const next = nextOpening([{ days: [at.getDay()], startHour: 14, endHour: 16, action: 'autoApprove' }], at);
    expect(next?.getHours()).toBe(14);
    expect(next?.getDate()).toBe(2);
    expect(nextOpening([], at)).toBeNull();
  });
});

describe('evaluatePolicy', () => {
  it('leaves requests pending when no policy is configured', () => {
    expect(evaluatePolicy(facts()).decision).toBe('pending');
  });

  it('approves under the size limit, not above it, and skips unknown sizes', () => {
    expect(evaluatePolicy(facts({ threshold: 10, estimatedSizeBytes: 4 * GB })).decision).toBe('approve');
    const above = evaluatePolicy(facts({ threshold: 10, estimatedSizeBytes: 12 * GB }));
    expect(above.decision).toBe('pending');
    expect(above.steps[0]).toMatchObject({ rule: 'size', outcome: 'fail' });
    expect(evaluatePolicy(facts({ threshold: 10, estimatedSizeBytes: null })).steps[0]).toMatchObject({ rule: 'size', outcome: 'skip' });
  });

  it('a user size limit replaces the global one', () => {
    expect(evaluatePolicy(facts({ threshold: 10, estimatedSizeBytes: 4 * GB, policy: { autoApproveIfSizeBelowGb: 2 } })).decision).toBe('pending');
    expect(evaluatePolicy(facts({ threshold: 1, estimatedSizeBytes: 4 * GB, policy: { autoApproveIfSizeBelowGb: 5 } })).decision).toBe('approve');
  });

  it('user override never wins over every policy; always approves without one', () => {
    expect(evaluatePolicy(facts({ threshold: 10, estimatedSizeBytes: GB, policy: { autoApprove: 'never' } })).decision).toBe('pending');
    expect(evaluatePolicy(facts({ policy: { autoApprove: 'always' } })).decision).toBe('approve');
  });

  it('a movie GB budget approves while there is room and stops when it is used up', () => {
    const b = [budget({ movieGb: 50 })];
    expect(evaluatePolicy(facts({ budgets: b, estimatedSizeBytes: 10 * GB, usage: () => ({ movieBytes: 30 * GB, seasons: 0 }) })).decision).toBe('approve');
    const full = evaluatePolicy(facts({ budgets: b, estimatedSizeBytes: 10 * GB, usage: () => ({ movieBytes: 45 * GB, seasons: 0 }) }));
    expect(full.decision).toBe('pending');
    expect(full.steps[0]?.message).toMatch(/exceeds 50 GB/);
    // A movie GB budget needs a size.
    expect(evaluatePolicy(facts({ budgets: b, estimatedSizeBytes: null })).decision).toBe('pending');
  });

  it('a season budget counts the seasons of the request', () => {
    const b = [budget({ tvSeasons: 4 })];
    expect(evaluatePolicy(facts({ type: 'series', budgets: b, seasonCount: 2, usage: () => ({ movieBytes: 0, seasons: 2 }) })).decision).toBe('approve');
    expect(evaluatePolicy(facts({ type: 'series', budgets: b, seasonCount: 3, usage: () => ({ movieBytes: 0, seasons: 2 }) })).decision).toBe('pending');
    // The movie budget does not cover series.
    expect(evaluatePolicy(facts({ type: 'series', budgets: [budget({ movieGb: 100 })], seasonCount: 1 })).steps).toEqual([]);
  });

  it('budgets apply only to their users and role', () => {
    const forOthers = [budget({ scope: 'user', userIds: [99], movieGb: 100 })];
    expect(evaluatePolicy(facts({ budgets: forOthers, estimatedSizeBytes: GB })).decision).toBe('pending');
    const admins = [budget({ scope: 'role', role: 'admin', movieGb: 100 })];
    expect(evaluatePolicy(facts({ budgets: admins, estimatedSizeBytes: GB })).decision).toBe('pending');
    const users = [budget({ scope: 'role', role: 'user', movieGb: 100 })];
    expect(evaluatePolicy(facts({ budgets: users, estimatedSizeBytes: GB })).decision).toBe('approve');
  });

  it('autoApproveUnder.sizeGb requires the request itself to be small', () => {
    const b = [budget({ scope: 'all', movieGb: 500, autoApproveUnder: { sizeGb: 8 } })];
    expect(evaluatePolicy(facts({ budgets: b, estimatedSizeBytes: 5 * GB })).decision).toBe('approve');
    expect(evaluatePolicy(facts({ budgets: b, estimatedSizeBytes: 9 * GB })).steps[0]?.message).toMatch(/not under 8 GB/);
  });

  it('budget-exempt users skip budgets', () => {
    const r = evaluatePolicy(facts({ budgets: [budget({ movieGb: 100 })], estimatedSizeBytes: GB, policy: { budgetExempt: true } }));
    expect(r.decision).toBe('pending');
    expect(r.steps[0]).toMatchObject({ rule: 'budget', outcome: 'skip' });
  });

  it('a hold window holds requests that would be approved and leaves the rest pending', () => {
    const hold: ApprovalWindow = { days: [0, 1, 2, 3, 4, 5, 6], startHour: hourAt(0), endHour: hourAt(1), action: 'hold' };
    const held = evaluatePolicy(facts({ windows: [hold], threshold: 10, estimatedSizeBytes: GB }));
    expect(held.decision).toBe('hold');
    expect(held.nextWindowAt).not.toBeNull();
    expect(evaluatePolicy(facts({ windows: [hold] })).decision).toBe('pending');
  });

  it('an auto-approve window approves inside and holds outside until it opens', () => {
    const inside: ApprovalWindow = { days: [DAY], startHour: hourAt(0), endHour: hourAt(1) || 24, action: 'autoApprove' };
    expect(evaluatePolicy(facts({ windows: [inside] })).decision).toBe('approve');
    const later: ApprovalWindow = { days: [0, 1, 2, 3, 4, 5, 6], startHour: hourAt(2), endHour: hourAt(3), action: 'autoApprove' };
    const outside = evaluatePolicy(facts({ windows: [later] }));
    expect(outside.decision).toBe('hold');
    expect(new Date(outside.nextWindowAt!).getHours()).toBe(hourAt(2));
  });

  it('only searches for a size when a policy needs one', () => {
    const user = { id: 1, role: 'user' as const, policy: UserApprovalPolicy.parse({}) };
    const settings = { approvalBudgets: [], approvalWindows: [], autoApproveIfSizeBelowGb: null };
    expect(needsSizeEstimate({ settings, user, type: 'movie' })).toBe(false);
    expect(needsSizeEstimate({ settings: { ...settings, autoApproveIfSizeBelowGb: 5 }, user, type: 'movie' })).toBe(true);
    expect(needsSizeEstimate({ settings: { ...settings, approvalBudgets: [budget({ tvSeasons: 3 })] }, user, type: 'series' })).toBe(false);
    expect(needsSizeEstimate({ settings: { ...settings, approvalBudgets: [budget({ movieGb: 3 })] }, user, type: 'movie' })).toBe(true);
    expect(needsSizeEstimate({ settings: { ...settings, autoApproveIfSizeBelowGb: 5 }, user: { ...user, policy: { ...user.policy, autoApprove: 'always' } }, type: 'movie' })).toBe(false);
  });
});

function saveSettings(h: Awaited<ReturnType<typeof setup>>, patch: Partial<RequestsSettings>): void {
  const admin = addUser(h.db, { role: 'admin' });
  h.services.requests.updateSettings(admin.actor, RequestsSettings.parse({ ...h.services.requests.settings(), ...patch }));
}

describe('approval policies in the requests service', () => {
  it('auto-approves under the size limit using the estimate, stores it, and records no human approver', async () => {
    const asked: unknown[] = [];
    const h = await setup({ extra: { estimateSize: async (q) => (asked.push(q), 3 * GB) } });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    saveSettings(h, { autoApproveIfSizeBelowGb: 5 });
    const u = addUser(h.db, { permissions: P.REQUEST });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(out.kind === 'created' && out.request).toMatchObject({ status: 'approved', modifiedBy: null });
    expect(asked).toEqual([{ type: 'movie', tmdbId: 603, is4k: false, seasons: [] }]);
    expect(h.db.select().from(mediaRequests).get()?.estimatedSizeBytes).toBe(3 * GB);
  });

  it('does not search for a size when no policy needs one', async () => {
    let calls = 0;
    const h = await setup({ extra: { estimateSize: async () => (calls++, GB) } });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const u = addUser(h.db, { permissions: P.REQUEST });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(out.kind === 'created' && out.request.status).toBe('pending');
    expect(calls).toBe(0);
  });

  it('a user budget counts earlier approved requests of that user only', async () => {
    const h = await setup({ extra: { estimateSize: async () => 30 * GB } });
    h.tmdb.addMovie({ tmdbId: 1, title: 'One', year: 2001 }).addMovie({ tmdbId: 2, title: 'Two', year: 2002 }).addMovie({ tmdbId: 3, title: 'Three', year: 2003 });
    saveSettings(h, { approvalBudgets: [budget({ scope: 'user', movieGb: 50 })] });
    const a = addUser(h.db, { permissions: P.REQUEST });
    const b = addUser(h.db, { permissions: P.REQUEST });
    const first = await h.services.requests.create(a.actor, { mediaType: 'movie', tmdbId: 1 });
    const second = await h.services.requests.create(a.actor, { mediaType: 'movie', tmdbId: 2 });
    const other = await h.services.requests.create(b.actor, { mediaType: 'movie', tmdbId: 3 });
    expect(first.kind === 'created' && first.request.status).toBe('approved');
    expect(second.kind === 'created' && second.request.status).toBe('pending');
    expect(other.kind === 'created' && other.request.status).toBe('approved');
  });

  it('holds requests outside the auto-approve window and RequestsPolicySweep approves them when it opens', async () => {
    let now = NOW;
    const h = await setup({ extra: { now: () => now } });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    saveSettings(h, { approvalWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: hourAt(2), endHour: hourAt(3), action: 'autoApprove' }] });
    const u = addUser(h.db, { permissions: P.REQUEST });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(out.kind === 'created' && out.request).toMatchObject({ status: 'pending', heldByPolicy: true });
    expect(await h.services.requests.policySweep()).toMatch(/0 approved/);
    now = new Date(NOW.getTime() + 2 * 3600_000);
    expect(await h.services.requests.policySweep()).toMatch(/1 approved/);
    const row = h.db.select().from(mediaRequests).get()!;
    expect(row).toMatchObject({ status: 'approved', policyHold: null, modifiedById: null });
    expect(row.libraryId).not.toBeNull();
  });

  it('the sweep releases held requests to plain pending once no window holds them', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    saveSettings(h, { approvalWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: hourAt(2), endHour: hourAt(3), action: 'autoApprove' }] });
    const u = addUser(h.db, { permissions: P.REQUEST });
    await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    saveSettings(h, { approvalWindows: [] });
    expect(await h.services.requests.policySweep()).toMatch(/1 released/);
    expect(h.db.select().from(mediaRequests).get()).toMatchObject({ status: 'pending', policyHold: null });
  });

  it('a manual approval clears the hold', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    saveSettings(h, { approvalWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: hourAt(2), endHour: hourAt(3), action: 'autoApprove' }] });
    const u = addUser(h.db, { permissions: P.REQUEST });
    const admin = addUser(h.db, { role: 'admin' });
    const out = await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    const id = out.kind === 'created' ? out.request.id : 0;
    const approved = await h.services.requests.approve(admin.actor, id);
    expect(approved.heldByPolicy).toBeUndefined();
    expect(h.db.select().from(mediaRequests).get()?.policyHold).toBeNull();
  });
});

describe('approval policy routes', () => {
  async function app() {
    const h = await buildApp({ extra: { estimateSize: async () => 12 * GB } });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const admin = addUser(h.db, { role: 'admin' });
    const user = addUser(h.db, { permissions: P.REQUEST });
    return { ...h, admin, user, adminCookie: h.cookieFor(admin.id), userCookie: h.cookieFor(user.id) };
  }

  it('GET/PUT /settings/requests round-trips budgets, windows, size limit and the portal', async () => {
    const h = await app();
    const current = (await h.app.inject({ method: 'GET', url: '/api/v1/settings/requests', headers: { cookie: h.adminCookie } })).json() as Record<string, unknown>;
    expect(current).toMatchObject({ approvalBudgets: [], approvalWindows: [], autoApproveIfSizeBelowGb: null, publicPortal: { enabled: false } });
    const body = {
      ...current,
      approvalBudgets: [{ scope: 'role', role: 'user', movieGb: 200, periodDays: 30, autoApproveUnder: { sizeGb: 15 } }],
      approvalWindows: [{ days: [6, 0], startHour: 1, endHour: 7, action: 'autoApprove' }],
      autoApproveIfSizeBelowGb: 4,
    };
    const saved = await h.app.inject({ method: 'PUT', url: '/api/v1/settings/requests', headers: { cookie: h.adminCookie }, payload: body });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ approvalBudgets: [{ scope: 'role', movieGb: 200 }], autoApproveIfSizeBelowGb: 4 });
    const bad = await h.app.inject({ method: 'PUT', url: '/api/v1/settings/requests', headers: { cookie: h.adminCookie }, payload: { ...body, approvalWindows: [{ days: [9], startHour: 1, endHour: 2, action: 'hold' }] } });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /request/:id/policy explains why a request is pending, for its owner and managers only', async () => {
    const h = await app();
    const settings = (await h.app.inject({ method: 'GET', url: '/api/v1/settings/requests', headers: { cookie: h.adminCookie } })).json() as Record<string, unknown>;
    await h.app.inject({ method: 'PUT', url: '/api/v1/settings/requests', headers: { cookie: h.adminCookie }, payload: { ...settings, autoApproveIfSizeBelowGb: 10 } });
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(created.json()).toMatchObject({ status: 'pending' });
    const id = created.json().id as number;
    const why = await h.app.inject({ method: 'GET', url: `/api/v1/request/${id}/policy`, headers: { cookie: h.userCookie } });
    expect(why.statusCode).toBe(200);
    expect(why.json()).toMatchObject({ requestId: id, decision: 'pending', held: false, estimatedSizeBytes: 12 * GB });
    const rules = (why.json().steps as { rule: string; outcome: string }[]).map((s) => `${s.rule}:${s.outcome}`);
    expect(rules).toEqual(['permission:fail', 'settings:fail', 'overrideRule:skip', 'size:fail']);
    const stranger = addUser(h.db, { permissions: P.REQUEST });
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/request/${id}/policy`, headers: { cookie: h.cookieFor(stranger.id) } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/request/${id}/policy`, headers: { cookie: h.adminCookie } })).statusCode).toBe(200);
  });

  it('managers set the per-user override on /user/:id/permissions; it shows on the user resource and users cannot change it themselves', async () => {
    const h = await app();
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/user/${h.user.id}/permissions`,
      headers: { cookie: h.adminCookie },
      payload: { permissions: P.REQUEST, approvalPolicy: { autoApprove: 'always' } },
    });
    expect(put.json()).toMatchObject({ permissions: P.REQUEST, approvalPolicy: { autoApprove: 'always', budgetExempt: false } });
    const row = h.db.select().from(users).where(eq(users.id, h.user.id)).get()!;
    expect(row.settings).toMatchObject({ approvalPolicy: { autoApprove: 'always' } });
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/request', headers: { cookie: h.userCookie }, payload: { mediaType: 'movie', tmdbId: 603 } });
    expect(created.json()).toMatchObject({ status: 'approved' });
    // PUT /user/me drops manager-owned keys.
    authServiceFor(h.ctx).updateSelf(h.user.id, { settings: { approvalPolicy: { autoApprove: 'never' }, theme: 'dark' } });
    const after = h.db.select().from(users).where(eq(users.id, h.user.id)).get()!;
    expect(after.settings).toMatchObject({ approvalPolicy: { autoApprove: 'always' }, theme: 'dark' });
    expect((await h.app.inject({ method: 'PUT', url: `/api/v1/user/${h.user.id}/permissions`, headers: { cookie: h.userCookie }, payload: { permissions: P.REQUEST, approvalPolicy: { autoApprove: 'always' } } })).statusCode).toBe(403);
  });
});
