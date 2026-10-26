import { finding, type HealthCheckDef } from '../types.js';

/** A Remote Engine download client whose agent cannot be reached (one finding per engine). */
export const remoteEngineUnreachableCheck: HealthCheckDef = {
  id: 'RemoteEngineUnreachable',
  async run(deps) {
    if (!deps.remoteEngines) return [];
    const engines = await deps.remoteEngines();
    return engines
      .filter((e) => !e.ok)
      .map((e) =>
        finding(
          this.id,
          'error',
          `Remote engine ${e.name} (${e.url}) is unreachable${e.message ? `: ${e.message}` : ''}. Downloads on it are not tracked or imported until it is back.`,
          'remote-engine-unreachable',
        ),
      );
  },
};
