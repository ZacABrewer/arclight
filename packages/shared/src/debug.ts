import { z } from 'zod';
import { TorrentEngineState } from './torrent.js';

// System → Debugging. A live process snapshot and a console that runs a fixed set of built-in,
// read-only diagnostic commands (never arbitrary shell or JavaScript). Admin-only.

/** The commands the console understands, in the order `help` lists them. */
export const DEBUG_COMMANDS = ['help', 'report', 'memory', 'buffers', 'gc', 'handles', 'engine', 'vpn', 'logs', 'ping', 'dns', 'version'] as const;
export const DebugCommandName = z.enum(DEBUG_COMMANDS);
export type DebugCommandName = z.infer<typeof DebugCommandName>;

/** Most commands one POST /system/debug/run may carry; the rest are skipped with a note. */
export const DEBUG_MAX_COMMANDS = 20;
/** Most input characters one run accepts. */
export const DEBUG_MAX_INPUT = 20_000;

export const DebugMemory = z.object({
  rss: z.number(),
  heapTotal: z.number(),
  heapUsed: z.number(),
  external: z.number(),
  arrayBuffers: z.number(),
});
export type DebugMemory = z.infer<typeof DebugMemory>;

/** Container memory from the cgroup files; every field null when not readable (not Linux, no cgroup). */
export const DebugCgroup = z.object({
  version: z.union([z.literal(1), z.literal(2)]).nullable(),
  /** Bytes; null when unlimited or unknown. */
  limit: z.number().nullable(),
  usage: z.number().nullable(),
  anon: z.number().nullable(),
  file: z.number().nullable(),
});
export type DebugCgroup = z.infer<typeof DebugCgroup>;

export const DebugHandleGroup = z.object({
  type: z.string(),
  count: z.number().int(),
  /** Sum of `writableLength` (bytes queued for writing) over the handles of this type. */
  queuedBytes: z.number(),
  maxQueuedBytes: z.number(),
});
export type DebugHandleGroup = z.infer<typeof DebugHandleGroup>;

export const DebugHandles = z.object({
  /** False when the runtime does not expose process._getActiveHandles(). */
  available: z.boolean(),
  total: z.number().int(),
  queuedBytes: z.number(),
  byType: z.array(DebugHandleGroup),
});
export type DebugHandles = z.infer<typeof DebugHandles>;

export const DebugEngineSummary = z.object({
  enabled: z.boolean(),
  state: TorrentEngineState,
  listenPort: z.number().int().nullable(),
  boundAddress: z.string().nullable(),
  torrents: z.number().int(),
  downloading: z.number().int(),
  seeding: z.number().int(),
  peers: z.number().int(),
  downloadRate: z.number(),
  uploadRate: z.number(),
  warning: z.string().optional(),
  error: z.string().optional(),
});
export type DebugEngineSummary = z.infer<typeof DebugEngineSummary>;

export const DebugVpnSummary = z.object({
  enabled: z.boolean(),
  provider: z.string().optional(),
  connected: z.boolean(),
  publicIp: z.string().optional(),
  forwardedPort: z.number().int().optional(),
  killSwitchEngaged: z.boolean(),
  lastChecked: z.string().nullable(),
  error: z.string().optional(),
});
export type DebugVpnSummary = z.infer<typeof DebugVpnSummary>;

/** GET /system/debug/snapshot. Byte figures are bytes. */
export const DebugSnapshot = z.object({
  time: z.string(),
  version: z.string(),
  uptimeSeconds: z.number(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  pid: z.number().int(),
  isDocker: z.boolean(),
  memory: DebugMemory,
  cgroup: DebugCgroup,
  /** Event-loop delay p99 in ms since the last metrics scrape; null when the monitor is not running. */
  eventLoopLagP99Ms: z.number().nullable(),
  handles: DebugHandles,
  /** Null when the torrent engine service is not available. */
  engine: DebugEngineSummary.nullable(),
  vpn: DebugVpnSummary.nullable(),
});
export type DebugSnapshot = z.infer<typeof DebugSnapshot>;

/** POST /system/debug/run: one command per line; blank lines and `#` comments are ignored. */
export const DebugRunRequest = z.object({ input: z.string().max(DEBUG_MAX_INPUT) });
export type DebugRunRequest = z.infer<typeof DebugRunRequest>;

export const DebugCommandResult = z.object({
  /** The line as typed (trimmed). */
  command: z.string(),
  ok: z.boolean(),
  /** Plain text, already redacted. */
  output: z.string(),
  durationMs: z.number(),
});
export type DebugCommandResult = z.infer<typeof DebugCommandResult>;

export const DebugRunResponse = z.object({
  results: z.array(DebugCommandResult),
  /** True when output was cut at the size cap or commands were skipped. */
  truncated: z.boolean().default(false),
});
export type DebugRunResponse = z.infer<typeof DebugRunResponse>;
