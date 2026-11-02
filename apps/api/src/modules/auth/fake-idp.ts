import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyObject } from 'jose';

// Test-only: a tiny OpenID Connect provider on 127.0.0.1 (discovery, authorize, token, JWKS,
// userinfo) so the sign-in flow runs over real HTTP with real signatures. Each test decides the
// claims, and can break the token on purpose (issuer, audience, expiry, key, nonce, alg).

export interface FakeIdpUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  groups?: string[];
}

export interface TokenTweaks {
  issuer?: string;
  audience?: string | string[];
  azp?: string;
  /** Seconds from now (negative: already expired). */
  expiresIn?: number;
  nonce?: string;
  /** Sign with a key the JWKS does not publish. */
  foreignKey?: boolean;
  /** An unsigned token (alg none). */
  unsigned?: boolean;
  /** userinfo answers for another subject. */
  userinfoSub?: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  user: FakeIdpUser;
}

export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Simulates the user signing in at the provider: returns the callback URL path + query. */
  authorize(authorizationUrl: string, user: FakeIdpUser, tweaks?: TokenTweaks): { callbackPath: string; state: string; code: string };
  /** Token requests seen (to check PKCE and client authentication). */
  tokenRequests: { authorization?: string | undefined; body: URLSearchParams }[];
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export async function startFakeIdp(opts: { clientId?: string; clientSecret?: string } = {}): Promise<FakeIdp> {
  const clientId = opts.clientId ?? 'arclight';
  const clientSecret = opts.clientSecret ?? 'test-client-secret';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode & { tweaks: TokenTweaks }>();
  const accessTokens = new Map<string, { user: FakeIdpUser; tweaks: TokenTweaks }>();
  const tokenRequests: FakeIdp['tokenRequests'] = [];
  let issuer = '';

  const sign = async (claims: Record<string, unknown>, tweaks: TokenTweaks): Promise<string> => {
    if (tweaks.unsigned) {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
      return `${header}.${b64url(Buffer.from(JSON.stringify(claims)))}.`;
    }
    const key = (tweaks.foreignKey ? foreign.privateKey : privateKey) as KeyObject;
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(key);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (url.pathname === '/userinfo') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const entry = accessTokens.get(token);
      if (!entry) return send(401, { error: 'invalid_token' });
      return send(200, { ...entry.user, sub: entry.tweaks.userinfoSub ?? entry.user.sub });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        void (async () => {
          const body = new URLSearchParams(raw);
          tokenRequests.push({ authorization: req.headers.authorization, body });
          const expectedBasic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
          if (req.headers.authorization !== expectedBasic) return send(401, { error: 'invalid_client' });
          const pending = codes.get(body.get('code') ?? '');
          codes.delete(body.get('code') ?? '');
          if (!pending) return send(400, { error: 'invalid_grant' });
          if (body.get('redirect_uri') !== pending.redirectUri) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri' });
          const verifier = body.get('code_verifier') ?? '';
          if (b64url(createHash('sha256').update(verifier).digest()) !== pending.challenge) return send(400, { error: 'invalid_grant', error_description: 'pkce' });
          const now = Math.floor(Date.now() / 1000);
          const t = pending.tweaks;
          const claims: Record<string, unknown> = {
            ...pending.user,
            iss: t.issuer ?? issuer,
            aud: t.audience ?? clientId,
            iat: now,
            exp: now + (t.expiresIn ?? 300),
            nonce: t.nonce ?? pending.nonce,
            ...(t.azp ? { azp: t.azp } : {}),
          };
          const accessToken = b64url(randomBytes(16));
          accessTokens.set(accessToken, { user: pending.user, tweaks: t });
          send(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: await sign(claims, t) });
        })();
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    tokenRequests,
    authorize(authorizationUrl, user, tweaks = {}) {
      const u = new URL(authorizationUrl);
      if (u.searchParams.get('client_id') !== clientId) throw new Error('fake idp: wrong client_id');
      if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('fake idp: PKCE S256 expected');
      const code = b64url(randomBytes(16));
      const redirectUri = u.searchParams.get('redirect_uri') ?? '';
      codes.set(code, {
        clientId,
        redirectUri,
        nonce: u.searchParams.get('nonce') ?? '',
        challenge: u.searchParams.get('code_challenge') ?? '',
        user,
        tweaks,
      });
      const state = u.searchParams.get('state') ?? '';
      const cb = new URL(redirectUri);
      cb.searchParams.set('code', code);
      cb.searchParams.set('state', state);
      return { callbackPath: `${cb.pathname}${cb.search}`, state, code };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
