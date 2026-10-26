import { z } from 'zod';

// Private-tracker helpers (tracker-stats module): per-indexer account settings (ratio
// requirement, hit-and-run rule, freeleech-only mode, buffer tracking) and the statistics
// gathered from the built-in engine and from the tracker's account page.

export const TrackerHnrRule = z.object({
  minSeedHours: z.number().min(0).optional().describe('Hours a finished torrent must seed before it may be removed.'),
  minRatio: z.number().min(0).optional().describe('Share ratio that also satisfies the rule (either one is enough).'),
});
export type TrackerHnrRule = z.infer<typeof TrackerHnrRule>;

export const TrackerAccountSettings = z.object({
  enabled: z.boolean().default(false).describe('Track this indexer as a private tracker account.'),
  ratioRequired: z.number().min(0).optional().describe('Minimum account ratio the tracker requires (health warns below it).'),
  hnrRule: TrackerHnrRule.default({}).describe(
    'Hit-and-run rule: the built-in client refuses to remove a finished torrent of this tracker before it is met.',
  ),
  freeleechOnly: z.boolean().default(false).describe('Reject releases from this indexer that are not freeleech.'),
  bufferTracking: z.boolean().default(false).describe('Track the upload buffer (uploaded / required ratio - downloaded).'),
  minBufferBytes: z.number().int().min(0).optional().describe('Warn when the buffer drops below this many bytes.'),
  announceHosts: z
    .array(z.string().trim().toLowerCase().min(1))
    .default([])
    .describe("Tracker announce host names. Empty = the indexer's own site hosts (and their subdomains)."),
  scrapeAccount: z
    .boolean()
    .default(true)
    .describe("Read ratio, upload, download, buffer and H&R count from the tracker's account page when its definition has one."),
});
export type TrackerAccountSettings = z.infer<typeof TrackerAccountSettings>;
export type TrackerAccountSettingsInput = z.input<typeof TrackerAccountSettings>;

/** ok: at or comfortably above the requirement; warning: within 10 %; low: below it. */
export const TrackerRatioStatus = z.enum(['ok', 'warning', 'low', 'unknown']);
export type TrackerRatioStatus = z.infer<typeof TrackerRatioStatus>;

export const TrackerStatsResource = z.object({
  indexerId: z.number().int(),
  indexerName: z.string(),
  account: TrackerAccountSettings,
  /** Announce hosts used to attribute engine torrents to this tracker. */
  hosts: z.array(z.string()),
  // From the built-in engine (torrents of this tracker in this client).
  torrents: z.number().int(),
  seeding: z.number().int(),
  /** Bytes. */
  uploaded: z.number().int(),
  downloaded: z.number().int(),
  seedingTimeMs: z.number().int(),
  /** Finished torrents that have not met the hit-and-run rule yet. */
  hnrPending: z.number().int(),
  engineUpdatedAt: z.string().nullable(),
  // From the tracker's account page (null when unknown).
  accountRatio: z.number().nullable(),
  accountUploaded: z.number().int().nullable(),
  accountDownloaded: z.number().int().nullable(),
  accountBuffer: z.number().int().nullable(),
  accountHnrCount: z.number().int().nullable(),
  accountSeedBonus: z.number().nullable(),
  accountUpdatedAt: z.string().nullable(),
  accountError: z.string().nullable(),
  /** The account buffer, or uploaded / ratioRequired - downloaded when buffer tracking is on. */
  buffer: z.number().int().nullable(),
  /** The account ratio when known, else this client's upload/download ratio for the tracker. */
  ratio: z.number().nullable(),
  ratioStatus: TrackerRatioStatus,
});
export type TrackerStatsResource = z.infer<typeof TrackerStatsResource>;

export const TrackerStatsSyncResult = z.object({
  message: z.string(),
  stats: z.array(TrackerStatsResource),
});
export type TrackerStatsSyncResult = z.infer<typeof TrackerStatsSyncResult>;

export const TrackerErrorResponse = z.object({ error: z.string(), code: z.string() });
export type TrackerErrorResponse = z.infer<typeof TrackerErrorResponse>;
