import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import type { MigrateApp, MigrateNetworkCandidate } from '@arclight/shared';
import type { MigrateDeps } from './deps.js';

// Suggestions for the connect step: the usual container names and ports of the old apps on
// the same Docker network (compose service names resolve through Docker's DNS). A name that
// resolves and a port that accepts a connection is offered as a URL to test; nothing is sent
// to it. These are suggestions only: the user still enters the API key and tests.

interface Guess {
  app: MigrateApp;
  hosts: string[];
  port: number;
}

const GUESSES: Guess[] = [
  { app: 'sonarr', hosts: ['sonarr', 'sonarr4k', 'sonarr-4k'], port: 8989 },
  { app: 'radarr', hosts: ['radarr', 'radarr4k', 'radarr-4k'], port: 7878 },
  { app: 'prowlarr', hosts: ['prowlarr'], port: 9696 },
  { app: 'bazarr', hosts: ['bazarr'], port: 6767 },
  { app: 'seerr', hosts: ['seerr', 'jellyseerr', 'overseerr'], port: 5055 },
  // qBittorrent often shares a VPN container's network (gluetun): its WebUI is reached there.
  { app: 'qbittorrent', hosts: ['qbittorrent', 'qbittorrentvpn', 'gluetun'], port: 8080 },
];

async function defaultResolve(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

function defaultProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function discoverNetwork(deps: Pick<MigrateDeps, 'resolveHost' | 'probePort'> = {}, timeoutMs = 800): Promise<MigrateNetworkCandidate[]> {
  const resolveHost = deps.resolveHost ?? defaultResolve;
  const probe = deps.probePort ?? defaultProbe;
  const checks = GUESSES.flatMap((g) => g.hosts.map((host) => ({ app: g.app, host, port: g.port })));
  const found = await Promise.all(
    checks.map(async (c) => {
      if (!(await resolveHost(c.host))) return null;
      if (!(await probe(c.host, c.port, timeoutMs))) return null;
      return { app: c.app, url: `http://${c.host}:${c.port}`, origin: 'docker network' } satisfies MigrateNetworkCandidate;
    }),
  );
  return found.filter((c): c is MigrateNetworkCandidate => c !== null);
}
