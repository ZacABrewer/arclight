import type {
  MigrateApp,
  MigrateArea,
  MigrateConflictPolicy,
  MigrateSourceInput,
  MigrateStackApplyRequest,
  MigrateStackPreview,
  MigrateTorrentAction,
  MigrationPlan,
} from '@arclight/shared';

// Pure state of the "Import your existing stack" wizard: the sources being connected, what
// the preview selected, and how both turn into the API requests.

export const STACK_APPS: readonly MigrateApp[] = ['sonarr', 'radarr', 'prowlarr', 'bazarr', 'seerr', 'qbittorrent'];

export interface MappingDraft {
  key: number;
  from: string;
  to: string;
}

export interface SourceDraft {
  id: number;
  app: MigrateApp;
  /** Empty for the first instance of an app; "Sonarr 4K" for a second one. */
  label: string;
  mode: 'api' | 'files';
  url: string;
  apiKey: string;
  username: string;
  password: string;
  dbPath: string;
  configPath: string;
  mappings: MappingDraft[];
}

export function newDraft(id: number, app: MigrateApp, label = ''): SourceDraft {
  return { id, app, label, mode: 'api', url: '', apiKey: '', username: '', password: '', dbPath: '', configPath: '', mappings: [] };
}

/** The API source for a draft (only the fields its mode uses). */
export function toSource(d: SourceDraft): MigrateSourceInput {
  const pathMappings = d.mappings.filter((m) => m.from.trim() && m.to.trim()).map((m) => ({ from: m.from.trim(), to: m.to.trim() }));
  const base: MigrateSourceInput = { app: d.app, mode: d.mode, pathMappings, ...(d.label.trim() ? { label: d.label.trim() } : {}) };
  if (d.mode === 'files') {
    return { ...base, dbPath: d.dbPath.trim(), ...(d.configPath.trim() ? { configPath: d.configPath.trim() } : {}) };
  }
  if (d.app === 'qbittorrent') return { ...base, url: d.url.trim(), username: d.username, password: d.password };
  return { ...base, url: d.url.trim(), apiKey: d.apiKey.trim() };
}

/** What still blocks a draft from being previewed (null when complete). */
export function draftProblem(d: SourceDraft): 'url' | 'urlScheme' | 'apiKey' | 'dbPath' | null {
  if (d.mode === 'files') return d.dbPath.trim() ? null : 'dbPath';
  if (!d.url.trim()) return 'url';
  if (!/^https?:\/\//i.test(d.url.trim())) return 'urlScheme';
  if (d.app !== 'qbittorrent' && !d.apiKey.trim()) return 'apiKey';
  return null;
}

/** Areas pre-selected after the preview: anything that would write or stage something. */
export function defaultAreas(plan: MigrationPlan): MigrateArea[] {
  return plan.areas.filter((a) => a.mode !== 'report' && (a.create + a.conflicts > 0 || (a.mode === 'stage' && a.total > 0))).map((a) => a.area);
}

export interface Selections {
  /** Per preview key ("0", "1", ...): the areas to import. */
  areas: Record<string, MigrateArea[]>;
  conflictPolicy: MigrateConflictPolicy;
  areaPolicies: Partial<Record<MigrateArea, MigrateConflictPolicy>>;
  /** qBittorrent category ('' = none) → action. */
  categories: Record<string, MigrateTorrentAction>;
}

export function defaultSelections(preview: MigrateStackPreview): Selections {
  const areas: Record<string, MigrateArea[]> = {};
  const categories: Record<string, MigrateTorrentAction> = {};
  for (const s of preview.sources) {
    areas[s.key] = s.plan ? defaultAreas(s.plan) : [];
    for (const c of s.plan?.torrentCategories ?? []) categories[c.category] = 'adopt';
  }
  return { areas, conflictPolicy: 'skip', areaPolicies: {}, categories };
}

export interface RunOptions {
  dryRun: boolean;
  backup: boolean;
  verify: 'recheck' | 'trust';
  pauseInSource: boolean;
  confirmSourceChanges: boolean;
}

export const DEFAULT_OPTIONS: RunOptions = { dryRun: true, backup: true, verify: 'recheck', pauseInSource: false, confirmSourceChanges: false };

/** The stack apply request: only sources that previewed without an error, with their selected areas. */
export function buildApplyRequest(drafts: readonly SourceDraft[], preview: MigrateStackPreview, sel: Selections, opts: RunOptions): MigrateStackApplyRequest {
  const sources = preview.sources
    .filter((s) => s.plan !== null)
    .flatMap((s) => {
      const draft = drafts[Number(s.key)];
      const areas = sel.areas[s.key] ?? [];
      return draft && areas.length > 0 ? [{ source: toSource(draft), areas }] : [];
    });
  return {
    sources,
    conflictPolicy: sel.conflictPolicy,
    areaPolicies: sel.areaPolicies,
    dryRun: opts.dryRun,
    backup: opts.backup,
    torrents: {
      categories: sel.categories,
      defaultAction: 'adopt',
      verify: opts.verify,
      pauseInSource: opts.pauseInSource && opts.confirmSourceChanges,
      confirmSourceChanges: opts.pauseInSource && opts.confirmSourceChanges,
    },
  };
}
