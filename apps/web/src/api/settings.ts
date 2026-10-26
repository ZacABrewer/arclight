import { z } from 'zod';
import { MediaManagementSettings as MediaManagementWire, MetadataSettingsResponse, type MetadataSettingsUpdate } from '@arclight/shared';
import { request } from './client.js';
import { t } from '../i18n/index.js';

// /settings/metadata mirrors apps/api/src/modules/settings/routes.ts.
//
// /settings/mediamanagement speaks the shared `MediaManagementSettings` (the wire form). The
// page edits a form-shaped copy: extensions as one comma-separated string and the recycle bin
// as '' instead of absent. looseObject keeps the other server fields so a save never drops them.
export const FILE_DATE_MODES = [
  { value: 'none', get label() { return t('common.none'); } },
  { value: 'localAirDate', get label() { return t('api.settings.localAirDate'); } },
  { value: 'utcAirDate', get label() { return t('api.settings.utcAirDate'); } },
  { value: 'releaseDate', get label() { return t('api.settings.releaseDateMovies'); } },
] as const;

export const MediaManagementSettings = z.looseObject({
  recycleBinPath: z.string().default(''),
  recycleBinCleanupDays: z.number().int().min(0).default(7),
  importExtraFiles: z.boolean().default(false),
  extraFileExtensions: z.string().default('srt'),
  useHardlinks: z.boolean().default(true),
  skipFreeSpaceCheck: z.boolean().default(false),
  minimumFreeSpaceMb: z.number().int().min(0).default(100),
  createEmptySeriesFolders: z.boolean().default(false),
  deleteEmptyFolders: z.boolean().default(false),
  setPermissions: z.boolean().default(false),
  chmodFolder: z.string().default('755'),
  chownGroup: z.string().default(''),
  enableMediaInfo: z.boolean().default(true),
  rescanAfterRefresh: z.string().default('always'),
  episodeTitleRequired: z.string().default('always'),
  downloadPropersAndRepacks: z.string().default('preferAndUpgrade'),
  fileDateMode: z.string().default('none'),
});
export type MediaManagementSettings = z.infer<typeof MediaManagementSettings>;

export const MEDIA_MANAGEMENT_DEFAULTS: MediaManagementSettings = MediaManagementSettings.parse({});
/** What the server returns for a fresh install (test fixtures). */
export const MEDIA_MANAGEMENT_WIRE_DEFAULTS = MediaManagementWire.parse({});

const MediaManagementResponse = MediaManagementWire.transform((wire) =>
  MediaManagementSettings.parse({ ...wire, recycleBinPath: wire.recycleBinPath ?? '', extraFileExtensions: wire.extraFileExtensions.join(', ') }),
);

/** Form → wire: split the extension list ("srt, .nfo" → ["srt", "nfo"]). */
export function mediaManagementToWire(form: MediaManagementSettings): Record<string, unknown> {
  const extensions = form.extraFileExtensions.split(/[\s,]+/).map((e) => e.replace(/^\./, '')).filter(Boolean);
  return { ...form, extraFileExtensions: extensions };
}

export const settingsApi = {
  metadata: {
    get: () => request('/settings/metadata', MetadataSettingsResponse),
    update: (body: MetadataSettingsUpdate) =>
      request('/settings/metadata', MetadataSettingsResponse, { method: 'PUT', json: body }),
  },
  mediaManagement: {
    get: () => request('/settings/mediamanagement', MediaManagementResponse),
    update: (body: MediaManagementSettings) =>
      request('/settings/mediamanagement', MediaManagementResponse, { method: 'PUT', json: mediaManagementToWire(body) }),
  },
};
