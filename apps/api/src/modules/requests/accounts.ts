import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  MediaBrowserClient,
  NotificationError,
  PlexServerClient,
  PlexTvClient,
  type FetchLike,
  type MediaServerAccount,
} from '@arclight/notifications';
import {
  MediaServerImportRequest,
  MediaServerLinkRequest,
  MediaServerSettings,
  REQUEST_SECRET_MASK,
  type LoginMethod,
  type MediaServerImportResult,
  type MediaServerKind,
  type MediaServerLink,
  type MediaServerTestResult,
  type MediaServerUser,
  type PlexPin,
  type UserRequestSettings,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { AuthError, hashPassword, type ExternalLoginProvider } from '../auth/index.js';
import { createMediaServerClient } from '@arclight/media-servers';
import { mediaServerView, saveMediaServerView } from '../media-servers/index.js';
import { RequestsError } from './errors.js';
import { DEFAULT_SERVER_NAMES } from './media-server.js';
import { canManageSettings, canManageUsers, type Actor } from './permissions.js';
import type { RequestsService } from './service.js';
import { allUserRows, mediaServerLinkOf, patchUserSettings, userRow, type UserRow } from './users.js';

// Media-server accounts (docs/spec/requests.md sections 2.3-2.4, adapted): the
// `mediaServer` view over Settings > Media servers (media-servers module; the first enabled server
// flagged loginEnabled), linking a local user to their Jellyfin/Emby/Plex account,
// signing in with that account (creating a local user on first sign-in), the Plex PIN flow
// and importing the server's users. Links live in users.settings.mediaServerLink.

export interface MediaServerAccountsOptions {
  db: Db;
  log?: Logger;
  requests: RequestsService;
  fetch?: FetchLike;
  /** plex.tv base URL (tests point it at a fake). */
  plexTvUrl?: string;
  now?: () => Date;
}

/** Stable per-account device id, so the server shows one device per user instead of one per login. */
export function deviceIdFor(kind: MediaServerKind, username: string): string {
  return `arclight-${createHash('sha256').update(`${kind}:${username.toLowerCase()}`).digest('hex').slice(0, 24)}`;
}

/** A username Arclight accepts: letters, digits and . _ @ - (others become _), at least 2 characters. */
export function localUsernameFrom(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned.length >= 2 ? cleaned : `user_${cleaned || 'media'}`;
}

function toRequestsError(err: unknown, what: string): RequestsError {
  if (err instanceof RequestsError) return err;
  if (err instanceof NotificationError) {
    if (err.code === 'unauthorized') return new RequestsError('FORBIDDEN', `${what}: the media server rejected the credentials`);
    if (err.code === 'invalidSettings') return new RequestsError('NOT_CONFIGURED', err.message);
    return new RequestsError('UPSTREAM', `${what}: ${err.message}`);
  }
  return new RequestsError('UPSTREAM', `${what}: ${err instanceof Error ? err.message : String(err)}`);
}

export class MediaServerAccounts implements ExternalLoginProvider {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly requests: RequestsService;
  private readonly fetchImpl: FetchLike;
  private readonly plexTv: PlexTvClient;
  private readonly now: () => Date;

  constructor(opts: MediaServerAccountsOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.requests = opts.requests;
    this.fetchImpl = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.plexTv = new PlexTvClient({ fetch: this.fetchImpl, ...(opts.plexTvUrl ? { baseUrl: opts.plexTvUrl } : {}) });
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // -------------------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------------------

  /** The single-server view over the media servers list. */
  stored(): MediaServerSettings {
    return mediaServerView(this.db);
  }

  private masked(s: MediaServerSettings): MediaServerSettings {
    return { ...s, apiKey: s.apiKey ? REQUEST_SECRET_MASK : '' };
  }

  settings(actor: Actor): MediaServerSettings {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    return this.masked(this.stored());
  }

  private merge(input: MediaServerSettings): MediaServerSettings {
    const parsed = MediaServerSettings.parse(input);
    const stored = this.stored();
    const apiKey = parsed.apiKey === REQUEST_SECRET_MASK ? stored.apiKey : parsed.apiKey.trim();
    const url = parsed.url.replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) throw new RequestsError('VALIDATION', 'the media server URL must start with http:// or https://');
    return { ...parsed, url, apiKey };
  }

  updateSettings(actor: Actor, input: MediaServerSettings): MediaServerSettings {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    // Compatibility: the old single-server route writes into the media servers list.
    return this.masked(saveMediaServerView(this.db, this.merge(input), this.iso()));
  }

  /** Tests the posted settings (masked key: the stored one) or, without a body, the stored ones. */
  async test(actor: Actor, input?: MediaServerSettings): Promise<MediaServerTestResult> {
    if (!canManageSettings(actor.permissions)) throw RequestsError.forbidden();
    const s = input ? this.merge(input) : this.stored();
    if (!s.kind || !s.url || !s.apiKey) return { ok: false, message: 'kind, URL and API key are required' };
    try {
      const info = await createMediaServerClient({ kind: s.kind, url: s.url, apiKey: s.apiKey, fetch: this.fetchImpl }).info();
      return { ok: true, serverName: info.name, ...(info.version ? { version: info.version } : {}) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private requireServer(kinds: readonly MediaServerKind[]): MediaServerSettings & { kind: MediaServerKind } {
    const s = this.stored();
    if (!s.kind || !s.url) throw new RequestsError('NOT_CONFIGURED', 'no media server is configured (Settings > Media server)');
    if (!kinds.includes(s.kind)) throw new RequestsError('VALIDATION', `the configured media server is ${DEFAULT_SERVER_NAMES[s.kind]}`);
    return s as MediaServerSettings & { kind: MediaServerKind };
  }

  private browser(s: MediaServerSettings & { kind: MediaServerKind }): MediaBrowserClient {
    if (s.kind === 'plex') throw new RequestsError('VALIDATION', 'not a Jellyfin/Emby server');
    return new MediaBrowserClient({ kind: s.kind, url: s.url, ...(s.apiKey ? { apiKey: s.apiKey } : {}), fetch: this.fetchImpl });
  }

  // -------------------------------------------------------------------------------------
  // local users behind media-server accounts
  // -------------------------------------------------------------------------------------

  /** Local user linked to this server account, if any. */
  linkedUser(kind: MediaServerKind, externalId: string): UserRow | undefined {
    // Jellyfin and Emby ids are both GUIDs of the same server family; match within the kind.
    return allUserRows(this.db).find((u) => {
      const link = mediaServerLinkOf(u);
      return link?.kind === kind && link.externalId === externalId;
    });
  }

  private freeUsername(base: string): string {
    const taken = new Set(allUserRows(this.db).map((u) => u.usernameKey));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}`;
    return candidate;
  }

  /** Creates a local `user` with the default permissions from Settings > Requests. */
  async createLinkedUser(account: MediaServerAccount, link: MediaServerLink): Promise<UserRow> {
    const username = this.freeUsername(localUsernameFrom(account.username));
    const now = this.iso();
    const settings: Record<string, unknown> = { mediaServerLink: link };
    if (link.kind === 'plex' && link.accessToken) settings['plexToken'] = link.accessToken;
    const row = this.db
      .insert(users)
      .values({
        username,
        usernameKey: username.toLowerCase(),
        // Media-server users sign in through the server; the local password is unguessable.
        passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
        displayName: account.username !== username ? account.username : null,
        email: account.email?.toLowerCase() ?? null,
        role: 'user',
        permissions: this.requests.settings().defaultPermissions,
        avatar: account.thumb ?? null,
        settings,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.log?.info({ userId: row.id, kind: link.kind, externalId: link.externalId }, 'created user from media server account');
    return row;
  }

  private saveLink(userId: number, link: MediaServerLink): void {
    const patch: Record<string, unknown> = { mediaServerLink: link };
    // The Plex watchlist provider reads plexToken; a Plex link keeps it current.
    if (link.kind === 'plex' && link.accessToken) patch['plexToken'] = link.accessToken;
    patchUserSettings(this.db, userId, patch, this.iso());
  }

  // -------------------------------------------------------------------------------------
  // per-user link
  // -------------------------------------------------------------------------------------

  async link(actor: Actor, userId: number, raw: MediaServerLinkRequest): Promise<UserRequestSettings> {
    if (actor.userId !== userId && !canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    userRow(this.db, userId);
    const body = MediaServerLinkRequest.parse(raw);
    let link: MediaServerLink;
    if ('pinId' in body) {
      const token = await this.plexTv.checkPin(body.pinId).catch((err: unknown) => {
        throw toRequestsError(err, 'Plex PIN');
      });
      if (!token) throw new RequestsError('VALIDATION', 'the Plex PIN has not been authorised yet');
      link = await this.plexLink(token);
    } else {
      const s = this.requireServer(['jellyfin', 'emby']);
      const deviceId = deviceIdFor(s.kind, body.username);
      const result = await this.browser(s)
        .authenticateByName(body.username, body.password, deviceId)
        .catch((err: unknown) => {
          throw toRequestsError(err, 'sign-in');
        });
      link = { kind: s.kind, externalId: result.account.id, username: result.account.username, accessToken: result.accessToken, deviceId, linkedAt: this.iso() };
    }
    const other = this.linkedUser(link.kind, link.externalId);
    if (other && other.id !== userId) throw new RequestsError('CONFLICT', `that ${DEFAULT_SERVER_NAMES[link.kind]} account is already linked to ${other.username}`);
    this.saveLink(userId, link);
    return this.requests.requestSettings(actor, userId);
  }

  private async plexLink(token: string): Promise<MediaServerLink> {
    const account = await this.plexTv.account(token).catch((err: unknown) => {
      throw toRequestsError(err, 'plex.tv account');
    });
    return { kind: 'plex', externalId: account.id, username: account.username, accessToken: token, linkedAt: this.iso() };
  }

  /**
   * POST /user/me/mediaserver/plex/poll: finishes a Plex PIN link for the signed-in user
   * (no sign-in, no session). Null while the PIN is not approved yet.
   */
  async plexLinkPoll(actor: Actor, pinId: number): Promise<UserRequestSettings | null> {
    if (actor.userId === null || actor.anonymous) throw new RequestsError('VALIDATION', 'this request is not signed in as a user');
    userRow(this.db, actor.userId);
    let token: string | null;
    try {
      token = await this.plexTv.checkPin(pinId);
    } catch (err) {
      throw toRequestsError(err, 'Plex PIN');
    }
    if (!token) return null;
    const link = await this.plexLink(token);
    const other = this.linkedUser('plex', link.externalId);
    if (other && other.id !== actor.userId) throw new RequestsError('CONFLICT', `that Plex account is already linked to ${other.username}`);
    this.saveLink(actor.userId, link);
    return this.requests.requestSettings(actor, actor.userId);
  }

  unlink(actor: Actor, userId: number): UserRequestSettings {
    if (actor.userId !== userId && !canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    const row = userRow(this.db, userId);
    const link = mediaServerLinkOf(row);
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { mediaServerLink: undefined };
    if (link?.kind === 'plex' && settings['plexToken'] === link.accessToken) patch['plexToken'] = undefined;
    patchUserSettings(this.db, userId, patch, this.iso());
    return this.requests.requestSettings(actor, userId);
  }

  // -------------------------------------------------------------------------------------
  // sign-in
  // -------------------------------------------------------------------------------------

  /** ExternalLoginProvider: Jellyfin/Emby username + password. */
  async login(method: Exclude<LoginMethod, 'local'>, username: string, password: string): Promise<number | null> {
    const s = this.stored();
    if (!s.kind || s.kind === 'plex' || !s.url) throw new AuthError('VALIDATION', 'Jellyfin/Emby sign-in is not configured');
    if (method !== 'mediaServer' && method !== s.kind) throw new AuthError('VALIDATION', `this server signs in with ${s.kind}, not ${method}`);
    if (!s.loginEnabled) throw new AuthError('FORBIDDEN', 'media server sign-in is disabled');
    const deviceId = deviceIdFor(s.kind, username);
    let result;
    try {
      result = await new MediaBrowserClient({ kind: s.kind, url: s.url, fetch: this.fetchImpl }).authenticateByName(username, password, deviceId);
    } catch (err) {
      if (err instanceof NotificationError && (err.code === 'unauthorized' || err.code === 'notFound')) return null;
      this.log?.warn({ err }, 'media server sign-in failed');
      throw new AuthError('VALIDATION', `could not reach the media server: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.account.isDisabled) throw new AuthError('FORBIDDEN', 'this media server account is disabled');
    const link: MediaServerLink = {
      kind: s.kind,
      externalId: result.account.id,
      username: result.account.username,
      accessToken: result.accessToken,
      deviceId,
      linkedAt: this.iso(),
    };
    const existing = this.linkedUser(s.kind, result.account.id);
    if (existing) {
      this.saveLink(existing.id, { ...link, linkedAt: mediaServerLinkOf(existing)?.linkedAt ?? link.linkedAt });
      return existing.id;
    }
    if (!s.createUsersOnLogin) throw new AuthError('FORBIDDEN', 'no Arclight account is linked to this media server account');
    return (await this.createLinkedUser(result.account, link)).id;
  }

  async plexPin(): Promise<PlexPin> {
    try {
      return await this.plexTv.createPin();
    } catch (err) {
      throw toRequestsError(err, 'plex.tv');
    }
  }

  /**
   * Finishes a Plex PIN sign-in: null while the user has not approved it. The account may
   * sign in when it is already linked, or (with a Plex server configured and new users
   * allowed) when it can reach that server; a new local user is created then.
   */
  async plexSignIn(pinId: number): Promise<number | null> {
    const s = this.stored();
    if (!s.loginEnabled) throw new RequestsError('FORBIDDEN', 'media server sign-in is disabled');
    let token: string | null;
    try {
      token = await this.plexTv.checkPin(pinId);
    } catch (err) {
      throw toRequestsError(err, 'plex.tv');
    }
    if (!token) return null;
    const account = await this.plexTv.account(token).catch((err: unknown) => {
      throw toRequestsError(err, 'plex.tv account');
    });
    const link: MediaServerLink = { kind: 'plex', externalId: account.id, username: account.username, accessToken: token, linkedAt: this.iso() };
    const existing = this.linkedUser('plex', account.id);
    if (existing) {
      this.saveLink(existing.id, { ...link, linkedAt: mediaServerLinkOf(existing)?.linkedAt ?? link.linkedAt });
      return existing.id;
    }
    if (s.kind !== 'plex' || !s.url || !s.apiKey) throw new RequestsError('FORBIDDEN', 'this Plex account is not linked to an Arclight user');
    if (!s.createUsersOnLogin) throw new RequestsError('FORBIDDEN', 'no Arclight account is linked to this Plex account');
    const machineId = await new PlexServerClient({ url: s.url, token: s.apiKey, fetch: this.fetchImpl })
      .info()
      .then((i) => i.id)
      .catch((err: unknown) => {
        throw toRequestsError(err, 'Plex server');
      });
    const reachable = await this.plexTv.serverIds(token).catch((err: unknown) => {
      throw toRequestsError(err, 'plex.tv resources');
    });
    if (!machineId || !reachable.includes(machineId)) throw new RequestsError('FORBIDDEN', 'this Plex account has no access to the Plex server');
    return (await this.createLinkedUser(account, link)).id;
  }

  // -------------------------------------------------------------------------------------
  // import
  // -------------------------------------------------------------------------------------

  private async serverAccounts(): Promise<{ kind: MediaServerKind; accounts: MediaServerAccount[] }> {
    const s = this.requireServer(['jellyfin', 'emby', 'plex']);
    if (!s.apiKey) throw new RequestsError('NOT_CONFIGURED', 'the media server API key is not configured');
    try {
      const accounts = s.kind === 'plex' ? await this.plexTv.friends(s.apiKey) : await this.browser(s).users();
      return { kind: s.kind, accounts };
    } catch (err) {
      throw toRequestsError(err, 'listing media server users');
    }
  }

  async listServerUsers(actor: Actor): Promise<MediaServerUser[]> {
    if (!canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    const { kind, accounts } = await this.serverAccounts();
    return accounts.map((a) => ({
      externalId: a.id,
      username: a.username,
      ...(a.email ? { email: a.email } : {}),
      isAdmin: a.isAdmin,
      isDisabled: a.isDisabled,
      linkedUserId: this.linkedUser(kind, a.id)?.id ?? null,
    }));
  }

  async importUsers(actor: Actor, raw: MediaServerImportRequest): Promise<MediaServerImportResult> {
    if (!canManageUsers(actor.permissions)) throw RequestsError.forbidden();
    const body = MediaServerImportRequest.parse(raw);
    const { kind, accounts } = await this.serverAccounts();
    const wanted = body.externalIds ? new Set(body.externalIds) : null;
    const result: MediaServerImportResult = { created: [], skipped: [] };
    if (wanted) {
      for (const id of wanted) if (!accounts.some((a) => a.id === id)) result.skipped.push({ externalId: id, reason: 'not on the media server' });
    }
    for (const account of accounts) {
      if (wanted && !wanted.has(account.id)) continue;
      if (this.linkedUser(kind, account.id)) {
        result.skipped.push({ externalId: account.id, reason: 'already linked' });
        continue;
      }
      if (account.isDisabled) {
        result.skipped.push({ externalId: account.id, reason: 'disabled on the media server' });
        continue;
      }
      const row = await this.createLinkedUser(account, { kind, externalId: account.id, username: account.username, linkedAt: this.iso() });
      result.created.push({ id: row.id, username: row.username, externalId: account.id });
    }
    return result;
  }

  /** For tests and diagnostics: the stored link of a user. */
  linkOf(userId: number): MediaServerLink | undefined {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    return row ? mediaServerLinkOf(row) : undefined;
  }
}
