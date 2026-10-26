import { downloadClientSettingsSchemas, type DownloadClientImplementation } from '@arclight/shared';
import type { DownloadClientInputRaw } from '../../download-clients/service.js';
import { bool, field, int, str } from '../foreign-db.js';
import type { ArrApp } from './quality.js';

// Download client settings per upstream implementation. qBittorrent, Transmission, Deluge,
// rTorrent, SABnzbd and NZBGet map onto Arclight's clients field by field; anything else
// (blackholes, Flood, Aria2, Download Station...) is normalised into one shape and staged under
// `downloadClients.unsupported` so a later module can pick it up.

export interface StagedDownloadClient {
  upstreamImplementation: string;
  name: string;
  enable: boolean;
  priority: number;
  host: string | null;
  port: number | null;
  useSsl: boolean;
  urlBase: string | null;
  username: string | null;
  password: string | null;
  apiKey: string | null;
  category: string | null;
  postImportCategory: string | null;
  directory: string | null;
  addPaused: boolean;
  /** The upstream settings object, for fields this shape does not name. */
  settings: Record<string, unknown>;
}

export interface DownloadClientCommon {
  name: string;
  enable: boolean;
  priority: number;
  removeCompletedDownloads: boolean;
  removeFailedDownloads: boolean;
}

export type NativeDownloadClientInput = DistributiveOmit<DownloadClientInputRaw, 'tags'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DownloadClientMapResult =
  | { kind: 'native'; input: NativeDownloadClientInput }
  | { kind: 'staged'; staged: StagedDownloadClient; reason: string };

const NATIVE: Record<string, DownloadClientImplementation> = {
  qbittorrent: 'qbittorrent',
  transmission: 'transmission',
  deluge: 'deluge',
  rtorrent: 'rtorrent',
  sabnzbd: 'sabnzbd',
  nzbget: 'nzbget',
};

const TWO_STEP = (v: number | null) => (v === 1 ? 'first' : 'last');
const RTORRENT: Record<number, string> = { 0: 'off', 1: 'low', 2: 'normal', 3: 'high' };
const SABNZBD: Record<number, string> = { [-100]: 'default', [-2]: 'paused', [-1]: 'low', 0: 'normal', 1: 'high', 2: 'force' };
const NZBGET: Record<number, string> = { [-100]: 'veryLow', [-50]: 'low', 0: 'normal', 50: 'high', 100: 'veryHigh', 900: 'force' };

function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export function mapDownloadClient(app: ArrApp, implementation: string, common: DownloadClientCommon, settings: Record<string, unknown>): DownloadClientMapResult {
  const impl = implementation.toLowerCase();
  const g = (...names: string[]) => field(settings, ...names);
  const pick = (tv: string, movie: string) => (app === 'sonarr' ? g(tv) : g(movie));
  const category = str(pick('tvCategory', 'movieCategory')) ?? str(g('category'));
  const imported = str(pick('tvImportedCategory', 'movieImportedCategory'));
  const recent = int(pick('recentTvPriority', 'recentMoviePriority'));
  const older = int(pick('olderTvPriority', 'olderMoviePriority'));
  const directory = str(pick('tvDirectory', 'movieDirectory'));
  const port = int(g('port'));
  const base = {
    host: str(g('host')) ?? 'localhost',
    ...(port && port > 0 && port <= 65535 ? { port } : {}),
    useSsl: bool(g('useSsl')),
    urlBase: str(g('urlBase')) ?? undefined,
    category: category ?? undefined,
    postImportCategory: imported ?? undefined,
  };
  const addPaused = bool(g('addPaused')) || bool(g('addStopped'));
  const native = NATIVE[impl];

  let candidate: Record<string, unknown> | null = null;
  switch (native) {
    case 'qbittorrent': {
      const initial = int(g('initialState'));
      const layout = int(g('contentLayout'));
      candidate = defined({
        ...base,
        username: str(g('username')) ?? '',
        password: str(g('password')) ?? '',
        recentPriority: TWO_STEP(recent),
        olderPriority: TWO_STEP(older),
        // Upstream enum: 0 start, 1 force start, 2 pause.
        initialState: initial === 1 ? 'forceStart' : initial === 2 ? 'pause' : 'start',
        sequentialOrder: bool(g('sequentialOrder')),
        firstAndLast: bool(g('firstAndLast')),
        contentLayout: layout === 1 ? 'original' : layout === 2 ? 'subfolder' : layout === 3 ? 'noSubfolder' : 'default',
      });
      break;
    }
    case 'transmission':
      candidate = defined({ ...base, username: str(g('username')), password: str(g('password')), directory, recentPriority: TWO_STEP(recent), olderPriority: TWO_STEP(older), addPaused });
      break;
    case 'deluge':
      candidate = defined({ ...base, password: str(g('password')), recentPriority: TWO_STEP(recent), olderPriority: TWO_STEP(older), addPaused });
      if (typeof candidate['category'] === 'string') candidate['category'] = candidate['category'].toLowerCase();
      if (typeof candidate['postImportCategory'] === 'string') candidate['postImportCategory'] = candidate['postImportCategory'].toLowerCase();
      break;
    case 'rtorrent':
      candidate = defined({
        ...base,
        username: str(g('username')),
        password: str(g('password')),
        directory,
        addPaused,
        recentPriority: recent !== null ? RTORRENT[recent] : undefined,
        olderPriority: older !== null ? RTORRENT[older] : undefined,
      });
      break;
    case 'sabnzbd':
      candidate = defined({
        ...base,
        apiKey: str(g('apiKey')),
        username: str(g('username')),
        password: str(g('password')),
        recentPriority: recent !== null ? SABNZBD[recent] : undefined,
        olderPriority: older !== null ? SABNZBD[older] : undefined,
      });
      break;
    case 'nzbget':
      candidate = defined({
        ...base,
        username: str(g('username')),
        password: str(g('password')),
        recentPriority: recent !== null ? NZBGET[recent] : undefined,
        olderPriority: older !== null ? NZBGET[older] : undefined,
        addPaused,
      });
      break;
    default:
      break;
  }

  if (native && candidate) {
    const parsed = downloadClientSettingsSchemas[native].safeParse(candidate);
    if (parsed.success) {
      return { kind: 'native', input: { ...common, implementation: native, settings: parsed.data } as NativeDownloadClientInput };
    }
    const first = parsed.error.issues[0];
    return {
      kind: 'staged',
      staged: stagedShape(implementation, common, settings, category, imported, directory, addPaused),
      reason: `settings do not validate (${first ? `${first.path.join('.')}: ${first.message}` : 'invalid'}); staged for review`,
    };
  }
  return {
    kind: 'staged',
    staged: stagedShape(implementation, common, settings, category, imported, directory, addPaused),
    reason: `${implementation || 'unknown'} is not supported by Arclight (staged for later)`,
  };
}

function stagedShape(
  implementation: string,
  common: DownloadClientCommon,
  settings: Record<string, unknown>,
  category: string | null,
  imported: string | null,
  directory: string | null,
  addPaused: boolean,
): StagedDownloadClient {
  return {
    upstreamImplementation: implementation,
    name: common.name,
    enable: common.enable,
    priority: common.priority,
    host: str(field(settings, 'host')),
    port: int(field(settings, 'port')),
    useSsl: bool(field(settings, 'useSsl')),
    urlBase: str(field(settings, 'urlBase')),
    username: str(field(settings, 'username')),
    password: str(field(settings, 'password')),
    apiKey: str(field(settings, 'apiKey')),
    category,
    postImportCategory: imported,
    directory: directory ?? str(field(settings, 'directory', 'torrentFolder', 'nzbFolder', 'watchFolder')),
    addPaused,
    settings,
  };
}
