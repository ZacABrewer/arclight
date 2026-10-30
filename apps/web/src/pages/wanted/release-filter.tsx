import { useCallback, useMemo } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { WantedReleased, releaseBoundMs, type WantedReleaseFilter } from '@arclight/shared';
import { FilterBar, Input, Segmented, Select } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

// The Wanted lists' release filter: status (Released / Upcoming / All) and a release date
// range, kept in the URL (`?released=`, `?releasedAfter=`, `?releasedBefore=`) like the text
// search, and sent to GET /wanted/* as is (packages/shared release-dates.ts).

const DAY_MS = 24 * 60 * 60 * 1000;
const PARAMS = ['released', 'releasedAfter', 'releasedBefore'] as const;

type SearchRecord = Record<string, unknown>;

/** Range presets: "released in the last N days" (from that UTC day on, no upper bound). */
const PRESETS = [
  { value: '7d', days: 7, get label() { return t('wanted.release.last7Days'); } },
  { value: '30d', days: 30, get label() { return t('wanted.release.last30Days'); } },
  { value: '1y', days: 365, get label() { return t('wanted.release.lastYear'); } },
] as const;

/** YYYY-MM-DD of the UTC day `days` before `now`. */
export function daysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString().slice(0, 10);
}

const validDate = (v: unknown): string | undefined => (typeof v === 'string' && releaseBoundMs(v, 'after') !== null ? v : undefined);

/** The filter in the URL; `released` is left out when it is the default. */
export function useReleaseFilter() {
  const search = useRouterState({ select: (s) => s.location.search as SearchRecord });
  const raw = search['released'];
  const after = validDate(search['releasedAfter']);
  const before = validDate(search['releasedBefore']);
  const released = WantedReleased.safeParse(raw).data;
  const filter = useMemo<WantedReleaseFilter>(
    () => ({
      ...(released && released !== 'released' ? { released } : {}),
      ...(after ? { releasedAfter: after } : {}),
      ...(before ? { releasedBefore: before } : {}),
    }),
    [released, after, before],
  );
  const navigate = useNavigate();
  const setFilter = useCallback(
    (next: WantedReleaseFilter) => {
      void navigate({
        to: '.',
        replace: true,
        search: (prev: SearchRecord) => {
          const out: SearchRecord = { ...prev };
          for (const p of PARAMS) delete out[p];
          if (next.released && next.released !== 'released') out['released'] = next.released;
          if (next.releasedAfter) out['releasedAfter'] = next.releasedAfter;
          if (next.releasedBefore) out['releasedBefore'] = next.releasedBefore;
          return out;
        },
      } as unknown as Parameters<typeof navigate>[0]);
    },
    [navigate],
  );
  /** A stable key of the filter: a change resets the list to page 1 like a new text search. */
  const key = `${filter.released ?? ''}|${filter.releasedAfter ?? ''}|${filter.releasedBefore ?? ''}`;
  return { filter, setFilter, key };
}

/** Which preset the range matches: `any`, a preset value, or `custom`. */
export function rangePreset(filter: WantedReleaseFilter, now = Date.now()): string {
  if (!filter.releasedAfter && !filter.releasedBefore) return 'any';
  if (filter.releasedBefore) return 'custom';
  return PRESETS.find((p) => daysAgo(p.days, now) === filter.releasedAfter)?.value ?? 'custom';
}

export function ReleaseFilterBar({ filter, onChange }: { filter: WantedReleaseFilter; onChange: (f: WantedReleaseFilter) => void }) {
  const status = filter.released ?? 'released';
  const preset = rangePreset(filter);
  const active = (status !== 'released' ? 1 : 0) + (filter.releasedAfter || filter.releasedBefore ? 1 : 0);
  const setRange = (releasedAfter: string | undefined, releasedBefore: string | undefined) => {
    const { releasedAfter: _a, releasedBefore: _b, ...rest } = filter;
    onChange({ ...rest, ...(releasedAfter ? { releasedAfter } : {}), ...(releasedBefore ? { releasedBefore } : {}) });
  };
  return (
    <FilterBar className="wanted-release" activeCount={active} onClear={() => onChange({})}>
      <Segmented
        aria-label={t('wanted.release.status')}
        variant="soft"
        options={[
          { value: 'released', label: t('wanted.release.released') },
          { value: 'unreleased', label: t('wanted.release.upcoming') },
          { value: 'all', label: t('wanted.release.all') },
        ]}
        value={status}
        onChange={(v) => {
          const { released: _r, ...rest } = filter;
          onChange(v === 'released' ? rest : { ...rest, released: v });
        }}
      />
      <Select
        aria-label={t('wanted.release.range')}
        value={preset}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === 'custom') return;
          const p = PRESETS.find((x) => x.value === v);
          setRange(p ? daysAgo(p.days) : undefined, undefined);
        }}
      >
        <option value="any">{t('wanted.release.anyDate')}</option>
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        {preset === 'custom' ? <option value="custom">{t('wanted.release.customRange')}</option> : null}
      </Select>
      <Input
        type="date"
        className="wanted-release__date"
        aria-label={t('wanted.release.releasedAfter')}
        title={t('wanted.release.releasedAfter')}
        value={filter.releasedAfter ?? ''}
        max={filter.releasedBefore}
        onChange={(e) => setRange(e.currentTarget.value || undefined, filter.releasedBefore)}
      />
      <Input
        type="date"
        className="wanted-release__date"
        aria-label={t('wanted.release.releasedBefore')}
        title={t('wanted.release.releasedBefore')}
        value={filter.releasedBefore ?? ''}
        min={filter.releasedAfter}
        onChange={(e) => setRange(filter.releasedAfter, e.currentTarget.value || undefined)}
      />
    </FilterBar>
  );
}
