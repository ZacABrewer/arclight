import { z } from 'zod';

/**
 * Shapes of the Transmission RPC responses we consume. Only fields we read are declared;
 * unknown fields are stripped. Fields missing from older daemons are optional.
 */

/** Every RPC reply: `result` is "success" or a human-readable error string. */
export const TrRpcEnvelope = z.object({
  result: z.string(),
  arguments: z.unknown().optional(),
});

export const TrSession = z.object({
  /** e.g. "4.0.5 (a6fe2a64aa)". */
  version: z.string(),
  'rpc-version': z.number().int(),
  'download-dir': z.string(),
  seedRatioLimit: z.number().optional(),
  seedRatioLimited: z.boolean().optional(),
  /** Minutes. */
  'idle-seeding-limit': z.number().optional(),
  'idle-seeding-limit-enabled': z.boolean().optional(),
  'peer-port': z.number().int().optional(),
  'download-queue-enabled': z.boolean().optional(),
});
export type TrSession = z.infer<typeof TrSession>;

/** Torrent status codes (rpc-version 14+). */
export const TR_STATUS = {
  stopped: 0,
  checkWait: 1,
  checking: 2,
  downloadWait: 3,
  downloading: 4,
  seedWait: 5,
  seeding: 6,
} as const;

/** `seedRatioMode` / `seedIdleMode`. */
export const TR_LIMIT_MODE = { global: 0, single: 1, unlimited: 2 } as const;

/** `error` codes. */
export const TR_ERROR = { ok: 0, trackerWarning: 1, trackerError: 2, localError: 3 } as const;

export const TrTorrent = z.object({
  hashString: z.string(),
  name: z.string(),
  downloadDir: z.string(),
  totalSize: z.number(),
  leftUntilDone: z.number(),
  /** 0..1 of the wanted files. */
  percentDone: z.number(),
  /** Seconds; -1 = not available, -2 = unknown. */
  eta: z.number(),
  status: z.number().int(),
  error: z.number().int().default(0),
  errorString: z.string().default(''),
  /** True once Transmission stopped the torrent because a seed limit was reached. */
  isFinished: z.boolean().default(false),
  isPrivate: z.boolean().optional(),
  /** rpc-version 16+ (Transmission 3.00+). */
  labels: z.array(z.string()).optional(),
  uploadRatio: z.number().default(0),
  seedRatioLimit: z.number().default(0),
  seedRatioMode: z.number().int().default(0),
  /** Minutes. */
  seedIdleLimit: z.number().default(0),
  seedIdleMode: z.number().int().default(0),
  secondsSeeding: z.number().optional(),
  /** Unix seconds of last upload/download activity. */
  activityDate: z.number().default(0),
});
export type TrTorrent = z.infer<typeof TrTorrent>;

export const TrTorrentGet = z.object({ torrents: z.array(TrTorrent) });

const TrAddedTorrent = z.object({ hashString: z.string(), id: z.number().optional(), name: z.string().optional() });

export const TrTorrentAdd = z.object({
  'torrent-added': TrAddedTorrent.optional(),
  'torrent-duplicate': TrAddedTorrent.optional(),
});

/** For calls whose arguments we ignore. */
export const TrAnything = z.unknown();

/** Fields requested from torrent-get. Older daemons skip names they do not know. */
export const TORRENT_FIELDS = [
  'hashString',
  'name',
  'downloadDir',
  'totalSize',
  'leftUntilDone',
  'percentDone',
  'eta',
  'status',
  'error',
  'errorString',
  'isFinished',
  'isPrivate',
  'labels',
  'uploadRatio',
  'seedRatioLimit',
  'seedRatioMode',
  'seedIdleLimit',
  'seedIdleMode',
  'secondsSeeding',
  'activityDate',
] as const;
