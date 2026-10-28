import { z } from 'zod';
import { MediaServerKind } from './requests.js';

// Media servers (Settings > Media servers): a list of Jellyfin/Emby/Plex connections stored in
// the `mediaServers` settings section and served under /api/v1/mediaserver. Each connection
// says which features may use it (availability, retention, library refresh), so the requests
// module, retention sweeps and import refreshes can share one list. The list is the source of
// truth: the older single-server `mediaServer` shape (requests module: sign-in, user links and
// user import; GET/PUT /settings/mediaserver) is a view over the first enabled server flagged
// `loginEnabled` (else the first enabled server), and a stored legacy value is moved into the
// list once at boot.

/** One stored connection. `apiKey` is a Jellyfin/Emby API key or the Plex owner's X-Plex-Token. */
export const MediaServerConfig = z.object({
  id: z.string().min(1).max(64),
  kind: MediaServerKind,
  name: z.string().trim().min(1).max(100),
  /** Base URL including any URL base, e.g. http://jellyfin.lan:8096. */
  url: z.string().trim().min(1).max(2048),
  apiKey: z.string().max(512),
  enabled: z.boolean().default(true),
  /** "Is it on the server?" lookups for requests. */
  usedForAvailability: z.boolean().default(true),
  /** Watch history feeds the retention sweep. */
  usedForRetention: z.boolean().default(false),
  /** Rescanned after imports, renames and deletions. */
  usedForRefresh: z.boolean().default(false),
  /** Users may sign in with their account on this server (the first such server is used). */
  loginEnabled: z.boolean().default(false),
  /** A first sign-in through this server creates a local account. */
  createUsersOnLogin: z.boolean().default(false),
});
export type MediaServerConfig = z.infer<typeof MediaServerConfig>;

/** Stored form of the `mediaServers` settings section. */
export const MediaServersSettings = z.object({
  servers: z.array(MediaServerConfig).default([]),
});
export type MediaServersSettings = z.infer<typeof MediaServersSettings>;

/** GET /mediaserver, /mediaserver/:id. `apiKey` is SECRET_MASK when one is stored, '' otherwise. */
export const MediaServerResource = MediaServerConfig;
export type MediaServerResource = MediaServerConfig;

/**
 * POST /mediaserver, PUT /mediaserver/:id. On update, `apiKey` SECRET_MASK (or omitted) keeps
 * the stored key.
 */
export const MediaServerInput = z.object({
  kind: MediaServerKind,
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2048),
  apiKey: z.string().max(512).optional(),
  enabled: z.boolean().default(true),
  usedForAvailability: z.boolean().default(true),
  usedForRetention: z.boolean().default(false),
  usedForRefresh: z.boolean().default(false),
  loginEnabled: z.boolean().default(false),
  createUsersOnLogin: z.boolean().default(false),
});
export type MediaServerInput = z.infer<typeof MediaServerInput>;
export type MediaServerInputRaw = z.input<typeof MediaServerInput>;

/** POST /mediaserver/test (unsaved candidate; pass `id` to reuse a stored key) and /mediaserver/:id/test. */
export const MediaServerTestRequest = MediaServerInput.extend({ id: z.string().optional() });
export type MediaServerTestRequest = z.infer<typeof MediaServerTestRequest>;

/** What a media-server library holds. */
export const MediaServerLibraryType = z.enum(['movie', 'series', 'music', 'audiobook', 'other']);
export type MediaServerLibraryType = z.infer<typeof MediaServerLibraryType>;

/** One server's outcome of a post-import refresh (`MediaServersService.refreshPath`). */
export const MediaServerRefreshResult = z.object({
  serverId: z.string(),
  name: z.string(),
  status: z.enum(['refreshed', 'skipped', 'failed']),
  /** Libraries whose folders contain the path. */
  libraries: z.array(z.string()),
  message: z.string().optional(),
});
export type MediaServerRefreshResult = z.infer<typeof MediaServerRefreshResult>;

export const MediaServerProbeResult = z.object({
  ok: z.boolean(),
  serverName: z.string().optional(),
  version: z.string().optional(),
  /** Libraries the server reports, on success (Plex audiobooks sit in `music` sections). */
  libraries: z.array(z.object({ id: z.string(), name: z.string(), type: MediaServerLibraryType })).optional(),
  message: z.string().optional(),
  /** MediaServerError code on failure (unauthorized, network, timeout, ...). */
  code: z.string().optional(),
});
export type MediaServerProbeResult = z.infer<typeof MediaServerProbeResult>;

/** GET /mediaserver/:id/users. */
export const MediaServerAccountResource = z.object({
  id: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  isDisabled: z.boolean(),
  lastActivityAt: z.string().nullable(),
});
export type MediaServerAccountResource = z.infer<typeof MediaServerAccountResource>;

export const MediaServersErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type MediaServersErrorResponse = z.infer<typeof MediaServersErrorResponse>;
