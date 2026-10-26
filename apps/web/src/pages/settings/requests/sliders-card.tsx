import { useEffect, useState } from 'react';
import type { DiscoverSlider, DiscoverSliderType } from '@arclight/shared';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { CUSTOM_SLIDER_TYPES, SLIDER_LABELS } from '../../../features/requests/status.js';
import { useCreateSlider, useDeleteSlider, useOrderSliders, useResetSliders, useSliders, useUpdateSlider } from '../../../hooks/requests.js';
import { EditorFooter, SaveError } from '../shared.js';
import '../../../features/requests/requests.css';

/** Move the item at `index` by `delta` (-1 up, +1 down); out-of-range moves are no-ops. */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

export function SlidersCard() {
  const sliders = useSliders();
  const order = useOrderSliders();
  const reset = useResetSliders();
  const del = useDeleteSlider();
  const [draft, setDraft] = useState<DiscoverSlider[] | null>(null);
  const [editing, setEditing] = useState<DiscoverSlider | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DiscoverSlider | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (sliders.data) setDraft([...sliders.data].sort((a, b) => a.order - b.order));
  }, [sliders.data]);

  const dirty =
    draft !== null &&
    sliders.data !== undefined &&
    JSON.stringify(draft.map((s) => [s.id, s.enabled])) !== JSON.stringify([...sliders.data].sort((a, b) => a.order - b.order).map((s) => [s.id, s.enabled]));

  return (
    <Card
      title="Discover sliders"
      actions={
        <div className="row">
          <Button onClick={() => setEditing('new')}>Add slider</Button>
          <Button variant="ghost" onClick={() => setConfirmReset(true)}>
            Reset to defaults
          </Button>
          <Button variant="primary" disabled={!dirty} loading={order.isPending} onClick={() => draft && order.mutate(draft.map((s) => ({ id: s.id, enabled: s.enabled })))}>
            Save order
          </Button>
        </div>
      }
    >
      {sliders.isError ? (
        <ErrorView error={sliders.error} onRetry={() => void sliders.refetch()} />
      ) : !draft ? (
        <LoadingBlock />
      ) : (
        <ol className="slider-list" aria-label="Sliders">
          {draft.map((s, i) => {
            const label = s.title ?? SLIDER_LABELS[s.type];
            return (
              <li key={s.id} className="slider-item">
                <Toggle
                  aria-label={`Show ${label}`}
                  checked={s.enabled}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    setDraft(draft.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
                  }}
                />
                <span className="slider-item-title">
                  {label} {s.isBuiltIn ? <Badge>built-in</Badge> : <Badge tone="info">{SLIDER_LABELS[s.type]}</Badge>}
                </span>
                <Button size="sm" variant="ghost" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => setDraft(moveItem(draft, i, -1))}>
                  ↑
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Move ${label} down`} disabled={i === draft.length - 1} onClick={() => setDraft(moveItem(draft, i, 1))}>
                  ↓
                </Button>
                {!s.isBuiltIn ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(s)}>
                      Delete
                    </Button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {editing ? <SliderEditor slider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.title ?? 'slider'}?`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        title="Reset sliders?"
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => {
          await reset.mutateAsync(undefined);
          setConfirmReset(false);
        }}
      >
        Custom sliders are deleted and the built-in ones return to their default order.
      </ConfirmDialog>
    </Card>
  );
}

function SliderEditor({ slider, onClose }: { slider: DiscoverSlider | null; onClose: () => void }) {
  const create = useCreateSlider();
  const update = useUpdateSlider();
  const [type, setType] = useState<DiscoverSliderType>(slider?.type ?? 'tmdbMovieKeyword');
  const [title, setTitle] = useState(slider?.title ?? '');
  const [data, setData] = useState(slider?.data ?? '');
  const [enabled, setEnabled] = useState(slider?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const dataLabel = CUSTOM_SLIDER_TYPES.find((t) => t.type === type)?.dataLabel ?? 'Data';

  const submit = () => {
    if (!title.trim() || !data.trim()) {
      setError('Title and data are required.');
      return;
    }
    setError(null);
    const done = { onSuccess: onClose };
    if (slider) update.mutate({ id: slider.id, body: { title: title.trim(), data: data.trim(), enabled } }, done);
    else create.mutate({ type, title: title.trim(), data: data.trim(), enabled }, done);
  };

  return (
    <Modal open onClose={onClose} title={slider ? `Edit ${slider.title ?? 'slider'}` : 'Add slider'} footer={<EditorFooter onCancel={onClose} onSave={submit} saving={create.isPending || update.isPending} />}>
      <FormField label="Type">
        <Select
          value={type}
          disabled={slider !== null}
          onChange={(e) => setType(e.currentTarget.value as DiscoverSliderType)}
          options={CUSTOM_SLIDER_TYPES.map((t) => ({ value: t.type, label: SLIDER_LABELS[t.type] }))}
        />
      </FormField>
      <FormField label="Title">
        <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      </FormField>
      <FormField label={dataLabel}>
        <Input value={data} onChange={(e) => setData(e.currentTarget.value)} />
      </FormField>
      <FormField label="Enabled" inline>
        <Toggle checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
      </FormField>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <SaveError error={create.error ?? update.error} />
    </Modal>
  );
}
