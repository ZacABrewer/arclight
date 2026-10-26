import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parseMagnet, parseTorrent, TorrentEngineError, type Session, type Torrent } from '@arclight/torrent-engine';
import {
  AGENT_PROTOCOL_VERSION,
  AgentAddOptions,
  type AgentAddResult,
  type AgentErrorCode,
  type AgentEvent,
  type AgentFile,
  type AgentFileChecksum,
  type AgentStatus,
  type AgentTorrent,
} from './protocol.js';

export const AGENT_VERSION = '0.1.0';

/** Typed failure of an agent operation; transports turn `code` into an HTTP status. */
export class AgentError extends Error {
  override readonly name = 'AgentError';
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface EngineAgentCoreOptions {
  /** The engine; a getter returning null while it is stopped (Arclight-as-agent). */
  session: Session | (() => Session | null);
  /** Root every save path must stay inside. */
  downloadsRoot: string | (() => string);
  kind: 'standalone' | 'arclight';
  /** True when the agent follows its own forwarded port; PUT /listen-port is then refused. */
  portManaged?: () => boolean;
  /** VPN interface state, when the agent follows one. */
  vpn?: () => { interface: string | null; up: boolean | null };
  /** How often a getter-backed session is re-checked for event subscriptions. Default 2 s. */
  sessionPollMs?: number;
}

/** A file to stream back: the range is inclusive. */
export interface FileRange {
  path: string;
  size: number;
  start: number;
  end: number;
  partial: boolean;
}

/**
 * The agent's operations over a torrent engine Session, independent of any transport. The
 * standalone node:http server and the api's engine-agent module both drive this class.
 */
export class EngineAgentCore {
  private readonly checksums = new Map<string, { size: number; mtimeMs: number; hash: Promise<string> }>();

  constructor(private readonly opts: EngineAgentCoreOptions) {}

  // ---- lookups ---------------------------------------------------------------------------

  currentSession(): Session | null {
    const s = this.opts.session;
    return typeof s === 'function' ? s() : s;
  }

  private session(): Session {
    const s = this.currentSession();
    if (!s) throw new AgentError('not-running', 'The torrent engine is not running.');
    return s;
  }

  private torrent(id: string): { session: Session; t: Torrent } {
    const session = this.session();
    const t = /^[0-9a-fA-F]{40}$/.test(id) ? session.getTorrent(id) : undefined;
    if (!t) throw new AgentError('not-found', `Torrent ${id} is not in the engine.`);
    return { session, t };
  }

  downloadsRoot(): string {
    const r = this.opts.downloadsRoot;
    return resolve(typeof r === 'function' ? r() : r);
  }

  /** Resolves `path` and refuses anything outside the downloads root. */
  private insideRoot(path: string): string {
    const root = this.downloadsRoot();
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new AgentError('forbidden', `Save path ${path} is outside the agent downloads folder ${root}.`);
    }
    return full;
  }

  // ---- read ------------------------------------------------------------------------------

  status(): AgentStatus {
    const session = this.currentSession();
    const stats = session?.getSessionStats();
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      kind: this.opts.kind,
      running: session !== null,
      listenPort: stats?.listenPort ?? 0,
      listenAddress: stats?.listenAddress ?? null,
      vpn: this.opts.vpn?.() ?? { interface: null, up: null },
      portManaged: this.opts.portManaged?.() ?? false,
      downloadsRoot: this.downloadsRoot(),
      seedLimitAction: session?.settings.seedLimitAction ?? 'pause',
      torrents: stats?.torrents ?? 0,
      downloadRate: stats?.downloadRate ?? 0,
      uploadRate: stats?.uploadRate ?? 0,
      connections: stats?.connections ?? 0,
    };
  }

  list(category?: string): AgentTorrent[] {
    const session = this.session();
    return session
      .getTorrents()
      .filter((t) => !category || t.category === category)
      .map((t) => describeTorrent(session, t));
  }

  get(id: string): AgentTorrent {
    const { session, t } = this.torrent(id);
    return describeTorrent(session, t);
  }

  files(id: string): AgentFile[] {
    const { t } = this.torrent(id);
    return t.getFiles().map((f) => ({
      index: f.index,
      path: f.path,
      length: f.length,
      priority: f.priority,
      progress: f.progress,
      complete: f.progress >= 1,
    }));
  }

  /** Disk location of a complete file; refuses files still downloading. */
  private async completeFile(id: string, index: number): Promise<{ path: string; size: number; mtimeMs: number }> {
    const { t } = this.torrent(id);
    const file = t.getFiles().find((f) => f.index === index);
    if (!file) throw new AgentError('not-found', `Torrent ${id} has no file ${index}.`);
    if (file.progress < 1) throw new AgentError('incomplete', `File ${file.path} is not completely downloaded yet.`);
    const segments = file.path.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new AgentError('forbidden', `Unsafe file path ${file.path}.`);
    const path = join(t.savePath, ...segments);
    try {
      const st = await stat(path);
      return { path, size: st.size, mtimeMs: st.mtimeMs };
    } catch (error) {
      throw new AgentError('not-found', `File ${file.path} is missing on the agent.`, { cause: error });
    }
  }

  /** Resolves a byte range (`Range` header value) over a complete file. */
  async fileRange(id: string, index: number, rangeHeader: string | undefined): Promise<FileRange> {
    const f = await this.completeFile(id, index);
    if (!rangeHeader) return { path: f.path, size: f.size, start: 0, end: f.size - 1, partial: false };
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (m[1] === '' && m[2] === '')) throw new AgentError('range', `Unsupported range ${rangeHeader}.`);
    let start: number;
    let end: number;
    if (m[1] === '') {
      const suffix = Number(m[2]);
      start = Math.max(0, f.size - suffix);
      end = f.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? f.size - 1 : Math.min(Number(m[2]), f.size - 1);
    }
    if (start >= f.size || start > end) {
      // A resume of an already complete file asks for bytes=<size>-: answer with an empty 206.
      if (start === f.size && m[1] !== '') return { path: f.path, size: f.size, start, end: start - 1, partial: true };
      throw new AgentError('range', `Range ${rangeHeader} is outside the file (${f.size} bytes).`);
    }
    return { path: f.path, size: f.size, start, end, partial: true };
  }

  openRange(range: FileRange): Readable {
    return createReadStream(range.path, { start: range.start, end: Math.max(range.start, range.end) });
  }

  /** SHA-256 of a complete file, cached per size and modification time. */
  async checksum(id: string, index: number): Promise<AgentFileChecksum> {
    const f = await this.completeFile(id, index);
    let cached = this.checksums.get(f.path);
    if (!cached || cached.size !== f.size || cached.mtimeMs !== f.mtimeMs) {
      cached = { size: f.size, mtimeMs: f.mtimeMs, hash: sha256File(f.path) };
      this.checksums.set(f.path, cached);
      cached.hash.catch(() => this.checksums.delete(f.path));
    }
    return { index, length: f.size, sha256: await cached.hash };
  }

  // ---- write -----------------------------------------------------------------------------

  async add(rawOptions: unknown, torrentFile?: Uint8Array): Promise<AgentAddResult> {
    const parsed = AgentAddOptions.safeParse(rawOptions ?? {});
    if (!parsed.success) throw new AgentError('bad-request', `Invalid add options: ${parsed.error.message}`);
    const options = parsed.data;
    const session = this.session();
    if (!torrentFile === !options.magnet) throw new AgentError('bad-request', 'Send exactly one of a magnet link or a .torrent file.');
    let id: string;
    try {
      id = torrentFile ? parseTorrent(torrentFile).infoHash.toString('hex') : parseMagnet(options.magnet as string).infoHash.toString('hex');
    } catch (error) {
      throw new AgentError('bad-request', `Invalid torrent: ${messageOf(error)}`, { cause: error });
    }
    if (session.getTorrent(id)) return { id, duplicate: true };
    const savePath = this.insideRoot(options.savePath ?? (options.category ? join(this.downloadsRoot(), options.category) : this.downloadsRoot()));
    try {
      await session.addTorrent({
        ...(torrentFile ? { torrent: torrentFile } : { magnet: options.magnet as string }),
        category: options.category,
        savePath,
        ...(options.paused !== undefined ? { paused: options.paused } : {}),
        ...(options.seedRatioLimit !== undefined ? { seedRatioLimit: options.seedRatioLimit } : {}),
        ...(options.seedTimeLimitMinutes !== undefined ? { seedTimeLimitMs: options.seedTimeLimitMinutes * 60_000 } : {}),
      });
    } catch (error) {
      if (session.getTorrent(id)) return { id, duplicate: true };
      if (error instanceof TorrentEngineError) throw new AgentError('conflict', `The engine refused the torrent: ${error.message}`, { cause: error });
      throw error;
    }
    return { id, duplicate: false };
  }

  async remove(id: string, deleteData: boolean): Promise<void> {
    const { session, t } = this.torrent(id);
    await session.removeTorrent(t.infoHashHex, deleteData);
  }

  async pause(id: string): Promise<void> {
    const { session, t } = this.torrent(id);
    await session.pauseTorrent(t.infoHashHex);
  }

  async resume(id: string): Promise<void> {
    const { session, t } = this.torrent(id);
    await session.resumeTorrent(t.infoHashHex);
  }

  async setCategory(id: string, category: string): Promise<void> {
    const { session, t } = this.torrent(id);
    await session.setCategory(t.infoHashHex, category, false);
  }

  async setSavePath(id: string, savePath: string): Promise<void> {
    const { session, t } = this.torrent(id);
    const target = this.insideRoot(savePath);
    if (target === resolve(t.savePath)) return;
    await t.moveStorage(target);
    await session.saveResumeData(t);
  }

  async setListenPort(port: number): Promise<AgentStatus> {
    if (this.opts.portManaged?.()) {
      throw new AgentError('conflict', 'The agent manages its own listen port (forwarded-port file); it cannot be set remotely.');
    }
    const session = this.session();
    if (session.listenPort !== port) await session.setListenPort(port);
    return this.status();
  }

  // ---- events ----------------------------------------------------------------------------

  /**
   * Streams engine events to `send` until the returned function is called. Follows a
   * getter-backed session across engine restarts.
   */
  subscribe(send: (event: AgentEvent) => void): () => void {
    let attached: Session | null = null;
    let detach: (() => void) | null = null;
    const describe = (t: Torrent): AgentTorrent | null => (attached ? describeTorrent(attached, t) : null);
    const attach = (s: Session) => {
      const onAdded = (t: Torrent) => {
        const d = describe(t);
        if (d) send({ type: 'added', torrent: d });
      };
      const onRemoved = (id: string) => send({ type: 'removed', id });
      const onState = (t: Torrent, prev: AgentTorrent['state'], next: AgentTorrent['state']) => {
        const d = describe(t);
        if (d) send({ type: 'stateChange', id: t.infoHashHex, prev, next, torrent: d });
      };
      const onCompleted = (t: Torrent) => {
        const d = describe(t);
        if (d) send({ type: 'completed', torrent: d });
      };
      const onMetadata = (t: Torrent) => {
        const d = describe(t);
        if (d) send({ type: 'metadata', torrent: d });
      };
      s.on('torrentAdded', onAdded);
      s.on('torrentRemoved', onRemoved);
      s.on('stateChange', onState);
      s.on('completed', onCompleted);
      s.on('metadata', onMetadata);
      attached = s;
      detach = () => {
        s.off('torrentAdded', onAdded);
        s.off('torrentRemoved', onRemoved);
        s.off('stateChange', onState);
        s.off('completed', onCompleted);
        s.off('metadata', onMetadata);
        attached = null;
      };
    };
    let lastPort = this.currentSession()?.listenPort ?? 0;
    const sync = () => {
      const current = this.currentSession();
      if (current !== attached) {
        detach?.();
        detach = null;
        if (current) attach(current);
      }
      const port = current?.listenPort ?? 0;
      if (port !== lastPort) {
        lastPort = port;
        send({ type: 'listenPort', port });
      }
    };
    sync();
    const timer = setInterval(sync, this.opts.sessionPollMs ?? 2000);
    timer.unref();
    return () => {
      clearInterval(timer);
      detach?.();
    };
  }
}

/** Full statistics of one torrent plus the derived fields the protocol carries. */
export function describeTorrent(session: Session, t: Torrent): AgentTorrent {
  const s = t.getStats();
  const ratioLimit = t.seedRatioLimit === undefined ? session.settings.seedRatioLimit : t.seedRatioLimit;
  const timeLimit = t.seedTimeLimitMs === undefined ? session.settings.seedTimeLimitMs : t.seedTimeLimitMs;
  const complete = t.isComplete;
  const seedLimitsMet = complete && ((ratioLimit !== null && s.ratio >= ratioLimit) || (timeLimit !== null && s.seedingTimeMs >= timeLimit));
  const out: AgentTorrent = {
    id: t.infoHashHex,
    name: s.name,
    state: s.state,
    category: s.category,
    tags: s.tags,
    progress: s.progress,
    wantedBytes: s.wantedBytes,
    totalBytes: s.totalBytes,
    bytesLeft: s.bytesLeft,
    downloaded: s.downloaded,
    uploaded: s.uploaded,
    downloadRate: s.downloadRate,
    uploadRate: s.uploadRate,
    ratio: s.ratio,
    connectedPeers: s.connectedPeers,
    connectedSeeds: s.connectedSeeds,
    swarmSeeds: s.swarmSeeds,
    swarmLeechers: s.swarmLeechers,
    seedingTimeMs: s.seedingTimeMs,
    activeTimeMs: s.activeTimeMs,
    addedAt: s.addedAt,
    completedAt: s.completedAt,
    savePath: s.savePath,
    contentPath: s.contentPath,
    piecesHave: s.piecesHave,
    pieceCount: s.pieceCount,
    hasMetadata: t.hasMetadata,
    isComplete: complete,
    isPrivate: t.metainfo?.private ?? false,
    seedRatioLimit: ratioLimit,
    seedTimeLimitMs: timeLimit,
    seedLimitsMet,
  };
  if (s.etaSeconds !== undefined) out.etaSeconds = s.etaSeconds;
  if (s.error !== undefined) out.error = s.error;
  if (s.state === 'downloading') {
    const trackers = t.getTrackers();
    if (trackers.length > 0 && s.connectedPeers === 0 && trackers.every((tr) => tr.state === 'error')) {
      out.trackerError = trackers[0]?.message ?? 'Every tracker failed.';
    }
  }
  return out;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
