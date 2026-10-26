import { afterEach, describe, expect, it } from 'vitest';
import { Permission as P } from '@arclight/shared';
import { users } from '../../db/schema.js';
import { addUser } from '../requests/test-support.js';
import { SLASH_COMMANDS } from './commands.js';
import { discordBotHealthCheck } from './index.js';
import type { HealthDeps } from '../health/index.js';
import { DISCONNECTED_GRACE_MS, LINK_CODE_TTL_MS } from './service.js';
import { botHarness, interaction, replyTo, waitFor, type BotHarness } from './test-support.js';

const harnesses: BotHarness[] = [];
async function harness(opts: Parameters<typeof botHarness>[0] = {}) {
  const h = await botHarness(opts);
  harnesses.push(h);
  h.tmdb
    .addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 })
    .addMovie({ tmdbId: 604, title: 'The Matrix Reloaded', year: 2003 })
    .addMovie({ tmdbId: 605, title: 'The Matrix Revolutions', year: 2003 });
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.bot.stop();
});

/** Links Discord user `discordId` to a new Arclight user through the real /link flow. */
async function linked(h: BotHarness, discordId: string, opts: Parameters<typeof addUser>[1] = {}) {
  const u = addUser(h.db, opts);
  const { code } = h.bot.createLinkCode(u.id);
  const i = interaction({ command: 'link', options: { code } }, discordId);
  await h.bot.handleInteraction(i);
  return { ...u, reply: replyTo(h.rest, i) };
}

async function run(h: BotHarness, i: ReturnType<typeof interaction>) {
  await h.bot.handleInteraction(i);
  return replyTo(h.rest, i);
}

describe('discord bot lifecycle', () => {
  it('registers the slash commands on the configured guild after Ready', async () => {
    const h = await harness();
    const put = h.rest.find('PUT', /^\/applications\/app-1\/guilds\/11111\/commands$/);
    expect(put).toHaveLength(1);
    expect((put[0]!.body as { name: string }[]).map((c) => c.name)).toEqual(['request', 'link', 'status', 'search', 'pending']);
    expect(SLASH_COMMANDS[0]!.options!.map((o) => o.name)).toEqual(['title', 'year', '4k']);
    expect(h.bot.status()).toMatchObject({ enabled: true, state: 'connected', botUser: { username: 'arclight-bot' }, commandsRegistered: true });
  });

  it('registers global commands when no guild is set, and stays disabled without a token', async () => {
    const h = await harness({ settings: { guildId: null } });
    expect(h.rest.find('PUT', /^\/applications\/app-1\/commands$/)).toHaveLength(1);
    const off = await harness({ settings: { enabled: false }, start: false });
    off.bot.start();
    expect(off.bot.status().state).toBe('disabled');
    expect(off.gateway.sockets).toHaveLength(0);
  });

  it('acknowledges every interaction with an ephemeral deferral before answering', async () => {
    const h = await harness();
    const i = interaction({ command: 'status' }, '501');
    await run(h, i);
    const callback = h.rest.find('POST', new RegExp(`^/interactions/${i.id}/${i.token}/callback$`))[0]!;
    expect(callback.body).toEqual({ type: 5, data: { flags: 64 } });
  });

  it('dispatches INTERACTION_CREATE from the gateway to the command handler', async () => {
    const h = await harness();
    const i = interaction({ command: 'status' }, '501');
    h.gateway.dispatch(h.gateway.last, 'INTERACTION_CREATE', i);
    await waitFor(() => h.rest.calls.some((c) => c.method === 'PATCH' && c.path.includes(i.token)));
    expect(replyTo(h.rest, i).content).toContain('/link');
  });
});

describe('account links', () => {
  it('links with a code from the profile; the code is single-use and replaced by a newer one', async () => {
    const h = await harness();
    const u = await linked(h, '501', { username: 'alice' });
    expect(u.reply.content).toContain('alice');
    const row = h.db.select().from(users).all().find((r) => r.id === u.id)!;
    expect(row.settings).toMatchObject({ discordUserId: '501' });
    expect(h.bot.status().linkedUsers).toBe(1);
    expect(h.bot.createLinkCode(u.id).linkedDiscordUserId).toBe('501');

    const other = addUser(h.db);
    const first = h.bot.createLinkCode(other.id);
    const second = h.bot.createLinkCode(other.id);
    expect((await run(h, interaction({ command: 'link', options: { code: first.code } }, '502'))).content).toContain('unknown or expired');
    expect((await run(h, interaction({ command: 'link', options: { code: second.code.toLowerCase() } }, '502'))).content).toContain('Linked');
    expect((await run(h, interaction({ command: 'link', options: { code: second.code } }, '502'))).content).toContain('unknown or expired');
  });

  it('refuses expired codes and moves a Discord account linked elsewhere', async () => {
    const h = await harness();
    const a = await linked(h, '501');
    const b = addUser(h.db);
    const stale = h.bot.createLinkCode(b.id);
    h.clock.now = new Date(h.clock.now.getTime() + LINK_CODE_TTL_MS + 1);
    expect((await run(h, interaction({ command: 'link', options: { code: stale.code } }, '501'))).content).toContain('expired');
    const fresh = h.bot.createLinkCode(b.id);
    await run(h, interaction({ command: 'link', options: { code: fresh.code } }, '501'));
    expect(h.bot.discordIdOf(b.id)).toBe('501');
    expect(h.bot.discordIdOf(a.id)).toBeNull();
    h.bot.unlink(b.id);
    expect(h.bot.linkedUser('501')).toBeUndefined();
  });
});

describe('/request', () => {
  it('tells unlinked users how to link', async () => {
    const h = await harness();
    const reply = await run(h, interaction({ command: 'request', options: { title: 'matrix' } }, '777'));
    expect(reply.content).toMatch(/Profile > Discord.*\/link/);
  });

  it('offers up to five matches as buttons and filters by year', async () => {
    const h = await harness();
    await linked(h, '501');
    const all = await run(h, interaction({ command: 'request', options: { title: 'matrix', '4k': true } }, '501'));
    const buttons = all.components![0]!.components;
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toMatchObject({ label: 'The Matrix (1999) [movie]', custom_id: 'req:movie:603:1' });
    const y = await run(h, interaction({ command: 'request', options: { title: 'matrix', year: 2003 } }, '501'));
    expect(y.components![0]!.components.map((b) => b.custom_id)).toEqual(['req:movie:604:0', 'req:movie:605:0']);
    const none = await run(h, interaction({ command: 'request', options: { title: 'zzz' } }, '501'));
    expect(none.content).toContain('Nothing found');
  });

  it('creates the request as the linked user when a button is clicked, and maps duplicates to a friendly reply', async () => {
    const h = await harness();
    const u = await linked(h, '501', { username: 'alice', permissions: P.REQUEST });
    const reply = await run(h, interaction({ button: 'req:movie:603:0' }, '501'));
    expect(reply.embeds![0]!.title).toBe('Request is waiting for approval: The Matrix (1999)');
    const list = h.services.requests.list({ userId: u.id, permissions: P.REQUEST }, {});
    expect(list.results).toMatchObject([{ mediaTmdbId: 603, status: 'pending', requestedBy: { id: u.id } }]);
    const again = await run(h, interaction({ button: 'req:movie:603:0' }, '501'));
    expect(again.content).toMatch(/^Already taken care of/);
    const stranger = await run(h, interaction({ button: 'req:movie:604:0' }, '999'));
    expect(stranger.content).toContain('/link');
  });

  it('respects the requester permissions (no request permission: not allowed)', async () => {
    const h = await harness();
    await linked(h, '501', { permissions: P.CREATE_ISSUES });
    const reply = await run(h, interaction({ button: 'req:movie:603:0' }, '501'));
    expect(reply.content).toMatch(/^Not allowed/);
  });
});

describe('/status and /search', () => {
  it('/status lists only the linked user\'s requests, optionally by title', async () => {
    const h = await harness();
    const u = await linked(h, '501');
    const other = addUser(h.db);
    await h.services.requests.create({ userId: u.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 603 });
    await h.services.requests.create({ userId: u.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 604 });
    await h.services.requests.create({ userId: other.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 605 });
    const all = await run(h, interaction({ command: 'status' }, '501'));
    expect(all.embeds![0]!.description!.split('\n')).toHaveLength(2);
    const one = await run(h, interaction({ command: 'status', options: { title: 'reloaded' } }, '501'));
    expect(one.embeds![0]!.description).toMatch(/^#\d+ The Matrix Reloaded \(2003\): pending$/);
    const none = await run(h, interaction({ command: 'status', options: { title: 'dune' } }, '501'));
    expect(none.content).toContain('no requests matching');
  });

  it('/search shows the library and request status of each match', async () => {
    const h = await harness();
    const u = addUser(h.db);
    await h.services.requests.create({ userId: u.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 604 });
    const reply = await run(h, interaction({ command: 'search', options: { title: 'matrix' } }, '888'));
    const fields = reply.embeds![0]!.fields!;
    expect(fields.find((f) => f.name.startsWith('The Matrix (1999)'))!.value).toBe('Not requested');
    expect(fields.find((f) => f.name.startsWith('The Matrix Reloaded'))!.value).toBe('Requested');
  });
});

describe('/pending', () => {
  async function withPending(h: BotHarness) {
    const requester = addUser(h.db, { username: 'kid' });
    const out = await h.services.requests.create({ userId: requester.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 603 });
    if (out.kind !== 'created') throw new Error('expected a request');
    return out.request.id;
  }

  it('is refused to members without the admin role or Manage requests', async () => {
    const h = await harness();
    await withPending(h);
    await linked(h, '501');
    expect((await run(h, interaction({ command: 'pending' }, '501'))).content).toContain('Only Arclight request managers');
    expect((await run(h, interaction({ command: 'pending' }, '502', ['44444']))).content).toContain('Only Arclight request managers');
  });

  it('lists pending requests with approve/decline buttons for linked managers, who approve as themselves', async () => {
    const h = await harness();
    const id = await withPending(h);
    const mgr = await linked(h, '601', { username: 'mod', permissions: P.MANAGE_REQUESTS });
    const reply = await run(h, interaction({ command: 'pending' }, '601'));
    expect(reply.embeds![0]!.title).toBe('Pending requests (1)');
    expect(reply.components![0]!.components.map((b) => b.custom_id)).toEqual([`appr:${id}`, `decl:${id}`]);
    const done = await run(h, interaction({ button: `appr:${id}` }, '601'));
    expect(done.embeds![0]!.title).toContain('Request approved');
    expect(h.services.requests.row(id)).toMatchObject({ status: 'approved', modifiedById: mgr.id });
  });

  it('lets an unlinked member with the admin role decline (as the system), re-checking on every click', async () => {
    const h = await harness();
    const id = await withPending(h);
    const denied = await run(h, interaction({ button: `decl:${id}` }, '700', []));
    expect(denied.content).toContain('may not approve or decline');
    expect(h.services.requests.row(id).status).toBe('pending');
    const ok = await run(h, interaction({ button: `decl:${id}` }, '700', ['33333']));
    expect(ok.embeds![0]!.title).toContain('Request declined');
    expect(h.services.requests.row(id)).toMatchObject({ status: 'declined', modifiedById: null, declineReason: 'Declined from Discord' });
  });
});

describe('request channel notifications', () => {
  it('posts created and approved embeds to the request channel through the bot', async () => {
    const h = await harness();
    const u = addUser(h.db, { username: 'alice' });
    const admin = addUser(h.db, { role: 'admin' });
    const out = await h.services.requests.create({ userId: u.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 603 });
    await h.bot.flush();
    if (out.kind !== 'created') throw new Error('expected a request');
    await h.services.requests.approve(admin.actor, out.request.id);
    await h.bot.flush();
    const posts = h.rest.find('POST', /^\/channels\/22222\/messages$/);
    const titles = posts.map((p) => (p.body as { embeds: { title: string }[] }).embeds[0]!.title);
    expect(titles).toEqual(['New request: The Matrix (1999)', 'Request approved: The Matrix (1999)']);
    expect(posts[0]!.headers['Authorization']).toBe('Bot bot-token');
  });

  it('posts "Now available" on completion and nothing without a channel', async () => {
    const h = await harness();
    h.ctx.bus.publish({ type: 'request', action: 'completed', id: await (async () => {
      const u = addUser(h.db);
      const out = await h.services.requests.create({ userId: u.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 604 });
      return out.kind === 'created' ? out.request.id : -1;
    })() });
    await h.bot.flush();
    const titles = h.rest.find('POST', /^\/channels\//).map((p) => (p.body as { embeds: { title: string }[] }).embeds[0]!.title);
    expect(titles).toContain('Now available: The Matrix Reloaded (2003)');

    const quiet = await harness({ settings: { requestChannelId: null } });
    const u = addUser(quiet.db);
    await quiet.services.requests.create({ userId: u.id, permissions: P.REQUEST }, { mediaType: 'movie', tmdbId: 603 });
    await quiet.bot.flush();
    expect(quiet.rest.find('POST', /^\/channels\//)).toHaveLength(0);
  });
});

describe('DiscordBotDisconnected health check', () => {
  const deps = {} as HealthDeps;

  it('passes while connected, warns after the grace period without a connection, and at once on a fatal error', async () => {
    const h = await harness();
    const check = discordBotHealthCheck(h.bot);
    expect(await check.run(deps)).toEqual([]);
    h.gateway.autoReady = false;
    h.gateway.last.drop(1006);
    expect(await check.run(deps)).toEqual([]);
    h.clock.now = new Date(h.clock.now.getTime() + DISCONNECTED_GRACE_MS + 1);
    const findings = await check.run(deps);
    expect(findings).toMatchObject([{ source: 'DiscordBotDisconnected', status: 'warning' }]);

    const bad = await harness();
    bad.gateway.last.drop(4004, 'Authentication failed.');
    expect(await discordBotHealthCheck(bad.bot).run(deps)).toMatchObject([{ message: expect.stringContaining('4004') }]);
    expect(bad.bot.status()).toMatchObject({ state: 'error', lastError: expect.stringContaining('Authentication failed') });
  });
});
