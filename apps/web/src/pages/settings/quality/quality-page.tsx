import { useMemo } from 'react';
import type { QualityDefinitionItem, QualityDefinitionLimits } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, QualityTag, Skeleton, Slider, Table, type Column } from '../../../arclight/index.js';
import { useQualityDefinitions, useSaveQualityDefinitions } from '../../../hooks/profiles.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import './quality.css';

/** Slider ceiling in MB/min; the top position of the max/preferred sliders means "no limit". */
export const SLIDER_MAX = 400;
const STEP = 0.5;

type LimitKey = keyof QualityDefinitionLimits;
type Limits = Record<number, QualityDefinitionLimits>;

const limitsOf = (d: QualityDefinitionItem): QualityDefinitionLimits => ({
  minSize: d.minSize,
  preferredSize: d.preferredSize,
  maxSize: d.maxSize,
});

/** Keep min <= preferred <= max after `key` changed (null = unlimited counts as +infinity). */
export function clampLimits(limits: QualityDefinitionLimits, key: LimitKey): QualityDefinitionLimits {
  const inf = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY : v);
  let { minSize, preferredSize, maxSize } = limits;
  const min = minSize ?? 0;
  if (key === 'minSize') {
    if (inf(preferredSize) < min) preferredSize = min;
    if (inf(maxSize) < min) maxSize = min;
  } else if (key === 'maxSize') {
    if (maxSize !== null && min > maxSize) minSize = maxSize;
    if (maxSize !== null && inf(preferredSize) > maxSize) preferredSize = maxSize;
  } else {
    if (preferredSize !== null && min > preferredSize) minSize = preferredSize;
    if (preferredSize !== null && inf(maxSize) < preferredSize) maxSize = preferredSize;
    if (preferredSize === null && maxSize !== null) preferredSize = maxSize;
  }
  return { minSize, preferredSize, maxSize };
}

const sameLimits = (a: QualityDefinitionLimits, b: QualityDefinitionLimits) =>
  a.minSize === b.minSize && a.preferredSize === b.preferredSize && a.maxSize === b.maxSize;

/** Mono value with unit: "12.5 MB/min", or "Unlimited" / "0" at the ends. */
export function sizeLabel(value: number | null, unlimitedAtTop: boolean): string {
  if (value === null) return unlimitedAtTop ? 'Unlimited' : '0 MB/min';
  return `${value.toFixed(1)} MB/min`;
}

/** MB/min as GB per hour of runtime, for the hint under each row. */
export function gbPerHour(mbPerMin: number | null): string {
  if (mbPerMin === null) return '∞';
  return ((mbPerMin * 60) / 1024).toFixed(1);
}

function SizeSlider({ label, value, unlimitedAtTop, onChange }: { label: string; value: number | null; unlimitedAtTop: boolean; onChange: (v: number | null) => void }) {
  const pos = value === null ? (unlimitedAtTop ? SLIDER_MAX : 0) : Math.min(value, SLIDER_MAX);
  return (
    <Slider
      className="al-size-slider"
      min={0}
      max={SLIDER_MAX}
      step={STEP}
      value={pos}
      aria-label={label}
      aria-valuetext={sizeLabel(value, unlimitedAtTop)}
      formatValue={() => <span data-testid="size-value">{sizeLabel(value, unlimitedAtTop)}</span>}
      onChange={(n) => onChange(unlimitedAtTop && n >= SLIDER_MAX ? null : n)}
    />
  );
}

export function QualityPage() {
  const defs = useQualityDefinitions();
  const save = useSaveQualityDefinitions();

  const original = useMemo<Limits>(() => Object.fromEntries((defs.data ?? []).map((d) => [d.qualityId, limitsOf(d)])), [defs.data]);
  const draft = useDraft<Limits>(original);

  const changed = (defs.data ?? []).filter((d) => draft.value[d.qualityId] && !sameLimits(draft.value[d.qualityId]!, original[d.qualityId]!));

  const update = (qualityId: number, key: LimitKey, value: number | null) =>
    draft.set((prev) => ({ ...prev, [qualityId]: clampLimits({ ...prev[qualityId]!, [key]: value }, key) }));

  const resetDefaults = () =>
    draft.set(Object.fromEntries((defs.data ?? []).map((d) => [d.qualityId, { minSize: null, preferredSize: null, maxSize: null }])));

  const limitsFor = (d: QualityDefinitionItem) => draft.value[d.qualityId] ?? limitsOf(d);

  const columns: Column<QualityDefinitionItem>[] = [
    {
      key: 'quality',
      header: 'Quality',
      width: '200px',
      cell: (d) => {
        const l = limitsFor(d);
        return (
          <div className="al-size-quality">
            <QualityTag>{d.title}</QualityTag>
            <span className="al-num al-size-quality__hint" title="GB per hour of runtime">
              {gbPerHour(l.minSize ?? 0)}–{gbPerHour(l.maxSize)} GB/h
            </span>
          </div>
        );
      },
    },
    {
      key: 'min',
      header: 'Min',
      cell: (d) => <SizeSlider label={`${d.title} minimum`} value={limitsFor(d).minSize} unlimitedAtTop={false} onChange={(v) => update(d.qualityId, 'minSize', v)} />,
    },
    {
      key: 'preferred',
      header: 'Preferred',
      cell: (d) => <SizeSlider label={`${d.title} preferred`} value={limitsFor(d).preferredSize} unlimitedAtTop onChange={(v) => update(d.qualityId, 'preferredSize', v)} />,
    },
    {
      key: 'max',
      header: 'Max',
      cell: (d) => <SizeSlider label={`${d.title} maximum`} value={limitsFor(d).maxSize} unlimitedAtTop onChange={(v) => update(d.qualityId, 'maxSize', v)} />,
    },
  ];

  return (
    <SettingsPage
      title="Quality"
      description="Size limits per quality in MB per minute of runtime. A 45-minute episode at 10 MB/min is about 450 MB."
      actions={
        <Button variant="ghost" size="sm" onClick={resetDefaults} disabled={!defs.data}>
          Reset to defaults
        </Button>
      }
      save={{
        count: changed.length,
        label: changed.length ? (
          <span>
            <span className="al-num">{changed.length}</span> {changed.length === 1 ? 'quality' : 'qualities'} changed
          </span>
        ) : undefined,
        onSave: () => save.mutate(changed.map((d) => ({ qualityId: d.qualityId, limits: draft.value[d.qualityId]! }))),
        onDiscard: draft.discard,
        saving: save.isPending,
      }}
    >
      {defs.isPending ? (
        <Skeleton lines={6} />
      ) : defs.isError ? (
        <ErrorBlock title="Couldn't load quality sizes" onRetry={() => void defs.refetch()}>
          {errorMessage(defs.error)}
        </ErrorBlock>
      ) : (
        <Table
          className="al-size-table"
          caption="Quality size limits"
          columns={columns}
          rows={[...defs.data].sort((a, b) => a.weight - b.weight)}
          rowKey={(d) => d.qualityId}
          density="rich"
        />
      )}
    </SettingsPage>
  );
}
