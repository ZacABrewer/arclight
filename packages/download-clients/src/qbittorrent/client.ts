import { z } from 'zod';
import { isLocalhostAddress, isRootedPath, joinRemotePath } from '../paths.js';
import { hashFromMagnet, hashFromTorrentFile, TorrentParseError } from '../torrent-hash.js';
import {
  DownloadClientError,
  type AddTorrentInput,
  type AddTorrentResult,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
} from '../types.js';
import {
  QBT_RATIO_ACTION_DELETE_FILES,
  QBT_RATIO_ACTION_REMOVE,
  QbtCategories,
  QbtFileList,
  QbtPreferences,
  QbtProperties,
  QbtTorrentList,
  type QbtTorrent,
} from './schemas.js';
import { QBittorrentSession, buildBaseUrl } from './session.js';
import { isFinishedState, mapTorrent, needsProperties, type TorrentExtras } from './state.js';

export const QBittorrentSettings = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  useSsl: z.boolean(),
  urlBase: z.string().optional(),
  username: z.string(),
  password: z.string(),
  category: z.string(),
  /** Queue position for recently released content: 'first' moves it to the top. */
  recentPriority: z.enum(['last', 'first']).optional(),
  olderPriority: z.enum(['last', 'first']).optional(),
  initialState: z.enum(['start', 'pause', 'forceStart']).optional(),
});
export type QBittorrentSettings = z.infer<typeof QBittorrentSettings>;

type ApiVersion = readonly [number, number, number];

function parseApiVersion(text: string): ApiVersion {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  if (!match) throw new DownloadClientError('bad-response', `Unrecognised qBittorrent API version "${text}".`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function atLeast(version: ApiVersion, major: number, minor: number, patch: number): boolean {
  const [a, b, c] = version;
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

/** API 2.11.0 (qBittorrent 5.0) renamed pause/resume to stop/start and `paused` to `stopped`. */
function usesStopNaming(version: ApiVersion): boolean {
  return atLeast(version, 2, 11, 0);
}

/** API 2.8.1 accepts ratioLimit/seedingTimeLimit on torrents/add. */
function acceptsShareLimitsOnAdd(version: ApiVersion): boolean {
  return atLeast(version, 2, 8, 1);
}

/** Fourteen days in minutes: shorter global seeding-time removal races with imports. */
const MIN_SAFE_SEEDING_MINUTES = 14 * 24 * 60;
const WAIT_FOR_TORRENT_ATTEMPTS = 10;
const WAIT_FOR_TORRENT_INTERVAL_MS = 100;

function torrentFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'release';
  return `${safe}.torrent`;
}

function magnetHasTrackers(magnet: string): boolean {
  return /[?&]tr(\.\d+)?=/.test(magnet);
}

export class QBittorrentClient implements DownloadClient {
  readonly name = 'qBittorrent';
  private readonly session: QBittorrentSession;
  private apiVersion: ApiVersion | undefined;
  private readonly knownCategories = new Set<string>();

  constructor(
    private readonly settings: QBittorrentSettings,
    private readonly runtime: ClientRuntime,
  ) {
    this.session = new QBittorrentSession(
      {
        baseUrl: buildBaseUrl(settings.host, settings.port, settings.useSsl, settings.urlBase),
        username: settings.username,
        password: settings.password,
      },
      runtime,
    );
  }

  // ---------------------------------------------------------------- DownloadClient

  async test(): Promise<DownloadClientTestResult> {
    this.session.reset();
    this.apiVersion = undefined;
    this.knownCategories.clear();

    const apiVersion = await this.getApiVersion();
    const version = (await this.session.requestText('/api/v2/app/version')).trim().replace(/^v/, '');
    const warnings: string[] = [];

    if (this.settings.category === '') {
      warnings.push('No category is set. A category keeps Media-Tron downloads apart from everything else.');
    } else {
      await this.ensureCategory(this.settings.category);
    }

    const prefs = await this.getPreferences();
    if (removesCompletedDownloads(prefs)) {
      warnings.push(
        'qBittorrent removes torrents when they reach their seeding limit, which can happen before Media-Tron imports them. Set the share limit action to Stop instead.',
      );
    }
    const wantsTopPriority = this.settings.recentPriority === 'first' || this.settings.olderPriority === 'first';
    if (wantsTopPriority && prefs.queueing_enabled === false) {
      warnings.push('Queue priority is set to "first" but torrent queueing is disabled in qBittorrent.');
    }

    await this.listTorrents(this.settings.category);
    return { version, apiVersion: apiVersion.join('.'), warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    const hasMagnet = input.magnet !== undefined && input.magnet !== '';
    const hasFile = input.torrentFile !== undefined && input.torrentFile.length > 0;
    if (hasMagnet === hasFile) {
      throw new DownloadClientError('rejected', 'Provide exactly one of a magnet link or a torrent file.');
    }

    const id = await this.computeId(input);
    const apiVersion = await this.getApiVersion();

    if (hasMagnet && input.magnet !== undefined && !magnetHasTrackers(input.magnet)) {
      const prefs = await this.getPreferences();
      if (prefs.dht === false) {
        throw new DownloadClientError('rejected', 'Magnet link has no trackers and DHT is disabled in qBittorrent.');
      }
    }

    if (input.category !== '') await this.ensureCategory(input.category, input.savePath);

    const initialState = input.paused === undefined
      ? (this.settings.initialState ?? 'start')
      : input.paused ? 'pause' : 'start';

    const form = new FormData();
    if (hasMagnet && input.magnet !== undefined) {
      form.append('urls', input.magnet);
    } else if (input.torrentFile !== undefined) {
      // Copy into a plain ArrayBuffer so Blob accepts it regardless of the source buffer kind.
      form.append('torrents', new Blob([input.torrentFile.slice()], { type: 'application/x-bittorrent' }), torrentFileName(input.title));
    }
    if (input.category !== '') form.append('category', input.category);
    if (input.savePath !== undefined && input.savePath !== '') {
      form.append('savepath', input.savePath);
      form.append('autoTMM', 'false');
    }
    form.append(usesStopNaming(apiVersion) ? 'stopped' : 'paused', initialState === 'pause' ? 'true' : 'false');

    const hasShareLimits = input.seedRatioLimit !== undefined || input.seedTimeLimitMinutes !== undefined;
    const shareLimitsOnAdd = hasShareLimits && acceptsShareLimitsOnAdd(apiVersion);
    if (shareLimitsOnAdd) {
      if (input.seedRatioLimit !== undefined) form.append('ratioLimit', String(input.seedRatioLimit));
      if (input.seedTimeLimitMinutes !== undefined) {
        form.append('seedingTimeLimit', String(Math.round(input.seedTimeLimitMinutes)));
      }
    }

    const reply = (await this.session.requestText('/api/v2/torrents/add', { body: form })).trim();
    if (reply === 'Fails.') {
      throw new DownloadClientError(
        'rejected',
        'qBittorrent refused the torrent (already added, or the torrent is invalid).',
      );
    }

    const priority = input.isRecent === true ? this.settings.recentPriority : this.settings.olderPriority;
    const moveToTop = priority === 'first';
    const forceStart = initialState === 'forceStart';
    const needsShareLimitsAfter = hasShareLimits && !shareLimitsOnAdd;
    const warnings: string[] = [];

    if (moveToTop || forceStart || needsShareLimitsAfter) {
      if (!(await this.waitForTorrent(id))) {
        warnings.push(`Torrent ${id} did not appear in qBittorrent in time; priority, force start and share limits were not applied.`);
        return { id, warnings };
      }
      if (needsShareLimitsAfter) {
        await this.attempt(warnings, 'set share limits', () =>
          this.post('/api/v2/torrents/setShareLimits', {
            hashes: id,
            ratioLimit: String(input.seedRatioLimit ?? -2),
            seedingTimeLimit: String(input.seedTimeLimitMinutes === undefined ? -2 : Math.round(input.seedTimeLimitMinutes)),
            inactiveSeedingTimeLimit: '-2',
          }),
        );
      }
      if (moveToTop) {
        await this.attempt(warnings, 'move to top of queue', async () => {
          try {
            await this.post('/api/v2/torrents/topPrio', { hashes: id });
          } catch (error) {
            // 409 means torrent queueing is disabled; priority is meaningless then.
            if (error instanceof DownloadClientError && error.httpStatus === 409) {
              throw new DownloadClientError('rejected', 'torrent queueing is disabled in qBittorrent', { cause: error });
            }
            throw error;
          }
        });
      }
      if (forceStart) {
        await this.attempt(warnings, 'force start', () =>
          this.post('/api/v2/torrents/setForceStart', { hashes: id, value: 'true' }),
        );
      }
    }

    return { id, warnings };
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const [prefs, torrents] = await Promise.all([this.getPreferences(), this.listTorrents(category)]);
    const nowMs = this.runtime.now();

    return Promise.all(
      torrents.map(async (torrent) => {
        let extras: TorrentExtras = {};
        if (needsProperties(torrent, prefs)) extras = await this.fetchExtras(torrent.hash);
        const fallbackOutputPath = torrent.content_path === undefined && isFinishedState(torrent.state)
          ? await this.deriveOutputPath(torrent)
          : undefined;
        return mapTorrent(torrent, {
          prefs,
          nowMs,
          extras,
          ...(fallbackOutputPath === undefined ? {} : { fallbackOutputPath }),
        });
      }),
    );
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    await this.post('/api/v2/torrents/delete', {
      hashes: id.toLowerCase(),
      deleteFiles: deleteData ? 'true' : 'false',
    });
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const prefs = await this.getPreferences();
    let outputRootDir = prefs.save_path;

    if (this.settings.category !== '') {
      const categories = await this.getCategories();
      let categoryPath = categories[this.settings.category]?.savePath ?? '';
      if (categoryPath !== '') {
        // A leading "//" is almost always a Windows UNC path entered with forward slashes.
        if (categoryPath.startsWith('//')) categoryPath = categoryPath.replace(/\//g, '\\');
        outputRootDir = isRootedPath(categoryPath) ? categoryPath : joinRemotePath(outputRootDir, categoryPath);
      } else if (prefs.auto_tmm_enabled === true) {
        // Automatic management saves a category without its own path to <save_path>/<category>.
        outputRootDir = joinRemotePath(outputRootDir, this.settings.category);
      }
    }

    return {
      outputRootDir,
      isLocalhost: isLocalhostAddress(this.settings.host),
      removesCompletedDownloads: removesCompletedDownloads(prefs),
    };
  }

  async setCategory(id: string, category: string): Promise<void> {
    if (category !== '') await this.ensureCategory(category);
    await this.post('/api/v2/torrents/setCategory', { hashes: id.toLowerCase(), category });
  }

  async pause(id: string): Promise<void> {
    const version = await this.getApiVersion();
    await this.post(usesStopNaming(version) ? '/api/v2/torrents/stop' : '/api/v2/torrents/pause', {
      hashes: id.toLowerCase(),
    });
  }

  async resume(id: string): Promise<void> {
    const version = await this.getApiVersion();
    await this.post(usesStopNaming(version) ? '/api/v2/torrents/start' : '/api/v2/torrents/resume', {
      hashes: id.toLowerCase(),
    });
  }

  // ---------------------------------------------------------------- qBittorrent helpers

  /** Creates the category if qBittorrent does not know it yet. */
  async ensureCategory(category: string, savePath?: string): Promise<void> {
    if (this.knownCategories.has(category)) return;
    const categories = await this.getCategories();
    if (!(category in categories)) {
      const body: Record<string, string> = { category };
      if (savePath !== undefined && savePath !== '') body['savePath'] = savePath;
      try {
        await this.post('/api/v2/torrents/createCategory', body);
      } catch (error) {
        // 409: created concurrently by someone else; that is fine.
        if (!(error instanceof DownloadClientError && error.httpStatus === 409)) throw error;
      }
    }
    this.knownCategories.add(category);
  }

  private async getApiVersion(): Promise<ApiVersion> {
    if (this.apiVersion !== undefined) return this.apiVersion;
    let text: string;
    try {
      text = await this.session.requestText('/api/v2/app/webapiVersion');
    } catch (error) {
      if (error instanceof DownloadClientError && error.code === 'not-found') {
        throw new DownloadClientError(
          'bad-response',
          'qBittorrent WebUI API v2 is not available. qBittorrent 4.1 or newer is required.',
          { cause: error, httpStatus: 404 },
        );
      }
      throw error;
    }
    const version = parseApiVersion(text);
    if (version[0] < 2) {
      throw new DownloadClientError('bad-response', `qBittorrent API ${text.trim()} is too old; 2.0 or newer is required.`);
    }
    this.apiVersion = version;
    return version;
  }

  private getPreferences(): Promise<QbtPreferences> {
    return this.session.requestJson('/api/v2/app/preferences', QbtPreferences);
  }

  private getCategories(): Promise<QbtCategories> {
    return this.session.requestJson('/api/v2/torrents/categories', QbtCategories);
  }

  private listTorrents(category: string): Promise<QbtTorrent[]> {
    const options = category === '' ? {} : { query: { category } };
    return this.session.requestJson('/api/v2/torrents/info', QbtTorrentList, options);
  }

  private async fetchExtras(hash: string): Promise<TorrentExtras> {
    const props = await this.session.requestJson('/api/v2/torrents/properties', QbtProperties, {
      query: { hash: hash.toLowerCase() },
    });
    const extras: TorrentExtras = {};
    if (props.seeding_time !== undefined) extras.seedingTimeSeconds = props.seeding_time;
    if (props.is_private !== undefined) extras.isPrivate = props.is_private;
    return extras;
  }

  /** For API < 2.6.1 (no content_path): save_path joined with the top-level entry of the first file. */
  private async deriveOutputPath(torrent: QbtTorrent): Promise<string | undefined> {
    const files = await this.session.requestJson('/api/v2/torrents/files', QbtFileList, {
      query: { hash: torrent.hash.toLowerCase() },
    });
    const first = files[0];
    if (first === undefined) return undefined;
    // qBittorrent uses "/" in file names on every platform.
    const topLevel = first.name.split(/[\\/]/)[0] ?? first.name;
    return joinRemotePath(torrent.save_path, topLevel);
  }

  private async computeId(input: AddTorrentInput): Promise<string> {
    try {
      if (input.magnet !== undefined && input.magnet !== '') {
        const hash = hashFromMagnet(input.magnet);
        if (hash === undefined) throw new TorrentParseError('Magnet link has no BitTorrent info-hash');
        return hash;
      }
      return await hashFromTorrentFile(input.torrentFile ?? new Uint8Array());
    } catch (error) {
      if (error instanceof TorrentParseError) {
        throw new DownloadClientError('rejected', `Invalid release: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  private async waitForTorrent(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < WAIT_FOR_TORRENT_ATTEMPTS; attempt++) {
      try {
        await this.session.requestText('/api/v2/torrents/properties', { query: { hash: id } });
        return true;
      } catch (error) {
        if (!(error instanceof DownloadClientError && error.code === 'not-found')) throw error;
      }
      await this.runtime.sleep(WAIT_FOR_TORRENT_INTERVAL_MS);
    }
    return false;
  }

  private async attempt(warnings: string[], what: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!(error instanceof DownloadClientError)) throw error;
      warnings.push(`Could not ${what}: ${error.message}`);
    }
  }

  private async post(path: string, body: Record<string, string>): Promise<void> {
    await this.session.requestText(path, { body });
  }
}

export function removesCompletedDownloads(prefs: QbtPreferences): boolean {
  const removes = prefs.max_ratio_act === QBT_RATIO_ACTION_REMOVE || prefs.max_ratio_act === QBT_RATIO_ACTION_DELETE_FILES;
  if (!removes) return false;
  const ratioEnabled = prefs.max_ratio_enabled ?? (prefs.max_ratio !== undefined && prefs.max_ratio >= 0);
  const timeEnabled = prefs.max_seeding_time_enabled ??
    (prefs.max_seeding_time !== undefined && prefs.max_seeding_time >= 0);
  const shortTime = timeEnabled && (prefs.max_seeding_time ?? 0) < MIN_SAFE_SEEDING_MINUTES;
  return ratioEnabled || shortTime;
}
