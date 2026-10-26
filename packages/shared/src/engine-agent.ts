import { z } from 'zod';

// Arclight as a remote engine agent: other Arclights drive this instance's torrent engine
// through /api/v1/engine-agent/* (the agent protocol of @arclight/engine-agent), authenticated
// with this instance's API key. Off by default.

export const EngineAgentSettings = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "Let other Arclight instances use this instance's built-in torrent engine as a remote engine (API key required).",
    ),
});
export type EngineAgentSettings = z.infer<typeof EngineAgentSettings>;

/** PUT /settings/engineagent: any subset; omitted keys keep their stored value. */
export const EngineAgentSettingsUpdate = EngineAgentSettings.partial();
export type EngineAgentSettingsUpdate = z.infer<typeof EngineAgentSettingsUpdate>;

export const EngineAgentSettingsResponse = EngineAgentSettings.extend({
  /** Path other instances enter as the remote engine URL, after this instance's address. */
  path: z.string(),
  /** Whether the built-in torrent engine is running (the agent serves nothing otherwise). */
  engineRunning: z.boolean(),
});
export type EngineAgentSettingsResponse = z.infer<typeof EngineAgentSettingsResponse>;
