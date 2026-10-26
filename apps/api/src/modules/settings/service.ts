import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  BackupSettings,
  CompatSettings,
  ImportListSettings,
  IndexerGlobalSettings,
  IndexerOptionsSection,
  MediaManagementSettings,
  MetadataSettings,
  NamingConfig,
  ReleasesSettings,
  RequestsSettings,
  SECRET_MASK,
  SecuritySettings,
  SubtitleSettings,
  TorrentSettings,
  VpnSettings,
  type MetadataSettingsResponse,
  type MetadataSettingsUpdate,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';

// Typed access to the `settings` table. Each section is one row (key = section name, value =
// JSON) validated by a Zod schema from the shared contract. Reads always go to the database so
// every module sees the latest value without a cache to invalidate.

const sections = {
  metadata: MetadataSettings,
  // Owned by the imports module (routes under /settings/mediamanagement and /settings/naming).
  mediaManagement: MediaManagementSettings,
  naming: NamingConfig,
  // Decision-engine knobs read by the releases module (routes under /settings/releases).
  releases: ReleasesSettings,
  // Owned by the vpn module (routes under /settings/vpn; secrets masked there).
  vpn: VpnSettings,
  // Owned by the auth module (auth method, API key, setup state; routes under /settings/security).
  security: SecuritySettings,
  // Owned by the import-lists module (sync interval, clean library; routes under /settings/importlists).
  importLists: ImportListSettings,
  // Owned by the subtitles module (routes under /subtitle/settings; provider secrets masked there).
  subtitles: SubtitleSettings,
  // Owned by the compat module (Sonarr/Radarr-shaped /api/v3; routes under /settings/compat).
  compat: CompatSettings,
  // Owned by the backup module (folder, schedule, retention; routes under /settings/backup).
  backup: BackupSettings,
  // Owned by the torrent module (built-in engine; routes under /settings/torrent).
  torrent: TorrentSettings,
  // Owned by the indexers module (RSS interval, subtitle/flag options; routes under
  // /settings/indexers, merged there with minimum age / retention / maximum size from `releases`).
  indexers: IndexerOptionsSection,
  // Owned by the requests module (routes under /settings/requests).
  requests: RequestsSettings,
} as const;

export type SettingsSection = keyof typeof sections;
export type SectionValue<K extends SettingsSection> = z.infer<(typeof sections)[K]>;

export class SettingsError extends Error {
  constructor(
    readonly code: 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** Read a section; missing rows and missing fields fall back to the schema defaults. */
export function getSection<K extends SettingsSection>(db: Db, section: K): SectionValue<K> {
  const row = db.select().from(settings).where(eq(settings.key, section)).get();
  const parsed = sections[section].safeParse(row?.value ?? {});
  // A stored value that no longer validates (e.g. hand-edited) must not take the api down:
  // fall back to defaults rather than throwing on every read.
  if (parsed.success) return parsed.data as SectionValue<K>;
  return sections[section].parse({}) as SectionValue<K>;
}

/** Validate and persist a whole section. */
export function setSection<K extends SettingsSection>(
  db: Db,
  section: K,
  value: SectionValue<K>,
  now: string = new Date().toISOString(),
): SectionValue<K> {
  const parsed = sections[section].safeParse(value);
  if (!parsed.success) throw new SettingsError('VALIDATION', parsed.error.message);
  db.insert(settings)
    .values({ key: section, value: parsed.data, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: parsed.data, updatedAt: now } })
    .run();
  return parsed.data as SectionValue<K>;
}

// ---------------------------------------------------------------------------------------
// metadata section: secret masking
// ---------------------------------------------------------------------------------------

export function maskMetadataSettings(value: MetadataSettings): MetadataSettingsResponse {
  return {
    tmdbApiKey: value.tmdbApiKey ? SECRET_MASK : null,
    language: value.language,
    region: value.region,
  };
}

/** Merge a client update onto the stored section. The mask (or an omitted key) keeps the stored key. */
export function applyMetadataUpdate(current: MetadataSettings, update: MetadataSettingsUpdate): MetadataSettings {
  const next: MetadataSettings = {
    language: update.language ?? current.language,
    region: update.region ?? current.region,
  };
  const key = update.tmdbApiKey;
  if (key === undefined || key === SECRET_MASK) {
    if (current.tmdbApiKey) next.tmdbApiKey = current.tmdbApiKey;
  } else if (key !== null && key.trim() !== '') {
    next.tmdbApiKey = key.trim();
  }
  return next;
}

export function getMetadataSettings(db: Db): MetadataSettingsResponse {
  return maskMetadataSettings(getSection(db, 'metadata'));
}

export function updateMetadataSettings(db: Db, update: MetadataSettingsUpdate): MetadataSettingsResponse {
  const next = applyMetadataUpdate(getSection(db, 'metadata'), update);
  return maskMetadataSettings(setSection(db, 'metadata', next));
}

// ---------------------------------------------------------------------------------------
// releases section
// ---------------------------------------------------------------------------------------

export function getReleasesSettings(db: Db): ReleasesSettings {
  return getSection(db, 'releases');
}

export function updateReleasesSettings(db: Db, value: ReleasesSettings): ReleasesSettings {
  return setSection(db, 'releases', value);
}

// ---------------------------------------------------------------------------------------
// indexer options (Settings -> Indexer options): a view over two sections
// ---------------------------------------------------------------------------------------

/** Minimum age / retention / maximum size from `releases`, the rest from `indexers`. */
export function getIndexerGlobalSettings(db: Db): IndexerGlobalSettings {
  const releases = getSection(db, 'releases');
  const options = getSection(db, 'indexers');
  return {
    minimumAgeMinutes: releases.minimumAgeMinutes,
    retentionDays: releases.retentionDays,
    maximumSizeMb: releases.maximumSizeMb,
    ...options,
  };
}

export function updateIndexerGlobalSettings(db: Db, value: IndexerGlobalSettings): IndexerGlobalSettings {
  const parsed = IndexerGlobalSettings.safeParse(value);
  if (!parsed.success) throw new SettingsError('VALIDATION', parsed.error.message);
  const v = parsed.data;
  const releases = getSection(db, 'releases');
  setSection(db, 'releases', {
    ...releases,
    minimumAgeMinutes: v.minimumAgeMinutes,
    retentionDays: v.retentionDays,
    maximumSizeMb: v.maximumSizeMb,
  });
  setSection(db, 'indexers', {
    rssSyncIntervalMinutes: v.rssSyncIntervalMinutes,
    allowHardcodedSubs: v.allowHardcodedSubs,
    whitelistedHardcodedSubs: v.whitelistedHardcodedSubs,
    preferIndexerFlags: v.preferIndexerFlags,
  });
  return getIndexerGlobalSettings(db);
}
