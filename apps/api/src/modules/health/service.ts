import type { Logger } from 'pino';
import { HealthResponse, type HealthCheck, type HealthStatus } from '@media-tron/shared';
import type { HealthCheckDef, HealthDeps } from './types.js';

// Runs the check catalogue and caches the latest results. Each check is isolated: one that
// throws is logged and contributes nothing, never failing the whole run. Concurrent callers
// share one in-flight run.

export class HealthService {
  private latest: HealthResponse | null = null;
  private latestAt: Date | null = null;
  private inFlight: Promise<HealthResponse> | null = null;

  constructor(
    private readonly checks: HealthCheckDef[],
    private readonly deps: () => HealthDeps,
    private readonly log?: Logger,
  ) {}

  /** Cached results, running the checks first if they never ran. */
  async current(): Promise<HealthResponse> {
    return this.latest ?? this.run();
  }

  lastRunAt(): Date | null {
    return this.latestAt;
  }

  run(): Promise<HealthResponse> {
    if (!this.inFlight) {
      this.inFlight = this.runAll().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async runAll(): Promise<HealthResponse> {
    let deps: HealthDeps;
    try {
      deps = this.deps();
    } catch (err) {
      this.log?.error({ err }, 'health check dependencies unavailable');
      throw err;
    }
    const results = await Promise.all(
      this.checks.map(async (check): Promise<HealthCheck[]> => {
        try {
          return (await check.run(deps)).filter((r) => r.status !== 'ok');
        } catch (err) {
          this.log?.warn({ err, check: check.id }, 'health check threw');
          return [];
        }
      }),
    );
    const checks = results.flat();
    const response = HealthResponse.parse({ status: overallStatus(checks), checks });
    this.latest = response;
    this.latestAt = deps.now();
    return response;
  }
}

export function overallStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warning')) return 'warning';
  return 'ok';
}
