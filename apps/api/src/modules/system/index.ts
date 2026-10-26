import { z } from 'zod';
import { SystemStatus } from '@media-tron/shared';
import type { AppModule } from '../../app.js';
import { VERSION } from '../../version.js';

export const systemModule: AppModule = (ctx) => async (app) => {
  // Public liveness probe (no auth; see modules/auth/hook.ts).
  app.get('/system/ping', { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } }, async () => ({
    status: 'ok' as const,
  }));

  app.get('/system/status', { schema: { response: { 200: SystemStatus } } }, async () => ({
    appName: 'Media-Tron' as const,
    version: VERSION,
    startTime: ctx.startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    paths: { config: ctx.config.configDir, database: ctx.config.dbPath, logs: ctx.config.logDir },
    isDocker: ctx.config.isDocker,
  }));
};
