import { z } from 'zod';
import { RestartResponse, SystemStatus } from '@arclight/shared';
import type { AppModule } from '../../app.js';
import { VERSION } from '../../version.js';
import { requireAdmin } from '../auth/hook.js';
import { isRestartRequired } from './restart.js';

export { requestRestart, isRestartRequired, restartReasons } from './restart.js';

export interface SystemModuleOptions {
  /**
   * Ends the process after POST /system/restart answered; the container or service manager
   * starts it again. Tests replace it.
   */
  exit?: () => void;
  /** Delay before `exit`, so the reply reaches the client. */
  restartDelayMs?: number;
}

export const systemModuleWith =
  (opts: SystemModuleOptions = {}): AppModule =>
  (ctx) =>
  async (app) => {
    // Public liveness probe (no auth; see modules/auth/hook.ts).
    app.get('/system/ping', { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } }, async () => ({
      status: 'ok' as const,
    }));

    app.get('/system/status', { schema: { response: { 200: SystemStatus } } }, async () => ({
      appName: 'Arclight' as const,
      version: VERSION,
      startTime: ctx.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      paths: { config: ctx.config.configDir, database: ctx.config.dbPath, logs: ctx.config.logDir },
      isDocker: ctx.config.isDocker,
      restartRequired: isRestartRequired(ctx),
    }));

    app.post(
      '/system/restart',
      { preHandler: requireAdmin, schema: { response: { 202: RestartResponse } } },
      async (_req, reply) => {
        ctx.log.info('restart requested');
        const exit =
          opts.exit ??
          (() => {
            // Close cleanly (scheduler, sockets) before exiting; exit regardless after 5 s.
            setTimeout(() => process.exit(0), 5000).unref();
            void app.close().finally(() => process.exit(0));
          });
        setTimeout(exit, opts.restartDelayMs ?? 500).unref?.();
        return reply.code(202).send({ restarting: true as const });
      },
    );
  };

export const systemModule: AppModule = systemModuleWith();
