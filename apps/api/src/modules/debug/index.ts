import { DebugRunRequest, DebugRunResponse, DebugSnapshot, type LogRecord } from '@arclight/shared';
import type { AppContext, AppModule } from '../../app.js';
import { VERSION } from '../../version.js';
import { requireAdmin } from '../auth/index.js';
import { logsServiceFor } from '../logs/index.js';
import { metricsServiceFor } from '../metrics/index.js';
import { torrentServiceFor } from '../torrent/index.js';
import { vpnServiceFor } from '../vpn/service.js';
import { runCommands } from './commands.js';
import { DebugService, type DebugSources } from './service.js';

export { DebugService, formatLogLine, type DebugSources, type VpnDetail } from './service.js';
export { parseInput, runCommands, DEBUG_MAX_OUTPUT, LOGS_MAX } from './commands.js';
export { redactText, redactJson } from './redact.js';
export { arrayBufferCensus, forceGc } from './inspector.js';
export { handleCensus, readCgroup } from './probes.js';

/** Live sources from the per-context services (resolved per call, never at boot). */
export function defaultDebugSources(ctx: AppContext): DebugSources {
  const logs = logsServiceFor(ctx);
  return {
    version: VERSION,
    isDocker: ctx.config.isDocker,
    eventLoopLagP99Ms: () => metricsServiceFor(ctx).eventLoopLagP99Ms(),
    torrent: () => torrentServiceFor(ctx).status(),
    vpn: () => {
      const vpn = vpnServiceFor(ctx);
      const s = vpn.settings();
      return {
        status: vpn.getStatus(),
        pauseGrabsWhenDown: s.pauseGrabsWhenDown,
        ...(s.provider.type === 'wireguard-windows' ? { providerKillSwitch: s.provider.killSwitch } : {}),
      };
    },
    logs: (limit, match) => {
      // Page through the ring buffer (newest first) until enough lines match.
      const out: LogRecord[] = [];
      for (let page = 1; out.length < limit; page++) {
        const res = logs.query({ page, pageSize: 1000 });
        for (const r of res.records) {
          if (match(r)) out.push(r);
          if (out.length >= limit) break;
        }
        if (page * 1000 >= res.totalRecords) break;
      }
      return out;
    },
  };
}

const services = new WeakMap<AppContext, DebugService>();

export function debugServiceFor(ctx: AppContext, overrides: Partial<DebugSources> = {}): DebugService {
  let service = services.get(ctx);
  if (!service) {
    service = new DebugService({ ...defaultDebugSources(ctx), ...overrides });
    services.set(ctx, service);
  }
  return service;
}

// System → Debugging: a live process snapshot and a console of built-in, read-only diagnostic
// commands (commands.ts). Never evaluates code or runs a shell. Admin-only: the routes carry no
// `config.access` (so the auth hook admits admins and the API key only) and requireAdmin runs
// again as a preHandler.
export const debugModule: AppModule = (ctx) => async (app) => {
  const service = debugServiceFor(ctx);

  app.get('/system/debug/snapshot', { preHandler: requireAdmin, schema: { response: { 200: DebugSnapshot } } }, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return service.snapshot();
  });

  app.post(
    '/system/debug/run',
    { preHandler: requireAdmin, schema: { body: DebugRunRequest, response: { 200: DebugRunResponse } } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const res = await runCommands(service, req.body.input);
      req.log.info({ commands: res.results.map((r) => r.command.split(/\s+/)[0]) }, 'debug console run');
      return res;
    },
  );
};
