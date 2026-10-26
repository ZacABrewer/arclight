import { dirname, join } from 'node:path';
import type { MigratePathMapping, MigrationWarning, RequestStatus } from '@arclight/shared';
import { parseJsonConfig, readTextFile, section, type ConfigTree } from './config-files.js';
import { MigrateError } from './errors.js';
import { bool, ForeignDb, int, isoDate, jsonArray, str, type ForeignRow } from './foreign-db.js';
import { remapPath } from './paths.js';
import type { SourceBundle, SourceItem } from './types.js';
import type { SeerrIssuePayload, SeerrMainSettings, SeerrOverrideRule, SeerrRequestPayload, SeerrSettingsPayload, SeerrSlider, SeerrUserPayload } from './types-requests.js';

// Seerr (Overseerr / Jellyseerr) → users, requests, issues and request settings. Both readers
// (database file here, live API in api/seerr-api.ts) fill a `SeerrRaw`; `buildSeerrBundle` turns
// it into importable areas that areas-requests.ts applies. Secrets (passwords, Plex/Jellyfin
// tokens, notification keys, API keys) are never read into the bundle.

export interface SeerrRaw {
  version: string | null;
  users: Array<{ sourceId: string; user: SeerrUserPayload }>;
  requests: Array<{ sourceId: string; request: SeerrRequestPayload }>;
  issues: Array<{ sourceId: string; issue: SeerrIssuePayload }>;
  main: SeerrMainSettings | null;
  sliders: Array<{ sourceId: string; slider: SeerrSlider }>;
  overrides: Array<{ sourceId: string; rule: SeerrOverrideRule }>;
}

export const USER_TYPES: Record<number, SeerrUserPayload['userType']> = { 1: 'plex', 2: 'local', 3: 'jellyfin', 4: 'emby' };
export const REQUEST_STATUS: Record<number, RequestStatus> = { 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' };
export const ISSUE_TYPES: Record<number, SeerrIssuePayload['issueType']> = { 1: 'video', 2: 'audio', 3: 'subtitles', 4: 'other' };
export const ISSUE_STATUS: Record<number, SeerrIssuePayload['status']> = { 1: 'open', 2: 'resolved' };

const idOf = (v: unknown): string | null => {
  const n = int(v);
  return n === null ? null : String(n);
};

/** Comma/pipe separated lists stored as text in override rules. */
export function splitList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = str(v);
  return s ? s.split(/[,|]/).map((x) => x.trim()).filter(Boolean) : [];
}

export function intList(v: unknown): number[] {
  const parsed = typeof v === 'string' && v.trim().startsWith('[') ? jsonArray(v) : Array.isArray(v) ? v : splitList(v);
  return parsed.map((x) => int(x)).filter((x): x is number => x !== null);
}

/** settings.json `main` (or /api/v1/settings/main) → the settings that have Arclight equivalents. */
export function mainSettings(main: ConfigTree | Record<string, unknown>): SeerrMainSettings {
  const quotas = (main['defaultQuotas'] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const b = (k: string) => (main[k] === undefined || main[k] === null ? null : bool(main[k]));
  return {
    kind: 'main',
    defaultPermissions: int(main['defaultPermissions']),
    movieQuotaLimit: int(quotas['movie']?.['quotaLimit']),
    movieQuotaDays: int(quotas['movie']?.['quotaDays']),
    tvQuotaLimit: int(quotas['tv']?.['quotaLimit']),
    tvQuotaDays: int(quotas['tv']?.['quotaDays']),
    partialRequestsEnabled: b('partialRequestsEnabled'),
    enableSpecialEpisodes: b('enableSpecialEpisodes'),
    hideAvailable: b('hideAvailable'),
    applicationUrl: str(main['applicationUrl']) || null,
  };
}

export function buildSeerrBundle(raw: SeerrRaw, extraWarnings: MigrationWarning[] = []): SourceBundle {
  const warnings: MigrationWarning[] = [...extraWarnings];
  const users: SourceItem<SeerrUserPayload>[] = raw.users.map(({ sourceId, user }) => {
    const item: SourceItem<SeerrUserPayload> = { sourceId, name: user.displayName ?? user.username ?? user.email, payload: user };
    if (!user.email && !user.username && !user.mediaServerUsername) item.unsupported = 'user has no email, username or media-server account';
    return item;
  });
  const requests: SourceItem<SeerrRequestPayload>[] = raw.requests.map(({ sourceId, request }) => {
    const item: SourceItem<SeerrRequestPayload> = { sourceId, name: `${request.mediaType === 'tv' ? 'Series' : 'Movie'} TMDB ${request.tmdbId ?? '?'}`, payload: request };
    if (request.tmdbId === null) item.unsupported = 'no TMDB id';
    else if (request.status === null) item.unsupported = 'unknown request status';
    return item;
  });
  const issues: SourceItem<SeerrIssuePayload>[] = raw.issues.map(({ sourceId, issue }) => {
    const item: SourceItem<SeerrIssuePayload> = { sourceId, name: `${issue.issueType} issue #${sourceId}`, payload: issue };
    if (issue.tmdbId === null || issue.mediaType === null) item.unsupported = 'issue has no media';
    return item;
  });
  const settings: SourceItem<SeerrSettingsPayload>[] = [];
  if (raw.main) settings.push({ sourceId: 'main', name: 'Request settings (default permissions, quotas)', payload: raw.main });
  for (const { sourceId, slider } of raw.sliders) {
    const item: SourceItem<SeerrSettingsPayload> = { sourceId: `slider:${sourceId}`, name: slider.title ?? `Discover slider ${sourceId}`, payload: slider };
    if (slider.type < 1 || slider.type > 19) item.unsupported = `discover slider type ${slider.type} is not known`;
    settings.push(item);
  }
  for (const { sourceId, rule } of raw.overrides) settings.push({ sourceId: `override:${sourceId}`, name: `Override rule ${sourceId}`, payload: rule });
  if (!raw.main) warnings.push({ area: 'requestSettings', message: 'Seerr settings were not found; default permissions and quotas are not imported' });
  warnings.push({ area: 'requestSettings', message: 'Seerr notification agents are not imported; set them up under Settings > Notifications' });
  if (users.some((u) => !u.unsupported && (u.payload.permissions & 2) !== 0)) {
    warnings.push({ area: 'users', message: 'Seerr admins become Arclight users who can manage requests and issues; Arclight administrators are never created by the import (promote them under Settings > Users if wanted)' });
  }
  return {
    app: 'seerr',
    schemaVersion: raw.version,
    warnings,
    areas: {
      users: { mode: 'import', items: users },
      requestSettings: { mode: 'import', items: settings },
      requests: { mode: 'import', items: requests },
      issues: { mode: 'import', items: issues },
    },
  };
}

// ---- file reader -----------------------------------------------------------------------------------

function loadSettings(dbPath: string, configPath: string | undefined): ConfigTree | null {
  const candidates = configPath ? [configPath] : [join(dirname(dbPath), '..', 'settings.json'), join(dirname(dbPath), 'settings.json')];
  for (const c of candidates) {
    const text = readTextFile(c);
    if (text !== null) return parseJsonConfig(text);
  }
  return null;
}

function mapUserRow(row: ForeignRow, settings: ForeignRow | undefined): SeerrUserPayload {
  const username = str(row['username']) || null;
  const userType = USER_TYPES[int(row['usertype']) ?? 0] ?? 'unknown';
  const mediaServerUsername = userType === 'plex' ? str(row['plexusername']) : str(row['jellyfinusername']);
  return {
    email: str(row['email']) ?? '',
    username,
    displayName: username ?? str(row['plexusername']) ?? str(row['jellyfinusername']) ?? null,
    permissions: int(row['permissions']) ?? 0,
    userType,
    plexId: int(row['plexid']),
    jellyfinUserId: str(row['jellyfinuserid']) || null,
    mediaServerUsername: mediaServerUsername || null,
    avatar: str(row['avatar']) || null,
    movieQuotaLimit: int(row['moviequotalimit']),
    movieQuotaDays: int(row['moviequotadays']),
    tvQuotaLimit: int(row['tvquotalimit']),
    tvQuotaDays: int(row['tvquotadays']),
    locale: str(settings?.['locale']) || null,
    createdAt: isoDate(row['createdat']),
  };
}

export function readSeerr(dbPath: string, configPath: string | undefined, mappings: readonly MigratePathMapping[]): SourceBundle {
  const db = ForeignDb.open(dbPath);
  try {
    if (!db.hasTable('media_request') || !db.hasTable('user')) {
      throw new MigrateError('WRONG_APP', `${dbPath} does not look like an Overseerr/Jellyseerr database (no user/media_request tables)`);
    }
    const settingsByUser = new Map<number, ForeignRow>();
    for (const s of db.rows('user_settings')) {
      const uid = int(s['userid']);
      if (uid !== null) settingsByUser.set(uid, s);
    }
    const media = new Map<number, ForeignRow>();
    for (const m of db.rows('media')) {
      const mid = int(m['id']);
      if (mid !== null) media.set(mid, m);
    }
    const seasonsByRequest = new Map<number, SeerrRequestPayload['seasons']>();
    for (const s of db.rows('season_request')) {
      const rid = int(s['requestid']);
      const n = int(s['seasonnumber']);
      if (rid === null || n === null) continue;
      const list = seasonsByRequest.get(rid) ?? [];
      list.push({ seasonNumber: n, status: REQUEST_STATUS[int(s['status']) ?? 0] ?? null });
      seasonsByRequest.set(rid, list);
    }
    const commentsByIssue = new Map<number, SeerrIssuePayload['comments']>();
    for (const c of db.rows('issue_comment')) {
      const iid = int(c['issueid']);
      if (iid === null) continue;
      const list = commentsByIssue.get(iid) ?? [];
      list.push({ userSourceId: idOf(c['userid']), message: str(c['message']) ?? '', createdAt: isoDate(c['createdat']) });
      commentsByIssue.set(iid, list);
    }
    const settings = loadSettings(dbPath, configPath);
    const version = db.scalar('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');
    const raw: SeerrRaw = {
      version: version === null ? null : String(version),
      users: db.rows('user').map((r) => ({ sourceId: String(int(r['id'])), user: mapUserRow(r, settingsByUser.get(int(r['id']) ?? -1)) })),
      requests: db.rows('media_request').map((r) => {
        const m = media.get(int(r['mediaid']) ?? -1);
        const type = (str(r['type']) ?? str(m?.['mediatype']) ?? 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
        const root = str(r['rootfolder']);
        return {
          sourceId: String(int(r['id'])),
          request: {
            mediaType: type,
            tmdbId: int(m?.['tmdbid']),
            tvdbId: int(m?.['tvdbid']),
            status: REQUEST_STATUS[int(r['status']) ?? 0] ?? null,
            is4k: bool(r['is4k']),
            requestedBySourceId: idOf(r['requestedbyid']),
            modifiedBySourceId: idOf(r['modifiedbyid']),
            seasons: seasonsByRequest.get(int(r['id']) ?? -1) ?? [],
            rootFolder: root ? remapPath(root, mappings).path : null,
            profileId: int(r['profileid']),
            tags: intList(r['tags']),
            isAutoRequest: bool(r['isautorequest']),
            createdAt: isoDate(r['createdat']),
            updatedAt: isoDate(r['updatedat']),
          },
        };
      }),
      issues: db.rows('issue').map((r) => {
        const m = media.get(int(r['mediaid']) ?? -1);
        const mt = str(m?.['mediatype'])?.toLowerCase();
        return {
          sourceId: String(int(r['id'])),
          issue: {
            issueType: ISSUE_TYPES[int(r['issuetype']) ?? 0] ?? 'other',
            status: ISSUE_STATUS[int(r['status']) ?? 0] ?? 'open',
            mediaType: mt === 'tv' ? 'tv' : mt === 'movie' ? 'movie' : null,
            tmdbId: int(m?.['tmdbid']),
            problemSeason: int(r['problemseason']) ?? 0,
            problemEpisode: int(r['problemepisode']) ?? 0,
            createdBySourceId: idOf(r['createdbyid']),
            modifiedBySourceId: idOf(r['modifiedbyid']),
            comments: commentsByIssue.get(int(r['id']) ?? -1) ?? [],
            createdAt: isoDate(r['createdat']),
            updatedAt: isoDate(r['updatedat']),
          },
        };
      }),
      main: settings ? mainSettings(section(settings, 'main')) : null,
      sliders: db.rows('discover_slider').map((s) => ({
        sourceId: String(int(s['id'])),
        slider: { kind: 'slider', type: int(s['type']) ?? 0, order: int(s['order']) ?? 0, isBuiltIn: bool(s['isbuiltin']), enabled: bool(s['enabled'], true), title: str(s['title']), data: str(s['data']) },
      })),
      overrides: db.rows('override_rule').map((o) => {
        const root = str(o['rootfolder']);
        return {
          sourceId: String(int(o['id'])),
          rule: {
            kind: 'override',
            mediaType: int(o['sonarrserviceid']) !== null ? 'tv' : 'movie',
            users: splitList(o['users']),
            genres: intList(o['genre']),
            languages: splitList(o['language']),
            keywords: intList(o['keywords']),
            profileId: int(o['profileid']),
            rootFolder: root ? remapPath(root, mappings).path : null,
            tags: intList(o['tags']),
          },
        };
      }),
    };

    return buildSeerrBundle(raw);
  } finally {
    db.close();
  }
}
