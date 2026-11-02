import { describe, expect, it } from 'vitest';
import { OIDC_BINDING_COOKIE } from './routes-identity.js';
import { buildAuthApp, cookieFrom } from './test-support.js';

// Runs the OpenID Connect sign-in against a real provider container. Off unless
// ARCLIGHT_OIDC_LIVE_ISSUER is set, e.g. with navikt/mock-oauth2-server:
//   docker run --rm -p 127.0.0.1:18089:8080 -e 'JSON_CONFIG={"interactiveLogin":false,"tokenCallbacks":[{"issuerId":"arclight",
//     "requestMappings":[{"requestParam":"grant_type","match":"authorization_code","claims":{"sub":"mock-user-1",
//     "aud":["arclight-test"],"email":"mock.user@example.com","email_verified":true,"preferred_username":"mockuser","groups":["family"]}}]}]}'
//     ghcr.io/navikt/mock-oauth2-server:2.1.10
//   ARCLIGHT_OIDC_LIVE_ISSUER=http://127.0.0.1:18089/arclight pnpm vitest run src/modules/auth/oidc-live.test.ts
const ISSUER = process.env['ARCLIGHT_OIDC_LIVE_ISSUER'];
const CLIENT_ID = process.env['ARCLIGHT_OIDC_LIVE_CLIENT_ID'] ?? 'arclight-test';

describe.skipIf(!ISSUER)('OpenID Connect against a live provider', () => {
  it('signs in end to end and creates the account', async () => {
    const { app } = await buildAuthApp();
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: 'password1' } });
    const cookie = cookieFrom(setup);
    await app.inject({ method: 'POST', url: '/api/v1/setup/complete', headers: { cookie }, payload: {} });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/identity',
      headers: { cookie },
      payload: { providers: [{ id: 'live', name: 'Live IdP', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'live-secret', autoCreate: true, allowedGroups: ['family'] }] },
    });
    expect(put.statusCode).toBe(200);

    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/live/start?returnTo=/portal' });
    expect(start.statusCode).toBe(302);
    // The provider signs the user in without a form and redirects back with a code.
    const authorize = await fetch(String(start.headers.location), { redirect: 'manual' });
    expect(authorize.status).toBe(302);
    const back = new URL(authorize.headers.get('location')!);
    expect(back.pathname).toBe('/api/v1/auth/oidc/live/callback');
    const cb = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: cookieFrom(start, OIDC_BINDING_COOKIE) } });
    expect(cb.headers.location).toBe('/portal');
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieFrom(cb) } });
    expect(me.json()).toMatchObject({ via: 'session', isAdmin: false, user: { username: 'mockuser', email: 'mock.user@example.com' } });

    // Replaying the provider's redirect fails.
    const replay = await app.inject({ method: 'GET', url: `${back.pathname}${back.search}`, headers: { cookie: cookieFrom(start, OIDC_BINDING_COOKIE) } });
    expect(String(replay.headers.location)).toContain('ssoError=state');
  });
});
