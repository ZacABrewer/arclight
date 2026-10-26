import { finding, type HealthCheckDef, type HealthDeps, type HealthIndexer } from '../types.js';

const LONG_TERM_MS = 6 * 60 * 60_000;

function isEnabled(i: HealthIndexer): boolean {
  return i.enableRss || i.enableAutomaticSearch || i.enableInteractiveSearch;
}

function isBlocked(i: HealthIndexer, now: Date): boolean {
  return i.disabledTill !== undefined && Date.parse(i.disabledTill) > now.getTime();
}

function enabledIndexers(deps: HealthDeps): HealthIndexer[] {
  return deps.indexers().filter(isEnabled);
}

/** No indexer has any of RSS / automatic / interactive search switched on. */
export const indexerCheck: HealthCheckDef = {
  id: 'IndexerCheck',
  async run(deps) {
    if (enabledIndexers(deps).length > 0) return [];
    return [finding(this.id, 'error', `No indexers enabled, ${deps.appName} will not return search results`, 'no-indexers-enabled')];
  },
};

/**
 * Indexers in failure back-off, split by how long the failure streak has lasted (< 6 h and
 * > 6 h). "All" means every enabled indexer, so a mix across the two windows gives Warnings.
 */
function statusCheck(id: string, longTerm: boolean): HealthCheckDef {
  const window = longTerm ? ' for more than 6 hours' : '';
  return {
    id,
    async run(deps) {
      const now = deps.now();
      const enabled = enabledIndexers(deps);
      const blocked = enabled.filter((i) => {
        if (!isBlocked(i, now)) return false;
        const started = i.initialFailure ? Date.parse(i.initialFailure) : now.getTime();
        return now.getTime() - started > LONG_TERM_MS === longTerm;
      });
      if (blocked.length === 0) return [];
      if (blocked.length === enabled.length) {
        return [finding(id, 'error', `All indexers are unavailable due to failures${window}`, 'indexers-are-unavailable-due-to-failures')];
      }
      return [
        finding(
          id,
          'warning',
          `Indexers unavailable due to failures${window}: ${blocked.map((i) => i.name).join(', ')}`,
          'indexers-are-unavailable-due-to-failures',
        ),
      ];
    },
  };
}

export const indexerStatusCheck = statusCheck('IndexerStatusCheck', false);
export const indexerLongTermStatusCheck = statusCheck('IndexerLongTermStatusCheck', true);

/** RSS: none enabled is an Error; all RSS indexers in back-off a Warning. */
export const indexerRssCheck: HealthCheckDef = {
  id: 'IndexerRssCheck',
  async run(deps) {
    const enabled = enabledIndexers(deps);
    if (enabled.length === 0) return []; // IndexerCheck already says so
    const rss = enabled.filter((i) => i.enableRss);
    if (rss.length === 0) {
      return [
        finding(
          this.id,
          'error',
          `No indexers available with RSS sync enabled, ${deps.appName} will not grab new releases automatically`,
          'no-indexers-available-with-rss-sync-enabled',
        ),
      ];
    }
    const now = deps.now();
    if (rss.every((i) => isBlocked(i, now))) {
      return [
        finding(
          this.id,
          'warning',
          'All rss-capable indexers are temporarily unavailable due to recent indexer errors',
          'indexers-are-unavailable-due-to-failures',
        ),
      ];
    }
    return [];
  },
};

/** Search: no automatic, no interactive, or every automatic indexer in back-off (all Warnings). */
export const indexerSearchCheck: HealthCheckDef = {
  id: 'IndexerSearchCheck',
  async run(deps) {
    const enabled = enabledIndexers(deps);
    if (enabled.length === 0) return [];
    const automatic = enabled.filter((i) => i.enableAutomaticSearch);
    if (automatic.length === 0) {
      return [
        finding(
          this.id,
          'warning',
          `No indexers available with Automatic Search enabled, ${deps.appName} will not provide any automatic search results`,
          'no-indexers-available-with-automatic-search-enabled',
        ),
      ];
    }
    if (!enabled.some((i) => i.enableInteractiveSearch)) {
      return [
        finding(
          this.id,
          'warning',
          `No indexers available with Interactive Search enabled, ${deps.appName} will not provide any interactive search results`,
          'no-indexers-available-with-interactive-search-enabled',
        ),
      ];
    }
    const now = deps.now();
    if (automatic.every((i) => isBlocked(i, now))) {
      return [
        finding(
          this.id,
          'warning',
          'All search-capable indexers are temporarily unavailable due to recent indexer errors',
          'indexers-are-unavailable-due-to-failures',
        ),
      ];
    }
    return [];
  },
};
