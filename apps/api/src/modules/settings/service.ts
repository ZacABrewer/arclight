import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  AlertSettings,
  BackupSettings,
  CompatSettings,
  CrossSeedSettings,
  DiscordBotSettings,
  EngineAgentSettings,
  DefinitionFeedSettings,
  GuidesSettings,
  ImportListSettings,
  IndexerGlobalSettings,
  IndexerOptionsSection,
  MediaManagementSettings,
  MediaServerSettings,
  MediaServersSettings,
  MetadataSettings,
  MetricsSettings,
  AuditSettings,
  NamingConfig,
  ReleasesSettings,
  RequestsSettings,
  SECRET_MASK,
  SecuritySettings,
  SolverSettings,
  SubtitleSettings,
  SeedingRulesSettings,
  TorrentSettings,
  TorrentSlowModeState,
  TorrentSpeedSettings,
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
  // Owned by the torrent module: alternative limits and their weekly schedule (routes under
  // /settings/torrent/speed), the manual slow-mode switch (/torrent/slowmode) and the seeding
  // rules (/settings/torrent/seedingrules).
  torrentSpeed: TorrentSpeedSettings,
  torrentSlowMode: TorrentSlowModeState,
  seedingRules: SeedingRulesSettings,
  // Owned by the indexers module (RSS interval, subtitle/flag options; routes under
  // /settings/indexers, merged there with minimum age / retention / maximum size from `releases`).
  indexers: IndexerOptionsSection,
  // Owned by the requests module (routes under /settings/requests).
  requests: RequestsSettings,
  // Owned by the requests module (Jellyfin/Emby/Plex for sign-in, watchlists, availability;
  // routes under /settings/mediaserver, apiKey masked there).
  mediaServer: MediaServerSettings,
  // Owned by the media-servers module: the list of Jellyfin/Emby/Plex connections with per-feature
  // flags (availability, retention, refresh); routes under /mediaserver, apiKey masked there.
  mediaServers: MediaServersSettings,
  // Owned by the solver module (built-in Cloudflare challenge solver; routes under /settings/solver).
  solver: SolverSettings,
  // Owned by the guides module (TRaSH-style format/score sync; routes under /settings/guides).
  guides: GuidesSettings,
  // Owned by the metrics module (GET /metrics; allowAnonymous).
  metrics: MetricsSettings,
  // Owned by the audit module (enabled, retentionDays).
  audit: AuditSettings,
  // Owned by the cross-seed module (routes under /settings/crossseed).
  crossSeed: CrossSeedSettings,
  // Owned by the engine-agent module (routes under /settings/engineagent).
  engineAgent: EngineAgentSettings,
  // Owned by the discord-bot module (routes under /settings/discordbot; botToken masked there).
  discordBot: DiscordBotSettings,
  // Owned by the summary module: quiet hours and the daily summary (routes under /settings/alerts).
  alerts: AlertSettings,
} as const;

export type SettingsSection = keyof typeof sections;

/** Every registered section name (config export/import walks these). */
export function settingsSections(): SettingsSection[] {
  return Object.keys(sections) as SettingsSection[];
}

/** Validate a whole section value without writing it; returns the parsed value or the error message. */
export function validateSection(
  section: SettingsSection,
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = sections[section].safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> };
  return { ok: false, error: parsed.error.message };
}
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
  // The definition feed shares the section but has its own routes (/indexer/definition/feed).
  const { definitionFeed: _feed, ...options } = getSection(db, 'indexers');
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
    definitionFeed: getSection(db, 'indexers').definitionFeed,
    rssSyncIntervalMinutes: v.rssSyncIntervalMinutes,
    allowHardcodedSubs: v.allowHardcodedSubs,
    whitelistedHardcodedSubs: v.whitelistedHardcodedSubs,
    preferIndexerFlags: v.preferIndexerFlags,
  });
  return getIndexerGlobalSettings(db);
}

// ---------------------------------------------------------------------------------------
// indexers.definitionFeed (owned by the indexers module's definition feed)
// ---------------------------------------------------------------------------------------

export function getDefinitionFeedSettings(db: Db): DefinitionFeedSettings {
  return getSection(db, 'indexers').definitionFeed;
}

export function updateDefinitionFeedSettings(db: Db, value: DefinitionFeedSettings): DefinitionFeedSettings {
  const parsed = DefinitionFeedSettings.safeParse(value);
  if (!parsed.success) throw new SettingsError('VALIDATION', parsed.error.message);
  return setSection(db, 'indexers', { ...getSection(db, 'indexers'), definitionFeed: parsed.data }).definitionFeed;
}
