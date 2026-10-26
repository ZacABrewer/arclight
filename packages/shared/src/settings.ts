import { z } from 'zod';

// General settings contract. Settings are stored per section (one row per section in the
// `settings` table, value = JSON). Each section has a stored shape (what the api persists),
// a response shape (secrets masked) and an update shape (what a client PUTs back).

/** Placeholder returned in place of a stored secret. Sending it back keeps the stored value. */
export const SECRET_MASK = '********';

// ---------------------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------------------

/** Stored form of the `metadata` section. */
export const MetadataSettings = z.object({
  /** TMDB v3 API key. Absent means fall back to MEDIATRON_TMDB_API_KEY. */
  tmdbApiKey: z.string().min(1).optional(),
  /** BCP-47 language tag passed to TMDB, e.g. en-US. */
  language: z.string().min(2).default('en-US'),
  /** ISO-3166-1 region used for release dates and certifications. */
  region: z.string().length(2).default('US'),
});
export type MetadataSettings = z.infer<typeof MetadataSettings>;

/** GET /api/v1/settings/metadata. `tmdbApiKey` is SECRET_MASK when a key is stored, null otherwise. */
export const MetadataSettingsResponse = z.object({
  tmdbApiKey: z.string().nullable(),
  language: z.string(),
  region: z.string(),
});
export type MetadataSettingsResponse = z.infer<typeof MetadataSettingsResponse>;

/**
 * PUT /api/v1/settings/metadata. `tmdbApiKey`: SECRET_MASK or omitted keeps the stored key,
 * null or '' clears it, any other string replaces it.
 */
export const MetadataSettingsUpdate = z.object({
  tmdbApiKey: z.string().nullable().optional(),
  language: z.string().min(2).optional(),
  region: z.string().length(2).optional(),
});
export type MetadataSettingsUpdate = z.infer<typeof MetadataSettingsUpdate>;

export const SettingsErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type SettingsErrorResponse = z.infer<typeof SettingsErrorResponse>;
