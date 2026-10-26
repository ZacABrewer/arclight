import {
  INDEXER_PRIORITY_DEFAULT,
  INDEXER_PRIORITY_MAX,
  INDEXER_PRIORITY_MIN,
  PASSWORD_MASK,
  qualityById,
  type CustomFormat,
  type CustomFormatSpec,
  type DelayProfile,
  type DownloadClientResource,
  type HealthCheck,
  type ImportList,
  type Indexer,
  type IndexerCreate,
  type IndexerImplementation,
  type IndexerUpdate,
  type NotificationConnection,
  type QualityDefinitionItem,
  type QualityProfile,
  type QualityProfileInput,
  type QualityProfileItem,
  type ReleaseProfile,
  type RootFolder,
  type Tag,
} from '@arclight/shared';
import { compact, CompatError, type Json } from './common.js';
import { languageCodeForId, SONARR_SOURCE_INT, v3Language, v3Quality, v3QualityById } from './quality.js';

// Configuration resources (profiles, indexers, clients, connections, folders) in the upstream
// "provider" shape: implementation / configContract / fields[{name, value}].

/** `fields: [{ order, name, label, value, type, advanced, privacy? }]`. */
export interface V3Field {
  order: number;
  name: string;
  label: string;
  value?: unknown;
  type: string;
  advanced: boolean;
  privacy?: string;
  selectOptions?: Json[];
}

function field(order: number, name: string, value: unknown, type = 'textbox', extra: Partial<V3Field> = {}): V3Field {
  const label = name
    .split('.')
    .pop()!
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
  return { order, name, label, ...(value !== undefined ? { value } : {}), type, advanced: false, ...extra };
}

/** Generic settings record -> fields; secret keys masked. */
function fieldsFromSettings(settings: Record<string, unknown>, secretKeys: readonly string[] = ['password', 'apiKey', 'token', 'secret']): V3Field[] {
  return Object.entries(settings).map(([name, value], i) => {
    const secret = secretKeys.some((k) => name.toLowerCase().includes(k.toLowerCase()));
    if (secret) return field(i, name, value ? PASSWORD_MASK : '', 'password', { privacy: 'password' });
    const type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : Array.isArray(value) ? 'tag' : 'textbox';
    return field(i, name, value, type);
  });
}

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---- root folders, tags -----------------------------------------------------------------

export function toV3RootFolder(r: RootFolder, totalSpace?: number | null): Json {
  return compact({
    id: r.id,
    path: r.path,
    accessible: r.accessible,
    freeSpace: r.freeSpaceBytes ?? 0,
    totalSpace: totalSpace ?? undefined,
    unmappedFolders: [],
    mediaType: r.mediaType,
  });
}

export function toV3Tag(t: Tag): Json {
  return { id: t.id, label: t.label };
}

// ---- quality profiles -------------------------------------------------------------------

function v3ProfileItem(item: QualityProfileItem): Json {
  if (item.kind === 'quality') return { quality: v3QualityById(item.qualityId), items: [], allowed: item.allowed };
  return {
    id: item.id,
    name: item.name,
    items: item.qualityIds.map((id) => ({ quality: v3QualityById(id), items: [], allowed: item.allowed })),
    allowed: item.allowed,
  };
}

export function toV3QualityProfile(p: QualityProfile, formats: readonly CustomFormat[]): Json {
  const scores = new Map(p.formatItems.map((f) => [f.formatId, f.score]));
  return {
    id: p.id,
    name: p.name,
    upgradeAllowed: p.upgradeAllowed,
    cutoff: p.cutoff,
    items: p.items.map(v3ProfileItem),
    minFormatScore: p.minFormatScore,
    cutoffFormatScore: p.cutoffFormatScore,
    minUpgradeFormatScore: p.minUpgradeFormatScore,
    formatItems: formats.map((f) => ({ format: f.id, name: f.name, score: scores.get(f.id) ?? 0 })),
    // Radarr-only; harmless for Sonarr clients.
    language: v3Language(p.languages[0] ?? 'original'),
  };
}

interface V3ProfileItemIn {
  id?: number | undefined;
  name?: string | undefined;
  quality?: { id: number } | null | undefined;
  items?: V3ProfileItemIn[] | undefined;
  allowed?: boolean | undefined;
}

export interface V3QualityProfileIn {
  name: string;
  upgradeAllowed?: boolean | undefined;
  cutoff: number;
  items: V3ProfileItemIn[];
  minFormatScore?: number | undefined;
  cutoffFormatScore?: number | undefined;
  minUpgradeFormatScore?: number | undefined;
  formatItems?: Array<{ format: number; score: number }> | undefined;
  language?: { id: number } | undefined;
}

/** Sonarr/Radarr quality profile body -> our QualityProfileInput. */
export function fromV3QualityProfile(body: V3QualityProfileIn, existing?: QualityProfile): QualityProfileInput {
  const items: QualityProfileItem[] = body.items.map((item) => {
    const children = item.items ?? [];
    if (item.quality && children.length === 0) {
      return { kind: 'quality', qualityId: item.quality.id, allowed: item.allowed ?? false };
    }
    if (item.id === undefined || !item.name) throw CompatError.validation('items', 'quality groups need an id and a name');
    return {
      kind: 'group',
      id: item.id,
      name: item.name,
      qualityIds: children.map((c) => c.quality?.id ?? 0),
      allowed: item.allowed ?? false,
    };
  });
  const language = body.language ? languageCodeForId(body.language.id) : undefined;
  return {
    name: body.name,
    upgradeAllowed: body.upgradeAllowed ?? existing?.upgradeAllowed ?? true,
    cutoff: body.cutoff,
    items,
    minFormatScore: body.minFormatScore ?? 0,
    cutoffFormatScore: body.cutoffFormatScore ?? 0,
    minUpgradeFormatScore: Math.max(1, body.minUpgradeFormatScore ?? 1),
    formatItems: (body.formatItems ?? []).filter((f) => f.score !== 0).map((f) => ({ formatId: f.format, score: f.score })),
    languages: language && language !== 'original' ? [language] : (existing?.languages ?? []),
  };
}

export function toV3QualityDefinition(d: QualityDefinitionItem): Json {
  const def = qualityById(d.qualityId);
  return compact({
    id: d.qualityId,
    quality: v3Quality(def),
    title: d.title,
    weight: d.weight,
    minSize: d.minSize ?? 0,
    maxSize: d.maxSize,
    preferredSize: d.preferredSize,
  });
}

// ---- custom formats, delay / release profiles -------------------------------------------

const SPEC_IMPLEMENTATION: Record<CustomFormatSpec['implementation'], string> = {
  releaseTitle: 'ReleaseTitleSpecification',
  releaseGroup: 'ReleaseGroupSpecification',
  edition: 'EditionSpecification',
  language: 'LanguageSpecification',
  source: 'SourceSpecification',
  resolution: 'ResolutionSpecification',
  qualityModifier: 'QualityModifierSpecification',
  size: 'SizeSpecification',
  indexerFlag: 'IndexerFlagSpecification',
  year: 'YearSpecification',
  releaseType: 'ReleaseTypeSpecification',
  releaseExtras: 'ReleaseExtrasSpecification',
};

function specFields(spec: CustomFormatSpec): V3Field[] {
  switch (spec.implementation) {
    case 'releaseTitle':
    case 'releaseGroup':
    case 'edition':
      return [field(0, 'value', spec.fields.pattern)];
    case 'language':
      return [field(0, 'value', v3Language(spec.fields.language).id, 'select'), field(1, 'exceptLanguage', spec.fields.exceptLanguage, 'checkbox')];
    case 'source':
      return [field(0, 'value', SONARR_SOURCE_INT[spec.fields.source] ?? spec.fields.source, 'select')];
    case 'resolution':
      return [field(0, 'value', spec.fields.resolution, 'select')];
    case 'qualityModifier':
      return [field(0, 'value', spec.fields.modifier, 'select')];
    case 'size':
      return [field(0, 'min', spec.fields.minGb, 'number'), field(1, 'max', spec.fields.maxGb, 'number')];
    case 'indexerFlag':
      return [field(0, 'value', spec.fields.flag, 'select')];
    case 'year':
      return [field(0, 'min', spec.fields.min, 'number'), field(1, 'max', spec.fields.max, 'number')];
    case 'releaseType':
      return [field(0, 'value', spec.fields.releaseType, 'select')];
    case 'releaseExtras':
      return [field(0, 'value', spec.fields.kinds, 'tag')];
  }
}

export function toV3CustomFormat(f: CustomFormat): Json {
  return {
    id: f.id,
    name: f.name,
    includeCustomFormatWhenRenaming: f.includeWhenRenaming,
    specifications: f.specifications.map((s) => ({
      name: s.name,
      implementation: SPEC_IMPLEMENTATION[s.implementation],
      implementationName: SPEC_IMPLEMENTATION[s.implementation].replace(/Specification$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
      negate: s.negate,
      required: s.required,
      fields: specFields(s),
    })),
  };
}

export function toV3DelayProfile(d: DelayProfile): Json {
  return {
    id: d.id,
    enableUsenet: true,
    enableTorrent: true,
    preferredProtocol: d.preferredProtocol,
    usenetDelay: d.usenetDelayMinutes,
    torrentDelay: d.torrentDelayMinutes,
    bypassIfHighestQuality: d.bypassIfHighestQuality,
    bypassIfAboveCustomFormatScore: d.bypassIfAboveCustomFormatScore,
    minimumCustomFormatScore: d.minimumCustomFormatScore,
    order: d.order,
    tags: d.tags,
  };
}

export function toV3ReleaseProfile(r: ReleaseProfile): Json {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    required: r.required,
    ignored: r.ignored,
    indexerId: r.indexerId ?? 0,
    tags: r.tags,
  };
}

// ---- indexers (Prowlarr application sync) -----------------------------------------------

const MINUTE = 60_000;

const INDEXER_IMPL: Record<IndexerImplementation, { name: string; contract: string; infoLink: string }> = {
  torznab: { name: 'Torznab', contract: 'TorznabSettings', infoLink: 'https://wiki.servarr.com/sonarr/supported#torznab' },
  newznab: { name: 'Newznab', contract: 'NewznabSettings', infoLink: 'https://wiki.servarr.com/sonarr/supported#newznab' },
  // Built-in site definitions have no upstream equivalent; they are torrent indexers, shown as Torznab.
  definition: { name: 'Torznab', contract: 'TorznabSettings', infoLink: '' },
};

interface IndexerFieldValues {
  baseUrl: string;
  apiPath: string;
  apiKey?: string | undefined;
  categories: number[];
  animeCategories: number[];
  additionalParameters?: string | undefined;
  minimumSeeders?: number | undefined;
  seedRatio?: number | undefined;
  seedTimeMs?: number | undefined;
  seasonPackSeedTimeMs?: number | undefined;
}

function indexerFields(impl: IndexerImplementation, v: IndexerFieldValues): V3Field[] {
  const fields: V3Field[] = [
    field(0, 'baseUrl', v.baseUrl, 'textbox', { label: 'URL' }),
    field(1, 'apiPath', v.apiPath, 'textbox', { label: 'API Path', advanced: true }),
    field(2, 'apiKey', v.apiKey ? PASSWORD_MASK : '', 'textbox', { label: 'API Key', privacy: 'apiKey' }),
    field(3, 'categories', v.categories, 'select'),
    field(4, 'animeCategories', v.animeCategories, 'select'),
    field(5, 'animeStandardFormatSearch', false, 'checkbox'),
    field(6, 'additionalParameters', v.additionalParameters ?? '', 'textbox', { advanced: true }),
    field(7, 'multiLanguages', [], 'select', { advanced: true }),
  ];
  if (impl !== 'newznab') {
    fields.push(
      field(8, 'minimumSeeders', v.minimumSeeders ?? 1, 'number', { advanced: true }),
      field(9, 'seedCriteria.seedRatio', v.seedRatio, 'textbox', { label: 'Seed Ratio' }),
      field(10, 'seedCriteria.seedTime', v.seedTimeMs === undefined ? undefined : Math.round(v.seedTimeMs / MINUTE), 'number', { label: 'Seed Time' }),
      field(11, 'seedCriteria.seasonPackSeedTime', v.seasonPackSeedTimeMs === undefined ? undefined : Math.round(v.seasonPackSeedTimeMs / MINUTE), 'number', {
        label: 'Season-Pack Seed Time',
      }),
      field(12, 'rejectBlocklistedTorrentHashesWhileGrabbing', false, 'checkbox', { advanced: true }),
    );
  }
  return fields;
}

export function toV3Indexer(ix: Indexer): Json {
  const impl = INDEXER_IMPL[ix.implementation];
  const s = ix.settings;
  return {
    id: ix.id,
    name: ix.name,
    fields: indexerFields(ix.implementation, {
      baseUrl: s.baseUrl,
      apiPath: s.apiPath,
      apiKey: s.apiKey,
      categories: s.categories,
      animeCategories: s.animeCategories,
      additionalParameters: s.additionalParameters,
      minimumSeeders: s.minimumSeeders,
      seedRatio: s.seedRatio,
      seedTimeMs: s.seedTime,
      seasonPackSeedTimeMs: s.seasonPackSeedTime,
    }),
    implementationName: impl.name,
    implementation: impl.name,
    configContract: impl.contract,
    infoLink: impl.infoLink,
    tags: ix.tags,
    enableRss: ix.enableRss,
    enableAutomaticSearch: ix.enableAutomaticSearch,
    enableInteractiveSearch: ix.enableInteractiveSearch,
    supportsRss: true,
    supportsSearch: true,
    protocol: ix.protocol,
    priority: ix.priority,
    seasonSearchMaximumSingleEpisodeAge: 0,
    downloadClientId: ix.downloadClientId ?? 0,
  };
}

/** GET /api/v3/indexer/schema: one blank template per implementation (Prowlarr fills it in). */
export function indexerSchemas(): Json[] {
  return (['newznab', 'torznab'] as const).map((implementation) => {
    const impl = INDEXER_IMPL[implementation];
    return {
      id: 0,
      name: '',
      fields: indexerFields(implementation, { baseUrl: '', apiPath: '/api', categories: [], animeCategories: [] }),
      implementationName: impl.name,
      implementation: impl.name,
      configContract: impl.contract,
      infoLink: impl.infoLink,
      tags: [],
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      supportsRss: true,
      supportsSearch: true,
      protocol: implementation === 'torznab' ? 'torrent' : 'usenet',
      priority: INDEXER_PRIORITY_DEFAULT,
      seasonSearchMaximumSingleEpisodeAge: 0,
      downloadClientId: 0,
      presets: [],
    };
  });
}

export interface V3ProviderBody {
  id?: number | undefined;
  name?: string | undefined;
  implementation?: string | undefined;
  configContract?: string | undefined;
  fields?: Array<{ name: string; value?: unknown }> | undefined;
  enableRss?: boolean | undefined;
  enableAutomaticSearch?: boolean | undefined;
  enableInteractiveSearch?: boolean | undefined;
  priority?: number | undefined;
  tags?: number[] | undefined;
  downloadClientId?: number | null | undefined;
}

function fieldMap(body: V3ProviderBody): Map<string, unknown> {
  return new Map((body.fields ?? []).map((f) => [f.name, f.value]));
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function intList(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  if (typeof v === 'string' && v.trim() !== '') return v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
  return [];
}

function implementationOf(body: V3ProviderBody): IndexerImplementation {
  const raw = (body.implementation ?? body.configContract ?? '').toLowerCase();
  if (raw.startsWith('torznab')) return 'torznab';
  if (raw.startsWith('newznab')) return 'newznab';
  throw CompatError.validation('implementation', `Unsupported indexer implementation "${body.implementation ?? ''}"; only Torznab and Newznab are supported`);
}

function clampPriority(p: number | undefined): number | undefined {
  if (p === undefined) return undefined;
  return Math.min(INDEXER_PRIORITY_MAX, Math.max(INDEXER_PRIORITY_MIN, Math.round(p)));
}

/** Prowlarr/Sonarr indexer body -> IndexerCreate. */
export function fromV3IndexerCreate(body: V3ProviderBody): IndexerCreate {
  const implementation = implementationOf(body);
  const f = fieldMap(body);
  const baseUrl = typeof f.get('baseUrl') === 'string' ? (f.get('baseUrl') as string).trim() : '';
  if (!baseUrl) throw CompatError.validation('baseUrl', "'Base Url' must not be empty.");
  const apiKey = f.get('apiKey');
  const seedRatio = num(f.get('seedCriteria.seedRatio'));
  const seedTime = num(f.get('seedCriteria.seedTime'));
  const seasonPackSeedTime = num(f.get('seedCriteria.seasonPackSeedTime'));
  const minimumSeeders = num(f.get('minimumSeeders'));
  const additionalParameters = f.get('additionalParameters');
  const priority = clampPriority(num(body.priority));
  return {
    name: body.name?.trim() || baseUrl,
    implementation,
    enableRss: body.enableRss ?? true,
    enableAutomaticSearch: body.enableAutomaticSearch ?? true,
    enableInteractiveSearch: body.enableInteractiveSearch ?? true,
    ...(priority !== undefined ? { priority } : {}),
    downloadClientId: body.downloadClientId ? body.downloadClientId : null,
    tags: body.tags ?? [],
    settings: {
      baseUrl,
      apiPath: typeof f.get('apiPath') === 'string' && (f.get('apiPath') as string).trim() ? (f.get('apiPath') as string).trim() : '/api',
      ...(typeof apiKey === 'string' && apiKey !== '' && apiKey !== PASSWORD_MASK ? { apiKey } : {}),
      categories: intList(f.get('categories')),
      animeCategories: intList(f.get('animeCategories')),
      ...(implementation === 'torznab' && minimumSeeders !== undefined ? { minimumSeeders: Math.max(0, Math.round(minimumSeeders)) } : {}),
      ...(implementation === 'torznab' && seedRatio !== undefined ? { seedRatio: Math.max(0, seedRatio) } : {}),
      ...(implementation === 'torznab' && seedTime !== undefined ? { seedTime: Math.max(0, Math.round(seedTime * MINUTE)) } : {}),
      ...(implementation === 'torznab' && seasonPackSeedTime !== undefined ? { seasonPackSeedTime: Math.max(0, Math.round(seasonPackSeedTime * MINUTE)) } : {}),
      ...(typeof additionalParameters === 'string' && additionalParameters !== '' ? { additionalParameters } : {}),
    },
  };
}

/** Same body as an update: a masked API key keeps the stored one. */
export function fromV3IndexerUpdate(body: V3ProviderBody): IndexerUpdate {
  const create = fromV3IndexerCreate(body);
  const { settings, ...rest } = create;
  return { ...rest, settings: { ...settings } };
}

// ---- download clients, notifications, import lists (read-only) ---------------------------

const CLIENT_IMPL: Record<DownloadClientResource['implementation'], string> = {
  qbittorrent: 'QBittorrent',
  transmission: 'Transmission',
  deluge: 'Deluge',
  rtorrent: 'RTorrent',
  sabnzbd: 'Sabnzbd',
  nzbget: 'Nzbget',
  builtin: 'ArclightBuiltin',
  remoteEngine: 'ArclightRemoteEngine',
};

export function toV3DownloadClient(c: DownloadClientResource): Json {
  const impl = CLIENT_IMPL[c.implementation];
  return {
    id: c.id,
    name: c.name,
    enable: c.enable,
    protocol: c.protocol,
    priority: c.priority,
    removeCompletedDownloads: c.removeCompletedDownloads,
    removeFailedDownloads: c.removeFailedDownloads,
    fields: fieldsFromSettings(c.settings as unknown as Record<string, unknown>),
    implementationName: impl === 'QBittorrent' ? 'qBittorrent' : impl,
    implementation: impl,
    configContract: `${impl}Settings`,
    infoLink: '',
    tags: c.tags,
  };
}

export function toV3Notification(n: NotificationConnection): Json {
  const impl = pascal(n.implementation);
  return {
    id: n.id,
    name: n.name,
    fields: fieldsFromSettings(n.settings),
    implementationName: impl,
    implementation: impl,
    configContract: `${impl}Settings`,
    infoLink: '',
    tags: n.tags,
    onGrab: n.onGrab,
    onDownload: n.onDownload,
    onUpgrade: n.onUpgrade,
    onRename: n.onRename,
    onSeriesAdd: n.onSeriesAdd,
    onSeriesDelete: n.onSeriesDelete,
    onMovieAdded: n.onMovieAdd,
    onMovieDelete: n.onMovieDelete,
    onEpisodeFileDelete: n.onFileDelete,
    onMovieFileDelete: n.onFileDelete,
    onHealthIssue: n.onHealthIssue,
    includeHealthWarnings: n.includeHealthWarnings,
    onHealthRestored: n.onHealthRestored,
    onApplicationUpdate: n.onApplicationUpdate,
    onManualInteractionRequired: n.onManualInteractionRequired,
    supportsOnGrab: n.supportsOnGrab,
    supportsOnDownload: n.supportsOnDownload,
    supportsOnUpgrade: n.supportsOnUpgrade,
    supportsOnRename: n.supportsOnRename,
    supportsOnSeriesAdd: n.supportsOnSeriesAdd,
    supportsOnSeriesDelete: n.supportsOnSeriesDelete,
    supportsOnEpisodeFileDelete: n.supportsOnFileDelete,
    supportsOnHealthIssue: n.supportsOnHealthIssue,
    supportsOnHealthRestored: n.supportsOnHealthRestored,
    supportsOnApplicationUpdate: n.supportsOnApplicationUpdate,
    supportsOnManualInteractionRequired: n.supportsOnManualInteractionRequired,
    enable: n.enabled,
  };
}

export function toV3ImportList(l: ImportList): Json {
  const impl = pascal(l.implementation);
  return compact({
    id: l.id,
    name: l.name,
    fields: fieldsFromSettings(l.settings),
    implementationName: impl,
    implementation: impl,
    configContract: `${impl}Settings`,
    infoLink: '',
    tags: l.tags,
    enableAutomaticAdd: l.enableAutomaticAdd,
    enabled: l.enabled,
    enableAuto: l.enableAutomaticAdd,
    searchForMissingEpisodes: l.searchOnAdd,
    searchOnAdd: l.searchOnAdd,
    shouldMonitor: l.monitorOption,
    monitor: l.monitorOption === 'none' ? 'none' : 'movieOnly',
    minimumAvailability: l.minimumAvailability,
    rootFolderPath: l.rootFolderPath,
    qualityProfileId: l.qualityProfileId,
    seriesType: l.seriesType,
    seasonFolder: l.seasonFolder,
    listType: 'other',
    listOrder: 0,
    minRefreshInterval: '06:00:00',
  });
}

// ---- health ------------------------------------------------------------------------------

export function toV3Health(c: HealthCheck): Json {
  return compact({ source: c.source, type: c.status, message: c.message, wikiUrl: c.wikiUrl });
}
