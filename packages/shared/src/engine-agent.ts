import { z } from 'zod';

// Arclight as a remote engine agent: other Arclights drive this instance's torrent engine
// through /api/v1/engine-agent/* (the agent protocol of @arclight/engine-agent), authenticated
// with this instance's agent token: a random secret that opens only those routes. Off by default.

export const EngineAgentSettings = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "Let other Arclight instances use this instance's built-in torrent engine as a remote engine (agent token required).",
    ),
  acceptApiKey: z
    .boolean()
    .default(false)
    .describe(
      "Also accept this instance's full API key as the token (deprecated). On for instances that already acted as remote engine before 0.24, so their remotes keep working; switch them to the agent token, then turn it off.",
    ),
});
export type EngineAgentSettings = z.infer<typeof EngineAgentSettings>;

/** PUT /settings/engineagent: any subset; omitted keys keep their stored value (no defaults here). */
export const EngineAgentSettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  acceptApiKey: z.boolean().optional(),
});
export type EngineAgentSettingsUpdate = z.infer<typeof EngineAgentSettingsUpdate>;

export const EngineAgentSettingsResponse = EngineAgentSettings.extend({
  /** Path other instances enter as the remote engine URL, after this instance's address. */
  path: z.string(),
  /** Whether the built-in torrent engine is running (the agent serves nothing otherwise). */
  engineRunning: z.boolean(),
  /** The agent token other instances enter (only GET /settings/engineagent, admin only). */
  token: z.string(),
  /** Last time (since this instance started) a remote signed in with the API key instead; null: none. */
  apiKeyLastUsedAt: z.string().nullable(),
});
export type EngineAgentSettingsResponse = z.infer<typeof EngineAgentSettingsResponse>;
