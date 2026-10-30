import { useEffect, useMemo, useState } from 'react';
import type { HealthFindingStatus, HealthFindingType, HealthMediaType, HealthScanSettings, HealthSeverity } from '@arclight/shared';
import {
  AccordionItem,
  Banner,
  Button,
  ErrorBlock,
  Field,
  FilterBar,
  Input,
  Pane,
  Select,
  Skeleton,
  Toggle,
  type RowKey,
} from '../../../arclight/index.js';
import { BulkBar } from '../../../components/media/bulk-bar.js';
import { useToast } from '../../../components/toast.js';
import { useHealthFindings, useHealthScan, useHealthSettings, useSaveHealthSettings } from '../../../hooks/health-scan.js';
import { relativeTime } from '../../../lib/format.js';
import { t } from '../../../i18n/index.js';
import { FindingsTable, useHealthActions } from './health-findings.js';
import { activeFilterCount, applyFilters, HEALTH_TYPES, hasFile, mediaLabel, NO_FILTERS, severityLabel, summaryTiles, typeLabel, type HealthFilters } from './health-model.js';
import './health.css';

type StatusFilter = HealthFindingStatus | 'all';

/** "Run health scan" for the page header while the Health tab is open. */
export function HealthScanButton() {
  const scan = useHealthScan();
  const toast = useToast();
  return (
    <Button
      variant="primary"
      loading={scan.isPending}
      onClick={() => scan.mutate({ all: true }, { onSuccess: () => toast.push({ tone: 'info', title: t('library.health.scanStarted'), message: t('library.health.scanStartedHint') }) })}
    >
      {t('library.health.runScan')}
    </Button>
  );
}

function SettingsForm({ value }: { value: HealthScanSettings }) {
  const save = useSaveHealthSettings();
  const toast = useToast();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const set = (patch: Partial<HealthScanSettings>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  return (
    <form
      className="hl-settings"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft, { onSuccess: () => toast.push({ tone: 'ok', title: t('library.health.settingsSaved') }) });
      }}
    >
      <Field label={t('library.health.schedule')} hint={t('library.health.scheduleHint')} htmlFor="hl-schedule">
        <Select
          id="hl-schedule"
          value={draft.schedule}
          onChange={(e) => set({ schedule: e.target.value as HealthScanSettings['schedule'] })}
          options={[
            { value: 'weekly', label: t('library.health.weekly') },
            { value: 'daily', label: t('library.health.daily') },
            { value: 'off', label: t('library.health.scheduleOff') },
          ]}
        />
      </Field>
      <Field label={t('library.health.mode')} hint={t('library.health.modeHint')} htmlFor="hl-mode">
        <Select
          id="hl-mode"
          value={draft.mode}
          onChange={(e) => set({ mode: e.target.value as HealthScanSettings['mode'] })}
          options={[
            { value: 'quick', label: t('library.health.modeQuick') },
            { value: 'deep', label: t('library.health.modeDeep') },
          ]}
        />
      </Field>
      <Field label={t('library.health.concurrency')} hint={t('library.health.concurrencyHint')} htmlFor="hl-concurrency">
        <Input id="hl-concurrency" type="number" min={1} max={4} value={draft.concurrency} onChange={(e) => set({ concurrency: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })} />
      </Field>
      <Field label={t('library.health.truncatedPercent')} hint={t('library.health.truncatedPercentHint')} htmlFor="hl-truncated">
        <Input id="hl-truncated" type="number" min={10} max={99} value={draft.truncatedPercent} onChange={(e) => set({ truncatedPercent: Math.min(99, Math.max(10, Number(e.target.value) || 75)) })} />
      </Field>
      <Toggle label={t('library.health.lowPriority')} checked={draft.lowPriority} onChange={(e) => set({ lowPriority: e.target.checked })} />
      <Toggle label={t('library.health.checkLanguages')} checked={draft.checkLanguages} onChange={(e) => set({ checkLanguages: e.target.checked })} />
      <Toggle label={t('library.health.notify')} checked={draft.notify} onChange={(e) => set({ notify: e.target.checked })} />
      <Toggle label={t('library.health.window')} checked={draft.window.enabled} onChange={(e) => set({ window: { ...draft.window, enabled: e.target.checked } })} />
      {draft.window.enabled ? (
        <div className="hl-window">
          <Field label={t('library.health.windowStart')} htmlFor="hl-window-start">
            <Input id="hl-window-start" type="time" value={draft.window.start} onChange={(e) => set({ window: { ...draft.window, start: e.target.value } })} />
          </Field>
          <Field label={t('library.health.windowEnd')} htmlFor="hl-window-end">
            <Input id="hl-window-end" type="time" value={draft.window.end} onChange={(e) => set({ window: { ...draft.window, end: e.target.value } })} />
          </Field>
        </div>
      ) : null}
      <p className="al-caption">{t('library.health.windowHint')}</p>
      <div>
        <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Library → Hygiene → Health: summary, filters, findings with bulk fixes, scan settings. */
export function HealthPanel() {
  const [status, setStatus] = useState<StatusFilter>('open');
  const [filters, setFilters] = useState<HealthFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const findings = useHealthFindings({ status });
  const settings = useHealthSettings();
  const { run, busy, dialog } = useHealthActions(() => setSelected(new Set()));
  useEffect(() => setSelected(new Set()), [status, filters]);

  const data = findings.data;
  const rows = useMemo(() => applyFilters(data?.records ?? [], filters), [data, filters]);
  const tiles = summaryTiles(data?.counts.byType ?? {});
  const chosen = rows.filter((r) => selected.has(r.id));
  const anyFile = chosen.some(hasFile);

  return (
    <div className="hyg-stack">
      {data && (!data.ffprobe || !data.ffmpeg) ? (
        <Banner tone="warn">{!data.ffprobe ? t('library.health.ffprobeMissing') : t('library.health.ffmpegMissing')}</Banner>
      ) : null}

      <section className="hl-summary" aria-label={t('library.health.summary')}>
        <p className="hl-progress">
          {data ? (
            <>
              {t('library.health.filesChecked', { checked: data.filesChecked, total: data.filesTotal })}
              {data.lastScan ? (
                <>
                  {' · '}
                  {t('library.health.lastScan')} <time dateTime={data.lastScan}>{relativeTime(data.lastScan)}</time>
                </>
              ) : null}
              {data.running ? ` · ${t('library.health.scanning')}` : ''}
            </>
          ) : null}
        </p>
        <div className="hl-tiles">
          <div className="hl-tile hl-tile--total">
            <span className="hl-tile__count al-num">{data?.counts.open ?? '–'}</span>
            <span className="hl-tile__label">{t('library.health.openProblems')}</span>
          </div>
          {tiles.map((x) => (
            <button
              key={x.type}
              type="button"
              className="hl-tile"
              aria-pressed={filters.type === x.type}
              onClick={() => setFilters((f) => ({ ...f, type: f.type === x.type ? '' : x.type }))}
            >
              <span className="hl-tile__count al-num">{x.count}</span>
              <span className="hl-tile__label">{typeLabel(x.type)}</span>
            </button>
          ))}
        </div>
      </section>

      <FilterBar activeCount={activeFilterCount(filters) + (status === 'open' ? 0 : 1)} onClear={() => {
          setFilters(NO_FILTERS);
          setStatus('open');
        }}>
        <Select
          aria-label={t('library.health.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          options={[
            { value: 'open', label: t('library.health.statusOpen', { count: data?.counts.open ?? 0 }) },
            { value: 'ignored', label: t('library.health.statusIgnored', { count: data?.counts.ignored ?? 0 }) },
            { value: 'fixed', label: t('library.health.statusFixed', { count: data?.counts.fixed ?? 0 }) },
            { value: 'all', label: t('library.health.statusAll') },
          ]}
        />
        <Select
          aria-label={t('library.health.problemType')}
          value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as HealthFindingType | '' }))}
          options={[{ value: '', label: t('library.health.allTypes') }, ...HEALTH_TYPES.map((type) => ({ value: type, label: typeLabel(type) }))]}
        />
        <Select
          aria-label={t('library.health.severityLabel')}
          value={filters.severity}
          onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value as HealthSeverity | '' }))}
          options={[{ value: '', label: t('library.health.allSeverities') }, ...(['error', 'warning', 'info'] as const).map((s) => ({ value: s, label: severityLabel(s) }))]}
        />
        <Select
          aria-label={t('library.health.mediaType')}
          value={filters.mediaType}
          onChange={(e) => setFilters((f) => ({ ...f, mediaType: e.target.value as HealthMediaType | '' }))}
          options={[{ value: '', label: t('library.health.allMedia') }, ...(['movie', 'series', 'music', 'audiobook'] as const).map((m) => ({ value: m, label: mediaLabel(m) }))]}
        />
      </FilterBar>

      {findings.isError ? (
        <ErrorBlock title={t('library.health.couldNotLoad')} onRetry={() => void findings.refetch()} />
      ) : findings.isPending ? (
        <Skeleton lines={5} />
      ) : (
        <Pane flush bare>
          <FindingsTable rows={rows} run={run} selected={selected} onSelectionChange={setSelected} />
        </Pane>
      )}

      <AccordionItem title={t('library.health.settings')} meta={settings.data ? t(`library.health.scheduleMeta.${settings.data.schedule}`) : undefined}>
        {settings.data ? <SettingsForm value={settings.data} /> : <Skeleton lines={3} />}
      </AccordionItem>

      <BulkBar
        count={chosen.length}
        total={rows.length}
        onSelectAll={() => setSelected(new Set(rows.map((r) => r.id)))}
        actions={[
          { id: 'replace', label: t('library.health.replace'), disabled: !anyFile, loading: busy === 'replace', onSelect: () => run('replace', chosen) },
          { id: 'recheck', label: t('library.health.recheck'), loading: busy === 'recheck', onSelect: () => run('recheck', chosen) },
          status === 'ignored'
            ? { id: 'unignore', label: t('library.health.unignore'), loading: busy === 'unignore', onSelect: () => run('unignore', chosen) }
            : { id: 'ignore', label: t('library.health.ignore'), loading: busy === 'ignore', onSelect: () => run('ignore', chosen) },
          { id: 'delete', label: t('library.health.deleteFile'), danger: true, disabled: !anyFile, onSelect: () => run('delete', chosen) },
        ]}
        onClear={() => setSelected(new Set())}
      />
      {dialog}
    </div>
  );
}
