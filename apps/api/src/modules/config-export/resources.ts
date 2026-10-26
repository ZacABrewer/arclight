import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ConfigCustomFormat,
  ConfigDelayProfile,
  ConfigDownloadClient,
  ConfigImportList,
  ConfigIndexer,
  ConfigIndexerProxy,
  ConfigLanguageProfile,
  ConfigNotification,
  ConfigQualityProfile,
  ConfigReleaseProfile,
  ConfigRemotePathMapping,
  ConfigRootFolder,
  type ConfigResourceKind,
} from '@arclight/shared';
import { downloadClientSettingsSchemas } from '@arclight/download-clients';
import { isAgentKind, parseAgentSettings } from '@arclight/notifications';
import { DOWNLOAD_CLIENT_PROTOCOLS } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import {
  customFormats,
  delayProfiles,
  downloadClients,
  importLists,
  indexerProxies,
  indexers,
  languageProfiles,
  notifications,
  qualityProfiles,
  releaseProfiles,
  remotePathMappings,
  rootFolders,
  tags,
} from '../../db/schema.js';

// One descriptor per resource collection of the config document: how rows become document
// entries (ids replaced by names) and back. The importer is generic over these.

/** Kinds other resources reference by name. */
export type RefKind =
  | 'tags'
  | 'customFormats'
  | 'qualityProfiles'
  | 'downloadClients'
  | 'indexerProxies'
  | 'indexers'
  | 'languageProfiles';

/**
 * id <-> name lookups for references. `id()` returns null for unknown names; the importer checks
 * references before writing, so writers may treat null as "no reference".
 */
export class Refs {
  private readonly cache = new Map<RefKind, { byName: Map<string, number>; byId: Map<number, string> }>();

  constructor(private readonly db: Db) {}

  private maps(kind: RefKind) {
    let m = this.cache.get(kind);
    if (!m) {
      const rows = this.load(kind);
      m = { byName: new Map(rows.map((r) => [r.name, r.id])), byId: new Map(rows.map((r) => [r.id, r.name])) };
      this.cache.set(kind, m);
    }
    return m;
  }

  private load(kind: RefKind): Array<{ id: number; name: string }> {
    switch (kind) {
      case 'tags':
        return this.db.select({ id: tags.id, name: tags.label }).from(tags).all();
      case 'customFormats':
        return this.db.select({ id: customFormats.id, name: customFormats.name }).from(customFormats).all();
      case 'qualityProfiles':
        return this.db.select({ id: qualityProfiles.id, name: qualityProfiles.name }).from(qualityProfiles).all();
      case 'downloadClients':
        return this.db.select({ id: downloadClients.id, name: downloadClients.name }).from(downloadClients).all();
      case 'indexerProxies':
        return this.db.select({ id: indexerProxies.id, name: indexerProxies.name }).from(indexerProxies).all();
      case 'indexers':
        return this.db.select({ id: indexers.id, name: indexers.name }).from(indexers).all();
      case 'languageProfiles':
        return this.db.select({ id: languageProfiles.id, name: languageProfiles.name }).from(languageProfiles).all();
    }
  }

  /** Forget cached lookups (after a kind was written). */
  invalidate(kind?: RefKind): void {
    if (kind) this.cache.delete(kind);
    else this.cache.clear();
  }

  id(kind: RefKind, name: string | null | undefined): number | null {
    if (name === null || name === undefined) return null;
    return this.maps(kind).byName.get(name) ?? null;
  }

  name(kind: RefKind, id: number | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return this.maps(kind).byId.get(id) ?? null;
  }

  has(kind: RefKind, name: string): boolean {
    return this.maps(kind).byName.has(name);
  }

  /** Tag ids for labels; unknown labels are skipped (the importer creates tags first). */
  tagIds(labels: readonly string[]): number[] {
    return labels.map((l) => this.id('tags', l)).filter((id): id is number => id !== null);
  }

  /** Tag labels for ids; ids without a tag are dropped. */
  tagLabels(ids: readonly number[] | null | undefined): string[] {
    return (ids ?? []).map((id) => this.name('tags', id)).filter((l): l is string => l !== null);
  }
}

/** A row as the document sees it. */
export interface ResourceItem<E> {
  id: number;
  key: string;
  entry: E;
}

/** A reference an entry makes to another collection, checked before writing. */
export interface EntryRef {
  kind: RefKind;
  name: string;
  /** Field path inside the entry, for messages. */
  field: string;
}

/** A problem `check` found; warnings do not block the import. */
export interface EntryCheck {
  field: string;
  message: string;
  level: 'error' | 'warning';
}

export interface ResourceKindDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  kind: Exclude<ConfigResourceKind, 'tags'>;
  schema: S;
  /** Every row, keyed (unique keys; duplicates get a " (2)" suffix). */
  list(db: Db, refs: Refs): Array<ResourceItem<z.infer<S>>>;
  /** References to other collections (tags included). */
  refsOf(entry: z.infer<S>): EntryRef[];
  /** Implementation-specific checks after the structural parse. */
  check?(entry: z.infer<S>): EntryCheck[];
  /** The stable key the importer matches on; default: the document key. */
  keyOf?(entry: z.infer<S>, docKey: string): string;
  insert(db: Db, key: string, entry: z.infer<S>, refs: Refs, now: string): void;
  update(db: Db, id: number, key: string, entry: z.infer<S>, refs: Refs, now: string): void;
  remove(db: Db, id: number): void;
}

function define<S extends z.ZodTypeAny>(def: ResourceKindDef<S>): ResourceKindDef<S> {
  return def;
}

/** Unique keys in row order: the second "x" becomes "x (2)". */
function keyed<E>(rows: Array<{ id: number; key: string; entry: E }>): Array<ResourceItem<E>> {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = (seen.get(r.key) ?? 0) + 1;
    seen.set(r.key, n);
    return n === 1 ? r : { ...r, key: `${r.key} (${n})` };
  });
}

function tagRefs(labels: readonly string[], field = 'tags'): EntryRef[] {
  return labels.map((name) => ({ kind: 'tags' as const, name, field }));
}

const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);

// ---------------------------------------------------------------------------------------

const customFormatKind = define({
  kind: 'customFormats',
  schema: ConfigCustomFormat,
  list: (db) =>
    keyed(
      byId(db.select().from(customFormats).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: { includeWhenRenaming: r.includeWhenRenaming, specifications: r.specifications },
      })),
    ),
  refsOf: () => [],
  insert: (db, key, e) => {
    db.insert(customFormats).values({ name: key, ...e }).run();
  },
  update: (db, id, key, e) => {
    db.update(customFormats).set({ name: key, ...e }).where(eq(customFormats.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(customFormats).where(eq(customFormats.id, id)).run();
  },
});

const qualityProfileKind = define({
  kind: 'qualityProfiles',
  schema: ConfigQualityProfile,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(qualityProfiles).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          upgradeAllowed: r.upgradeAllowed,
          cutoff: r.cutoff,
          items: r.items,
          minFormatScore: r.minFormatScore,
          cutoffFormatScore: r.cutoffFormatScore,
          minUpgradeFormatScore: r.minUpgradeFormatScore,
          formatItems: r.formatItems
            .map((f) => ({ format: refs.name('customFormats', f.formatId), score: f.score }))
            .filter((f): f is { format: string; score: number } => f.format !== null),
          languages: r.languages,
        },
      })),
    ),
  refsOf: (e) => e.formatItems.map((f, i) => ({ kind: 'customFormats' as const, name: f.format, field: `formatItems[${i}].format` })),
  insert: (db, key, e, refs) => {
    db.insert(qualityProfiles).values({ name: key, ...qualityProfileValues(e, refs) }).run();
  },
  update: (db, id, key, e, refs) => {
    db.update(qualityProfiles).set({ name: key, ...qualityProfileValues(e, refs) }).where(eq(qualityProfiles.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(qualityProfiles).where(eq(qualityProfiles.id, id)).run();
  },
});

function qualityProfileValues(e: ConfigQualityProfile, refs: Refs) {
  return {
    upgradeAllowed: e.upgradeAllowed,
    cutoff: e.cutoff,
    items: e.items,
    minFormatScore: e.minFormatScore,
    cutoffFormatScore: e.cutoffFormatScore,
    minUpgradeFormatScore: e.minUpgradeFormatScore,
    formatItems: e.formatItems
      .map((f) => ({ formatId: refs.id('customFormats', f.format), score: f.score }))
      .filter((f): f is { formatId: number; score: number } => f.formatId !== null),
    languages: e.languages,
  };
}

/** Delay profiles have no name: their key is the tag set ("default" for the untagged one). */
export function delayProfileKey(labels: readonly string[]): string {
  return labels.length === 0 ? 'default' : [...labels].sort().join(', ');
}

const delayProfileKind = define({
  kind: 'delayProfiles',
  schema: ConfigDelayProfile,
  list: (db, refs) =>
    keyed(
      [...db.select().from(delayProfiles).all()]
        .sort((a, b) => a.order - b.order || a.id - b.id)
        .map((r) => {
          const labels = refs.tagLabels(r.tags);
          return {
            id: r.id,
            key: delayProfileKey(labels),
            entry: {
              order: r.order,
              tags: labels,
              preferredProtocol: r.preferredProtocol,
              usenetDelayMinutes: r.usenetDelayMinutes,
              torrentDelayMinutes: r.torrentDelayMinutes,
              bypassIfHighestQuality: r.bypassIfHighestQuality,
              bypassIfAboveCustomFormatScore: r.bypassIfAboveCustomFormatScore,
              minimumCustomFormatScore: r.minimumCustomFormatScore,
            },
          };
        }),
    ),
  refsOf: (e) => tagRefs(e.tags),
  insert: (db, _key, e, refs) => {
    db.insert(delayProfiles).values({ ...e, tags: refs.tagIds(e.tags) }).run();
  },
  update: (db, id, _key, e, refs) => {
    db.update(delayProfiles).set({ ...e, tags: refs.tagIds(e.tags) }).where(eq(delayProfiles.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(delayProfiles).where(eq(delayProfiles.id, id)).run();
  },
});

const releaseProfileKind = define({
  kind: 'releaseProfiles',
  schema: ConfigReleaseProfile,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(releaseProfiles).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          enabled: r.enabled,
          required: r.required,
          ignored: r.ignored,
          indexer: refs.name('indexers', r.indexerId),
          tags: refs.tagLabels(r.tags),
        },
      })),
    ),
  refsOf: (e) => [...(e.indexer ? [{ kind: 'indexers' as const, name: e.indexer, field: 'indexer' }] : []), ...tagRefs(e.tags)],
  insert: (db, key, e, refs) => {
    db.insert(releaseProfiles).values(releaseProfileValues(key, e, refs)).run();
  },
  update: (db, id, key, e, refs) => {
    db.update(releaseProfiles).set(releaseProfileValues(key, e, refs)).where(eq(releaseProfiles.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(releaseProfiles).where(eq(releaseProfiles.id, id)).run();
  },
});

function releaseProfileValues(key: string, e: ConfigReleaseProfile, refs: Refs) {
  return {
    name: key,
    enabled: e.enabled,
    required: e.required,
    ignored: e.ignored,
    indexerId: refs.id('indexers', e.indexer),
    tags: refs.tagIds(e.tags),
  };
}

const downloadClientKind = define({
  kind: 'downloadClients',
  schema: ConfigDownloadClient,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(downloadClients).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          implementation: r.implementation,
          enable: r.enable,
          protocol: r.protocol,
          priority: r.priority,
          removeCompletedDownloads: r.removeCompletedDownloads,
          removeFailedDownloads: r.removeFailedDownloads,
          tags: refs.tagLabels(r.tags),
          settings: r.settings,
        },
      })),
    ),
  refsOf: (e) => tagRefs(e.tags),
  check: (e) => {
    const out: EntryCheck[] = [];
    const expected = DOWNLOAD_CLIENT_PROTOCOLS[e.implementation];
    if (e.protocol !== expected) out.push({ field: 'protocol', message: `${e.implementation} downloads ${expected}`, level: 'error' });
    const parsed = downloadClientSettingsSchemas[e.implementation].safeParse(e.settings);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
      out.push({ field: 'settings', message: `does not match the ${e.implementation} settings (${fields}); the client will fail until fixed`, level: 'warning' });
    }
    return out;
  },
  insert: (db, key, e, refs, now) => {
    db.insert(downloadClients).values({ name: key, ...e, tags: refs.tagIds(e.tags), updatedAt: now }).run();
  },
  update: (db, id, key, e, refs, now) => {
    db.update(downloadClients)
      .set({ name: key, ...e, tags: refs.tagIds(e.tags), updatedAt: now })
      .where(eq(downloadClients.id, id))
      .run();
  },
  remove: (db, id) => {
    db.delete(downloadClients).where(eq(downloadClients.id, id)).run();
  },
});

const indexerProxyKind = define({
  kind: 'indexerProxies',
  schema: ConfigIndexerProxy,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(indexerProxies).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          type: r.type,
          host: r.host,
          port: r.port,
          username: r.username,
          password: r.password,
          requestTimeout: r.requestTimeout,
          tags: refs.tagLabels(r.tags),
        },
      })),
    ),
  refsOf: (e) => tagRefs(e.tags),
  insert: (db, key, e, refs) => {
    db.insert(indexerProxies).values({ name: key, ...e, tags: refs.tagIds(e.tags) }).run();
  },
  update: (db, id, key, e, refs) => {
    db.update(indexerProxies).set({ name: key, ...e, tags: refs.tagIds(e.tags) }).where(eq(indexerProxies.id, id)).run();
  },
  remove: (db, id) => {
    db.update(indexers).set({ proxyId: null }).where(eq(indexers.proxyId, id)).run();
    db.delete(indexerProxies).where(eq(indexerProxies.id, id)).run();
  },
});

const indexerKind = define({
  kind: 'indexers',
  schema: ConfigIndexer,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(indexers).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          implementation: r.implementation,
          enableRss: r.enableRss,
          enableAutomaticSearch: r.enableAutomaticSearch,
          enableInteractiveSearch: r.enableInteractiveSearch,
          priority: r.priority,
          downloadClient: refs.name('downloadClients', r.downloadClientId),
          proxy: refs.name('indexerProxies', r.proxyId),
          tags: refs.tagLabels(r.tags),
          settings: r.settings,
        },
      })),
    ),
  refsOf: (e) => [
    ...(e.downloadClient ? [{ kind: 'downloadClients' as const, name: e.downloadClient, field: 'downloadClient' }] : []),
    ...(e.proxy ? [{ kind: 'indexerProxies' as const, name: e.proxy, field: 'proxy' }] : []),
    ...tagRefs(e.tags),
  ],
  insert: (db, key, e, refs, now) => {
    db.insert(indexers).values({ name: key, ...indexerValues(e, refs), addedAt: now }).run();
  },
  update: (db, id, key, e, refs) => {
    db.update(indexers).set({ name: key, ...indexerValues(e, refs) }).where(eq(indexers.id, id)).run();
  },
  remove: (db, id) => {
    db.update(releaseProfiles).set({ indexerId: null }).where(eq(releaseProfiles.indexerId, id)).run();
    db.delete(indexers).where(eq(indexers.id, id)).run();
  },
});

function indexerValues(e: ConfigIndexer, refs: Refs) {
  return {
    implementation: e.implementation,
    enableRss: e.enableRss,
    enableAutomaticSearch: e.enableAutomaticSearch,
    enableInteractiveSearch: e.enableInteractiveSearch,
    priority: e.priority,
    downloadClientId: refs.id('downloadClients', e.downloadClient),
    proxyId: refs.id('indexerProxies', e.proxy),
    tags: refs.tagIds(e.tags),
    settings: e.settings,
  };
}

/** Remote path mappings are identified by host + remote path (unique in the table). */
export function remotePathKey(host: string, remotePath: string): string {
  return `${host}:${remotePath}`;
}

const remotePathMappingKind = define({
  kind: 'remotePathMappings',
  schema: ConfigRemotePathMapping,
  list: (db) =>
    keyed(
      byId(db.select().from(remotePathMappings).all()).map((r) => ({
        id: r.id,
        key: remotePathKey(r.host, r.remotePath),
        entry: { host: r.host, remotePath: r.remotePath, localPath: r.localPath },
      })),
    ),
  refsOf: () => [],
  keyOf: (e) => remotePathKey(e.host, e.remotePath),
  insert: (db, _key, e) => {
    db.insert(remotePathMappings).values(e).run();
  },
  update: (db, id, _key, e) => {
    db.update(remotePathMappings).set(e).where(eq(remotePathMappings.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(remotePathMappings).where(eq(remotePathMappings.id, id)).run();
  },
});

const rootFolderKind = define({
  kind: 'rootFolders',
  schema: ConfigRootFolder,
  list: (db) =>
    keyed(byId(db.select().from(rootFolders).all()).map((r) => ({ id: r.id, key: r.path, entry: { mediaType: r.mediaType } }))),
  refsOf: () => [],
  insert: (db, key, e) => {
    db.insert(rootFolders).values({ path: key, mediaType: e.mediaType }).run();
  },
  update: (db, id, key, e) => {
    db.update(rootFolders).set({ path: key, mediaType: e.mediaType }).where(eq(rootFolders.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(rootFolders).where(eq(rootFolders.id, id)).run();
  },
});

const NOTIFICATION_FLAGS = [
  'onGrab',
  'onDownload',
  'onUpgrade',
  'onRename',
  'onSeriesAdd',
  'onMovieAdd',
  'onSeriesDelete',
  'onMovieDelete',
  'onFileDelete',
  'onHealthIssue',
  'onHealthRestored',
  'onApplicationUpdate',
  'onManualInteractionRequired',
  'onRequestCreated',
  'onRequestApproved',
  'onRequestDeclined',
  'onRequestAvailable',
  'onIssueCreated',
  'onIssueUpdated',
  'includeHealthWarnings',
] as const;

const notificationKind = define({
  kind: 'notifications',
  schema: ConfigNotification,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(notifications).all()).map((r) => {
        const flags = Object.fromEntries(NOTIFICATION_FLAGS.map((f) => [f, r[f]])) as Record<(typeof NOTIFICATION_FLAGS)[number], boolean>;
        return {
          id: r.id,
          key: r.name,
          entry: { implementation: r.implementation, enabled: r.enabled, ...flags, tags: refs.tagLabels(r.tags), settings: r.settings },
        };
      }),
    ),
  refsOf: (e) => tagRefs(e.tags),
  check: (e) => {
    if (!isAgentKind(e.implementation)) return [];
    try {
      parseAgentSettings(e.implementation, e.settings);
      return [];
    } catch (err) {
      const message = err instanceof Error ? (err.message.split(/\r?\n/)[0] ?? err.message) : String(err);
      return [{ field: 'settings', message: `does not match the ${e.implementation} settings: ${message}`, level: 'warning' }];
    }
  },
  insert: (db, key, e, refs, now) => {
    db.insert(notifications).values({ name: key, ...e, tags: refs.tagIds(e.tags), addedAt: now, updatedAt: now }).run();
  },
  update: (db, id, key, e, refs, now) => {
    db.update(notifications)
      .set({ name: key, ...e, tags: refs.tagIds(e.tags), updatedAt: now })
      .where(eq(notifications.id, id))
      .run();
  },
  remove: (db, id) => {
    db.delete(notifications).where(eq(notifications.id, id)).run();
  },
});

const importListKind = define({
  kind: 'importLists',
  schema: ConfigImportList,
  list: (db, refs) =>
    keyed(
      byId(db.select().from(importLists).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          implementation: r.implementation,
          enabled: r.enabled,
          enableAutomaticAdd: r.enableAutomaticAdd,
          searchOnAdd: r.searchOnAdd,
          monitorOption: r.monitorOption,
          seriesType: r.seriesType,
          seasonFolder: r.seasonFolder,
          rootFolderPath: r.rootFolderPath,
          movieRootFolderPath: r.movieRootFolderPath,
          qualityProfile: refs.name('qualityProfiles', r.qualityProfileId) ?? `#${r.qualityProfileId}`,
          tags: refs.tagLabels(r.tags),
          minimumAvailability: r.minimumAvailability,
          mediaType: r.mediaType,
          settings: r.settings,
        },
      })),
    ),
  refsOf: (e) => [{ kind: 'qualityProfiles' as const, name: e.qualityProfile, field: 'qualityProfile' }, ...tagRefs(e.tags)],
  insert: (db, key, e, refs, now) => {
    db.insert(importLists).values({ ...importListValues(key, e, refs), addedAt: now }).run();
  },
  update: (db, id, key, e, refs) => {
    db.update(importLists).set(importListValues(key, e, refs)).where(eq(importLists.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(importLists).where(eq(importLists.id, id)).run();
  },
});

function importListValues(key: string, e: ConfigImportList, refs: Refs) {
  const { qualityProfile, tags: labels, ...rest } = e;
  return { name: key, ...rest, qualityProfileId: refs.id('qualityProfiles', qualityProfile) ?? 0, tags: refs.tagIds(labels) };
}

const languageProfileKind = define({
  kind: 'languageProfiles',
  schema: ConfigLanguageProfile,
  list: (db) =>
    keyed(
      byId(db.select().from(languageProfiles).all()).map((r) => ({
        id: r.id,
        key: r.name,
        entry: {
          languages: r.languages,
          cutoff: r.cutoff,
          mustContain: r.mustContain,
          mustNotContain: r.mustNotContain,
          originalFormat: r.originalFormat,
        },
      })),
    ),
  refsOf: () => [],
  insert: (db, key, e) => {
    db.insert(languageProfiles).values({ name: key, ...e }).run();
  },
  update: (db, id, key, e) => {
    db.update(languageProfiles).set({ name: key, ...e }).where(eq(languageProfiles.id, id)).run();
  },
  remove: (db, id) => {
    db.delete(languageProfiles).where(eq(languageProfiles.id, id)).run();
  },
});

/** Dependency order: a kind only references kinds before it. Prune runs in reverse. */
export const RESOURCE_KINDS: readonly ResourceKindDef[] = [
  customFormatKind,
  qualityProfileKind,
  downloadClientKind,
  indexerProxyKind,
  indexerKind,
  releaseProfileKind,
  delayProfileKind,
  remotePathMappingKind,
  rootFolderKind,
  notificationKind,
  importListKind,
  languageProfileKind,
];

/** Tag labels in id order. */
export function listTags(db: Db): Array<{ id: number; label: string }> {
  return byId(db.select().from(tags).all());
}
