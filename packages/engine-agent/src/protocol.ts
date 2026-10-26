import { z } from 'zod';

/**
 * Wire contract of the remote engine agent (protocol v1).
 *
 * The agent is Arclight's torrent engine running somewhere else (a seedbox, a VPS, or another
 * Arclight). The main Arclight drives it through these endpoints, relative to the agent's
 * base URL (`http://seedbox:7879` for the standalone agent, `http://nas:7878/api/v1/engine-agent`
 * for an Arclight acting as agent):
 *
 *   GET    /status                               AgentStatus
 *   PUT    /listen-port            {port}        AgentStatus
 *   GET    /torrents?category=                   AgentTorrent[]
 *   POST   /torrents               json | multipart (torrent + options)  AgentAddResult
 *   GET    /torrents/:id                         AgentTorrent
 *   DELETE /torrents/:id?deleteData=true|false   204
 *   POST   /torrents/:id/pause | /resume         204
 *   PUT    /torrents/:id/category  {category}    204
 *   PUT    /torrents/:id/save-path {savePath}    204
 *   GET    /torrents/:id/files                   AgentFile[]
 *   GET    /torrents/:id/files/:index/content    file bytes (Range: bytes=a-b supported; 206)
 *   GET    /torrents/:id/files/:index/sha256     AgentFileChecksum
 *   GET    /events                               WebSocket, text frames of AgentEvent JSON
 *
 * Authentication: the standalone agent takes its shared token in `x-agent-token` (or
 * `Authorization: Bearer <token>`); an Arclight acting as agent takes its API key in
 * `x-api-key`. Clients send the token in all of them. Errors are `AgentErrorBody` JSON.
 */

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_TOKEN_HEADER = 'x-agent-token';

export const AgentTorrentState = z.enum(['checking', 'downloadingMetadata', 'downloading', 'seeding', 'paused', 'queued', 'error']);
export type AgentTorrentState = z.infer<typeof AgentTorrentState>;

/** One torrent with its full statistics plus what a download client needs to classify it. */
export const AgentTorrent = z.object({
  id: z.string(),
  name: z.string(),
  state: AgentTorrentState,
  category: z.string(),
  tags: z.array(z.string()),
  /** 0..1 over the wanted bytes. */
  progress: z.number(),
  wantedBytes: z.number(),
  totalBytes: z.number(),
  bytesLeft: z.number(),
  downloaded: z.number(),
  uploaded: z.number(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  etaSeconds: z.number().optional(),
  ratio: z.number(),
  connectedPeers: z.number(),
  connectedSeeds: z.number(),
  swarmSeeds: z.number(),
  swarmLeechers: z.number(),
  seedingTimeMs: z.number(),
  activeTimeMs: z.number(),
  addedAt: z.string(),
  completedAt: z.string().nullable(),
  /** Paths as the agent sees them. */
  savePath: z.string(),
  contentPath: z.string(),
  piecesHave: z.number(),
  pieceCount: z.number(),
  error: z.string().optional(),
  hasMetadata: z.boolean(),
  isComplete: z.boolean(),
  isPrivate: z.boolean(),
  /** Effective limits (per-torrent value, else the engine default); null = unlimited. */
  seedRatioLimit: z.number().nullable(),
  seedTimeLimitMs: z.number().nullable(),
  /** A seed limit has been reached. */
  seedLimitsMet: z.boolean(),
  /** Set when every tracker fails and no peer is connected. */
  trackerError: z.string().optional(),
});
export type AgentTorrent = z.infer<typeof AgentTorrent>;

export const AgentFile = z.object({
  index: z.number().int(),
  /** '/'-separated, starting with the torrent name (the payload path below the save path). */
  path: z.string(),
  length: z.number(),
  /** 0 = skipped. */
  priority: z.number(),
  progress: z.number(),
  /** Fully downloaded and verified: content and checksum may be fetched. */
  complete: z.boolean(),
});
export type AgentFile = z.infer<typeof AgentFile>;

export const AgentFileChecksum = z.object({
  index: z.number().int(),
  length: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AgentFileChecksum = z.infer<typeof AgentFileChecksum>;

export const AgentStatus = z.object({
  protocolVersion: z.number().int(),
  agentVersion: z.string(),
  /** 'standalone' for the agent process, 'arclight' for an Arclight serving the protocol. */
  kind: z.enum(['standalone', 'arclight']),
  running: z.boolean(),
  listenPort: z.number().int(),
  /** Address the engine's sockets are bound to (null = all interfaces). */
  listenAddress: z.string().nullable(),
  vpn: z.object({
    /** Network interface the engine follows (e.g. tun0), or null when not configured. */
    interface: z.string().nullable(),
    /** Null when no interface is configured; false = interface missing, engine in lockdown. */
    up: z.boolean().nullable(),
  }),
  /** The agent manages its own listen port (forwarded-port file); PUT /listen-port is refused. */
  portManaged: z.boolean(),
  downloadsRoot: z.string(),
  seedLimitAction: z.enum(['pause', 'remove', 'none']),
  torrents: z.number().int(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  connections: z.number().int(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

/** Options of POST /torrents (the JSON body, or the `options` part of a multipart upload). */
export const AgentAddOptions = z.object({
  magnet: z.string().min(1).optional(),
  category: z.string().default(''),
  /** Agent-side folder; must be inside the agent's downloads root. Default <root>/<category>. */
  savePath: z.string().optional(),
  paused: z.boolean().optional(),
  seedRatioLimit: z.number().min(0).optional(),
  seedTimeLimitMinutes: z.number().int().min(0).optional(),
});
export type AgentAddOptions = z.input<typeof AgentAddOptions>;

export const AgentAddResult = z.object({ id: z.string(), duplicate: z.boolean() });
export type AgentAddResult = z.infer<typeof AgentAddResult>;

export const AgentCategoryBody = z.object({ category: z.string() });
export const AgentSavePathBody = z.object({ savePath: z.string().min(1) });
export const AgentListenPortBody = z.object({ port: z.number().int().min(1).max(65535) });

export const AgentErrorCode = z.enum([
  'unauthorized',
  'forbidden',
  'not-found',
  'bad-request',
  'conflict',
  'incomplete',
  'range',
  'not-running',
  'internal',
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCode>;

export const AgentErrorBody = z.object({ error: z.string(), code: AgentErrorCode });
export type AgentErrorBody = z.infer<typeof AgentErrorBody>;

/** Messages on GET /events. The first one is always `hello`. */
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), status: AgentStatus }),
  z.object({ type: z.literal('added'), torrent: AgentTorrent }),
  z.object({ type: z.literal('removed'), id: z.string() }),
  z.object({ type: z.literal('stateChange'), id: z.string(), prev: AgentTorrentState, next: AgentTorrentState, torrent: AgentTorrent }),
  z.object({ type: z.literal('completed'), torrent: AgentTorrent }),
  z.object({ type: z.literal('metadata'), torrent: AgentTorrent }),
  z.object({ type: z.literal('listenPort'), port: z.number().int() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** HTTP status for each error code. */
export const AGENT_ERROR_STATUS: Readonly<Record<AgentErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  'bad-request': 400,
  conflict: 409,
  incomplete: 409,
  range: 416,
  'not-running': 503,
  internal: 500,
};
