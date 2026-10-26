import { statfsSync } from 'node:fs';
import { HealthResponse, type HealthCheck } from '@media-tron/shared';
import type { AppModule } from '../../app.js';

// Health checks are plain functions returning zero or more findings. Modules append their
// own (download client unreachable, indexer failing, root folder missing…) in later phases.
type Check = () => HealthCheck[];

export const healthModule: AppModule = (ctx) => async (app) => {
  const checks: Check[] = [
    () => {
      const { bavail, bsize } = statfsSync(ctx.config.configDir);
      const freeBytes = bavail * bsize;
      if (freeBytes > 1024 ** 3) return [];
      return [
        {
          source: 'ConfigDiskSpace',
          status: 'warning',
          message: `Less than 1 GiB free on the config volume (${(freeBytes / 1024 ** 2).toFixed(0)} MiB)`,
        },
      ];
    },
  ];

  const evaluate = () => {
    const findings = checks.flatMap((c) => c());
    const status = findings.some((f) => f.status === 'error')
      ? 'error'
      : findings.some((f) => f.status === 'warning')
        ? 'warning'
        : 'ok';
    return HealthResponse.parse({ status, checks: findings });
  };

  app.get('/health', { schema: { response: { 200: HealthResponse } } }, async () => evaluate());

  ctx.scheduler.register({
    name: 'HealthCheck',
    cron: '*/5 * * * *',
    handler: async () => {
      const health = evaluate();
      ctx.bus.publish({ type: 'health', health });
      return `${health.checks.length} finding(s), status ${health.status}`;
    },
  });
};
