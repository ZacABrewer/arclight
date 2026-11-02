import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { DiscoverTile, ImportListCleanupAction, ImportListCreateInput, ImportListFilters, ImportListMediaType } from '@arclight/shared';
import { discoverApi } from '../../../api/requests.js';
import { Checkbox, Input, Skeleton } from '../../../arclight/index.js';
import type { FieldDefinition, FieldRendererProps, FieldRenderers, FormValues } from '../../../components/forms/types.js';
import { t } from '../../../i18n/index.js';

// Per-list rules: sync schedule, filters, "skip if streamable" and clean-up. These sit under
// their own heading in the editor and map onto the list body's syncIntervalHours / filters /
// streaming / cleanupAction.

export const CLEANUP_LABELS: Record<ImportListCleanupAction, string> = {
  get none() {
    return t('settings.importLists.rules.cleanupNone');
  },
  get unmonitor() {
    return t('settings.importLists.rules.cleanupUnmonitor');
  },
  get remove() {
    return t('settings.importLists.rules.cleanupRemove');
  },
  get removeAndDeleteFiles() {
    return t('settings.importLists.rules.cleanupRemoveFiles');
  },
};

export const RULE_DEFAULTS = {
  syncIntervalHours: null,
  filters: {},
  streaming: { enabled: false, region: null, providerIds: [] },
  cleanupAction: 'none',
} as const;

export interface RuleFieldContext {
  mediaType: ImportListMediaType;
  streamingEnabled: boolean;
  /** The instance region (Settings > Metadata), shown as the region placeholder. */
  defaultRegion?: string | undefined;
}

export function ruleFields({ streamingEnabled, defaultRegion }: RuleFieldContext): FieldDefinition[] {
  const fields: Array<FieldDefinition | false> = [
    {
      name: 'syncIntervalHours',
      label: t('settings.importLists.rules.syncEvery'),
      type: 'number',
      min: 1,
      max: 720,
      unit: t('settings.importLists.rules.hoursUnit'),
      placeholder: t('settings.importLists.rules.global'),
      helpText: t('settings.importLists.rules.syncEveryHelp'),
    },
    { name: 'filters.minRating', label: t('settings.importLists.rules.minRating'), type: 'number', min: 0, max: 10, helpText: t('settings.importLists.rules.minRatingHelp') },
    { name: 'filters.minVotes', label: t('settings.importLists.rules.minVotes'), type: 'number', min: 0 },
    { name: 'filters.yearFrom', label: t('settings.importLists.rules.yearFrom'), type: 'number', min: 1870, max: 2200 },
    { name: 'filters.yearTo', label: t('settings.importLists.rules.yearTo'), type: 'number', min: 1870, max: 2200 },
    { name: 'streaming.enabled', label: t('settings.importLists.rules.skipStreaming'), type: 'checkbox', helpText: t('settings.importLists.rules.skipStreamingHelp') },
    streamingEnabled && {
      name: 'streaming.region',
      label: t('settings.importLists.rules.region'),
      type: 'text',
      placeholder: defaultRegion ?? 'US',
      helpText: t('settings.importLists.rules.regionHelp'),
    },
    streamingEnabled && { name: 'streaming.providerIds', label: t('settings.importLists.rules.services'), type: 'multiSelect', required: true },
    {
      name: 'cleanupAction',
      label: t('settings.importLists.rules.cleanup'),
      type: 'select',
      options: Object.entries(CLEANUP_LABELS).map(([value, label]) => ({ value, label })),
      helpText: t('settings.importLists.rules.cleanupHelp'),
    },
  ];
  return fields.filter((f): f is FieldDefinition => f !== false);
}

export function ruleRenderers(ctx: { mediaType: ImportListMediaType; region: string | undefined }): FieldRenderers {
  return { 'streaming.providerIds': (p) => <ProviderPicker {...p} mediaType={ctx.mediaType} region={ctx.region} /> };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Form values -> the rule part of the list body. */
export function rulesBody(values: FormValues): Pick<ImportListCreateInput, 'syncIntervalHours' | 'filters' | 'streaming' | 'cleanupAction'> {
  const f = (values.filters ?? {}) as Record<string, unknown>;
  const filters: ImportListFilters = {};
  const minRating = num(f.minRating);
  const minVotes = num(f.minVotes);
  const yearFrom = num(f.yearFrom);
  const yearTo = num(f.yearTo);
  if (minRating !== undefined) filters.minRating = minRating;
  if (minVotes !== undefined) filters.minVotes = Math.round(minVotes);
  if (yearFrom !== undefined) filters.yearFrom = Math.round(yearFrom);
  if (yearTo !== undefined) filters.yearTo = Math.round(yearTo);
  const s = (values.streaming ?? {}) as Record<string, unknown>;
  const region = typeof s.region === 'string' && s.region.trim() ? s.region.trim().toUpperCase() : null;
  const providerIds = Array.isArray(s.providerIds) ? s.providerIds.map(Number).filter((n) => Number.isInteger(n)) : [];
  return {
    syncIntervalHours: num(values.syncIntervalHours) !== undefined ? Math.round(num(values.syncIntervalHours)!) : null,
    filters,
    streaming: { enabled: s.enabled === true, region, providerIds },
    cleanupAction: (values.cleanupAction as ImportListCleanupAction | undefined) ?? 'none',
  };
}

/** Streaming services in the region, searchable; selected ones stay on top. */
function ProviderPicker({ id, field, value, onChange, error, mediaType, region }: FieldRendererProps & { mediaType: ImportListMediaType; region: string | undefined }) {
  const kinds = mediaType === 'both' ? (['movie', 'tv'] as const) : mediaType === 'movie' ? (['movie'] as const) : (['tv'] as const);
  const results = useQueries({
    queries: kinds.map((kind) => ({
      queryKey: ['discover', 'tiles', 'providers', { kind, region: region ?? null }],
      queryFn: () => discoverApi.providers(kind, region),
      staleTime: 3_600_000,
      retry: false,
    })),
  });
  const [filter, setFilter] = useState('');
  const selected = useMemo(() => (Array.isArray(value) ? value.map(Number) : []), [value]);
  const loading = results.some((r) => r.isPending);
  const failed = results.every((r) => r.isError);
  const providers = useMemo(() => {
    const byId = new Map<number, DiscoverTile>();
    for (const r of results) for (const p of r.data ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
    return [...byId.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join()]);
  const needle = filter.trim().toLowerCase();
  const shown = providers
    .filter((p) => selected.includes(p.id) || !needle || p.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)));
  const toggle = (pid: number) => onChange(selected.includes(pid) ? selected.filter((s) => s !== pid) : [...selected, pid]);

  return (
    <div id={id} className="al-providers" role="group" aria-label={field.label} aria-invalid={error ? true : undefined}>
      <Input
        type="search"
        value={filter}
        placeholder={t('settings.importLists.rules.findService')}
        aria-label={t('settings.importLists.rules.findService')}
        onChange={(e) => setFilter(e.currentTarget.value)}
      />
      {loading ? (
        <Skeleton lines={3} />
      ) : failed ? (
        <p className="al-inline-error" role="alert">
          {t('settings.importLists.rules.servicesFailed')}
        </p>
      ) : (
        <div className="al-providers__list">
          {shown.map((p) => (
            <Checkbox key={p.id} label={p.name} checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
          ))}
          {shown.length === 0 ? <p className="al-muted">{t('settings.importLists.rules.noServices')}</p> : null}
        </div>
      )}
      <p className="al-caption">{t('settings.importLists.rules.servicesSelected', { count: selected.length })}</p>
    </div>
  );
}
