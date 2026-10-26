import { finding, type HealthCheckDef } from '../types.js';

/** A FlareSolverr-type indexer proxy (bundled container, external, or the built-in solver) is down. */
export const flareSolverrUnreachableCheck: HealthCheckDef = {
  id: 'FlareSolverrUnreachable',
  async run(deps) {
    if (!deps.flareSolverrs) return [];
    const solvers = await deps.flareSolverrs();
    return solvers
      .filter((s) => !s.ok)
      .map((s) =>
        finding(
          this.id,
          'warning',
          `Challenge solver "${s.name}" is unreachable${s.message ? `: ${s.message}` : ''}. Cloudflare-protected indexers will fail until it is back.`,
          'flaresolverr-unreachable',
        ),
      );
  },
};
