import { z } from 'zod';

/** Initial state of torrents added to the built-in engine. */
export const BuiltinInitialState = z.enum(['start', 'pause']);

export const BuiltinCategoryPath = z.object({
  name: z.string().trim().min(1).describe('Category name.'),
  savePath: z.string().trim().min(1).describe('Folder downloads of this category are saved to.'),
});

/**
 * Settings of the built-in torrent engine client. Must stay shape-identical to the shared
 * `BuiltinClientSettings` contract (the api checks this at compile time and at runtime).
 */
export const BuiltinSettings = z.object({
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
  savePath: z
    .string()
    .trim()
    .default('')
    .describe(
      'Root download folder. Downloads go to <root>/<category> unless the category has its own folder below. Leave empty to use the engine downloads folder (Settings > Torrent Engine).',
    ),
  categories: z
    .array(BuiltinCategoryPath)
    .default([])
    .describe('Per-category download folders. Categories without an entry use <root>/<category>.'),
  initialState: BuiltinInitialState.default('start').describe('State of torrents when they are added.'),
  seedRatioLimit: z
    .number()
    .min(0)
    .optional()
    .describe('Stop seeding once this share ratio is reached. Leave empty to use the engine default.'),
  seedTimeLimitMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Stop seeding after this many minutes. Leave empty to use the engine default.'),
  superSeeding: z
    .boolean()
    .optional()
    .describe('Turn on super-seeding (BEP 16) for new torrents: while seeding, each peer is offered one piece at a time.'),
  uploadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Upload limit per torrent in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
  downloadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Download limit per torrent in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
  peerUploadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Upload limit per peer connection in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
  peerDownloadLimitKbps: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Download limit per peer connection in KiB/s for new torrents. Leave empty or 0 for unlimited.'),
});
export type BuiltinSettings = z.infer<typeof BuiltinSettings>;
export type BuiltinSettingsInput = z.input<typeof BuiltinSettings>;
