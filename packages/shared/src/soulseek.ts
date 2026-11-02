import { z } from 'zod';
import { SECRET_MASK } from './settings.js';

// Soulseek through slskd: an optional music source next to indexers and download clients.
// The user runs their own slskd instance (a Soulseek client daemon with a web API) and points
// Arclight at it; Arclight searches through it, queues the files of one peer's album folder and
// imports them when the transfers finish. Off by default. Routes under /api/v1/soulseek and
// /api/v1/settings/soulseek; all of them are admin-only and answer 404 MUSIC_DISABLED while
// music is off.

/** Settings section `soulseek`. */
export const SoulseekSettings = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().default(''),
  port: z.number().int().min(1).max(65535).default(5030),
  useSsl: z.boolean().default(false),
  urlBase: z.string().trim().default(''),
  /** One of slskd's configured API keys. */
  apiKey: z.string().default(''),
  /**
   * slskd's downloads directory as Arclight sees it (a path mapping: slskd usually runs in its
   * own container). Finished files land at `<downloadsPath>/<remote folder name>/<file>`.
   */
  downloadsPath: z.string().trim().default(''),
  /** How long slskd collects search responses. */
  searchTimeoutSeconds: z.number().int().min(5).max(120).default(15),
  /** Peers with a longer upload queue than this are skipped. */
  maxPeerQueue: z.number().int().min(0).max(10_000).default(50),
  /** Search wanted albums on a schedule and grab the best accepted folder. */
  autoSearch: z.boolean().default(false),
  /** Copy (keep slskd's copy, e.g. to share it back) or move finished files into the library. */
  importMode: z.enum(['copy', 'move']).default('copy'),
  /** Fail a download that has not finished after this many hours. */
  stalledHours: z.number().int().min(1).max(168).default(24),
});
export type SoulseekSettings = z.infer<typeof SoulseekSettings>;

/** GET /settings/soulseek: `apiKey` is SECRET_MASK when one is stored, '' otherwise. */
export const SoulseekSettingsResponse = SoulseekSettings;
export type SoulseekSettingsResponse = SoulseekSettings;

/** PUT /settings/soulseek. `apiKey` SECRET_MASK or omitted keeps the stored key, '' clears it. */
export const SoulseekSettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  host: z.string().trim().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useSsl: z.boolean().optional(),
  urlBase: z.string().trim().optional(),
  apiKey: z.string().optional(),
  downloadsPath: z.string().trim().optional(),
  searchTimeoutSeconds: z.number().int().min(5).max(120).optional(),
  maxPeerQueue: z.number().int().min(0).max(10_000).optional(),
  autoSearch: z.boolean().optional(),
  importMode: z.enum(['copy', 'move']).optional(),
  stalledHours: z.number().int().min(1).max(168).optional(),
});
export type SoulseekSettingsUpdate = z.infer<typeof SoulseekSettingsUpdate>;

export function maskSoulseekSettings(value: SoulseekSettings): SoulseekSettingsResponse {
  return { ...value, apiKey: value.apiKey ? SECRET_MASK : '' };
}

export function applySoulseekUpdate(current: SoulseekSettings, update: SoulseekSettingsUpdate): SoulseekSettings {
  const { apiKey, ...rest } = update;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return SoulseekSettings.parse({
    ...current,
    ...defined,
    apiKey: apiKey === undefined || apiKey === SECRET_MASK ? current.apiKey : apiKey.trim(),
  });
}

/** POST /soulseek/test: optional unsaved settings (a masked key uses the stored one). */
export const SoulseekTestRequest = SoulseekSettingsUpdate;
export const SoulseekTestResult = z.object({
  ok: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
  message: z.string(),
});
export type SoulseekTestResult = z.infer<typeof SoulseekTestResult>;

export const SoulseekFile = z.object({
  /** Full remote path as the peer shares it. */
  filename: z.string(),
  size: z.number().int(),
  bitRate: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  sampleRate: z.number().int().nullable(),
  lengthSeconds: z.number().nullable(),
});
export type SoulseekFile = z.infer<typeof SoulseekFile>;

export const SoulseekRejection = z.enum([
  'qualityNotAllowed',
  'notAnUpgrade',
  'tooFewTracks',
  'missingWantedTracks',
  'peerQueueTooLong',
  'mixedQuality',
]);
export type SoulseekRejection = z.infer<typeof SoulseekRejection>;

/** One peer's folder that looks like the album. */
export const SoulseekCandidate = z.object({
  username: z.string(),
  directory: z.string(),
  /** The folder's audio files, in track order. */
  files: z.array(SoulseekFile),
  totalSize: z.number().int(),
  qualityId: z.number().int(),
  qualityName: z.string(),
  matchedTracks: z.number().int(),
  wantedTracks: z.number().int(),
  totalTracks: z.number().int(),
  /** Track-match confidence 0..1. */
  confidence: z.number(),
  freeSlot: z.boolean(),
  queueLength: z.number().int(),
  /** Bytes per second the peer reports. */
  uploadSpeed: z.number(),
  score: z.number(),
  accepted: z.boolean(),
  rejections: z.array(SoulseekRejection),
});
export type SoulseekCandidate = z.infer<typeof SoulseekCandidate>;

export const SoulseekSearchRequest = z.object({
  albumId: z.number().int(),
  /** Overrides the "artist album" query. */
  query: z.string().trim().min(1).max(200).optional(),
});
export type SoulseekSearchRequest = z.infer<typeof SoulseekSearchRequest>;

export const SoulseekSearchResult = z.object({
  query: z.string(),
  candidates: z.array(SoulseekCandidate),
});
export type SoulseekSearchResult = z.infer<typeof SoulseekSearchResult>;

export const SoulseekGrabRequest = z.object({
  albumId: z.number().int(),
  username: z.string().min(1),
  directory: z.string(),
  files: z.array(z.object({ filename: z.string().min(1), size: z.number().int().min(0) })).min(1).max(500),
  qualityName: z.string().optional(),
});
export type SoulseekGrabRequest = z.infer<typeof SoulseekGrabRequest>;

export const SoulseekDownloadStatus = z.enum(['queued', 'downloading', 'importing', 'imported', 'failed', 'cancelled']);
export type SoulseekDownloadStatus = z.infer<typeof SoulseekDownloadStatus>;

export const SoulseekDownload = z.object({
  id: z.number().int(),
  albumId: z.number().int(),
  artistId: z.number().int(),
  albumTitle: z.string(),
  artistName: z.string(),
  username: z.string(),
  directory: z.string(),
  fileCount: z.number().int(),
  totalSize: z.number().int(),
  qualityName: z.string().nullable(),
  status: SoulseekDownloadStatus,
  /** 0..1 */
  progress: z.number(),
  message: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SoulseekDownload = z.infer<typeof SoulseekDownload>;

export const SoulseekAutoResult = z.object({
  grabbed: SoulseekDownload.nullable(),
  candidates: z.number().int(),
  message: z.string(),
});
export type SoulseekAutoResult = z.infer<typeof SoulseekAutoResult>;
