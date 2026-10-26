import { dirname, join } from 'node:path';
import { parseLanguageTag } from '@arclight/subtitles';
import { MIGRATE_SECRET_MASK, SUBTITLE_PROVIDER_IDS, type LanguageProfileFlagMode, type MigratePathMapping, type MigrationWarning, type SubtitleHistoryAction } from '@arclight/shared';
import { warn } from './arr-common.js';
import { parseIni, parseSimpleYaml, readTextFile, section, type ConfigTree } from './config-files.js';
import { MigrateError } from './errors.js';
import { bool, field, ForeignDb, int, isoDate, json, jsonArray, num, str, type ForeignRow } from './foreign-db.js';
import { remapPath } from './paths.js';
import type { SourceBundle, SourceItem } from './types.js';
import type {
  BazarrMediaRef,
  SubtitleAssignmentPayload,
  SubtitleEventPayload,
  SubtitleFilePayload,
  SubtitleProfilePayload,
  SubtitleProviderPayload,
} from './types-subtitles.js';

// Bazarr → the subtitles module. Both readers (database file here, live API in
// api/bazarr-api.ts) fill a `BazarrRaw` and `buildBazarrBundle` turns it into importable areas:
// languages profiles, which series/movie uses which profile, providers with their credentials
// (the ones Arclight also has), the subtitle files Bazarr knows on disk, and the download
// history and blacklist. areas-subtitles.ts applies them.

/** One subtitle Bazarr lists for a video: `en`, `en:forced` or `en:hi`, with a path (null: embedded). */
export interface RawSubtitle {
  code: string;
  path: string | null;
  size: number | null;
}

export interface RawShow {
  sonarrSeriesId: number | null;
  title: string | null;
  path: string | null;
  tvdbId: number | null;
  imdbId: string | null;
  profileId: number | null;
}

export interface RawMovie {
  radarrId: number | null;
  title: string | null;
  /** The movie's video file. */
  path: string | null;
  tmdbId: number | null;
  imdbId: string | null;
  profileId: number | null;
  subtitles: RawSubtitle[];
}

export interface RawEpisode {
  sonarrSeriesId: number | null;
  sonarrEpisodeId: number | null;
  path: string | null;
  subtitles: RawSubtitle[];
}

export interface RawEvent {
  mediaType: 'series' | 'movie';
  id: string;
  action: number | null;
  description: string | null;
  language: string | null;
  provider: string | null;
  score: number | null;
  subsId: string | null;
  sonarrSeriesId: number | null;
  sonarrEpisodeId: number | null;
  radarrId: number | null;
  videoPath: string | null;
  subtitlesPath: string | null;
  timestamp: string | null;
}

export interface BazarrRaw {
  version: string | null;
  /** Languages profiles as rows with lower-cased keys (profileid, name, cutoff, items, ...). */
  profiles: ForeignRow[];
  config: ConfigTree | null;
  shows: RawShow[];
  movies: RawMovie[];
  episodes: RawEpisode[];
  history: RawEvent[];
  blacklist: RawEvent[];
}

// ---- small parsers ---------------------------------------------------------------------------

/**
 * Bazarr stores subtitle lists as Python literals (`[['en', '/a.srt', 123], ['fr:forced', None, None]]`)
 * in older releases and JSON in newer ones. A small literal parser for lists, strings, numbers,
 * None/True/False.
 */
export function parsePyLiteral(text: string): unknown {
  const s = text.trim();
  if (s === '') return null;
  try {
    return JSON.parse(s);
  } catch {
    // fall through to the Python literal parser
  }
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const value = (): unknown => {
    ws();
    const c = s[i];
    if (c === '[' || c === '(') {
      const close = c === '[' ? ']' : ')';
      i++;
      const out: unknown[] = [];
      ws();
      while (i < s.length && s[i] !== close) {
        out.push(value());
        ws();
        if (s[i] === ',') i++;
        ws();
      }
      i++;
      return out;
    }
    if (c === "'" || c === '"') {
      i++;
      let out = '';
      while (i < s.length && s[i] !== c) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1]!;
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else out += s[i++];
      }
      i++;
      return out;
    }
    const m = /^(None|True|False|-?\d+(?:\.\d+)?)/.exec(s.slice(i));
    if (!m) throw new Error('unreadable literal');
    i += m[0].length;
    return m[0] === 'None' ? null : m[0] === 'True' ? true : m[0] === 'False' ? false : Number(m[0]);
  };
  try {
    return value();
  } catch {
    return null;
  }
}

/** A Bazarr subtitles column / API array → RawSubtitle[]. */
export function parseSubtitleList(v: unknown): RawSubtitle[] {
  const list = typeof v === 'string' ? parsePyLiteral(v) : v;
  if (!Array.isArray(list)) return [];
  const out: RawSubtitle[] = [];
  for (const entry of list) {
    if (Array.isArray(entry)) {
      const code = str(entry[0]);
      if (code) out.push({ code, path: str(entry[1]) || null, size: int(entry[2]) });
    } else if (entry && typeof entry === 'object') {
      // API: { code2, forced, hi, path, file_size }
      const o = entry as Record<string, unknown>;
      const base = str(field(o, 'code2')) ?? str(field(o, 'code3')) ?? str(field(o, 'name'));
      if (!base) continue;
      const flag = bool(field(o, 'forced')) ? ':forced' : bool(field(o, 'hi')) ? ':hi' : '';
      out.push({ code: `${base}${flag}`, path: str(field(o, 'path')) || null, size: int(field(o, 'file_size', 'size')) });
    }
  }
  return out;
}

/** Bazarr language codes (`pb`, `zt`, `en:forced`) → Arclight language tag and flags. */
export function bazarrLanguage(raw: string): { code: string; forced: boolean; hi: boolean } | null {
  const [baseRaw, flag] = raw.trim().split(':');
  const base = (baseRaw ?? '').toLowerCase();
  if (!base) return null;
  const special: Record<string, string> = { pb: 'pt-BR', zt: 'zh-Hant', zh: 'zh-Hans' };
  const code = special[base] ?? parseLanguageTag(base);
  if (!code) return null;
  return { code, forced: flag === 'forced', hi: flag === 'hi' };
}

function flagMode(v: unknown): LanguageProfileFlagMode {
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

/** One languages profile row (DB or API, keys lower-cased) → Arclight profile payload. */
export function mapLanguagesProfile(row: ForeignRow, notes: string[] = []): SubtitleProfilePayload {
  const ids: Array<number | null> = [];
  const languages: SubtitleProfilePayload['languages'] = [];
  for (const raw of jsonArray(row['items'])) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const language = str(field(o, 'language'));
    const mapped = language ? bazarrLanguage(language) : null;
    if (!mapped) {
      if (language) notes.push(`language "${language}" has no equivalent and was dropped`);
      continue;
    }
    if (bool(field(o, 'audio_exclude'))) notes.push(`"exclude if the audio is ${mapped.code}" is not supported and was dropped`);
    ids.push(int(field(o, 'id')));
    languages.push({ code: mapped.code, hi: flagMode(field(o, 'hi')), forced: flagMode(field(o, 'forced')) });
  }
  const cutoffId = int(row['cutoff']);
  // 65535 is Bazarr's "any language satisfies the cutoff".
  let cutoff: string | null = null;
  if (cutoffId === 65535) cutoff = '*';
  else if (cutoffId !== null) {
    const idx = ids.indexOf(cutoffId);
    cutoff = idx >= 0 ? (languages[idx]?.code ?? null) : null;
  }
  return {
    name: str(row['name']) ?? `Profile ${String(int(row['profileid']))}`,
    languages,
    cutoff,
    mustContain: terms(row['mustcontain']),
    mustNotContain: terms(row['mustnotcontain']),
    originalFormat: bool(row['originalformat']),
    tag: str(row['tag']) || null,
  };
}

// ---- providers -----------------------------------------------------------------------------------

const PROVIDER_IDS = new Set<string>(SUBTITLE_PROVIDER_IDS);

/** Bazarr option name → Arclight setting name, per provider (others: snake_case → camelCase). */
const PROVIDER_FIELDS: Record<string, Record<string, string>> = {
  opensubtitlescom: { use_hash: 'useHash', include_ai_translated: 'includeAiTranslated', include_machine_translated: 'includeMachineTranslated' },
  subdl: { api_key: 'apiKey' },
  jimaku: { api_key: 'apiKey', enable_name_search_fallback: 'nameSearchFallback', enable_archives_download: 'archives', enable_ai_subs: 'aiSubs' },
  subf2m: { user_agent: 'userAgent' },
  animetosho: { search_threshold: 'searchThreshold' },
  whisperai: { pass_video_name: 'passVideoName' },
  embeddedsubtitles: { hi_fallback: 'hiFallback', unknown_as_fallback: 'unknownAsFallback', fallback_lang: 'fallbackLanguage' },
};

/** Options Arclight's providers do not have (dropped silently). */
const IGNORED_FIELDS = new Set(['verify_ssl', 'included_codecs', 'timeout', 'loglevel', 'response', 'skip_wrong_fps', 'approved_only', 'vip_rate_limit']);

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function isMasked(v: unknown): boolean {
  return typeof v === 'string' && (v === MIGRATE_SECRET_MASK || /^\*+$/.test(v));
}

export function mapProviderSettings(provider: string, raw: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const names = PROVIDER_FIELDS[provider] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (IGNORED_FIELDS.has(key) || v === null || v === undefined) continue;
    if (v === '') continue;
    if (isMasked(v)) {
      notes.push(`${provider}: ${key} was hidden by Bazarr's API; enter it again in Arclight`);
      continue;
    }
    out[names[key] ?? camel(key)] = v;
  }
  if (provider === 'opensubtitlescom' && !out['apiKey']) notes.push('opensubtitlescom: Arclight needs your own OpenSubtitles.com consumer API key; add it under Settings > Subtitles');
  return out;
}

export function providerItems(config: ConfigTree | null, warnings: MigrationWarning[]): SourceItem<SubtitleProviderPayload>[] {
  if (!config) return [];
  const general = section(config, 'general');
  const raw = general['enabled_providers'];
  const enabled = Array.isArray(raw) ? raw.map((p) => String(p).trim()).filter(Boolean) : typeof raw === 'string' ? raw.split(',').map((p) => p.trim()).filter(Boolean) : [];
  const items: SourceItem<SubtitleProviderPayload>[] = [];
  for (const provider of enabled) {
    const notes: string[] = [];
    const id = provider.toLowerCase();
    const settings = mapProviderSettings(id, { ...section(config, provider) }, notes);
    for (const n of notes) warnings.push({ area: 'subtitleProviders', message: n, sourceId: provider });
    const item: SourceItem<SubtitleProviderPayload> = { sourceId: provider, name: provider, payload: { kind: 'provider', provider: id, enabled: true, settings } };
    if (!PROVIDER_IDS.has(id)) item.unsupported = `${provider} is not one of Arclight's subtitle providers`;
    items.push(item);
  }
  // Default profiles for new series / movies.
  const seriesProfile = bool(general['serie_default_enabled']) ? int(general['serie_default_profile']) : null;
  const movieProfile = bool(general['movie_default_enabled']) ? int(general['movie_default_profile']) : null;
  if (seriesProfile !== null || movieProfile !== null) {
    items.push({ sourceId: 'defaults', name: 'Default profiles for new series and movies', payload: { kind: 'defaults', provider: 'defaults', enabled: true, settings: { seriesProfile, movieProfile } } });
  }
  return items;
}

// ---- bundle --------------------------------------------------------------------------------------

const ACTIONS: Record<number, SubtitleHistoryAction> = {
  0: 'deleted',
  1: 'downloaded',
  2: 'manualDownload',
  3: 'upgraded',
  4: 'uploaded',
  5: 'synced',
  6: 'translated',
};

function mapPath(p: string | null, mappings: readonly MigratePathMapping[]): string | null {
  return p ? remapPath(p, mappings).path : null;
}

function ref(over: Partial<BazarrMediaRef> & Pick<BazarrMediaRef, 'mediaType'>): BazarrMediaRef {
  return { path: null, title: null, tvdbId: null, tmdbId: null, imdbId: null, sonarrSeriesId: null, sonarrEpisodeId: null, radarrMovieId: null, ...over };
}

export function buildBazarrBundle(raw: BazarrRaw, mappings: readonly MigratePathMapping[], extraWarnings: MigrationWarning[] = []): SourceBundle {
  const warnings: MigrationWarning[] = [...extraWarnings];

  const profiles: SourceItem<SubtitleProfilePayload>[] = raw.profiles.map((r) => {
    const notes: string[] = [];
    const payload = mapLanguagesProfile(r, notes);
    const sourceId = String(int(r['profileid']));
    for (const n of notes) warn({ warnings }, 'subtitleProfiles', `"${payload.name}": ${n}`, sourceId);
    const item: SourceItem<SubtitleProfilePayload> = { sourceId, name: payload.name, payload };
    if (payload.languages.length === 0) item.unsupported = 'no language could be translated';
    return item;
  });
  if (raw.profiles.some((r) => str(r['tag']))) warn({ warnings }, 'subtitleProfiles', 'Bazarr assigns profiles by tag; Arclight assigns them per series and movie (the current assignments are imported)');

  const showsById = new Map<number, RawShow>();
  for (const s of raw.shows) if (s.sonarrSeriesId !== null) showsById.set(s.sonarrSeriesId, s);
  const moviesById = new Map<number, RawMovie>();
  for (const m of raw.movies) if (m.radarrId !== null) moviesById.set(m.radarrId, m);
  const showRef = (id: number | null, episodeId: number | null = null): BazarrMediaRef => {
    const s = id !== null ? showsById.get(id) : undefined;
    return ref({ mediaType: 'series', path: mapPath(s?.path ?? null, mappings), title: s?.title ?? null, tvdbId: s?.tvdbId ?? null, imdbId: s?.imdbId ?? null, sonarrSeriesId: id, sonarrEpisodeId: episodeId });
  };
  const movieRef = (id: number | null): BazarrMediaRef => {
    const m = id !== null ? moviesById.get(id) : undefined;
    return ref({ mediaType: 'movie', path: mapPath(m?.path ?? null, mappings), title: m?.title ?? null, tmdbId: m?.tmdbId ?? null, imdbId: m?.imdbId ?? null, radarrMovieId: id });
  };

  const assignments: SourceItem<SubtitleAssignmentPayload>[] = [];
  for (const s of raw.shows) {
    if (s.profileId === null || s.sonarrSeriesId === null) continue;
    assignments.push({ sourceId: `series:${s.sonarrSeriesId}`, name: s.title ?? `Series ${s.sonarrSeriesId}`, payload: { ...showRef(s.sonarrSeriesId), sourceProfileId: s.profileId } });
  }
  for (const m of raw.movies) {
    if (m.profileId === null || m.radarrId === null) continue;
    assignments.push({ sourceId: `movie:${m.radarrId}`, name: m.title ?? `Movie ${m.radarrId}`, payload: { ...movieRef(m.radarrId), sourceProfileId: m.profileId } });
  }

  const files: SourceItem<SubtitleFilePayload>[] = [];
  let embedded = 0;
  const addFiles = (base: BazarrMediaRef, videoPath: string | null, subs: RawSubtitle[], label: string) => {
    for (const sub of subs) {
      if (!sub.path) {
        embedded++;
        continue;
      }
      const lang = bazarrLanguage(sub.code);
      const subtitlePath = mapPath(sub.path, mappings)!;
      const item: SourceItem<SubtitleFilePayload> = {
        sourceId: subtitlePath,
        name: `${label}: ${sub.code}`,
        payload: { ...base, videoPath: mapPath(videoPath, mappings), subtitlePath, language: lang?.code ?? sub.code, forced: lang?.forced ?? false, hi: lang?.hi ?? false, size: sub.size },
      };
      if (!lang) item.unsupported = `language "${sub.code}" is not known`;
      files.push(item);
    }
  };
  for (const e of raw.episodes) addFiles(showRef(e.sonarrSeriesId, e.sonarrEpisodeId), e.path, e.subtitles, showsById.get(e.sonarrSeriesId ?? -1)?.title ?? 'episode');
  for (const m of raw.movies) addFiles(movieRef(m.radarrId), m.path, m.subtitles, m.title ?? 'movie');

  const events: SourceItem<SubtitleEventPayload>[] = [];
  const addEvent = (kind: 'history' | 'blacklist', e: RawEvent) => {
    const base = e.mediaType === 'series' ? showRef(e.sonarrSeriesId, e.sonarrEpisodeId) : movieRef(e.radarrId);
    const lang = e.language ? bazarrLanguage(e.language) : null;
    const item: SourceItem<SubtitleEventPayload> = {
      sourceId: `${kind}:${e.mediaType}:${e.id}`,
      name: e.description ?? `${kind === 'blacklist' ? 'blacklisted' : 'subtitle'} ${e.subsId ?? ''}`.trim(),
      payload: {
        ...base,
        kind,
        action: ACTIONS[e.action ?? 1] ?? 'downloaded',
        description: e.description ?? '',
        language: lang?.code ?? e.language ?? 'und',
        forced: lang?.forced ?? false,
        hi: lang?.hi ?? false,
        provider: e.provider,
        score: e.score,
        subsId: e.subsId,
        videoPath: mapPath(e.videoPath, mappings) ?? (e.mediaType === 'movie' ? base.path : null),
        subtitlesPath: mapPath(e.subtitlesPath, mappings),
        timestamp: e.timestamp,
      },
    };
    if (!e.timestamp) item.unsupported = 'no date';
    else if (kind === 'blacklist' && (!e.provider || !e.subsId)) item.unsupported = 'no provider or subtitle id';
    events.push(item);
  };
  for (const e of raw.history) addEvent('history', e);
  for (const e of raw.blacklist) addEvent('blacklist', e);

  const providers = providerItems(raw.config, warnings);
  if (!raw.config) warnings.push({ area: 'subtitleProviders', message: 'Bazarr settings were not found; providers are not imported' });

  return {
    app: 'bazarr',
    schemaVersion: raw.version,
    warnings,
    areas: {
      subtitleProfiles: { mode: 'import', items: profiles },
      subtitleAssignments: { mode: 'import', items: assignments },
      subtitleProviders: { mode: 'import', items: providers },
      subtitleFiles: { mode: 'import', items: files, ...(embedded > 0 ? { details: { embeddedSkipped: embedded } } : {}) },
      subtitleHistory: {
        mode: 'import',
        items: events,
        details: { history: events.filter((e) => e.payload.kind === 'history').length, blacklist: events.filter((e) => e.payload.kind === 'blacklist').length },
      },
    },
  };
}

// ---- file reader ----------------------------------------------------------------------------------

function loadConfig(dbPath: string, configPath: string | undefined): ConfigTree | null {
  const candidates = configPath
    ? [configPath]
    : [join(dirname(dbPath), '..', 'config', 'config.yaml'), join(dirname(dbPath), '..', 'config', 'config.ini'), join(dirname(dbPath), 'config.yaml')];
  for (const c of candidates) {
    const text = readTextFile(c);
    if (text === null) continue;
    return /\.ini$/i.test(c) || /^\s*\[general]/m.test(text) ? parseIni(text) : parseSimpleYaml(text);
  }
  return null;
}

function rawEvent(row: ForeignRow, mediaType: 'series' | 'movie', id: string): RawEvent {
  return {
    mediaType,
    id,
    action: int(row['action']),
    description: str(row['description']),
    language: str(row['language']),
    provider: str(row['provider']),
    score: num(row['score']),
    subsId: str(row['subs_id']),
    sonarrSeriesId: int(row['sonarrseriesid'] ?? row['sonarr_series_id']),
    sonarrEpisodeId: int(row['sonarrepisodeid'] ?? row['sonarr_episode_id']),
    radarrId: int(row['radarrid'] ?? row['radarr_id']),
    videoPath: str(row['video_path']),
    subtitlesPath: str(row['subtitles_path']),
    timestamp: isoDate(row['timestamp']),
  };
}

export function readBazarr(dbPath: string, configPath: string | undefined, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('table_languages_profiles') && !db.hasTable('table_history')) {
      throw new MigrateError('WRONG_APP', `${dbPath} does not look like a Bazarr database (no table_languages_profiles)`);
    }
    const version = db.scalar('SELECT version_num FROM alembic_version');
    const raw: BazarrRaw = {
      version: version === null ? null : String(version),
      profiles: db.rows('table_languages_profiles'),
      config: loadConfig(dbPath, configPath),
      shows: db.rows('table_shows').map((r) => ({
        sonarrSeriesId: int(r['sonarrseriesid']),
        title: str(r['title']),
        path: str(r['path']),
        tvdbId: int(r['tvdbid']),
        imdbId: str(r['imdbid']) || null,
        profileId: int(r['profileid']),
      })),
      movies: db.rows('table_movies').map((r) => ({
        radarrId: int(r['radarrid']),
        title: str(r['title']),
        path: str(r['path']),
        tmdbId: int(r['tmdbid']),
        imdbId: str(r['imdbid']) || null,
        profileId: int(r['profileid']),
        subtitles: parseSubtitleList(r['subtitles']),
      })),
      episodes: db.rows('table_episodes').map((r) => ({
        sonarrSeriesId: int(r['sonarrseriesid']),
        sonarrEpisodeId: int(r['sonarrepisodeid']),
        path: str(r['path']),
        subtitles: parseSubtitleList(r['subtitles']),
      })),
      history: [
        ...db.rows('table_history').map((r) => rawEvent(r, 'series', String(int(r['id'])))),
        ...db.rows('table_history_movie').map((r) => rawEvent(r, 'movie', String(int(r['id'])))),
      ],
      blacklist: [
        ...db.rows('table_blacklist').map((r) => rawEvent(r, 'series', String(int(r['id']) ?? str(r['subs_id'])))),
        ...db.rows('table_blacklist_movie').map((r) => rawEvent(r, 'movie', String(int(r['id']) ?? str(r['subs_id'])))),
      ],
    };
    return buildBazarrBundle(raw, mappings);
  } finally {
    db.close();
  }
}
