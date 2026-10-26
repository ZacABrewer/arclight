import { SystemStatus } from '@media-tron/shared';
import type { AppModule } from '../../app.js';
import { VERSION } from '../../version.js';

export const systemModule: AppModule = (ctx) => async (app) => {
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
