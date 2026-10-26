import { useState } from 'react';
import type { ImportList, ImportListCreateInput, ImportListField, ImportListMediaType, ImportListSchema } from '@arclight/shared';
import { Input } from '../../../arclight/index.js';
import { tagRenderer } from '../../../components/forms/tag-picker.js';
import type { FieldDefinition, FieldRendererProps, FieldRenderers, FormValues } from '../../../components/forms/types.js';
import { MINIMUM_AVAILABILITY_LABELS, MONITOR_OPTION_LABELS, SERIES_TYPE_LABELS } from '../../library/add-form.js';
import { t } from '../../../i18n/index.js';

// Maps the import-list schema (GET /importlist/schema) and the list-level defaults onto the
// shared schema-form vocabulary, and turns form values back into a create/update body.

export const MEDIA_TYPE_LABELS: Record<ImportListMediaType, string> = { get series() { return t('common.series'); }, get movie() { return t('common.movies'); }, get both() { return t('settings.importLists.fields.seriesMovies'); } };

const options = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }));

/** Comma-separated input for textList / numberList settings. Keeps the raw text while typing. */
function ListInput({ id, value, onChange, numeric }: FieldRendererProps & { numeric: boolean }) {
  const initial = Array.isArray(value) ? value.join(', ') : '';
  const [text, setText] = useState(initial);
  return (
    <Input
      id={id}
      type="text"
      value={text}
      placeholder={t('settings.importLists.fields.commaSeparated')}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        setText(raw);
        const parts = raw
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        onChange(numeric ? parts.map(Number).filter((n) => Number.isFinite(n)) : parts);
      }}
    />
  );
}

function ReadOnlyValue({ id, value }: FieldRendererProps) {
  const shown = value === undefined || value === null || value === '' ? t('settings.importLists.fields.notSet') : value === '********' ? t('settings.importLists.fields.stored') : String(value);
  return (
    <span id={id} className="al-muted">
      {shown}
    </span>
  );
}

const toFieldType = (item: ImportListField['type']): FieldDefinition['type'] => {
  switch (item) {
    case 'boolean':
      return 'checkbox';
    case 'password':
    case 'number':
    case 'select':
      return item;
    default:
      return 'text';
  }
};

/** Implementation fields, namespaced under `settings.`, plus renderers for list/read-only types. */
export function settingsFields(schema: ImportListSchema | undefined): { fields: FieldDefinition[]; renderers: FieldRenderers } {
  const renderers: FieldRenderers = { tags: tagRenderer };
  const fields = (schema?.fields ?? []).map((f): FieldDefinition => {
    const name = `settings.${f.name}`;
    if (f.readOnly) renderers[name] = ReadOnlyValue;
    else if (f.type === 'textList') renderers[name] = (p) => <ListInput {...p} numeric={false} />;
    else if (f.type === 'numberList') renderers[name] = (p) => <ListInput {...p} numeric />;
    return {
      name,
      label: f.label,
      type: toFieldType(f.type),
      helpText: f.helpText,
      required: f.readOnly ? false : f.required,
      default: f.default,
      options: f.options,
      min: f.min,
      max: f.max,
    };
  });
  return { fields, renderers };
}

export interface RootFolderOption {
  path: string;
  mediaType: 'series' | 'movie';
}

/** Root folders for one media type; every folder when none is marked for it. */
export function rootsFor(rootFolders: readonly RootFolderOption[], type: 'series' | 'movie'): RootFolderOption[] {
  const matching = rootFolders.filter((r) => r.mediaType === type);
  return matching.length ? matching : [...rootFolders];
}

export interface ListFieldContext {
  schema: ImportListSchema | undefined;
  mediaType: ImportListMediaType;
  rootFolders: readonly RootFolderOption[];
  profiles: readonly { id: number; name: string }[];
}

/** List-level defaults used when an item is added. Series-/movie-only fields follow the media type. */
export function listFields({ schema, mediaType, rootFolders, profiles }: ListFieldContext): FieldDefinition[] {
  const opts = (type: 'series' | 'movie') => rootsFor(rootFolders, type).map((r) => ({ value: r.path, label: r.path }));
  const supported = schema?.supportedMediaTypes ?? ['series', 'movie', 'both'];
  const series = mediaType !== 'movie';
  const movies = mediaType !== 'series';
  const fields: Array<FieldDefinition | false> = [
    { name: 'name', label: t('common.name'), type: 'text', required: true },
    { name: 'enabled', label: t('common.enabled'), type: 'checkbox' },
    { name: 'enableAutomaticAdd', label: t('settings.importLists.fields.addAutomatically'), type: 'checkbox', helpText: t('settings.importLists.fields.offOnlyFetchTheList') },
    { name: 'mediaType', label: t('common.mediaType'), type: 'select', required: true, options: supported.map((m) => ({ value: m, label: MEDIA_TYPE_LABELS[m] })) },
    {
      name: 'rootFolderPath',
      label: mediaType === 'both' ? t('settings.importLists.fields.seriesRootFolder') : t('common.rootFolder'),
      type: 'select',
      required: true,
      options: opts(mediaType === 'movie' ? 'movie' : 'series'),
    },
    mediaType === 'both' && { name: 'movieRootFolderPath', label: t('settings.importLists.fields.movieRootFolder'), type: 'select', required: true, options: opts('movie') },
    {
      name: 'qualityProfileId',
      label: t('common.qualityProfile'),
      type: 'select',
      required: true,
      options: profiles.map((p) => ({ value: p.id, label: p.name })),
    },
    series && { name: 'monitorOption', label: t('common.monitor'), type: 'select', options: options(MONITOR_OPTION_LABELS) },
    series && { name: 'seriesType', label: t('common.seriesType'), type: 'select', options: options(SERIES_TYPE_LABELS) },
    series && { name: 'seasonFolder', label: t('common.seasonFolders'), type: 'checkbox' },
    movies && { name: 'minimumAvailability', label: t('common.minimumAvailability'), type: 'select', options: options(MINIMUM_AVAILABILITY_LABELS) },
    { name: 'searchOnAdd', label: t('common.searchOnAdd'), type: 'checkbox', helpText: t('settings.importLists.fields.searchForMissingItemsAs') },
    { name: 'tags', label: t('common.tags'), type: 'text', helpText: t('settings.importLists.fields.appliedToEveryItemAdded') },
  ];
  return fields.filter((f): f is FieldDefinition => f !== false);
}

/** Start values for a new list from its schema, with the first root folder / profile preselected. */
export function newListValues(schema: ImportListSchema, ctx: Pick<ListFieldContext, 'rootFolders' | 'profiles'>): FormValues {
  const mediaType = schema.supportedMediaTypes.includes('both') ? 'both' : (schema.supportedMediaTypes[0] ?? 'movie');
  const root = rootsFor(ctx.rootFolders, mediaType === 'movie' ? 'movie' : 'series')[0]?.path;
  const movieRoot = rootsFor(ctx.rootFolders, 'movie')[0]?.path;
  return {
    name: schema.implementationName,
    implementation: schema.implementation,
    enabled: true,
    enableAutomaticAdd: true,
    searchOnAdd: false,
    monitorOption: 'all',
    seriesType: 'standard',
    seasonFolder: true,
    minimumAvailability: 'released',
    mediaType,
    ...(root ? { rootFolderPath: root } : {}),
    ...(mediaType === 'both' && movieRoot ? { movieRootFolderPath: movieRoot } : {}),
    ...(ctx.profiles[0] ? { qualityProfileId: ctx.profiles[0].id } : {}),
    tags: [],
    settings: {},
  };
}

export function existingListValues(list: ImportList): FormValues {
  const { id: _id, lastSyncAt: _a, lastSyncError: _e, ...rest } = list;
  return structuredClone(rest) as FormValues;
}

/** Form values -> POST/PUT body. Empty settings values are dropped; series-only fields are kept as-is. */
export function toListBody(values: FormValues): ImportListCreateInput {
  const settings: Record<string, unknown> = {};
  const raw = (values.settings ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === '') continue;
    settings[k] = v;
  }
  const mediaType = values.mediaType as ImportListMediaType;
  return {
    name: String(values.name ?? '').trim(),
    implementation: values.implementation as ImportListCreateInput['implementation'],
    enabled: values.enabled !== false,
    enableAutomaticAdd: values.enableAutomaticAdd !== false,
    searchOnAdd: values.searchOnAdd === true,
    monitorOption: values.monitorOption as ImportListCreateInput['monitorOption'],
    seriesType: values.seriesType as ImportListCreateInput['seriesType'],
    seasonFolder: values.seasonFolder !== false,
    rootFolderPath: String(values.rootFolderPath ?? ''),
    movieRootFolderPath: mediaType === 'both' && typeof values.movieRootFolderPath === 'string' ? values.movieRootFolderPath : null,
    qualityProfileId: Number(values.qualityProfileId),
    tags: Array.isArray(values.tags) ? (values.tags as number[]) : [],
    minimumAvailability: values.minimumAvailability as ImportListCreateInput['minimumAvailability'],
    mediaType,
    settings,
  };
}
