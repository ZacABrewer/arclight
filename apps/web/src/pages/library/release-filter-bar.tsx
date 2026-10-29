import type { ReleaseDecision } from '@arclight/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, EmptyState, FilterBar, Input, Select } from '../../arclight/index.js';
import { MultiSelect } from '../../components/multi-select.js';
import { t } from '../../i18n/index.js';
import {
  DEFAULT_RELEASE_FILTERS,
  activeReleaseFilterCount,
  filterReleases,
  formatSizeGb,
  parseSizeGb,
  releaseFilterChoices,
  type ReleaseDecisionFilter,
  type ReleaseFilters,
  type ReleaseProtocolFilter,
} from './release-filters.js';

/**
 * Filters of a release table: state, the filtered rows and the bar above the table. Filtering
 * is client side over what the search already returned. A new search target (`resetKey`) starts
 * from no filters.
 */
export function useReleaseFilters<T extends ReleaseDecision>(rows: readonly T[] | undefined, resetKey: unknown) {
  const [filters, setFilters] = useState<ReleaseFilters>(DEFAULT_RELEASE_FILTERS);
  const key = JSON.stringify(resetKey ?? null);
  useEffect(() => setFilters(DEFAULT_RELEASE_FILTERS), [key]);
  const filtered = useMemo(() => (rows ? filterReleases(rows, filters) : undefined), [rows, filters]);
  const clear = () => setFilters(DEFAULT_RELEASE_FILTERS);
  const bar =
    rows && rows.length > 0 ? <ReleaseFilterBar rows={rows} filters={filters} onChange={setFilters} shown={filtered?.length ?? 0} /> : null;
  /** Empty state when the filters hide every release (the table's own one covers "no results"). */
  const empty: ReactNode =
    rows && rows.length > 0 ? (
      <EmptyState title={t('library.releaseFilters.noMatches')} action={<Button onClick={clear}>{t('library.clearFilters')}</Button>} />
    ) : null;
  return { rows: filtered, bar, empty };
}

/** A GB bound: keeps what is typed ("1.") while the filter holds the parsed bytes. */
function SizeField({ label, value, onChange }: { label: string; value: number | null; onChange: (bytes: number | null) => void }) {
  const [text, setText] = useState(formatSizeGb(value));
  useEffect(() => {
    if (parseSizeGb(text) !== value) setText(formatSizeGb(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an outside change (Clear) resets the text
  }, [value]);
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      className="rel-filters__num"
      aria-label={label}
      placeholder={label}
      end={t('library.releaseFilters.gb')}
      value={text}
      onChange={(e) => {
        setText(e.currentTarget.value);
        onChange(parseSizeGb(e.currentTarget.value));
      }}
    />
  );
}

export function ReleaseFilterBar({
  rows,
  filters,
  onChange,
  shown,
}: {
  rows: readonly ReleaseDecision[];
  filters: ReleaseFilters;
  onChange: (f: ReleaseFilters) => void;
  shown: number;
}) {
  const choices = useMemo(() => releaseFilterChoices(rows), [rows]);
  const set = (patch: Partial<ReleaseFilters>) => onChange({ ...filters, ...patch });
  return (
    <FilterBar
      className="rel-filters"
      activeCount={activeReleaseFilterCount(filters)}
      onClear={() => onChange(DEFAULT_RELEASE_FILTERS)}
      end={
        <span className="al-caption al-num" role="status" aria-live="polite">
          {t('library.releaseFilters.count', { shown, total: rows.length })}
        </span>
      }
    >
      <Input
        type="search"
        className="mk-search"
        aria-label={t('library.releaseFilters.title')}
        placeholder={t('library.releaseFilters.titleContains')}
        value={filters.title}
        onChange={(e) => set({ title: e.currentTarget.value })}
      />
      <MultiSelect
        label={t('common.quality')}
        options={choices.qualities}
        value={filters.qualities}
        onChange={(qualities) => set({ qualities })}
        emptyLabel={t('library.releaseFilters.anyQuality')}
      />
      <MultiSelect
        label={t('common.indexers')}
        options={choices.indexers}
        value={filters.indexers}
        onChange={(indexers) => set({ indexers })}
        emptyLabel={t('library.releaseFilters.anyIndexer')}
      />
      {choices.mixedProtocols || filters.protocol !== 'all' ? (
        <Select
          aria-label={t('common.protocol')}
          value={filters.protocol}
          onChange={(e) => set({ protocol: e.currentTarget.value as ReleaseProtocolFilter })}
          options={[
            { value: 'all', label: t('search.anyProtocol') },
            { value: 'torrent', label: t('common.torrent') },
            { value: 'usenet', label: t('common.usenet') },
          ]}
        />
      ) : null}
      <Select
        aria-label={t('library.interactiveSearch.decision')}
        value={filters.decision}
        onChange={(e) => set({ decision: e.currentTarget.value as ReleaseDecisionFilter })}
        options={[
          { value: 'all', label: t('library.releaseFilters.allDecisions') },
          { value: 'approved', label: t('library.releaseFilters.approvedOnly') },
          { value: 'rejected', label: t('library.releaseFilters.rejectedOnly') },
        ]}
      />
      <span className="rel-filters__range">
        <SizeField label={t('library.releaseFilters.minSize')} value={filters.minSize} onChange={(minSize) => set({ minSize })} />
        <SizeField label={t('library.releaseFilters.maxSize')} value={filters.maxSize} onChange={(maxSize) => set({ maxSize })} />
      </span>
      {/* Seeders only exist for torrents. */}
      {choices.hasTorrents || filters.minSeeders !== null ? (
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          className="rel-filters__num"
          aria-label={t('library.releaseFilters.minSeeders')}
          placeholder={t('library.releaseFilters.minSeeders')}
          value={filters.minSeeders ?? ''}
          onChange={(e) => {
            const n = Number.parseInt(e.currentTarget.value, 10);
            set({ minSeeders: Number.isFinite(n) && n > 0 ? n : null });
          }}
        />
      ) : null}
    </FilterBar>
  );
}
