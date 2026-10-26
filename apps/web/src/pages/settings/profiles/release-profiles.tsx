import { useState } from 'react';
import type { ReleaseProfile, ReleaseProfileInput } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Field, Input, Modal, Select, Skeleton, Tag, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TagPicker, useTagLabels } from '../../../components/forms/tag-picker.js';
import { TermList } from '../../../components/forms/term-list.js';
import { useIndexerList } from '../../../hooks/indexers.js';
import { useDeleteReleaseProfile, useReleaseProfileList, useSaveReleaseProfile } from '../../../hooks/profiles.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, SaveError, SettingsSection } from '../shared.js';
import './profiles.css';

const EMPTY: ReleaseProfileInput = { name: '', enabled: true, required: [], ignored: [], tags: [] };

function toInput(p: ReleaseProfile): ReleaseProfileInput {
  const { id: _id, ...rest } = p;
  return rest;
}

function ReleaseProfileEditor({ profile, onClose }: { profile: ReleaseProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<ReleaseProfileInput>(() => (profile ? toInput(profile) : EMPTY));
  const [nameError, setNameError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    <>
      <Modal
        open
        onClose={onClose}
        size={560}
        title={profile ? `Edit ${profile.name}` : 'Add release profile'}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={profile ? () => setConfirmDelete(true) : undefined}
            deleteLabel="Delete profile"
          />
        }
      >
        <div className="al-profile-editor">
          <Field label="Name" error={nameError}>
            <Input value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <Toggle checked={draft.enabled} label="Enabled" onChange={(e) => set('enabled', e.currentTarget.checked)} />
          <Field label="Must contain" hint="At least one term must appear in the release title. Plain text is case-insensitive; wrap regexes in /…/.">
            <TermList value={draft.required} onChange={(v) => set('required', v)} />
          </Field>
          <Field label="Must not contain" hint="A release containing any of these terms is rejected.">
            <TermList value={draft.ignored} onChange={(v) => set('ignored', v)} />
          </Field>
          <Field label="Indexer" hint="Only apply to releases from this indexer.">
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
          </Field>
          <Field label="Tags" hint="Only apply to series and movies with a matching tag. Empty applies to everything.">
            <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />
          </Field>
          <SaveError error={save.error} />
        </div>
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${profile.name}?`}
          confirmLabel="Delete profile"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>This cannot be undone.</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function Terms({ label, terms, negative }: { label: string; terms: readonly string[]; negative?: boolean }) {
  if (terms.length === 0) return null;
  return (
    <span className="al-profile-card__terms" data-negative={negative || undefined}>
      <span className="al-profile-card__label">{label}</span>
      {terms.map((t) => (
        <Tag key={t} className="al-num">
          {t}
        </Tag>
      ))}
    </span>
  );
}

export function ReleaseProfilesSection() {
  const list = useReleaseProfileList();
  const indexers = useIndexerList();
  const tagLabels = useTagLabels();
  const [editing, setEditing] = useState<ReleaseProfile | 'new' | null>(null);

  return (
    <SettingsSection
      label="Release profiles"
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          Add release profile
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load release profiles" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <CardGrid label="Release profiles">
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              muted={!p.enabled}
              onClick={() => setEditing(p)}
              status={
                p.enabled ? null : (
                  <Chip tone="muted" dot="none">
                    Off
                  </Chip>
                )
              }
            >
              <Terms label="Must contain" terms={p.required} />
              <Terms label="Must not contain" terms={p.ignored} negative />
              {p.indexerId ? (
                <span className="al-profile-card__terms">
                  <span className="al-profile-card__label">Indexer</span>
                  {indexers.data?.find((i) => i.id === p.indexerId)?.name ?? <span className="al-num">#{p.indexerId}</span>}
                </span>
              ) : null}
              {p.tags.length ? (
                <span className="al-profile-card__terms">
                  <span className="al-profile-card__label">Tags</span>
                  {tagLabels(p.tags).map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </span>
              ) : null}
            </ItemCard>
          ))}
          <AddCard label="Add release profile" onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing ? (
        <ReleaseProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsSection>
  );
}
