import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AuthThrottle, EngineAgentCore, presentedToken, secretEquals } from '@arclight/engine-agent';
import { EngineAgentSettings, EngineAgentSettingsUpdate, type EngineAgentSettingsResponse } from '@arclight/shared';
import type { Session } from '@arclight/torrent-engine';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';

// Arclight as a remote engine agent. Another Arclight's `remoteEngine` download client drives
// this instance's built-in torrent engine through /api/v1/engine-agent/* (the agent protocol),
// authenticated with this instance's agent token (x-agent-token): a random secret that opens
// only those routes, never the rest of the API. The `engineAgent` settings row (off by default)
// gates every protocol route. The token has its own row (`engineAgentToken`), outside the
// settings sections, so config export never carries it and config import never replaces it.
//
// Upgrade from 0.23, where remotes used this instance's full API key: an instance that already
// had the agent enabled keeps `acceptApiKey` on, so those remotes keep working (in x-api-key as
// 0.23 clients send it, or in x-agent-token as 0.24 clients do). Every such request is answered
// with a deprecation header (the remote's Test shows a warning), logged at most hourly, and the
// settings page shows when it last happened, so the admin can switch the remote to the agent
// token and turn `acceptApiKey` off. New setups start with it off.

/** Settings-table key of this module's section. */
export const ENGINE_AGENT_SETTINGS_KEY = 'engineAgent';
/** Settings-table key of the agent token (not a settings section). */
export const ENGINE_AGENT_TOKEN_KEY = 'engineAgentToken';
/** Where the protocol is served, relative to the instance's base URL. */
export const ENGINE_AGENT_PATH = '/api/v1/engine-agent';

export class EngineAgentSettingsError extends Error {
  readonly code = 'VALIDATION';
  override readonly name = 'EngineAgentSettingsError';
}

export interface EngineAgentServiceOptions {
  db: Db;
  /** The built-in engine (null while it is stopped). */
  session: () => Session | null;
  /** Downloads root; agent save paths must stay inside it. */
  downloadsRoot: () => string;
  /** Whether a candidate is this instance's API key (the deprecated way in). */
  verifyApiKey?: (candidate: string) => boolean;
  /** Failed-auth back-off per client address. */
  throttle?: AuthThrottle;
  now?: () => Date;
}

/** Outcome of checking one protocol request's credentials. */
export type AgentAuthResult =
  | { ok: true; via: 'token' | 'api-key' }
  | { ok: false; status: 401 | 429; retryAfterSeconds?: number };

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export class EngineAgentService {
  readonly core: EngineAgentCore;
  private readonly throttle: AuthThrottle;
  private readonly now: () => Date;
  private apiKeyLastUsed: Date | null = null;
  private lastDeprecationLog = 0;

  constructor(private readonly opts: EngineAgentServiceOptions) {
    this.core = new EngineAgentCore({
      session: opts.session,
      downloadsRoot: opts.downloadsRoot,
      kind: 'arclight',
      // This instance's listen port belongs to its own torrent/VPN settings.
      portManaged: () => true,
    });
    this.throttle = opts.throttle ?? new AuthThrottle();
    this.now = opts.now ?? (() => new Date());
  }

  private put(key: string, value: Record<string, unknown>, now: string = this.now().toISOString()): void {
    this.opts.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }

  settings(): EngineAgentSettings {
    const row = this.opts.db.select().from(settings).where(eq(settings.key, ENGINE_AGENT_SETTINGS_KEY)).get();
    const raw: unknown = row?.value ?? {};
    const parsed = EngineAgentSettings.safeParse(raw);
    const value = parsed.success ? parsed.data : EngineAgentSettings.parse({});
    // A row from before 0.24 has no acceptApiKey: keep the API key working where the agent was on.
    if (row && typeof raw === 'object' && raw !== null && !('acceptApiKey' in raw)) value.acceptApiKey = value.enabled;
    return value;
  }

  private storedToken(): string | undefined {
    const row = this.opts.db.select().from(settings).where(eq(settings.key, ENGINE_AGENT_TOKEN_KEY)).get();
    const token = (row?.value as { token?: unknown } | undefined)?.token;
    return typeof token === 'string' && token.length >= 32 ? token : undefined;
  }

  enabled(): boolean {
    return this.settings().enabled;
  }

  /** The agent token, generated on first use. */
  token(): string {
    const existing = this.storedToken();
    if (existing) return existing;
    const created = newToken();
    this.put(ENGINE_AGENT_TOKEN_KEY, { token: created });
    return created;
  }

  /** Replaces the agent token; remotes using the old one are refused from now on. */
  regenerateToken(): EngineAgentSettingsResponse {
    this.put(ENGINE_AGENT_TOKEN_KEY, { token: newToken() });
    return this.response();
  }

  response(value: EngineAgentSettings = this.settings()): EngineAgentSettingsResponse {
    return {
      ...value,
      path: ENGINE_AGENT_PATH,
      engineRunning: this.opts.session() !== null,
      token: this.token(),
      apiKeyLastUsedAt: this.apiKeyLastUsed?.toISOString() ?? null,
    };
  }

  updateSettings(update: unknown, now: string = this.now().toISOString()): EngineAgentSettingsResponse {
    const patch = EngineAgentSettingsUpdate.safeParse(update);
    if (!patch.success) throw new EngineAgentSettingsError(patch.error.message);
    // The resolved acceptApiKey is written explicitly, so the pre-0.24 default applies only once.
    const value = EngineAgentSettings.parse({ ...this.settings(), ...patch.data });
    this.put(ENGINE_AGENT_SETTINGS_KEY, value, now);
    return this.response(value);
  }

  /**
   * Checks one protocol request: the agent token in x-agent-token (or Bearer), or, while
   * `acceptApiKey` is on, the API key there or as `apiKeyAuth` (the auth hook resolved
   * x-api-key). Repeated failures from one address are throttled.
   */
  authenticate(headers: Readonly<Record<string, string | string[] | undefined>>, address: string | undefined, apiKeyAuth: boolean): AgentAuthResult {
    const wait = this.throttle.retryAfterMs(address);
    if (wait > 0) return { ok: false, status: 429, retryAfterSeconds: Math.ceil(wait / 1000) };
    const presented = presentedToken(headers);
    const value = this.settings();
    const token = this.storedToken();
    if (token && secretEquals(presented, token)) {
      this.throttle.succeed(address);
      return { ok: true, via: 'token' };
    }
    if (value.acceptApiKey && (apiKeyAuth || (presented !== undefined && this.opts.verifyApiKey?.(presented) === true))) {
      this.throttle.succeed(address);
      this.apiKeyLastUsed = this.now();
      return { ok: true, via: 'api-key' };
    }
    this.throttle.fail(address);
    return { ok: false, status: 401 };
  }

  /** True at most once an hour: when to log that a remote still signs in with the API key. */
  shouldLogDeprecation(): boolean {
    const now = this.now().getTime();
    if (now - this.lastDeprecationLog < 60 * 60_000) return false;
    this.lastDeprecationLog = now;
    return true;
  }
}
