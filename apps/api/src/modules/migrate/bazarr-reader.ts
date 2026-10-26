import { dirname, join } from 'node:path';
import type { MigratePathMapping, StagedSubtitleEvent, StagedSubtitleLanguageProfile, StagedSubtitleProvider } from '@media-tron/shared';
import { warn } from './arr-common.js';
import { parseIni, parseSimpleYaml, readTextFile, section, type ConfigTree } from './config-files.js';
import { MigrateError } from './errors.js';
import { bool, field, ForeignDb, int, isoDate, json, jsonArray, num, str, type ForeignRow } from './foreign-db.js';
import { normalizeLanguageCode } from './mappers/languages.js';
import { remapPath } from './paths.js';
import type { SourceBundle, SourceItem } from './types.js';
import type { MigrationWarning } from '@media-tron/shared';

// Bazarr. Nothing here maps onto an existing Media-Tron table yet: the subtitles module is
// built in parallel, so languages profiles, providers (with credentials) and subtitle
// history/blacklist are staged in `migrate_staging` (areas `subtitles.*`, payloads typed in
// @media-tron/shared migrate.ts) for that module to import when it lands.

function flagMode(v: unknown): 'only' | 'also' | 'never' {
  const s = String(v ?? '').toLowerCase();
  if (s === 'also') return 'also';
  return s === 'true' || s === '1' ? 'only' : 'never';
}

function terms(v: unknown): string[] {
  const parsed = json<unknown>(v, null);
  if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  const s = str(v);
  return s && !s.startsWith('[') ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export function mapLanguagesProfile(row: ForeignRow): StagedSubtitleLanguageProfile {
  const rawItems = jsonArray(row['items']);
  const ids: Array<number | null> = [];
  const items: StagedSubtitleLanguageProfile['items'] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const language = str(field(o, 'language'));
    if (!language) continue;
    ids.push(int(field(o, 'id')));
    items.push({
      language: normalizeLanguageCode(language),
      hearingImpaired: flagMode(field(o, 'hi')),
      forced: flagMode(field(o, 'forced')),
      audioExclude: bool(field(o, 'audio_exclude')),
    });
  }
  const cutoffId = int(row['cutoff']);
  // 65535 is Bazarr's "any language satisfies the cutoff".
  const cutoffIndex = cutoffId === null || cutoffId === 65535 ? -1 : ids.indexOf(cutoffId);
  return {
    name: str(row['name']) ?? `Profile ${String(int(row['profileid']))}`,
    items,
    cutoff: cutoffIndex >= 0 ? cutoffIndex : null,
    mustContain: terms(row['mustcontain']),
    mustNotContain: terms(row['mustnotcontain']),
    originalFormat: bool(row['originalformat']),
    tag: str(row['tag']) || null,
  };
}

/** Provider sections of the config that are enabled (`general.enabled_providers`). */
export function mapProviders(config: ConfigTree): StagedSubtitleProvider[] {
  const general = section(config, 'general');
  const raw = general['enabled_providers'];
  const enabled = Array.isArray(raw) ? raw.map((p) => String(p).trim()).filter(Boolean) : typeof raw === 'string' ? raw.split(',').map((p) => p.trim()).filter(Boolean) : [];
  return enabled.map((provider) => ({ provider, enabled: true, settings: { ...section(config, provider) } }));
}

function loadConfig(dbPath: string, configPath: string | undefined, warnings: MigrationWarning[]): ConfigTree | null {
  const candidates = configPath
    ? [configPath]
    : [join(dirname(dbPath), '..', 'config', 'config.yaml'), join(dirname(dbPath), '..', 'config', 'config.ini'), join(dirname(dbPath), 'config.yaml')];
  for (const c of candidates) {
    const text = readTextFile(c);
    if (text === null) continue;
    return /\.ini$/i.test(c) || /^\s*\[general]/m.test(text) ? parseIni(text) : parseSimpleYaml(text);
  }
  warnings.push({ area: 'subtitleProviders', message: 'Bazarr config.yaml/config.ini not found; providers are not imported' });
  return null;
}

function event(row: ForeignRow, mediaType: 'series' | 'movie', mappings: readonly MigratePathMapping[]): StagedSubtitleEvent {
  const path = (v: unknown) => {
    const s = str(v);
    return s ? remapPath(s, mappings).path : null;
  };
  return {
    mediaType,
    sonarrSeriesId: int(row['sonarrseriesid'] ?? row['sonarr_series_id']),
    sonarrEpisodeId: int(row['sonarrepisodeid'] ?? row['sonarr_episode_id']),
    radarrMovieId: int(row['radarrid'] ?? row['radarr_id']),
    action: int(row['action']),
    description: str(row['description']),
    language: str(row['language']),
    provider: str(row['provider']),
    score: num(row['score']),
    subsId: str(row['subs_id']),
    videoPath: path(row['video_path']),
    subtitlesPath: path(row['subtitles_path']),
    timestamp: isoDate(row['timestamp']),
  };
}

export function readBazarr(dbPath: string, configPath: string | undefined, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('table_languages_profiles') && !db.hasTable('table_history')) {
      throw new MigrateError('WRONG_APP', `${dbPath} does not look like a Bazarr database (no table_languages_profiles)`);
    }
    const warnings: MigrationWarning[] = [];
    const profiles: SourceItem<unknown>[] = db.rows('table_languages_profiles').map((r) => {
      const payload = mapLanguagesProfile(r);
      return { sourceId: String(int(r['profileid'])), name: payload.name, payload, stageArea: 'subtitles.languageProfiles' as const };
    });
    const config = loadConfig(dbPath, configPath, warnings);
    const providers: SourceItem<unknown>[] = config
      ? mapProviders(config).map((p) => ({ sourceId: p.provider, name: p.provider, payload: p, stageArea: 'subtitles.providers' as const }))
      : [];
    const history: SourceItem<unknown>[] = [
      ...db.rows('table_history').map((r) => ({ sourceId: `episode:${String(int(r['id']))}`, name: str(r['description']) ?? 'subtitle', payload: event(r, 'series', mappings), stageArea: 'subtitles.history' as const })),
      ...db.rows('table_history_movie').map((r) => ({ sourceId: `movie:${String(int(r['id']))}`, name: str(r['description']) ?? 'subtitle', payload: event(r, 'movie', mappings), stageArea: 'subtitles.history' as const })),
      ...db.rows('table_blacklist').map((r) => ({ sourceId: `episode:${String(int(r['id']) ?? str(r['subs_id']))}`, name: `blacklisted ${str(r['subs_id']) ?? ''}`, payload: event(r, 'series', mappings), stageArea: 'subtitles.blacklist' as const })),
      ...db.rows('table_blacklist_movie').map((r) => ({ sourceId: `movie:${String(int(r['id']) ?? str(r['subs_id']))}`, name: `blacklisted ${str(r['subs_id']) ?? ''}`, payload: event(r, 'movie', mappings), stageArea: 'subtitles.blacklist' as const })),
    ];
    if (profiles.length > 0) warn({ warnings }, 'subtitleProfiles', 'subtitle settings are staged for the subtitles module; they take effect once it imports them');
    const version = db.scalar('SELECT version_num FROM alembic_version');
    return {
      app: 'bazarr',
      schemaVersion: version === null ? null : String(version),
      warnings,
      areas: {
        subtitleProfiles: { mode: 'stage', items: profiles },
        subtitleProviders: { mode: 'stage', items: providers },
        subtitleHistory: { mode: 'stage', items: history },
      },
    };
  } finally {
    db.close();
  }
}
