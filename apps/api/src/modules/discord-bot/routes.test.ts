import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { DISCORD_BOT_TOKEN_MASK } from '@arclight/shared';
import { authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import { healthServiceFor } from '../health/index.js';
import { addUser, setup } from '../requests/test-support.js';
import { discordBotModuleWith, discordBotServiceFor } from './index.js';
import { FakeGateway, fakeRest, saveSettings, waitFor } from './test-support.js';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function app(opts: { enabled?: boolean } = {}) {
  const h = await setup();
  const gateway = new FakeGateway();
  const rest = fakeRest();
  if (opts.enabled) saveSettings(h.db, {});
  const server = Fastify().withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(
    async (api) => {
      installAuth(api, h.ctx);
      await api.register(discordBotModuleWith({ webSocket: gateway.ctor, fetch: rest.fetch, baseDelayMs: 5, random: () => 0, sleep: async () => {} })(h.ctx));
    },
    { prefix: '/api/v1' },
  );
  await server.ready();
  closers.push(() => server.close());
  const auth = authServiceFor(h.ctx);
  const admin = addUser(h.db, { role: 'admin' });
  const user = addUser(h.db);
  const cookie = (id: number) => ({ cookie: `${SESSION_COOKIE}=${auth.createSession(id).token}` });
  return { ...h, server, gateway, rest, admin, user, adminH: cookie(admin.id), userH: cookie(user.id), bot: discordBotServiceFor(h.ctx) };
}

describe('discord bot routes', () => {
  it('settings are admin-only, mask the token, keep it when the mask comes back, and (re)start the bot', async () => {
    const h = await app();
    expect((await h.server.inject({ method: 'GET', url: '/api/v1/settings/discordbot', headers: h.userH })).statusCode).toBe(403);
    expect((await h.server.inject({ method: 'GET', url: '/api/v1/settings/discordbot' })).statusCode).toBe(401);
    const empty = await h.server.inject({ method: 'GET', url: '/api/v1/settings/discordbot', headers: h.adminH });
    expect(empty.json()).toEqual({ enabled: false, botToken: '', guildId: null, requestChannelId: null, adminRoleId: null });

    const noToken = await h.server.inject({ method: 'PUT', url: '/api/v1/settings/discordbot', headers: h.adminH, payload: { enabled: true } });
    expect(noToken.statusCode).toBe(400);
    const badId = await h.server.inject({ method: 'PUT', url: '/api/v1/settings/discordbot', headers: h.adminH, payload: { botToken: 'x', guildId: 'abc' } });
    expect(badId.statusCode).toBe(400);

    const saved = await h.server.inject({ method: 'PUT', url: '/api/v1/settings/discordbot', headers: h.adminH, payload: { enabled: true, botToken: 'tok-1', guildId: '12345' } });
    expect(saved.json()).toMatchObject({ enabled: true, botToken: DISCORD_BOT_TOKEN_MASK, guildId: '12345' });
    await waitFor(() => h.bot.status().state === 'connected');
    expect(h.gateway.last.ops(2)[0]!.d).toMatchObject({ token: 'tok-1' });

    await h.server.inject({ method: 'PUT', url: '/api/v1/settings/discordbot', headers: h.adminH, payload: { ...(saved.json() as Record<string, unknown>), requestChannelId: '67890' } });
    expect(h.bot.stored()).toMatchObject({ botToken: 'tok-1', requestChannelId: '67890' });
    await waitFor(() => h.gateway.sockets.length === 2 && h.bot.status().state === 'connected');
    expect(h.gateway.sockets[0]!.closedWith).toBe(1000);
  });

  it('GET /discordbot/status reports the connection; POST /discordbot/test checks the token and posts to the channel', async () => {
    const h = await app({ enabled: true });
    await waitFor(() => h.bot.status().commandsRegistered);
    const status = await h.server.inject({ method: 'GET', url: '/api/v1/discordbot/status', headers: h.adminH });
    expect(status.json()).toMatchObject({ enabled: true, state: 'connected', botUser: { id: '900' }, reconnectAttempts: 0, linkedUsers: 0 });
    expect((await h.server.inject({ method: 'GET', url: '/api/v1/discordbot/status', headers: h.userH })).statusCode).toBe(403);

    const test = await h.server.inject({ method: 'POST', url: '/api/v1/discordbot/test', headers: h.adminH });
    expect(test.json()).toEqual({ ok: true, botUser: { id: '900', username: 'arclight-bot' } });
    expect(h.rest.find('POST', /^\/channels\/22222\/messages$/)).toHaveLength(1);

    h.rest.overrides.push((c) => (c.path === '/users/@me' ? Response.json({ message: '401: Unauthorized' }, { status: 401 }) : undefined));
    const bad = await h.server.inject({ method: 'POST', url: '/api/v1/discordbot/test', headers: h.adminH, payload: { botToken: 'other', enabled: false } });
    expect(bad.json()).toMatchObject({ ok: false, message: expect.stringContaining('401') });
    expect(h.rest.calls.at(-1)!.headers['Authorization']).toBe('Bot other');
  });

  it('users create link codes for themselves and can unlink; API-key callers cannot', async () => {
    const h = await app();
    const res = await h.server.inject({ method: 'POST', url: '/api/v1/user/me/discord/link-code', headers: h.userH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{8}$/), linkedDiscordUserId: null });
    const apiKey = authServiceFor(h.ctx).apiKey();
    const viaKey = await h.server.inject({ method: 'POST', url: '/api/v1/user/me/discord/link-code', headers: { 'x-api-key': apiKey } });
    expect(viaKey.statusCode).toBe(400);
    expect((await h.server.inject({ method: 'POST', url: '/api/v1/user/me/discord/link-code' })).statusCode).toBe(401);

    const code = h.bot.createLinkCode(h.user.id).code;
    expect(code).not.toBe(res.json().code);
    const del = await h.server.inject({ method: 'DELETE', url: '/api/v1/user/me/discord/link', headers: h.userH });
    expect(del.statusCode).toBe(204);
    expect(h.bot.discordIdOf(h.user.id)).toBeNull();
  });

  it('registers the DiscordBotDisconnected health check and stops the bot on close', async () => {
    const h = await app({ enabled: true });
    await waitFor(() => h.bot.status().state === 'connected');
    const health = healthServiceFor(h.ctx) as unknown as { checks: { id: string }[] };
    expect(health.checks.some((c) => c.id === 'DiscordBotDisconnected')).toBe(true);
    await h.server.close();
    expect(health.checks.some((c) => c.id === 'DiscordBotDisconnected')).toBe(false);
    expect(h.gateway.last.closedWith).toBe(1000);
    expect(h.bot.status().state).toBe('disabled');
  });
});
