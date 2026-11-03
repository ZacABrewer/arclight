import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { engineAgentServiceFor } from './index.js';

// DATA-18 through the real auth hook: the agent token opens /engine-agent/* and nothing else,
// and the settings that show it stay with sessions and admin-scoped keys.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

async function instance() {
  const db = await createTestDb();
  seedAdmin(db);
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
  await app.ready();
  open.push(app);
  const agent = engineAgentServiceFor(ctx!);
  agent.updateSettings({ enabled: true });
  return { app, agent, apiKey: authServiceFor(ctx!).apiKey() };
}

describe('engine agent token scope', () => {
  it('opens the agent routes and nothing else', async () => {
    const { app, agent, apiKey } = await instance();
    const token = agent.token();
    expect(token).not.toBe(apiKey);
    const status = await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status', headers: { 'x-agent-token': token } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ kind: 'arclight' });
    for (const [method, url] of [
      ['GET', '/api/v1/settings/security'],
      ['GET', '/api/v1/settings/engineagent'],
      ['POST', '/api/v1/settings/engineagent/token'],
      ['GET', '/api/v1/system/status'],
      ['GET', '/api/v1/series'],
      ['GET', '/api/v1/torrent/torrents'],
    ] as const) {
      for (const headers of [{ 'x-agent-token': token }, { 'x-api-key': token }, { authorization: `Bearer ${token}` }]) {
        const res = await app.inject({ method, url, headers });
        expect([method, url, Object.keys(headers)[0], res.statusCode]).toEqual([method, url, Object.keys(headers)[0], 401]);
      }
    }
  });

  it('refuses the API key on a new setup and accepts it, flagged, while acceptApiKey is on', async () => {
    const { app, agent, apiKey } = await instance();
    expect((await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status', headers: { 'x-api-key': apiKey } })).statusCode).toBe(401);
    agent.updateSettings({ acceptApiKey: true });
    const legacy = await app.inject({ method: 'GET', url: '/api/v1/engine-agent/status', headers: { 'x-api-key': apiKey, 'x-agent-token': apiKey } });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.headers['x-agent-deprecation']).toBe('api-key');
    // The admin reads the token from the settings with the API key or a session.
    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings/engineagent', headers: { 'x-api-key': apiKey } });
    expect(settings.json()).toMatchObject({ enabled: true, acceptApiKey: true, token: agent.token() });
  });
});
