import { useState } from 'react';
import type { ReleaseProfile, ReleaseProfileInput } from '@media-tron/shared';
import { Badge } from '../../../components/badge.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { TagPicker, useTagLabels } from '../../../components/forms/tag-picker.js';
import { TermList } from '../../../components/forms/term-list.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useIndexerList } from '../../../hooks/indexers.js';
import { useDeleteReleaseProfile, useReleaseProfileList, useSaveReleaseProfile } from '../../../hooks/profiles.js';
import { CardGrid, AddCard, EditorFooter, ItemCard, SaveError } from '../shared.js';

const EMPTY: ReleaseProfileInput = { name: '', enabled: true, required: [], ignored: [], tags: [] };

function toInput(p: ReleaseProfile): ReleaseProfileInput {
  const { id: _id, ...rest } = p;
  return rest;
}

function ReleaseProfileEditor({ profile, onClose }: { profile: ReleaseProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<ReleaseProfileInput>(() => (profile ? toInput(profile) : EMPTY));
  const [nameError, setNameError] = useState<string>();
  const indexers = useIndexerList();
  const save = useSaveReleaseProfile();
  const remove = useDeleteReleaseProfile();
  const set = <K extends keyof ReleaseProfileInput>(k: K, v: ReleaseProfileInput[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = () => {
    if (!draft.name.trim()) return setNameError('Name is required');
    if (draft.required.length === 0 && draft.ignored.length === 0) return setNameError('Add at least one required or ignored term');
    setNameError(undefined);
    save.mutate({ id: profile?.id, body: draft }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={profile ? `Edit ${profile.name}` : 'Add release profile'}
      footer={
        <EditorFooter
          onCancel={onClose}
          onSave={submit}
          saving={save.isPending}
          onDelete={profile ? () => remove.mutate(profile.id, { onSuccess: onClose }) : undefined}
        />
      }
    >
      <FormField label="Name" error={nameError}>
        <Input value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
      </FormField>
      <FormField label="Enabled">
        <Toggle checked={draft.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormField>
      <FormField label="Must contain" hint="At least one term must appear in the release title. Plain text is case-insensitive; wrap regexes in /…/.">
        <TermList value={draft.required} onChange={(v) => set('required', v)} />
      </FormField>
      <FormField label="Must not contain" hint="A release containing any of these terms is rejected.">
        <TermList value={draft.ignored} onChange={(v) => set('ignored', v)} />
      </FormField>
      <FormField label="Indexer" hint="Only apply to releases from this indexer.">
        <Select
          value={draft.indexerId === undefined ? '' : String(draft.indexerId)}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setDraft((d) => {
              const { indexerId: _drop, ...rest } = d;
              return v ? { ...rest, indexerId: Number(v) } : rest;
            });
          }}
          options={[{ value: '', label: 'Any indexer' }, ...(indexers.data ?? []).map((i) => ({ value: String(i.id), label: i.name }))]}
        />
      </FormField>
      <FormField label="Tags" hint="Only apply to series/movies with a matching tag. Empty applies to everything.">
        <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />
      </FormField>
      <SaveError error={save.error} />
    </Modal>
  );
}

export function ReleaseProfilesSection() {
  const list = useReleaseProfileList();
  const indexers = useIndexerList();
  const tagLabels = useTagLabels();
  const [editing, setEditing] = useState<ReleaseProfile | 'new' | null>(null);

  return (
    <Card title="Release profiles">
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <CardGrid>
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              muted={!p.enabled}
              onClick={() => setEditing(p)}
              status={p.enabled ? null : <Badge>disabled</Badge>}
            >
              {p.required.length ? <div className="muted">Must contain: {p.required.join(', ')}</div> : null}
              {p.ignored.length ? <div className="muted">Must not contain: {p.ignored.join(', ')}</div> : null}
              {p.indexerId ? <div className="muted">Indexer: {indexers.data?.find((i) => i.id === p.indexerId)?.name ?? `#${p.indexerId}`}</div> : null}
              {p.tags.length ? <div className="muted">Tags: {tagLabels(p.tags).join(', ')}</div> : null}
            </ItemCard>
          ))}
          <AddCard label="Add release profile" onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing ? (
        <ReleaseProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}

