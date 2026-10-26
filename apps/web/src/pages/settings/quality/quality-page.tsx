import { useEffect, useMemo, useState } from 'react';
import type { QualityDefinitionItem, QualityDefinitionLimits } from '@media-tron/shared';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useQualityDefinitions, useSaveQualityDefinitions } from '../../../hooks/profiles.js';

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

function SizeSlider({
  label,
  value,
  unlimitedAtTop,
  onChange,
}: {
  label: string;
  value: number | null;
  unlimitedAtTop: boolean;
  onChange: (v: number | null) => void;
}) {
  const pos = value === null ? (unlimitedAtTop ? SLIDER_MAX : 0) : Math.min(value, SLIDER_MAX);
  return (
    <div className="size-slider">
      <input
        type="range"
        min={0}
        max={SLIDER_MAX}
        step={STEP}
        value={pos}
        aria-label={label}
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          onChange(unlimitedAtTop && n >= SLIDER_MAX ? null : n);
        }}
      />
      <span className="size-slider-value">{value === null ? (unlimitedAtTop ? 'Unlimited' : '0') : value.toFixed(1)}</span>
    </div>
  );
}

export function QualityPage() {
  const defs = useQualityDefinitions();
  const save = useSaveQualityDefinitions();
  const [draft, setDraft] = useState<Limits>({});

  const original = useMemo<Limits>(
    () => Object.fromEntries((defs.data ?? []).map((d) => [d.qualityId, limitsOf(d)])),
    [defs.data],
  );
  useEffect(() => setDraft(original), [original]);

  const changed = (defs.data ?? []).filter((d) => draft[d.qualityId] && !sameLimits(draft[d.qualityId]!, original[d.qualityId]!));

  const update = (qualityId: number, key: LimitKey, value: number | null) =>
    setDraft((prev) => ({ ...prev, [qualityId]: clampLimits({ ...prev[qualityId]!, [key]: value }, key) }));

  const resetDefaults = () =>
    setDraft(Object.fromEntries((defs.data ?? []).map((d) => [d.qualityId, { minSize: null, preferredSize: null, maxSize: null }])));

  return (
    <Page
      title="Quality"
      subtitle="Size limits per quality in MB per minute of runtime. A 45-minute episode at 10 MB/min is about 450 MB."
      actions={
        <>
          <Button variant="ghost" onClick={resetDefaults} disabled={!defs.data}>
            Reset to defaults
          </Button>
          <Button variant="ghost" onClick={() => setDraft(original)} disabled={changed.length === 0}>
            Discard
          </Button>
          <Button
            variant="primary"
            disabled={changed.length === 0}
            loading={save.isPending}
            onClick={() => save.mutate(changed.map((d) => ({ qualityId: d.qualityId, limits: draft[d.qualityId]! })))}
          >
            Save{changed.length ? ` (${changed.length})` : ''}
          </Button>
        </>
      }
    >
      <Card flush>
        {defs.isPending ? (
          <LoadingBlock />
        ) : defs.isError ? (
          <ErrorView error={defs.error} onRetry={() => void defs.refetch()} />
        ) : (
          <div className="table-wrap">
            <table className="table quality-table">
              <thead>
                <tr>
                  <th>Quality</th>
                  <th>Min</th>
                  <th>Preferred</th>
                  <th>Max</th>
                </tr>
              </thead>
              <tbody>
                {[...defs.data]
                  .sort((a, b) => a.weight - b.weight)
                  .map((d) => {
                    const l = draft[d.qualityId] ?? limitsOf(d);
                    return (
                      <tr key={d.qualityId}>
                        <td>
                          {d.title}
                          <div className="muted small">{d.mediaTypes.join(' · ')}</div>
                        </td>
                        <td>
                          <SizeSlider label={`${d.title} minimum`} value={l.minSize} unlimitedAtTop={false} onChange={(v) => update(d.qualityId, 'minSize', v)} />
                        </td>
                        <td>
                          <SizeSlider
                            label={`${d.title} preferred`}
                            value={l.preferredSize}
                            unlimitedAtTop
                            onChange={(v) => update(d.qualityId, 'preferredSize', v)}
                          />
                        </td>
                        <td>
                          <SizeSlider label={`${d.title} maximum`} value={l.maxSize} unlimitedAtTop onChange={(v) => update(d.qualityId, 'maxSize', v)} />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
