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
import { useResourceBulk } from '../../../components/resource-bulk-actions.js';
import './profiles.css';
import { t } from '../../../i18n/index.js';

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
    if (!draft.name.trim()) return setNameError(t('common.nameIsRequired'));
    if (draft.required.length === 0 && draft.ignored.length === 0) return setNameError(t('settings.profiles.releaseProfiles.addAtLeastOneRequired'));
    setNameError(undefined);
    save.mutate({ id: profile?.id, body: draft }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size={560}
        title={profile ? t('settings.profiles.releaseProfiles.editName', { name: profile.name }) : t('settings.profiles.releaseProfiles.addReleaseProfile')}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={profile ? () => setConfirmDelete(true) : undefined}
            deleteLabel={t('settings.profiles.releaseProfiles.deleteProfile')}
          />
        }
      >
        <div className="al-profile-editor">
          <Field label={t('common.name')} error={nameError}>
            <Input value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <Toggle checked={draft.enabled} label={t('common.enabled')} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          <Field label={t('settings.profiles.releaseProfiles.mustContain')} hint={t('settings.profiles.releaseProfiles.atLeastOneTermMust')}>
            <TermList value={draft.required} onChange={(v) => set('required', v)} />
          </Field>
          <Field label={t('settings.profiles.releaseProfiles.mustNotContain')} hint={t('settings.profiles.releaseProfiles.aReleaseContainingAnyOf')}>
            <TermList value={draft.ignored} onChange={(v) => set('ignored', v)} />
          </Field>
          <Field label={t('common.indexer')} hint={t('settings.profiles.releaseProfiles.onlyApplyToReleasesFrom')}>
            <Select
              value={draft.indexerId === undefined ? '' : String(draft.indexerId)}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setDraft((d) => {
                  const { indexerId: _drop, ...rest } = d;
                  return v ? { ...rest, indexerId: Number(v) } : rest;
                });
              }}
              options={[{ value: '', label: t('settings.profiles.releaseProfiles.anyIndexer') }, ...(indexers.data ?? []).map((i) => ({ value: String(i.id), label: i.name }))]}
            />
          </Field>
          <Field label={t('common.tags')} hint={t('settings.profiles.releaseProfiles.onlyApplyToSeriesAnd')}>
            <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />
          </Field>
          <SaveError error={save.error} />
        </div>
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.profiles.releaseProfiles.deleteName', { name: profile.name })}
          confirmLabel={t('settings.profiles.releaseProfiles.deleteProfile')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>{t('settings.profiles.releaseProfiles.thisCannotBeUndone')}</p>
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
      {terms.map((item) => (
        <Tag key={item} className="al-num">
          {item}
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
  const bulk = useResourceBulk('releaseprofile', list.data, (p) => p.id, (p) => p.name);

  return (
    <SettingsSection
      label={t('settings.profiles.releaseProfiles.releaseProfiles')}
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          {t('settings.profiles.releaseProfiles.addReleaseProfile')}
        </Button>
      }
    >
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.profiles.releaseProfiles.couldntLoadReleaseProfiles')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <>
        <CardGrid label={t('settings.profiles.releaseProfiles.releaseProfiles')}>
          {list.data.map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              select={bulk.cardProps(p)}
              muted={!p.enabled}
              onClick={() => setEditing(p)}
              status={
                p.enabled ? null : (
                  <Chip tone="muted" dot="none">
                    {t('common.off')}
                  </Chip>
                )
              }
            >
              <Terms label={t('settings.profiles.releaseProfiles.mustContain')} terms={p.required} />
              <Terms label={t('settings.profiles.releaseProfiles.mustNotContain')} terms={p.ignored} negative />
              {p.indexerId ? (
                <span className="al-profile-card__terms">
                  <span className="al-profile-card__label">{t('common.indexer')}</span>
                  {indexers.data?.find((i) => i.id === p.indexerId)?.name ?? <span className="al-num">#{p.indexerId}</span>}
                </span>
              ) : null}
              {p.tags.length ? (
                <span className="al-profile-card__terms">
                  <span className="al-profile-card__label">{t('common.tags')}</span>
                  {tagLabels(p.tags).map((entry) => (
                    <Tag key={entry}>{entry}</Tag>
                  ))}
                </span>
              ) : null}
            </ItemCard>
          ))}
          <AddCard label={t('settings.profiles.releaseProfiles.addReleaseProfile')} onClick={() => setEditing('new')} />
        </CardGrid>
        {bulk.bar}
        </>
      )}
      {editing ? (
        <ReleaseProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsSection>
  );
}
