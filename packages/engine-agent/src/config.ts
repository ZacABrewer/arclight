import { join, resolve } from 'node:path';
import type { SessionSettings } from '@arclight/torrent-engine';

/** Agent process configuration, read from the environment (see `parseAgentEnv`). */
export interface AgentConfig {
  token: string;
  /** HTTP API port and bind address. */
  port: number;
  host: string;
  downloadsRoot: string;
  /** Fast-resume data and saved .torrent files. */
  resumeDir: string;
  /** Engine socket binding (AGENT_LISTEN_ADDRESS); null = all interfaces. */
  listenAddress: string | null;
  /** Interface to follow (AGENT_LISTEN_INTERFACE, e.g. tun0); its IPv4 address wins over listenAddress. */
  listenInterface: string | null;
  listenPort: number;
  /** File holding the VPN's forwarded port (Gluetun: /tmp/gluetun/forwarded_port). */
  portFile: string | null;
  /** How often the interface and port file are re-read. */
  networkPollMs: number;
  session: Partial<SessionSettings>;
}

export class AgentConfigError extends Error {
  override readonly name = 'AgentConfigError';
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new AgentConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  return n;
}

function num(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new AgentConfigError(`${name} must be a non-negative number (got "${raw}").`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new AgentConfigError(`${name} must be true/false or 1/0 (got "${raw}").`);
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!(values as readonly string[]).includes(raw)) throw new AgentConfigError(`${name} must be one of ${values.join(', ')} (got "${raw}").`);
  return raw as T;
}

function str(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

/**
 * Reads the agent configuration:
 *
 *   AGENT_TOKEN (required, 16+ chars)   AGENT_PORT (7879)        AGENT_HOST (0.0.0.0)
 *   AGENT_DOWNLOADS (/downloads)        AGENT_DATA (/data)       AGENT_LISTEN_PORT (6881)
 *   AGENT_LISTEN_ADDRESS                AGENT_LISTEN_INTERFACE   AGENT_PORT_FILE
 *   AGENT_ENCRYPTION (preferred|required|disabled)  AGENT_UTP (1)  AGENT_TCP (1)
 *   AGENT_DHT (1)  AGENT_PEX (1)  AGENT_MAX_CONNECTIONS (200)
 *   AGENT_MAX_ACTIVE_DOWNLOADS (3)  AGENT_MAX_ACTIVE_SEEDS (5)
 *   AGENT_DOWNLOAD_LIMIT_KBPS (0)   AGENT_UPLOAD_LIMIT_KBPS (0)
 *   AGENT_SEED_RATIO  AGENT_SEED_TIME_MINUTES  AGENT_SEED_LIMIT_ACTION (pause|remove|none)
 */
export function parseAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env['AGENT_TOKEN']?.trim() ?? '';
  if (token.length < 16) throw new AgentConfigError('AGENT_TOKEN must be set to a secret of at least 16 characters (e.g. `openssl rand -hex 32`).');
  const data = resolve(env['AGENT_DATA']?.trim() || '/data');
  const seedRatio = num(env, 'AGENT_SEED_RATIO');
  const seedMinutes = num(env, 'AGENT_SEED_TIME_MINUTES');
  const listenPort = int(env, 'AGENT_LISTEN_PORT', 6881, 0, 65535);
  const listenAddress = str(env, 'AGENT_LISTEN_ADDRESS');
  const downloadsRoot = resolve(env['AGENT_DOWNLOADS']?.trim() || '/downloads');
  const resumeDir = join(data, 'resume');
  return {
    token,
    port: int(env, 'AGENT_PORT', 7879, 1, 65535),
    host: str(env, 'AGENT_HOST') ?? '0.0.0.0',
    downloadsRoot,
    resumeDir,
    listenAddress,
    listenInterface: str(env, 'AGENT_LISTEN_INTERFACE'),
    listenPort,
    portFile: str(env, 'AGENT_PORT_FILE'),
    networkPollMs: int(env, 'AGENT_NETWORK_POLL_MS', 15_000, 100, 3_600_000),
    session: {
      savePath: downloadsRoot,
      resumeDataDir: resumeDir,
      listenPort,
      listenAddress,
      encryption: oneOf(env, 'AGENT_ENCRYPTION', ['preferred', 'required', 'disabled'] as const, 'preferred'),
      utp: bool(env, 'AGENT_UTP', true),
      tcp: bool(env, 'AGENT_TCP', true),
      dht: bool(env, 'AGENT_DHT', true),
      pex: bool(env, 'AGENT_PEX', true),
      maxConnections: int(env, 'AGENT_MAX_CONNECTIONS', 200, 1, 5000),
      maxActiveDownloads: int(env, 'AGENT_MAX_ACTIVE_DOWNLOADS', 3, -1, 1000),
      maxActiveSeeds: int(env, 'AGENT_MAX_ACTIVE_SEEDS', 5, -1, 1000),
      downloadLimit: int(env, 'AGENT_DOWNLOAD_LIMIT_KBPS', 0, 0, 10_000_000) * 1024,
      uploadLimit: int(env, 'AGENT_UPLOAD_LIMIT_KBPS', 0, 0, 10_000_000) * 1024,
      seedRatioLimit: seedRatio,
      seedTimeLimitMs: seedMinutes === null ? null : Math.round(seedMinutes * 60_000),
      seedLimitAction: oneOf(env, 'AGENT_SEED_LIMIT_ACTION', ['pause', 'remove', 'none'] as const, 'pause'),
      peerIdPrefix: '-AL0100-',
    },
  };
}
