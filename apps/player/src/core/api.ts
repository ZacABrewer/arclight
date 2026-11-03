import { z } from 'zod';
import {
  AppDeviceCode,
  AppDeviceCodePollResponse,
  AppSignInResponse,
  ArtworkLinkResponse,
  ErrorResponse,
  PlayableItem,
  PLAYBACK_ITEMS_MAX,
  PlayerCapabilities,
  PROGRESS_BATCH_MAX,
  ProgressBatchResponse,
  StreamLinksResponse,
  User,
  type AppDeviceCodeRequest,
  type AppDeviceInfo,
  type AppPairRequest,
  type AppPlatform,
  type AppSignInRequest,
  type ProgressBeacon,
  type ProgressReport,
  type StreamFormat,
} from '@arclight/shared';
// The web client's error classes: the web player's views check `instanceof` against these.
import { ApiError, ContractError, type QueryParams, type RequestOptions } from '@web/api/client';
import { t } from '@web/i18n/index';
import { CONNECT_TIMEOUT_MS } from '../config';
import { absoluteUrl, getSession } from './session';

export { ApiError, ContractError };
export type { QueryParams, RequestOptions };
// The app-auth and playback contracts come from @arclight/shared; re-exported for the app's modules.
export { AppSignInResponse, ArtworkLinkResponse, PLAYBACK_ITEMS_MAX, PROGRESS_BATCH_MAX, ProgressBatchResponse };
export type { AppDeviceInfo, AppPairRequest, AppPlatform, AppSignInRequest };

// The one way the app talks to an Arclight server: `${serverUrl}/api/v1${path}` with the device
// token as `Authorization: Bearer`. No cookies (the app's pages are on another origin). Every
// response is parsed against its Zod schema, like the web client, and image URLs in it are made
// loadable by an <img> (see "Artwork" below).

/** Where a request goes: the active session by default. `token: null` for sign-in and pairing. */
export interface Target {
  serverUrl: string;
  token: string | null;
}

export interface AppRequestOptions extends RequestOptions {
  target?: Target;
  timeoutMs?: number;
}

/** Thrown when the server could not be reached at all (status 0). */
export const NETWORK_ERROR = 'NETWORK';

type UnauthorizedHandler = (path: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Called when a signed-in request answers 401: the device was removed or the token revoked. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

// Picking a profile answers 401 pin-required / pin-wrong for a missing or wrong PIN: a pad error,
// not a revoked token.
const PROFILE_SELECT = /^\/households\/profiles\/\d+\/select$/;

function triggersSignOut(path: string): boolean {
  return (
    !path.startsWith('/auth/') && !path.startsWith('/app/') && path !== '/user/me/password' && !path.startsWith('/user/me/2fa') && !PROFILE_SELECT.test(path)
  );
}

let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Tests: replace fetch. */
export function setFetch(impl: typeof fetch | null): void {
  fetchImpl = impl ?? ((...args) => fetch(...args));
}

function currentTarget(): Target {
  const s = getSession();
  if (!s) throw new ApiError(401, 'Not signed in', '', 'NOT_SIGNED_IN');
  return { serverUrl: s.serverUrl, token: s.token };
}

export function buildApiUrl(serverUrl: string, path: string, query?: QueryParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${serverUrl.replace(/\/+$/, '')}/api/v1${path}${s ? `?${s}` : ''}`;
}

export async function request<T extends z.ZodType>(path: string, schema: T, init?: AppRequestOptions): Promise<z.infer<T>>;
export async function request(path: string, schema: null, init?: AppRequestOptions): Promise<void>;
export async function request(path: string, schema: z.ZodType | null, init: AppRequestOptions = {}): Promise<unknown> {
  const { json, query, headers, body: rawBody, target: explicit, timeoutMs = CONNECT_TIMEOUT_MS, signal, ...rest } = init;
  const target = explicit ?? currentTarget();
  const url = buildApiUrl(target.serverUrl, path, query);
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.has('accept')) finalHeaders.set('accept', 'application/json');
  if (target.token) finalHeaders.set('authorization', `Bearer ${target.token}`);
  let body: BodyInit | null = rawBody ?? null;
  if (json !== undefined) {
    finalHeaders.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, credentials: 'omit', headers: finalHeaders, body, signal: ctl.signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    const timedOut = ctl.signal.aborted;
    const host = hostOf(target.serverUrl);
    const message = timedOut
      ? t('app.error.serverTimeout', { host, seconds: Math.round(timeoutMs / 1000) })
      : t('app.error.serverUnreachable', { host });
    const error = new ApiError(0, message, path, NETWORK_ERROR);
    if (timedOut) timedOutErrors.add(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }

  if (res.status === 401 && target.token && !explicit && onUnauthorized && triggersSignOut(path)) onUnauthorized(path);
  if (!res.ok) throw await toApiError(res, path);
  if (schema === null || res.status === 204) return undefined;

  const data: unknown = await res.json();
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ContractError(path, parsed.error.issues);
  if (target.token && hasArtwork(parsed.data)) {
    const query = await artworkQuery(target).catch(() => null);
    return rewriteArtwork(parsed.data, target.serverUrl, query);
  }
  return parsed.data;
}

async function toApiError(res: Response, path: string): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  let body: unknown;
  try {
    body = await res.json();
    const parsed = ErrorResponse.safeParse(body);
    if (parsed.success) {
      message = parsed.data.error;
      code = parsed.data.code;
    }
  } catch {
    // Empty or not JSON: keep the status text.
  }
  const err = new ApiError(res.status, message, path, code);
  // The whole JSON body, for routes that add fields (households: retryAfterSeconds).
  if (body !== undefined) errorBodies.set(err, body);
  return err;
}

const errorBodies = new WeakMap<ApiError, unknown>();

/** The JSON body a failed request answered with (undefined: none, or not an ApiError). */
export function apiErrorBody(err: unknown): unknown {
  return err instanceof ApiError ? errorBodies.get(err) : undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === NETWORK_ERROR;
}

const timedOutErrors = new WeakSet<object>();

/** A network error because the server did not answer within the connect timeout. */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof ApiError && timedOutErrors.has(err);
}

/**
 * The app's query retry: one more try, except after a connect timeout (another wait as long
 * would only delay the "couldn't reach" message).
 */
export function retryUnlessUnreachable(failureCount: number, err: unknown): boolean {
  return failureCount < 1 && !isTimeoutError(err);
}

// ---------------------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------------------
// The server answers image paths ("/api/v1/playback/artwork/album/12"), guarded like the rest of
// the API. An <img> cannot send the Bearer token, so POST /playback/artwork-link hands out a
// signed query (`u=&exp=&sig=`) that opens every artwork URL of this user until it expires.
// Responses get absolute artwork URLs with that query; when it is renewed, the app refetches.

const ARTWORK_PATH = '/api/v1/playback/artwork/';
/** Renew the query this long before it expires. */
const ARTWORK_RENEW_MS = 30 * 60_000;

interface ArtworkLinkState {
  key: string;
  query: string;
  expiresAt: number;
}
let artworkLink: ArtworkLinkState | null = null;
let artworkPending: { key: string; promise: Promise<string> } | null = null;
const artworkListeners = new Set<() => void>();

/** Called when the artwork query was renewed (cached responses still carry the old one). */
export function onArtworkLinkRenewed(listener: () => void): () => void {
  artworkListeners.add(listener);
  return () => artworkListeners.delete(listener);
}

/** Tests / sign-out. */
export function resetArtworkLink(): void {
  artworkLink = null;
  artworkPending = null;
}

async function artworkQuery(target: Target): Promise<string> {
  const key = `${target.serverUrl}|${target.token ?? ''}`;
  if (artworkLink && artworkLink.key === key && artworkLink.expiresAt - Date.now() > ARTWORK_RENEW_MS) return artworkLink.query;
  if (artworkPending?.key === key) return artworkPending.promise;
  const renewing = artworkLink?.key === key;
  const promise = request('/playback/artwork-link', ArtworkLinkResponse, { method: 'POST', target: { ...target } })
    .then((r) => {
      artworkLink = { key, query: r.query, expiresAt: Date.parse(r.expiresAt) || Date.now() + 3600_000 };
      if (renewing) for (const l of [...artworkListeners]) l();
      return r.query;
    })
    .finally(() => {
      if (artworkPending?.promise === promise) artworkPending = null;
    });
  artworkPending = { key, promise };
  return promise;
}

function isArtworkPath(v: string): boolean {
  return v.startsWith('/') && v.includes(ARTWORK_PATH);
}

function hasArtwork(data: unknown, depth = 0): boolean {
  if (depth > 12 || data === null || typeof data !== 'object') return typeof data === 'string' && isArtworkPath(data);
  if (Array.isArray(data)) return data.some((v) => hasArtwork(v, depth + 1));
  return Object.values(data as Record<string, unknown>).some((v) => hasArtwork(v, depth + 1));
}

/** Every artwork path in `data` made absolute (and signed, when there is a query). Other values are untouched. */
export function rewriteArtwork<T>(data: T, serverUrl: string, query: string | null): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      if (!isArtworkPath(v)) return v;
      const abs = absoluteUrl(v, serverUrl);
      return query ? `${abs}${abs.includes('?') ? '&' : '?'}${query}` : abs;
    }
    if (depth > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(data, 0) as T;
}

// ---------------------------------------------------------------------------------------
// App sign-in and playback calls
// ---------------------------------------------------------------------------------------

/** Error codes the sign-in screens tell apart. */
export const SIGN_IN_ERRORS = {
  totpRequired: 'TOTP_REQUIRED',
  invalidTotp: 'TOTP_INVALID',
  invalidCredentials: 'INVALID_CREDENTIALS',
  rateLimited: 'RATE_LIMITED',
  pairInvalid: 'PAIR_CODE_INVALID',
  pairExpired: 'PAIR_CODE_EXPIRED',
  playerDisabled: 'PLAYER_DISABLED',
  playerNotAllowed: 'PLAYER_NOT_ALLOWED',
  /** 403: this server only lets the app in with a QR pairing code from the web player. */
  pairingRequired: 'PAIRING_REQUIRED',
  /** 403: the account must turn on two-factor (in a browser) before signing in. */
  twoFactorSetupRequired: 'TWO_FACTOR_SETUP_REQUIRED',
} as const;

const enc = encodeURIComponent;

export const appApi = {
  signIn: (serverUrl: string, body: AppSignInRequest) =>
    request('/app/sign-in', AppSignInResponse, { method: 'POST', json: body, target: { serverUrl, token: null } }),
  pair: (serverUrl: string, body: AppPairRequest) => request('/app/pair', AppSignInResponse, { method: 'POST', json: body, target: { serverUrl, token: null } }),
  /** TV sign-in: a code the user confirms in a browser (/player/link). */
  deviceCode: (serverUrl: string, body: AppDeviceCodeRequest) =>
    request('/app/device-codes', AppDeviceCode, { method: 'POST', json: body, target: { serverUrl, token: null } }),
  deviceCodePoll: (serverUrl: string, pollToken: string) =>
    request('/app/device-codes/poll', AppDeviceCodePollResponse, { method: 'POST', json: { pollToken }, target: { serverUrl, token: null } }),
  /** Ends this device's token on the server. */
  signOut: (target: Target) => request('/app/sign-out', null, { method: 'POST', target }),
  me: (target?: Target) => request('/user/me', User, target ? { target } : {}),
  capabilities: (target?: Target) => request('/playback/me', PlayerCapabilities, target ? { target } : {}),
};

export interface StreamLinkOptions {
  format?: StreamFormat;
  bitrateKbps?: number;
  /** Links that answer as a file download (offline copies). */
  download?: boolean;
}

export const appPlaybackApi = {
  item: (itemKey: string) => request(`/playback/item/${enc(itemKey)}`, PlayableItem),
  /** Up to 200 items in one call (queues, downloads). */
  items: (itemKeys: readonly string[]) =>
    request('/playback/items', z.array(PlayableItem), { method: 'POST', json: { itemKeys: itemKeys.slice(0, PLAYBACK_ITEMS_MAX) } }),
  streamLinks: (itemKey: string, opts: StreamLinkOptions = {}) =>
    request('/playback/stream-links', StreamLinksResponse, {
      method: 'POST',
      json: { itemKey, format: opts.format ?? 'original', ...(opts.bitrateKbps ? { bitrateKbps: opts.bitrateKbps } : {}), ...(opts.download ? { download: true } : {}) },
    }),
  report: (itemKey: string, body: ProgressReport, target?: Target) =>
    request(`/playback/progress/${enc(itemKey)}`, null, { method: 'PUT', json: body, ...(target ? { target } : {}) }),
  progressBatch: (reports: readonly ProgressBeacon[], target?: Target) =>
    request('/playback/progress/batch', ProgressBatchResponse, { method: 'POST', json: { reports }, ...(target ? { target } : {}) }),
};
