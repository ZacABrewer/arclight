import { z } from 'zod';

/**
 * Settings of the `remoteEngine` client: Arclight's torrent engine running elsewhere (the
 * standalone engine agent or another Arclight). Must stay shape-identical to the shared
 * `RemoteEngineClientSettings` contract (the api checks this at compile time and at startup).
 */
export const RemoteEngineSettings = z.object({
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s/]+/i, 'Enter an http:// or https:// URL')
    .describe(
      'Address of the engine agent, e.g. http://seedbox:7879, or http://other-arclight:7878/api/v1/engine-agent for another Arclight.',
    ),
  token: z
    .string()
    .default('')
    .describe("The agent's AGENT_TOKEN (or the other Arclight's API key). Write-only: never returned by the API."),
  category: z
    .string()
    .trim()
    .default('arclight')
    .describe('Category Arclight assigns to its downloads, keeping them apart from everything else. Leave empty to not use one.'),
  postImportCategory: z
    .string()
    .trim()
    .optional()
    .describe('Category to move a download to after Arclight has imported it. Leave empty to keep it unchanged.'),
  pullMode: z
    .boolean()
    .default(false)
    .describe(
      'Copy finished downloads from the agent over HTTP into the local download folder (resumable, SHA-256 verified) before importing. Off: the agent shares storage with Arclight; add a Remote Path Mapping when the paths differ.',
    ),
  localDownloadPath: z
    .string()
    .trim()
    .default('')
    .describe('Pull mode: local folder finished downloads are copied into before import.'),
  bandwidthLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Pull mode: limit for copying from the agent in KiB/s. Leave empty or 0 for unlimited.'),
  followVpnPort: z
    .boolean()
    .default(false)
    .describe(
      "Apply this Arclight's VPN forwarded port to the agent's listener. Only for an agent behind the same VPN connection; an agent with its own VPN follows its own forwarded port (AGENT_PORT_FILE).",
    ),
});
export type RemoteEngineSettings = z.infer<typeof RemoteEngineSettings>;
export type RemoteEngineSettingsInput = z.input<typeof RemoteEngineSettings>;
