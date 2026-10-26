import { finding, type HealthCheckDef } from '../types.js';

/** No TMDB API key in settings or the environment: no metadata, no adding media. */
export const metadataSourceCheck: HealthCheckDef = {
  id: 'MetadataSourceCheck',
  async run(deps) {
    if (deps.tmdbKeyConfigured()) return [];
    return [
      finding(
        this.id,
        'error',
        'TMDB API key is not configured; series and movie metadata cannot be fetched. Set it in Settings > Metadata or ARCLIGHT_TMDB_API_KEY',
        'tmdb-api-key-missing',
      ),
    ];
  },
};

/** Update available. There is no update channel until Phase 6, so this always passes. */
export const updateCheck: HealthCheckDef = {
  id: 'UpdateCheck',
  async run() {
    return [];
  },
};

/**
 * System clock skew. Needs an authoritative time source, which Arclight does not contact
 * (privacy); the extension point exists and always passes.
 */
export const systemTimeCheck: HealthCheckDef = {
  id: 'SystemTimeCheck',
  async run() {
    return [];
  },
};

// Import lists arrive in Phase 2; their status/root-folder checks are registered then.

/** In Docker, the container user (PUID/PGID) must be able to write the config volume. */
export const dockerPermissionsCheck: HealthCheckDef = {
  id: 'DockerPermissionsCheck',
  async run(deps) {
    if (!deps.isDocker) return [];
    if (await deps.fs.canWrite(deps.configDir)) return [];
    const { uid, gid } = deps.processIds;
    const owner = await deps.fs.owner(deps.configDir);
    const runningAs = uid !== undefined ? ` (running as uid ${uid}, gid ${gid ?? '?'})` : '';
    const ownedBy = owner ? `; ${deps.configDir} is owned by uid ${owner.uid}, gid ${owner.gid}` : '';
    return [
      finding(
        this.id,
        'error',
        `${deps.appName} cannot write to ${deps.configDir}${runningAs}${ownedBy}. Set the container's PUID/PGID to the owner of the config volume`,
        'docker-puid-pgid-mismatch',
      ),
    ];
  },
};
