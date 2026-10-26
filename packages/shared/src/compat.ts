import { z } from 'zod';

// Compatibility API settings (the `compat` settings section). The compatibility API serves
// Sonarr-v3 and Radarr-v3 shaped endpoints under /api/v3 so third-party tools can talk to
// Media-Tron as if it were Sonarr or Radarr. The resource shapes themselves mirror those
// external contracts and live in apps/api/src/modules/compat; they are never consumed by the
// web app, so they are not duplicated here.

/** Version advertised in the `X-Application-Version` header (Prowlarr gates syncing on it). */
export const COMPAT_DEFAULT_ADVERTISED_VERSION = '4.0.4.0';

/** Stored form of the `compat` section; also the GET/PUT body of /api/v1/settings/compat. */
export const CompatSettings = z.object({
  /** Serve /api/v3 (and the /api, /ping, /initialize.json probes). Off: those answer 404. */
  enabled: z.boolean().default(true),
  /** Reported as `instanceName` by /api/v3/system/status. */
  instanceName: z.string().trim().min(1).max(100).default('Media-Tron'),
  /**
   * Version string sent in the `X-Application-Version` response header. Tools such as Prowlarr
   * refuse to sync unless it parses as a .NET version at or above the Sonarr/Radarr minimum.
   * `system/status.version` always reports the real Media-Tron version.
   */
  advertisedVersion: z
    .string()
    .regex(/^\d+\.\d+(\.\d+){0,2}$/, 'must look like 4.0.4.0')
    .default(COMPAT_DEFAULT_ADVERTISED_VERSION),
});
export type CompatSettings = z.infer<typeof CompatSettings>;
export type CompatSettingsInput = z.input<typeof CompatSettings>;
