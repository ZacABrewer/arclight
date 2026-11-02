/**
 * Response shapes of the slskd web API (v0) that Arclight reads. Validation is loose:
 * only the fields we use are declared and everything else passes through.
 */
import { z } from 'zod';

export const SlskdApplication = z.looseObject({
  version: z.looseObject({ full: z.string().optional(), current: z.string().optional() }).optional(),
  server: z
    .looseObject({
      state: z.string().optional(),
      isConnected: z.boolean().optional(),
      isLoggedIn: z.boolean().optional(),
    })
    .optional(),
});
export type SlskdApplication = z.infer<typeof SlskdApplication>;

export const SlskdSearchState = z.looseObject({
  id: z.string(),
  searchText: z.string().optional(),
  state: z.string().optional(),
  isComplete: z.boolean().optional(),
  responseCount: z.number().optional(),
  fileCount: z.number().optional(),
});
export type SlskdSearchState = z.infer<typeof SlskdSearchState>;

export const SlskdFile = z.looseObject({
  filename: z.string(),
  size: z.number().default(0),
  extension: z.string().nullish(),
  bitRate: z.number().nullish(),
  bitDepth: z.number().nullish(),
  sampleRate: z.number().nullish(),
  /** Duration in seconds. */
  length: z.number().nullish(),
  isLocked: z.boolean().optional(),
});
export type SlskdFile = z.infer<typeof SlskdFile>;

export const SlskdResponse = z.looseObject({
  username: z.string(),
  files: z.array(SlskdFile).default([]),
  lockedFiles: z.array(SlskdFile).optional(),
  hasFreeUploadSlot: z.boolean().optional(),
  queueLength: z.number().optional(),
  uploadSpeed: z.number().optional(),
});
export type SlskdResponse = z.infer<typeof SlskdResponse>;

export const SlskdTransfer = z.looseObject({
  id: z.string(),
  username: z.string(),
  filename: z.string(),
  size: z.number().default(0),
  state: z.string().default(''),
  bytesTransferred: z.number().optional(),
  percentComplete: z.number().optional(),
  averageSpeed: z.number().optional(),
  exception: z.string().nullish(),
});
export type SlskdTransfer = z.infer<typeof SlskdTransfer>;

export const SlskdUserTransfers = z.looseObject({
  username: z.string(),
  directories: z
    .array(z.looseObject({ directory: z.string(), files: z.array(SlskdTransfer).default([]) }))
    .default([]),
});

export const SlskdTransferList = z.array(SlskdUserTransfers);
