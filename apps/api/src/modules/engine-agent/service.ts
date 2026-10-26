import { eq } from 'drizzle-orm';
import { EngineAgentCore } from '@arclight/engine-agent';
import { EngineAgentSettings, EngineAgentSettingsUpdate, type EngineAgentSettingsResponse } from '@arclight/shared';
import type { Session } from '@arclight/torrent-engine';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';

// Arclight as a remote engine agent. Another Arclight's `remoteEngine` download client drives
// this instance's built-in torrent engine through /api/v1/engine-agent/* (the agent protocol),
// authenticated with this instance's API key. The `engineAgent` settings row (off by default)
// gates every protocol route.

/** Settings-table key of this module's section. */
export const ENGINE_AGENT_SETTINGS_KEY = 'engineAgent';
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
}

export class EngineAgentService {
  readonly core: EngineAgentCore;

  constructor(private readonly opts: EngineAgentServiceOptions) {
    this.core = new EngineAgentCore({
      session: opts.session,
      downloadsRoot: opts.downloadsRoot,
      kind: 'arclight',
      // This instance's listen port belongs to its own torrent/VPN settings.
      portManaged: () => true,
    });
  }

  settings(): EngineAgentSettings {
    const row = this.opts.db.select().from(settings).where(eq(settings.key, ENGINE_AGENT_SETTINGS_KEY)).get();
    const parsed = EngineAgentSettings.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : EngineAgentSettings.parse({});
  }

  enabled(): boolean {
    return this.settings().enabled;
  }

  response(value: EngineAgentSettings = this.settings()): EngineAgentSettingsResponse {
    return { ...value, path: ENGINE_AGENT_PATH, engineRunning: this.opts.session() !== null };
  }

  updateSettings(update: unknown, now: string = new Date().toISOString()): EngineAgentSettingsResponse {
    const patch = EngineAgentSettingsUpdate.safeParse(update);
    if (!patch.success) throw new EngineAgentSettingsError(patch.error.message);
    const value = EngineAgentSettings.parse({ ...this.settings(), ...patch.data });
    this.opts.db
      .insert(settings)
      .values({ key: ENGINE_AGENT_SETTINGS_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
    return this.response(value);
  }
}
