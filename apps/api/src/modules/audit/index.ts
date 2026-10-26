import type { FastifyInstance } from 'fastify';
import type { AppContext, AppModule } from '../../app.js';
import type { Scheduler } from '../../scheduler.js';
import { installAuditHook } from './hook.js';
import { auditRecorderFor } from './recorder.js';
import { auditRoutes } from './routes.js';
import { AuditService } from './service.js';

export { audit, auditRecorderFor, AuditRecorder, sanitizeDetails, type AuditEntry, type AuditSink } from './recorder.js';
export { describeAction, isSkipped } from './actions.js';
export { actorOf, auditHook } from './hook.js';
export { AuditService, csvCell } from './service.js';
export * from './schema.js';

export const AUDIT_CLEANUP_JOB = 'AuditCleanup';

export function registerAuditJobs(scheduler: Scheduler, service: AuditService): void {
  scheduler.register({
    name: AUDIT_CLEANUP_JOB,
    cron: '17 3 * * *',
    handler: async () => {
      const removed = service.prune();
      return removed > 0 ? `removed ${removed} audit events` : 'nothing to remove';
    },
  });
}

/**
 * Call on the /api/v1 scope right after installAuth(api, ctx), before modules register: every
 * mutating request on that scope is recorded on response. Also registers the recorder that
 * `audit(ctx).record(...)` uses.
 */
export function installAudit(scope: FastifyInstance, ctx: AppContext): void {
  installAuditHook(scope, auditRecorderFor(ctx.db, ctx.log.child({ module: 'audit' })));
}

/** GET /audit, /audit/actions, /audit/export (CSV), GET/PUT /settings/audit and the daily AuditCleanup job. */
export const auditModule: AppModule = (ctx) => async (app) => {
  auditRecorderFor(ctx.db, ctx.log.child({ module: 'audit' }));
  const service = new AuditService(ctx.db);
  await app.register(auditRoutes(service, ctx.bus));
  registerAuditJobs(ctx.scheduler, service);
};
