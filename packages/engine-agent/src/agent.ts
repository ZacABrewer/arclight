import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Session, type SessionOptions } from '@arclight/torrent-engine';
import type { AgentConfig } from './config.js';
import { EngineAgentCore } from './core.js';
import { NetworkFollower, type NetworkFollowerOptions } from './network.js';
import { createAgentServer, type AgentServer } from './server.js';

export type AgentLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

/** One JSON line per message on stdout (the container log). */
export const jsonLog: AgentLog = (level, msg, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra })}\n`);
};

export interface RunningAgent {
  session: Session;
  core: EngineAgentCore;
  server: AgentServer;
  follower: NetworkFollower;
  address: AddressInfo;
  /** Graceful stop: close the API, then save resume data and close the engine. */
  stop(): Promise<void>;
}

export interface StartAgentOptions {
  log?: AgentLog;
  /** Extra Session options (tests inject fast timers). */
  sessionOptions?: Omit<SessionOptions, 'settings'>;
  /** Network follower test seams. */
  network?: Pick<NetworkFollowerOptions, 'interfaces' | 'readPortFile'>;
  pingIntervalMs?: number;
}

/** Starts the engine, the network follower and the HTTP API. */
export async function startAgent(config: AgentConfig, options: StartAgentOptions = {}): Promise<RunningAgent> {
  const log = options.log ?? jsonLog;
  await mkdir(config.downloadsRoot, { recursive: true });
  await mkdir(config.resumeDir, { recursive: true });

  const session = new Session({ ...options.sessionOptions, settings: config.session });
  session.on('warning', (m) => log('warn', m));
  const follower = new NetworkFollower({
    session,
    interfaceName: config.listenInterface,
    portFile: config.portFile,
    pollMs: config.networkPollMs,
    log,
    ...options.network,
  });
  // Bind to the VPN interface (or loopback while it is missing) before any socket opens.
  await follower.check();
  await session.start();
  await follower.start();

  const core = new EngineAgentCore({
    session,
    downloadsRoot: config.downloadsRoot,
    kind: 'standalone',
    portManaged: () => follower.portManaged(),
    vpn: () => follower.state(),
  });
  const server = createAgentServer({
    core,
    token: config.token,
    ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {}),
    onRequest: ({ method, path, status }) => {
      if (status >= 400) log('warn', 'request failed', { method, path, status });
    },
  });
  let address: AddressInfo;
  try {
    address = await server.listen(config.port, config.host);
  } catch (error) {
    follower.stop();
    await session.shutdown();
    throw error;
  }
  log('info', 'engine agent listening', {
    api: `${address.address}:${address.port}`,
    peerPort: session.listenPort,
    bind: session.settings.listenAddress ?? 'all interfaces',
    downloads: config.downloadsRoot,
  });

  let stopping: Promise<void> | null = null;
  return {
    session,
    core,
    server,
    follower,
    address,
    stop() {
      stopping ??= (async () => {
        follower.stop();
        await server.close();
        await session.shutdown();
        log('info', 'engine agent stopped');
      })();
      return stopping;
    },
  };
}
