import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// A small OpenID Connect relying party: discovery, the authorization-code flow with PKCE (S256),
// state and nonce, the token exchange and ID token validation (signature through the provider's
// JWKS, issuer, audience, authorized party, expiry, nonce). Only what Arclight needs; the
// account mapping lives in identity.ts.

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/** Why a sign-in failed; maps to the ssoError code the login page shows. */
export type OidcFailure = 'state' | 'provider' | 'token' | 'no_account' | 'forbidden' | 'disabled' | 'link_conflict';

export class OidcError extends Error {
  constructor(
    readonly failure: OidcFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ASYMMETRIC_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA', 'Ed25519'];
const HMAC_ALGS = ['HS256', 'HS384', 'HS512'];
const HTTP_TIMEOUT_MS = 10_000;
/** Seconds of clock difference accepted on exp / iat / nbf. */
export const CLOCK_TOLERANCE_SECONDS = 60;

const WELL_KNOWN = '/.well-known/openid-configuration';

/** The issuer a configured URL stands for (the URL itself, or the discovery URL without its suffix). */
export function issuerOf(configured: string): string {
  const trimmed = configured.trim();
  return trimmed.endsWith(WELL_KNOWN) ? trimmed.slice(0, -WELL_KNOWN.length) : trimmed;
}

export function discoveryUrlOf(configured: string): string {
  const trimmed = configured.trim();
  if (trimmed.endsWith(WELL_KNOWN)) return trimmed;
  return `${trimmed.replace(/\/+$/, '')}${WELL_KNOWN}`;
}

/** Issuers compare exactly, except for one trailing slash (providers differ in how they print it). */
export function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

export function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** RFC 7636 S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

async function getJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(`${url}: ${err}`);
  }
  if (body === null || typeof body !== 'object') throw new Error(`${url}: not a JSON object`);
  return body;
}

function requireUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) throw new Error(`discovery document has no valid ${name}`);
  return value;
}

/** Fetches and checks a discovery document; its `issuer` must be the configured one. */
export async function discover(fetchImpl: FetchLike, configured: string): Promise<OidcDiscovery> {
  const body = (await getJson(fetchImpl, discoveryUrlOf(configured))) as Record<string, unknown>;
  const issuer = typeof body['issuer'] === 'string' ? body['issuer'] : '';
  if (!issuer || !sameIssuer(issuer, issuerOf(configured))) {
    throw new Error(`discovery issuer "${issuer}" does not match the configured issuer "${issuerOf(configured)}"`);
  }
  const doc: OidcDiscovery = {
    issuer,
    authorization_endpoint: requireUrl(body['authorization_endpoint'], 'authorization_endpoint'),
    token_endpoint: requireUrl(body['token_endpoint'], 'token_endpoint'),
    jwks_uri: requireUrl(body['jwks_uri'], 'jwks_uri'),
  };
  if (typeof body['userinfo_endpoint'] === 'string') doc.userinfo_endpoint = body['userinfo_endpoint'];
  for (const key of ['id_token_signing_alg_values_supported', 'token_endpoint_auth_methods_supported', 'code_challenge_methods_supported'] as const) {
    const v = body[key];
    if (Array.isArray(v)) doc[key] = v.filter((x): x is string => typeof x === 'string');
  }
  return doc;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** `openid` first, no duplicates. */
export function scopeList(scopes: string): string {
  const parts = scopes.split(/\s+/).filter((s) => s !== '' && s !== 'openid');
  return ['openid', ...new Set(parts)].join(' ');
}

export function authorizationUrl(doc: OidcDiscovery, req: AuthorizationRequest): string {
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', req.clientId);
  url.searchParams.set('redirect_uri', req.redirectUri);
  url.searchParams.set('scope', scopeList(req.scopes));
  url.searchParams.set('state', req.state);
  url.searchParams.set('nonce', req.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(req.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface TokenRequest {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export interface TokenSet {
  idToken: string;
  accessToken?: string;
}

/** Exchanges the code (client_secret_basic when a secret is set and allowed, else _post, else public). */
export async function exchangeCode(fetchImpl: FetchLike, doc: OidcDiscovery, req: TokenRequest): Promise<TokenSet> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: req.code, redirect_uri: req.redirectUri, code_verifier: req.codeVerifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  if (req.clientSecret) {
    if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
      // RFC 6749 2.3.1: both parts are form-urlencoded before base64.
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
      headers['authorization'] = `Basic ${Buffer.from(`${enc(req.clientId)}:${enc(req.clientSecret)}`).toString('base64')}`;
    } else {
      form.set('client_id', req.clientId);
      form.set('client_secret', req.clientSecret);
    }
  } else {
    form.set('client_id', req.clientId);
  }
  const body = (await getJson(fetchImpl, doc.token_endpoint, { method: 'POST', headers, body: form.toString() })) as Record<string, unknown>;
  const idToken = body['id_token'];
  if (typeof idToken !== 'string' || idToken === '') throw new Error('token response has no id_token');
  const out: TokenSet = { idToken };
  if (typeof body['access_token'] === 'string') out.accessToken = body['access_token'];
  return out;
}

export interface IdTokenCheck {
  issuer: string;
  clientId: string;
  clientSecret: string;
  nonce: string;
  /** Algorithms the provider advertises; asymmetric ones (and HS* with a client secret) are accepted. */
  advertisedAlgs?: string[] | undefined;
  now?: Date;
}

export function acceptedAlgs(advertised: string[] | undefined, hasSecret: boolean): string[] {
  const allowed = [...ASYMMETRIC_ALGS, ...(hasSecret ? HMAC_ALGS : [])];
  const list = (advertised && advertised.length > 0 ? advertised : ['RS256']).filter((a) => allowed.includes(a));
  return list.length > 0 ? list : ['RS256'];
}

export interface IdTokenClaims extends JWTPayload {
  sub: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  preferred_username?: string;
  azp?: string;
  [claim: string]: unknown;
}

/**
 * Verifies an ID token (OpenID Connect Core 3.1.3.7): signature from the JWKS (or the client
 * secret for HS*), never `none`; iss exact; aud contains the client id and, with several
 * audiences, azp is the client; exp in the future and iat present (60 s tolerance); nonce equals
 * the one sent; sub present.
 */
export async function verifyIdToken(token: string, keys: JWTVerifyGetKey, check: IdTokenCheck): Promise<IdTokenClaims> {
  const algorithms = acceptedAlgs(check.advertisedAlgs, check.clientSecret !== '');
  const header = decodeHeader(token);
  const options = {
    issuer: check.issuer,
    audience: check.clientId,
    algorithms,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    requiredClaims: ['exp', 'iat', 'sub'],
    ...(check.now ? { currentDate: check.now } : {}),
  };
  let payload: JWTPayload;
  try {
    if (typeof header.alg === 'string' && HMAC_ALGS.includes(header.alg)) {
      if (!check.clientSecret) throw new Error('HMAC-signed ID token without a client secret');
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(check.clientSecret), options));
    } else {
      ({ payload } = await jwtVerify(token, keys, options));
    }
  } catch (err) {
    throw new OidcError('token', `ID token rejected: ${describeJoseError(err)}`);
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') throw new OidcError('token', 'ID token has no subject');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((aud.length > 1 || payload['azp'] !== undefined) && payload['azp'] !== check.clientId) throw new OidcError('token', 'ID token azp is not this client');
  if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== check.nonce) throw new OidcError('token', 'ID token nonce does not match');
  return payload as IdTokenClaims;
}

function decodeHeader(token: string): { alg?: unknown } {
  const first = token.split('.')[0] ?? '';
  try {
    return JSON.parse(Buffer.from(first, 'base64url').toString('utf8')) as { alg?: unknown };
  } catch {
    throw new OidcError('token', 'ID token is not a JWT');
  }
}

function describeJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) return `claim ${err.claim} invalid (${err.reason})`;
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'bad signature';
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'signing algorithm not allowed';
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'no matching signing key';
  return err instanceof Error ? err.message : String(err);
}

/** Userinfo claims; `sub` must equal the ID token's. */
export async function fetchUserinfo(fetchImpl: FetchLike, doc: OidcDiscovery, accessToken: string, subject: string): Promise<Record<string, unknown>> {
  if (!doc.userinfo_endpoint) return {};
  const body = (await getJson(fetchImpl, doc.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } })) as Record<string, unknown>;
  if (body['sub'] !== subject) throw new OidcError('token', 'userinfo subject does not match the ID token');
  return body;
}

/** Remote JWKS (cached and refreshed by jose on unknown key ids). */
export function remoteKeys(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: HTTP_TIMEOUT_MS, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
}

/** A claim as a list of strings (groups may be an array, or a comma/pipe separated string). */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,|]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

/** `email_verified` true (some providers send the string "true"). */
export function emailVerified(claims: Record<string, unknown>): boolean {
  const v = claims['email_verified'];
  return v === true || v === 'true';
}
