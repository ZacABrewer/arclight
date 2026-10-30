import { useState } from 'react';
import {
  AlbumPrimaryType,
  AlbumReleaseStatus,
  AlbumSecondaryType,
  type AlbumTypeProfile,
  type AlbumTypeProfileInput,
} from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Checkbox, Chip, ErrorBlock, Field, Input, Modal, Skeleton, Tag, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { ListSearchCount, ListSearchEmpty, useClientListSearch } from '../../../components/list-search.js';
import { useAlbumTypeProfiles, useDeleteAlbumTypeProfile, useFeatures, useSaveAlbumTypeProfile } from '../../../hooks/music.js';
import { albumTypeLabel } from '../../library/music/music-model.js';
import { AddCard, CardGrid, EditorFooter, ItemCard, SaveError, SettingsSection } from '../shared.js';
import '../../library/music/music.css';
import './profiles.css';
import { t } from '../../../i18n/index.js';

// Album-type profiles (music): which MusicBrainz release groups become album rows.

const EMPTY: AlbumTypeProfileInput = { name: '', primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'], isDefault: false };

function toInput(p: AlbumTypeProfile): AlbumTypeProfileInput {
  const { id: _id, ...rest } = p;
  return rest;
}

/** Problems that keep the profile from saving (name, at least one primary type and status). */
export function albumTypeProfileErrors(d: AlbumTypeProfileInput): string[] {
  const out: string[] = [];
  if (!d.name.trim()) out.push(t('common.nameIsRequired'));
  if (d.primaryTypes.length === 0) out.push(t('music.typeProfiles.pickAPrimaryType'));
  if (d.releaseStatuses.length === 0) out.push(t('music.typeProfiles.pickAStatus'));
  return out;
}

function toggleIn<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
}

function CheckGroup<T extends string>({ label, hint, options, value, onChange, render }: {
  label: string;
  hint?: string;
  options: readonly T[];
  value: readonly T[];
  onChange: (next: T[]) => void;
  render?: (v: T) => string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="music-type-grid" role="group" aria-label={label}>
        {options.map((o) => (
          <Checkbox key={o} label={render ? render(o) : o} checked={value.includes(o)} onChange={(e) => onChange(toggleIn(value, o, e.currentTarget.checked))} />
        ))}
      </div>
    </Field>
  );
}

function AlbumTypeProfileEditor({ profile, onClose }: { profile: AlbumTypeProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<AlbumTypeProfileInput>(() => (profile ? toInput(profile) : EMPTY));
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveAlbumTypeProfile();
  const remove = useDeleteAlbumTypeProfile();
  const set = <K extends keyof AlbumTypeProfileInput>(k: K, v: AlbumTypeProfileInput[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = () => {
    const errs = albumTypeProfileErrors(draft);
    setProblems(errs);
    if (errs.length) return;
    save.mutate({ id: profile?.id, body: { ...draft, name: draft.name.trim() } }, { onSuccess: onClose });
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size={640}
        title={profile ? t('music.typeProfiles.editName', { name: profile.name }) : t('music.typeProfiles.add')}
        footer={
          <EditorFooter
            onCancel={onClose}
            onSave={submit}
            saving={save.isPending}
            onDelete={profile && !profile.isDefault ? () => setConfirmDelete(true) : undefined}
            deleteLabel={t('music.typeProfiles.delete')}
          />
        }
      >
        <div className="al-profile-editor">
          <Field label={t('common.name')}>
            <Input value={draft.name} onChange={(e) => set('name', e.currentTarget.value)} />
          </Field>
          <CheckGroup label={t('music.typeProfiles.primaryTypes')} options={AlbumPrimaryType.options} value={draft.primaryTypes} onChange={(v) => set('primaryTypes', v)} render={albumTypeLabel} />
          <CheckGroup
            label={t('music.typeProfiles.secondaryTypes')}
            hint={t('music.typeProfiles.secondaryTypesHint')}
            options={AlbumSecondaryType.options}
            value={draft.secondaryTypes}
            onChange={(v) => set('secondaryTypes', v)}
          />
          <CheckGroup label={t('music.typeProfiles.releaseStatuses')} options={AlbumReleaseStatus.options} value={draft.releaseStatuses} onChange={(v) => set('releaseStatuses', v)} />
          <Toggle checked={draft.isDefault} label={t('music.typeProfiles.useForNewArtists')} onChange={(e) => set('isDefault', e.currentTarget.checked)} />
          {problems.length ? (
            <p className="al-inline-error" role="alert">
              {problems.join(' · ')}
            </p>
          ) : null}
          <SaveError error={save.error} />
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        title={t('music.typeProfiles.deleteName', { name: profile?.name ?? '' })}
        confirmLabel={t('music.typeProfiles.delete')}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!profile) return;
          await remove.mutateAsync(profile.id);
          setConfirmDelete(false);
          onClose();
        }}
      >
        <p>{t('music.typeProfiles.deleteBody')}</p>
      </ConfirmDialog>
    </>
  );
}

/** Settings → Profiles → Album types (while music is on). */
export function AlbumTypeProfilesSection() {
  const features = useFeatures();
  if (!features.music) return null;
  return <AlbumTypeProfilesList />;
}

function AlbumTypeProfilesList() {
  const list = useAlbumTypeProfiles();
  // The profiles page search: name and primary types.
  const search = useClientListSearch(list.data, (p) => [p.name, p.primaryTypes.map(albumTypeLabel)]);
  const [editing, setEditing] = useState<AlbumTypeProfile | 'new' | null>(null);
  return (
    <SettingsSection
      label={t('music.typeProfiles.title')}
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <>
          <ListSearchCount active={search.active} shown={list.data ? search.shown : undefined} total={search.total} />
          <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
            {t('music.typeProfiles.add')}
          </Button>
        </>
      }
    >
      {list.isPending ? (
        <Skeleton lines={2} />
      ) : list.isError ? (
        <ErrorBlock title={t('music.typeProfiles.couldNotLoad')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : search.active && search.shown === 0 && search.total > 0 ? (
        <ListSearchEmpty query={search.q} onClear={search.clear} />
      ) : (
        <CardGrid label={t('music.typeProfiles.title')}>
          {(search.rows ?? []).map((p) => (
            <ItemCard
              key={p.id}
              title={p.name}
              onClick={() => setEditing(p)}
              status={
                p.isDefault ? (
                  <Chip tone="accent" dot="none">
                    {t('music.typeProfiles.default')}
                  </Chip>
                ) : null
              }
            >
              <span className="al-profile-card__tags" aria-label={t('music.typeProfiles.primaryTypesOf', { name: p.name })}>
                {p.primaryTypes.map((x) => (
                  <Tag key={x}>{albumTypeLabel(x)}</Tag>
                ))}
              </span>
              <span className="al-caption">
                {p.secondaryTypes.length ? t('music.typeProfiles.plusSecondary', { count: p.secondaryTypes.length }) : t('music.typeProfiles.noSecondary')}
                {' · '}
                {p.releaseStatuses.join(', ')}
              </span>
            </ItemCard>
          ))}
          <AddCard label={t('music.typeProfiles.add')} onClick={() => setEditing('new')} />
        </CardGrid>
      )}
      {editing ? <AlbumTypeProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </SettingsSection>
  );
}
