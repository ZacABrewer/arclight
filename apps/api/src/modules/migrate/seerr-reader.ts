import { dirname, join } from 'node:path';
import type { MigratePathMapping, MigrationWarning, StagedIssue, StagedMediaRequest, StagedRequestUser } from '@arclight/shared';
import { parseJsonConfig, readTextFile, section, type ConfigTree } from './config-files.js';
import { MigrateError } from './errors.js';
import { bool, ForeignDb, int, isoDate, json, jsonArray, str, type ForeignRow } from './foreign-db.js';
import { remapPath } from './paths.js';
import type { SourceBundle, SourceItem } from './types.js';

// Seerr (Overseerr / Jellyseerr). The requests module is built in parallel, and Arclight
// users have no "must reset password" flag (modules/auth/schema.ts), so users, requests,
// issues and request settings are all staged in `migrate_staging` (areas `requests.*`).
// Secrets in settings.json (Plex/Jellyfin tokens, API keys) are never staged.

const USER_TYPES: Record<number, StagedRequestUser['userType']> = { 1: 'plex', 2: 'local', 3: 'jellyfin', 4: 'emby' };
const REQUEST_STATUS: Record<number, StagedMediaRequest['status']> = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' };
const ISSUE_TYPES: Record<number, StagedIssue['issueType']> = { 1: 'video', 2: 'audio', 3: 'subtitles', 4: 'other' };
const ISSUE_STATUS: Record<number, StagedIssue['status']> = { 1: 'open', 2: 'resolved' };

/** user_settings columns safe to carry over (no tokens or keys). */
const USER_SETTING_KEYS = [
  'locale',
  'discoverregion',
  'streamingregion',
  'originallanguage',
  'discordid',
  'telegramchatid',
  'telegramsendsilently',
  'watchlistsyncmovies',
  'watchlistsynctv',
  'notificationtypes',
];

/** settings.json `main` keys carried over. */
const MAIN_KEYS = [
  'applicationTitle',
  'defaultPermissions',
  'defaultQuotas',
  'hideAvailable',
  'localLogin',
  'newPlexLogin',
  'mediaServerLogin',
  'partialRequestsEnabled',
  'enableSpecialEpisodes',
  'locale',
  'discoverRegion',
  'streamingRegion',
  'originalLanguage',
  'blacklistedTags',
  'blacklistedTagsLimit',
];

function seasonStatus(v: unknown): string {
  return REQUEST_STATUS[int(v) ?? 0] ?? 'unknown';
}

function mapUser(row: ForeignRow, settings: ForeignRow | undefined): StagedRequestUser {
  const picked: Record<string, unknown> = {};
  if (settings) {
    for (const k of USER_SETTING_KEYS) {
      if (settings[k] === undefined || settings[k] === null) continue;
      picked[k] = k === 'notificationtypes' ? json<unknown>(settings[k], null) : settings[k];
    }
  }
  const username = str(row['username']) || null;
  return {
    email: str(row['email']) ?? '',
    username,
    displayName: username ?? str(row['plexusername']) ?? str(row['jellyfinusername']) ?? null,
    permissions: int(row['permissions']) ?? 0,
    userType: USER_TYPES[int(row['usertype']) ?? 0] ?? 'unknown',
    plexId: int(row['plexid']),
    jellyfinUserId: str(row['jellyfinuserid']),
    avatar: str(row['avatar']),
    movieQuotaLimit: int(row['moviequotalimit']),
    movieQuotaDays: int(row['moviequotadays']),
    tvQuotaLimit: int(row['tvquotalimit']),
    tvQuotaDays: int(row['tvquotadays']),
    settings: settings ? picked : null,
    createdAt: isoDate(row['createdat']),
  };
}

function loadSettings(dbPath: string, configPath: string | undefined, warnings: MigrationWarning[]): ConfigTree | null {
  const candidates = configPath ? [configPath] : [join(dirname(dbPath), '..', 'settings.json'), join(dirname(dbPath), 'settings.json')];
  for (const c of candidates) {
    const text = readTextFile(c);
    if (text !== null) return parseJsonConfig(text);
  }
  warnings.push({ area: 'requestSettings', message: 'settings.json not found; default permissions and quotas are not imported' });
  return null;
}

export function readSeerr(dbPath: string, configPath: string | undefined, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('media_request') || !db.hasTable('user')) {
      throw new MigrateError('WRONG_APP', `${dbPath} does not look like an Overseerr/Jellyseerr database (no user/media_request tables)`);
    }
    const warnings: MigrationWarning[] = [];
    const settingsByUser = new Map<number, ForeignRow>();
    for (const s of db.rows('user_settings')) {
      const uid = int(s['userid']);
      if (uid !== null) settingsByUser.set(uid, s);
    }
    const users: SourceItem<unknown>[] = db.rows('user').map((r) => {
      const payload = mapUser(r, settingsByUser.get(int(r['id']) ?? -1));
      return { sourceId: String(int(r['id'])), name: payload.displayName ?? payload.email, payload, stageArea: 'requests.users' as const };
    });

    const media = new Map<number, ForeignRow>();
    for (const m of db.rows('media')) {
      const mid = int(m['id']);
      if (mid !== null) media.set(mid, m);
    }
    const seasonsByRequest = new Map<number, Array<{ seasonNumber: number; status: string }>>();
    for (const s of db.rows('season_request')) {
      const rid = int(s['requestid']);
      const n = int(s['seasonnumber']);
      if (rid === null || n === null) continue;
      const list = seasonsByRequest.get(rid) ?? [];
      list.push({ seasonNumber: n, status: seasonStatus(s['status']) });
      seasonsByRequest.set(rid, list);
    }
    const requests: SourceItem<unknown>[] = db.rows('media_request').map((r) => {
      const m = media.get(int(r['mediaid']) ?? -1);
      const type = (str(r['type']) ?? str(m?.['mediatype']) ?? 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
      const root = str(r['rootfolder']);
      const tags = jsonArray(r['tags'])
        .map((t) => int(t))
        .filter((t): t is number => t !== null);
      const payload: StagedMediaRequest = {
        mediaType: type,
        tmdbId: int(m?.['tmdbid']),
        tvdbId: int(m?.['tvdbid']),
        status: REQUEST_STATUS[int(r['status']) ?? 0] ?? 'unknown',
        is4k: bool(r['is4k']),
        requestedBySourceId: int(r['requestedbyid']) !== null ? String(int(r['requestedbyid'])) : null,
        modifiedBySourceId: int(r['modifiedbyid']) !== null ? String(int(r['modifiedbyid'])) : null,
        seasons: seasonsByRequest.get(int(r['id']) ?? -1) ?? [],
        rootFolder: root ? remapPath(root, mappings).path : null,
        profileId: int(r['profileid']),
        tags,
        createdAt: isoDate(r['createdat']),
        updatedAt: isoDate(r['updatedat']),
      };
      return { sourceId: String(int(r['id'])), name: `${type} tmdb:${payload.tmdbId ?? '?'}`, payload, stageArea: 'requests.requests' as const };
    });

    const commentsByIssue = new Map<number, StagedIssue['comments']>();
    for (const c of db.rows('issue_comment')) {
      const iid = int(c['issueid']);
      if (iid === null) continue;
      const list = commentsByIssue.get(iid) ?? [];
      list.push({ userSourceId: int(c['userid']) !== null ? String(int(c['userid'])) : null, message: str(c['message']) ?? '', createdAt: isoDate(c['createdat']) });
      commentsByIssue.set(iid, list);
    }
    const issues: SourceItem<unknown>[] = db.rows('issue').map((r) => {
      const m = media.get(int(r['mediaid']) ?? -1);
      const mt = str(m?.['mediatype'])?.toLowerCase();
      const payload: StagedIssue = {
        issueType: ISSUE_TYPES[int(r['issuetype']) ?? 0] ?? 'unknown',
        status: ISSUE_STATUS[int(r['status']) ?? 0] ?? 'unknown',
        mediaType: mt === 'tv' ? 'tv' : mt === 'movie' ? 'movie' : null,
        tmdbId: int(m?.['tmdbid']),
        problemSeason: int(r['problemseason']) ?? 0,
        problemEpisode: int(r['problemepisode']) ?? 0,
        createdBySourceId: int(r['createdbyid']) !== null ? String(int(r['createdbyid'])) : null,
        comments: commentsByIssue.get(int(r['id']) ?? -1) ?? [],
        createdAt: isoDate(r['createdat']),
      };
      return { sourceId: String(int(r['id'])), name: `${payload.issueType} issue #${String(int(r['id']))}`, payload, stageArea: 'requests.issues' as const };
    });

    const requestSettings: SourceItem<unknown>[] = [];
    const settings = loadSettings(dbPath, configPath, warnings);
    if (settings) {
      const main = section(settings, 'main');
      const picked = Object.fromEntries(MAIN_KEYS.filter((k) => main[k] !== undefined).map((k) => [k, main[k]]));
      requestSettings.push({ sourceId: 'main', name: 'Request settings (permissions, quotas)', payload: picked, stageArea: 'requests.settings' });
    }
    for (const s of db.rows('discover_slider')) {
      requestSettings.push({
        sourceId: `slider:${String(int(s['id']))}`,
        name: str(s['title']) ?? `Discover slider ${String(int(s['id']))}`,
        stageArea: 'requests.discoverSliders',
        payload: { type: int(s['type']), order: int(s['order']), isBuiltIn: bool(s['isbuiltin']), enabled: bool(s['enabled'], true), title: str(s['title']), data: str(s['data']) },
      });
    }
    for (const o of db.rows('override_rule')) {
      const root = str(o['rootfolder']);
      requestSettings.push({
        sourceId: `override:${String(int(o['id']))}`,
        name: `Override rule ${String(int(o['id']))}`,
        stageArea: 'requests.overrideRules',
        payload: {
          radarrServiceId: int(o['radarrserviceid']),
          sonarrServiceId: int(o['sonarrserviceid']),
          users: str(o['users']),
          genre: str(o['genre']),
          language: str(o['language']),
          keywords: str(o['keywords']),
          profileId: int(o['profileid']),
          rootFolder: root ? remapPath(root, mappings).path : null,
          tags: str(o['tags']),
        },
      });
    }
    warnings.push({ area: 'users', message: 'Seerr users are staged for the requests module (Arclight accounts have no forced password reset yet); passwords are never copied' });
    const version = db.scalar('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
    return {
      app: 'seerr',
      schemaVersion: version === null ? null : String(version),
      warnings,
      areas: {
        users: { mode: 'stage', items: users },
        requests: { mode: 'stage', items: requests },
        issues: { mode: 'stage', items: issues },
        requestSettings: { mode: 'stage', items: requestSettings },
      },
    };
  } finally {
    db.close();
  }
}
