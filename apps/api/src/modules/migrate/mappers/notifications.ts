import { agentSettingsSchemas } from '@arclight/notifications';
import type { NotificationImplementation, NotificationTrigger } from '@arclight/shared';
import { bool, field, int, str, type ForeignRow } from '../foreign-db.js';

// Notification connections per upstream implementation. Settings are translated field by
// field and validated with the agent package's schema so the plan can show what will fail.

const IMPLEMENTATIONS: Record<string, NotificationImplementation> = {
  discord: 'discord',
  telegram: 'telegram',
  webhook: 'webhook',
  email: 'email',
  customscript: 'custom-script',
  ntfy: 'ntfy',
  gotify: 'gotify',
  pushover: 'pushover',
  jellyfin: 'jellyfin',
  emby: 'emby',
  mediabrowser: 'emby',
  plexserver: 'plex',
  plex: 'plex',
};

export interface NotificationMapResult {
  implementation: NotificationImplementation | null;
  settings: Record<string, unknown>;
  triggers: Partial<Record<NotificationTrigger, boolean>>;
  includeHealthWarnings: boolean;
  /** Set when the connection cannot be imported. */
  unsupported?: string;
  notes: string[];
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = str(v);
  return s ? s.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
}

function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function translateSettings(impl: NotificationImplementation, s: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const g = (...names: string[]) => field(s, ...names);
  switch (impl) {
    case 'discord':
      notes.push('Discord embed field lists use Arclight defaults');
      return defined({ webhookUrl: str(g('webHookUrl', 'webhookUrl')), username: str(g('username')), avatarUrl: str(g('avatar')), author: str(g('author')) });
    case 'telegram': {
      const topic = int(g('topicId'));
      return defined({
        botToken: str(g('botToken')),
        chatId: str(g('chatId')),
        topicId: topic !== null && topic > 1 ? topic : undefined,
        sendSilently: bool(g('sendSilently')),
      });
    }
    case 'webhook': {
      const headers: Record<string, string> = {};
      const rawHeaders = g('headers');
      if (Array.isArray(rawHeaders)) {
        for (const h of rawHeaders) {
          if (h && typeof h === 'object') {
            const k = str(field(h as Record<string, unknown>, 'key'));
            const v = str(field(h as Record<string, unknown>, 'value'));
            if (k && v !== null) headers[k] = v;
          }
        }
      }
      return defined({ url: str(g('url')), method: int(g('method')) === 2 ? 'PUT' : 'POST', username: str(g('username')), password: str(g('password')), headers });
    }
    case 'email': {
      // Upstream encryption: 0 preferred (STARTTLS when offered), 1 always, 2 never; older schemas had a `requireEncryption`/`ssl` bool.
      const enc = int(g('useEncryption'));
      const port = int(g('port')) ?? 587;
      const security = enc === 2 ? 'none' : port === 465 || bool(g('ssl')) ? 'tls' : 'starttls';
      return defined({
        host: str(g('server', 'host')),
        port,
        security,
        username: str(g('username')),
        password: str(g('password')),
        from: str(g('from')),
        to: list(g('to')),
        cc: list(g('cc')),
        bcc: list(g('bcc')),
      });
    }
    case 'custom-script':
      return defined({ path: str(g('path')), arguments: str(g('arguments')) ?? '' });
    case 'ntfy': {
      const priority = int(g('priority'));
      return defined({
        serverUrl: str(g('serverUrl')) ?? 'https://ntfy.sh',
        topics: list(g('topics')),
        priority: priority && priority >= 1 && priority <= 5 ? priority : undefined,
        tags: list(g('tags')),
        clickUrl: str(g('clickUrl')),
        accessToken: str(g('accessToken')),
        username: str(g('userName', 'username')),
        password: str(g('password')),
      });
    }
    case 'gotify': {
      const priority = int(g('priority'));
      return defined({ serverUrl: str(g('server', 'serverUrl')), appToken: str(g('appToken')), priority: priority !== null ? Math.min(10, Math.max(0, priority)) : undefined });
    }
    case 'pushover': {
      const priority = int(g('priority'));
      return defined({
        apiToken: str(g('apiKey', 'apiToken')),
        userKey: str(g('userKey')),
        devices: list(g('devices')),
        priority: priority !== null && priority >= -2 && priority <= 2 ? priority : undefined,
        retry: int(g('retry')) ?? undefined,
        expire: int(g('expire')) ?? undefined,
        sound: str(g('sound')),
      });
    }
    case 'jellyfin':
    case 'emby':
      return defined({
        host: str(g('host')),
        port: int(g('port')) ?? 8096,
        useSsl: bool(g('useSsl')),
        urlBase: str(g('urlBase')),
        apiKey: str(g('apiKey')),
        updateLibrary: bool(g('updateLibrary'), true),
        ...(impl === 'emby' ? { notify: bool(g('notify')) } : {}),
      });
    case 'plex':
      return defined({ host: str(g('host')), port: int(g('port')) ?? 32400, useSsl: bool(g('useSsl')), authToken: str(g('authToken')), updateLibrary: bool(g('updateLibrary'), true) });
  }
}

/** One Notifications row (any arr app) → Arclight connection parts. */
export function mapNotification(row: ForeignRow, settings: Record<string, unknown>): NotificationMapResult {
  const upstream = str(row['implementation']) ?? '';
  const name = str(row['name']) ?? '';
  let impl = IMPLEMENTATIONS[upstream.toLowerCase()] ?? null;
  if (impl === 'emby' && /jellyfin/i.test(name)) impl = 'jellyfin';
  const triggers: Partial<Record<NotificationTrigger, boolean>> = {
    onGrab: bool(row['ongrab']),
    onDownload: bool(row['ondownload'] ?? row['onimportcomplete']),
    onUpgrade: bool(row['onupgrade']),
    onRename: bool(row['onrename']),
    onSeriesAdd: bool(row['onseriesadd']),
    onMovieAdd: bool(row['onmovieadded'] ?? row['onmovieadd']),
    onSeriesDelete: bool(row['onseriesdelete']),
    onMovieDelete: bool(row['onmoviedelete']),
    onFileDelete: bool(row['onepisodefiledelete']) || bool(row['onmoviefiledelete']),
    onHealthIssue: bool(row['onhealthissue']),
    onHealthRestored: bool(row['onhealthrestored']),
    onApplicationUpdate: bool(row['onapplicationupdate']),
    onManualInteractionRequired: bool(row['onmanualinteractionrequired']),
  };
  const notes: string[] = [];
  if (!impl) {
    return { implementation: null, settings: {}, triggers, includeHealthWarnings: false, unsupported: `${upstream || 'unknown'} notifications are not supported`, notes };
  }
  const translated = translateSettings(impl, settings, notes);
  const parsed = agentSettingsSchemas[impl].safeParse(translated);
  const result: NotificationMapResult = { implementation: impl, settings: translated, triggers, includeHealthWarnings: bool(row['includehealthwarnings']), notes };
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    result.unsupported = `settings do not validate (${first ? `${first.path.join('.')}: ${first.message}` : 'invalid'})`;
  }
  return result;
}
