import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Bitfield,
  parseMagnet,
  parseTorrent,
  TorrentEngineError,
  type AddTorrentOptions,
  type Metainfo,
  type ResumeData,
  type Session,
  type Torrent,
  type TorrentStats,
} from '@arclight/torrent-engine';
import {
  DownloadClientError,
  type AddNzbResult,
  type AddTorrentInput,
  type AddTorrentResult,
  type DownloadClient,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
  type DownloadItemLive,
  type DownloadItemPhase,
  type DownloadItemStatus,
  type ItemSpeedLimits,
  type QueueMove,
} from '../types.js';
import type { BuiltinSettings } from './settings.js';

/** Version reported by `test()` for the in-process engine. */
export const BUILTIN_ENGINE_VERSION = '0.1.0';

/**
 * Where the client finds the api's torrent engine. A getter lets the api start, stop and
 * restart the engine without rebuilding clients; it returns null while the engine is off.
 */
export type SessionSource = Session | (() => Session | null);

const NOT_RUNNING = 'The built-in torrent engine is not running. Enable it under Settings > Torrent Engine.';

/**
 * A private tracker's hit-and-run rule. The torrent may leave the client once it has seeded
 * `minSeedHours` or reached `minRatio` (either one when both are set).
 */
export interface SeedRule {
  minSeedHours?: number;
  minRatio?: number;
  /** Shown in messages, e.g. the indexer name. */
  label?: string;
}

/**
 * Looks up the hit-and-run rule for a torrent from its announce hosts (lowercase host names,
 * no port) and info-hash. Null when no tracker rule applies.
 */
export type SeedRuleProvider = (hosts: readonly string[], infoHash: string) => SeedRule | null;

const sessionSeedRules = new WeakMap<Session, SeedRuleProvider>();

/**
 * Attaches hit-and-run rules to a Session, so every `BuiltinClient` driving it guards
 * removals (the api's torrent module does this whenever it starts the engine). null detaches.
 */
export function attachSeedRules(session: Session, provider: SeedRuleProvider | null): void {
  if (provider) sessionSeedRules.set(session, provider);
  else sessionSeedRules.delete(session);
}

export interface BuiltinClientOptions {
  /** Hit-and-run rules; defaults to the provider attached to the Session, if any. */
  seedRules?: SeedRuleProvider;
}

/** Lowercase announce host names of a torrent (trackers of the .torrent and of its magnet). */
export function announceHosts(t: Pick<Torrent, 'metainfo' | 'magnet' | 'getTrackers'>): string[] {
  const urls = [
    ...(t.metainfo?.announceList.flat() ?? []),
    ...(t.metainfo?.announce ? [t.metainfo.announce] : []),
    ...(t.magnet?.trackers ?? []),
    ...t.getTrackers().map((tr) => tr.url),
  ];
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host) hosts.add(host);
    } catch {
      // Not a URL: ignore.
    }
  }
  return [...hosts];
}

/** Message when `rule` is not satisfied yet by these stats; null when it is (or is empty). */
export function seedRulePending(rule: SeedRule, stats: Pick<TorrentStats, 'seedingTimeMs' | 'ratio'>): string | null {
  const hours = rule.minSeedHours;
  const ratio = rule.minRatio;
  if (hours === undefined && ratio === undefined) return null;
  const timeMet = hours !== undefined && stats.seedingTimeMs >= hours * 3_600_000;
  const ratioMet = ratio !== undefined && stats.ratio >= ratio;
  if (timeMet || ratioMet) return null;
  const needs = [hours !== undefined ? `${hours} h of seeding` : null, ratio !== undefined ? `ratio ${ratio}` : null]
    .filter((x): x is string => x !== null)
    .join(' or ');
  const seeded = (stats.seedingTimeMs / 3_600_000).toFixed(1);
  const who = rule.label ? `${rule.label} ` : '';
  return `Hit-and-run guard: ${who}requires ${needs} (seeded ${seeded} h, ratio ${stats.ratio.toFixed(2)}).`;
}

/**
 * Fast-resume data claiming every piece of `meta` is present at `savePath`, so the engine
 * seeds without hashing (cross-seeding a payload that was verified beforehand). Undefined
 * when a file is missing or has the wrong size: the engine then checks normally.
 */
export async function completeResumeData(
  meta: Metainfo,
  savePath: string,
  init: { category: string; paused: boolean; now?: Date },
): Promise<ResumeData | undefined> {
  const fileStats: ResumeData['fileStats'] = [];
  for (const f of meta.files) {
    if (f.padding) {
      fileStats.push(null);
      continue;
    }
    try {
      const s = await stat(join(savePath, ...f.pathSegments));
      if (!s.isFile() || s.size !== f.length) return undefined;
      fileStats.push({ size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
    } catch {
      return undefined;
    }
  }
  const at = (init.now ?? new Date()).toISOString();
  return {
    version: 1,
    infoHash: meta.infoHashHex,
    name: meta.name,
    bitfield: Bitfield.full(meta.pieceCount).toBuffer().toString('base64'),
    pieceCount: meta.pieceCount,
    uploaded: 0,
    downloaded: 0,
    seedingTimeMs: 0,
    activeTimeMs: 0,
    addedAt: at,
    completedAt: at,
    savePath,
    category: init.category,
    tags: [],
    filePriorities: [],
    paused: init.paused,
    sequential: false,
    fileStats,
    magnet: null,
    seedRatioLimit: null,
    seedTimeLimitMs: null,
  };
}

/**
 * Live transfer numbers of an engine torrent, for queue items (also used by the api to show
 * up-to-the-second numbers between queue polls).
 */
export function builtinLive(t: Torrent, stats: TorrentStats = t.getStats(), queuePosition?: number): DownloadItemLive {
  let tcp = 0;
  let utp = 0;
  let encrypted = 0;
  for (const p of t.getPeers()) {
    if (p.transport === 'utp') utp++;
    else tcp++;
    if (p.encrypted) encrypted++;
  }
  const limits = t.rateLimits;
  return {
    downloadRate: stats.downloadRate,
    uploadRate: stats.uploadRate,
    downloadLimit: limits.downloadLimit,
    uploadLimit: limits.uploadLimit,
    forceStart: t.forceStart,
    ...(queuePosition !== undefined ? { queuePosition } : {}),
    connectedPeers: stats.connectedPeers,
    connectedSeeds: stats.connectedSeeds,
    swarmSeeds: stats.swarmSeeds,
    swarmLeechers: stats.swarmLeechers,
    piecesHave: stats.piecesHave,
    pieceCount: stats.pieceCount,
    ratio: stats.ratio,
    transports: { tcp, utp },
    encryptedPeers: encrypted,
  };
}

/**
 * 1-based places in the engine's download queue: unfinished torrents in queue order. Finished
 * torrents have none (they compete for seed slots, not download slots).
 */
export function builtinQueuePositions(session: Pick<Session, 'getTorrents'>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of session.getTorrents()) if (!t.isComplete) out.set(t.infoHashHex, out.size + 1);
  return out;
}

/** The finer phase of an engine torrent (metadata / checking), when it has one. */
export function builtinPhase(stats: Pick<TorrentStats, 'state'>): DownloadItemPhase | undefined {
  if (stats.state === 'downloadingMetadata') return 'metadata';
  if (stats.state === 'checking') return 'checking';
  return undefined;
}

/**
 * Download client backed by the in-process `@arclight/torrent-engine` Session. The api
 * owns the Session's lifetime; this client never starts or shuts it down.
 */
export class BuiltinClient implements DownloadClient {
  readonly name = 'Built-in';
  readonly protocol = 'torrent' as const;

  constructor(
    private readonly settings: BuiltinSettings,
    private readonly source: SessionSource,
    private readonly options: BuiltinClientOptions = {},
  ) {}

  private session(): Session {
    const s = typeof this.source === 'function' ? this.source() : this.source;
    if (!s) throw new DownloadClientError('unreachable', NOT_RUNNING);
    return s;
  }

  private torrent(session: Session, id: string): Torrent {
    const t = session.getTorrent(id);
    if (!t) throw new DownloadClientError('not-found', `Torrent ${id} is not in the built-in engine.`);
    return t;
  }

  /** Save path for a category: its own folder, else <root>/<category>, else the root. */
  savePathFor(category: string, session: Session = this.session()): string {
    const own = this.settings.categories.find((c) => c.name === category);
    if (own) return own.savePath;
    const root = this.settings.savePath || session.settings.savePath;
    return category ? join(root, category) : root;
  }

  async test(): Promise<DownloadClientTestResult> {
    const session = this.session();
    const warnings: string[] = [];
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const { name } of this.settings.categories) {
      if (seen.has(name) && !reported.has(name)) {
        warnings.push(`Category "${name}" has more than one download folder; only the first is used.`);
        reported.add(name);
      }
      seen.add(name);
    }
    if (session.listenPort === 0) {
      warnings.push('The torrent engine is not listening for incoming connections; downloads may be slow.');
    }
    return { version: `Arclight engine ${BUILTIN_ENGINE_VERSION}`, apiVersion: '1', warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    const session = this.session();
    let id: string;
    try {
      if (input.torrentFile) id = parseTorrent(input.torrentFile).infoHash.toString('hex');
      else if (input.magnet) id = parseMagnet(input.magnet).infoHash.toString('hex');
      else throw new DownloadClientError('rejected', 'Neither a magnet link nor a torrent file was given.');
    } catch (error) {
      if (error instanceof DownloadClientError) throw error;
      throw new DownloadClientError('rejected', `Invalid torrent: ${errorMessage(error)}`, { cause: error });
    }
    const duplicate = (): AddTorrentResult => ({
      id,
      warnings: [`Torrent ${id} is already in the built-in engine; it was not added again.`],
    });
    if (session.getTorrent(id)) return duplicate();

    const category = input.category;
    const seedRatioLimit = input.seedRatioLimit ?? this.settings.seedRatioLimit;
    const seedTimeMinutes = input.seedTimeLimitMinutes ?? this.settings.seedTimeLimitMinutes;
    const savePath = input.savePath ?? this.savePathFor(category, session);
    const paused = input.paused ?? this.settings.initialState === 'pause';
    const kib = (v: number | undefined): number => (v ?? 0) * 1024;
    const options: AddTorrentOptions = {
      ...(input.torrentFile ? { torrent: input.torrentFile } : { magnet: input.magnet as string }),
      category,
      savePath,
      paused,
      ...(seedRatioLimit !== undefined ? { seedRatioLimit } : {}),
      ...(seedTimeMinutes !== undefined ? { seedTimeLimitMs: seedTimeMinutes * 60_000 } : {}),
      superSeeding: this.settings.superSeeding ?? false,
      uploadLimit: kib(this.settings.uploadLimitKbps),
      downloadLimit: kib(this.settings.downloadLimitKbps),
      peerUploadLimit: kib(this.settings.peerUploadLimitKbps),
      peerDownloadLimit: kib(this.settings.peerDownloadLimitKbps),
    };
    const warnings: string[] = [];
    let resume: ResumeData | undefined;
    if (input.skipChecking && input.torrentFile) {
      resume = await completeResumeData(parseTorrent(input.torrentFile), savePath, { category, paused });
      if (!resume) warnings.push('The files at the save path do not match the torrent; the engine checks them before seeding.');
    }
    try {
      const t = await session.addTorrent(options, resume);
      return { id: t.infoHashHex, warnings };
    } catch (error) {
      // Lost a race with a concurrent add of the same torrent.
      if (session.getTorrent(id)) return duplicate();
      if (error instanceof TorrentEngineError) {
        throw new DownloadClientError('rejected', `The engine refused the torrent: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async addNzb(): Promise<AddNzbResult> {
    throw new DownloadClientError('not-supported', 'The built-in torrent engine cannot download NZBs.');
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const session = this.session();
    const positions = builtinQueuePositions(session);
    return session
      .getTorrents()
      .filter((t) => !category || t.category === category)
      .map((t) => this.toItem(session, t, positions.get(t.infoHashHex)));
  }

  private toItem(session: Session, t: Torrent, queuePosition?: number): DownloadItem {
    const stats = t.getStats();
    const complete = t.isComplete;
    const wanted = stats.wantedBytes || stats.totalBytes;
    let status: DownloadItemStatus;
    let statusMessage: string | undefined;
    switch (stats.state) {
      case 'checking':
        status = 'queued';
        statusMessage = 'Checking files';
        break;
      case 'downloadingMetadata':
        status = 'downloading';
        statusMessage = 'Downloading metadata';
        break;
      case 'downloading': {
        status = 'downloading';
        const trackers = t.getTrackers();
        if (trackers.length > 0 && trackers.every((tr) => tr.state === 'error') && stats.connectedPeers === 0) {
          status = 'warning';
          statusMessage = trackers[0]?.message ?? 'All trackers failed';
        }
        break;
      }
      case 'seeding':
        status = 'seeding';
        break;
      case 'paused':
        status = complete ? 'completed' : 'paused';
        break;
      case 'queued':
        status = complete ? 'completed' : 'queued';
        break;
      case 'error':
        status = 'failed';
        statusMessage = stats.error ?? 'Unknown engine error';
        break;
    }

    const ratioLimit = t.seedRatioLimit === undefined ? session.settings.seedRatioLimit : t.seedRatioLimit;
    const timeLimit = t.seedTimeLimitMs === undefined ? session.settings.seedTimeLimitMs : t.seedTimeLimitMs;
    const limitsMet =
      (ratioLimit != null && stats.ratio >= ratioLimit) || (timeLimit != null && stats.seedingTimeMs >= timeLimit);
    const isPrivate = t.metainfo?.private ?? false;
    const hnr = this.hitAndRunPending(session, t, stats);
    const releasable = complete && (limitsMet || stats.state === 'paused') && hnr === null;

    const item: DownloadItem = {
      id: t.infoHashHex,
      title: stats.name,
      category: stats.category,
      totalBytes: wanted,
      remainingBytes: stats.bytesLeft,
      downloadedBytes: Math.max(0, wanted - stats.bytesLeft),
      progress: stats.progress,
      status,
      outputPath: stats.contentPath,
      isReadOnly: complete && ((isPrivate && !limitsMet) || hnr !== null),
      canMoveFiles: releasable,
      canBeRemoved: releasable,
    };
    if (statusMessage !== undefined) item.statusMessage = statusMessage;
    item.live = builtinLive(t, stats, queuePosition);
    const phase = builtinPhase(stats);
    if (phase !== undefined) item.phase = phase;
    if (complete) item.etaSeconds = 0;
    else if (stats.etaSeconds !== undefined) item.etaSeconds = stats.etaSeconds;
    return item;
  }

  /**
   * Hit-and-run guard: the message when a tracker rule still requires this finished torrent
   * to seed; null otherwise (no rule, not finished, or already satisfied).
   */
  hitAndRunPending(session: Session, t: Torrent, stats: TorrentStats = t.getStats()): string | null {
    if (!t.isComplete) return null;
    const provider = this.options.seedRules ?? sessionSeedRules.get(session);
    if (!provider) return null;
    const rule = provider(announceHosts(t), t.infoHashHex);
    return rule ? seedRulePending(rule, stats) : null;
  }

  /** Refuses (`rejected`) while a tracker's hit-and-run rule still requires seeding. */
  async removeItem(id: string, deleteData: boolean): Promise<void> {
    const session = this.session();
    const t = this.torrent(session, id);
    const hnr = this.hitAndRunPending(session, t);
    if (hnr !== null) throw new DownloadClientError('rejected', hnr);
    await session.removeTorrent(t.infoHashHex, deleteData);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const session = this.session();
    return {
      outputRootDir: this.savePathFor(this.settings.category, session),
      isLocalhost: true,
      removesCompletedDownloads: session.settings.seedLimitAction === 'remove',
    };
  }

  async setCategory(id: string, category: string): Promise<void> {
    const session = this.session();
    const t = this.torrent(session, id);
    await session.setCategory(t.infoHashHex, category, false);
  }

  async pause(id: string): Promise<void> {
    const session = this.session();
    await session.pauseTorrent(this.torrent(session, id).infoHashHex);
  }

  async resume(id: string): Promise<void> {
    const session = this.session();
    await session.resumeTorrent(this.torrent(session, id).infoHashHex);
  }

  async setListenPort(port: number): Promise<void> {
    const session = this.session();
    if (session.listenPort === port) return;
    await session.setListenPort(port);
  }

  async getListenPort(): Promise<number> {
    return this.session().listenPort;
  }

  /** Per-torrent limits; saved with the torrent's resume data. */
  async setItemLimits(id: string, limits: ItemSpeedLimits): Promise<void> {
    const session = this.session();
    const t = this.torrent(session, id);
    const patch: { downloadLimit?: number; uploadLimit?: number } = {};
    if (limits.downloadLimit !== undefined) patch.downloadLimit = Math.max(0, Math.round(limits.downloadLimit));
    if (limits.uploadLimit !== undefined) patch.uploadLimit = Math.max(0, Math.round(limits.uploadLimit));
    t.setRateLimits(patch);
    await session.saveResumeData(t);
  }

  async moveInQueue(id: string, move: QueueMove): Promise<void> {
    const session = this.session();
    await session.moveInQueue(this.torrent(session, id).infoHashHex, move);
  }

  async setForceStart(id: string, enabled: boolean): Promise<void> {
    const session = this.session();
    await session.setForceStart(this.torrent(session, id).infoHashHex, enabled);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
