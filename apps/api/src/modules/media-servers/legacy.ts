import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { normaliseBaseUrl } from '@arclight/media-servers';
import { MediaServerSettings, type MediaServerConfig, type MediaServerKind } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { settings } from '../../db/schema.js';
import { getSection, setSection } from '../settings/service.js';

// The single-server `mediaServer` shape (requests module: sign-in, user links, user import and
// the old GET/PUT /settings/mediaserver route) as a view over the `mediaServers` list, which is
// the source of truth. The view's server is the first enabled one flagged `loginEnabled`, else
// the first enabled one (so a server used only for user import and links still shows), else none.

export const LEGACY_MEDIA_SERVER_SECTION = 'mediaServer';

const PRODUCT_NAMES: Record<MediaServerKind, string> = { jellyfin: 'Jellyfin', emby: 'Emby', plex: 'Plex' };

function list(db: Db): MediaServerConfig[] {
  return getSection(db, 'mediaServers').servers;
}

/** The list entry the legacy view points at, if any. */
export function primaryMediaServer(servers: readonly MediaServerConfig[]): MediaServerConfig | undefined {
  return servers.find((s) => s.enabled && s.loginEnabled) ?? servers.find((s) => s.enabled);
}

function toView(config: MediaServerConfig | undefined): MediaServerSettings {
  if (!config) return MediaServerSettings.parse({ loginEnabled: false, createUsersOnLogin: false });
  return {
    kind: config.kind,
    url: config.url,
    apiKey: config.apiKey,
    name: config.name,
    loginEnabled: config.loginEnabled,
    createUsersOnLogin: config.createUsersOnLogin,
  };
}

/** The `mediaServer` view (with secrets; callers mask). */
export function mediaServerView(db: Db): MediaServerSettings {
  return toView(primaryMediaServer(list(db)));
}

function cleanUrl(url: string): string {
  return url ? normaliseBaseUrl(url) : '';
}

function uniqueName(servers: readonly MediaServerConfig[], wanted: string, selfId: string | null): string {
  const taken = new Set(servers.filter((s) => s.id !== selfId).map((s) => s.name.toLowerCase()));
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted} ${n}`;
  return name;
}

/**
 * Writes a `mediaServer` value into the list: updates the view's server in place (its purpose
 * flags are kept), appends a new entry when there is none, and with `kind: null` turns login off
 * on the view's server (removing it when nothing else uses it). `apiKey` is taken as given;
 * callers resolve a masked key first. Returns the new view.
 */
export function saveMediaServerView(db: Db, value: MediaServerSettings, now?: string, newId: () => string = randomUUID): MediaServerSettings {
  const servers = list(db);
  const current = primaryMediaServer(servers);
  let next: MediaServerConfig[];
  if (!value.kind) {
    if (!current) return mediaServerView(db);
    const stillUsed = current.usedForRetention || current.usedForRefresh;
    next = stillUsed
      ? servers.map((s) => (s.id === current.id ? { ...s, loginEnabled: false, createUsersOnLogin: false, usedForAvailability: false } : s))
      : servers.filter((s) => s.id !== current.id);
  } else {
    const fields = {
      kind: value.kind,
      url: cleanUrl(value.url),
      apiKey: value.apiKey,
      loginEnabled: value.loginEnabled,
      createUsersOnLogin: value.createUsersOnLogin,
    };
    const wantedName = value.name || PRODUCT_NAMES[value.kind];
    if (current) {
      next = servers.map((s) => (s.id === current.id ? { ...s, ...fields, name: uniqueName(servers, wantedName, s.id) } : s));
    } else {
      next = [
        ...servers,
        {
          ...fields,
          id: newId(),
          name: uniqueName(servers, wantedName, null),
          enabled: true,
          usedForAvailability: true,
          usedForRetention: false,
          usedForRefresh: false,
        },
      ];
    }
  }
  setSection(db, 'mediaServers', { servers: next }, now);
  return mediaServerView(db);
}

/**
 * One-time move of a stored legacy `mediaServer` value into the list. The legacy row is removed
 * afterwards, so this is a no-op on every later boot. An entry with the same kind and URL is
 * reused (its login flags are set from the legacy value) instead of duplicated.
 */
export function migrateLegacyMediaServer(db: Db, newId: () => string = randomUUID): boolean {
  const row = db.select().from(settings).where(eq(settings.key, LEGACY_MEDIA_SERVER_SECTION)).get();
  if (!row) return false;
  const legacy = MediaServerSettings.safeParse(row.value);
  let migrated = false;
  if (legacy.success && legacy.data.kind && legacy.data.url) {
    const value = legacy.data;
    const url = cleanUrl(value.url);
    const servers = list(db);
    const same = servers.find((s) => s.kind === value.kind && s.url === url);
    if (same) {
      setSection(db, 'mediaServers', {
        servers: servers.map((s) =>
          s.id === same.id
            ? { ...s, apiKey: s.apiKey || value.apiKey, loginEnabled: value.loginEnabled, createUsersOnLogin: value.createUsersOnLogin }
            : s,
        ),
      });
    } else {
      const kind = value.kind as MediaServerKind;
      // Prepended so the migrated server stays the one the legacy view (sign-in) points at.
      setSection(db, 'mediaServers', {
        servers: [
          {
            id: newId(),
            kind,
            name: uniqueName(servers, value.name || PRODUCT_NAMES[kind], null),
            url,
            apiKey: value.apiKey,
            enabled: true,
            usedForAvailability: true,
            usedForRetention: false,
            usedForRefresh: false,
            loginEnabled: value.loginEnabled,
            createUsersOnLogin: value.createUsersOnLogin,
          },
          ...servers,
        ],
      });
    }
    migrated = true;
  }
  db.delete(settings).where(eq(settings.key, LEGACY_MEDIA_SERVER_SECTION)).run();
  return migrated;
}
