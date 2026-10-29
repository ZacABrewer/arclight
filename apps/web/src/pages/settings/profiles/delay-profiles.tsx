import { useState, type DragEvent } from 'react';
import { DelayProfileInput, type DelayProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Checkbox, Chip, ErrorBlock, Field, Input, Modal, Select, Skeleton, Tag, Toggle, cx } from '../../../arclight/index.js';
import { useSelection } from '../../../components/bulk-actions.js';
import { ResourceBulkBar } from '../../../components/resource-bulk-actions.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TagPicker, useTagLabels } from '../../../components/forms/tag-picker.js';
import { useDelayProfileList, useDeleteDelayProfile, useReorderDelayProfile, useSaveDelayProfile } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError, SettingsSection, minutesLabel } from '../shared.js';
import { delayDropRequest, delayReorderRequest, isDefaultDelayProfile } from './quality-profile-model.js';
import './profiles.css';
import { t } from '../../../i18n/index.js';

function DelayProfileEditor({ profile, onClose }: { profile: DelayProfile | null; onClose: () => void }) {
  const [draft, setDraft] = useState<DelayProfileInput>(() =>
    profile
      ? {
          tags: profile.tags,
          preferredProtocol: profile.preferredProtocol,
          usenetDelayMinutes: profile.usenetDelayMinutes,
          torrentDelayMinutes: profile.torrentDelayMinutes,
          bypassIfHighestQuality: profile.bypassIfHighestQuality,
          bypassIfAboveCustomFormatScore: profile.bypassIfAboveCustomFormatScore,
          minimumCustomFormatScore: profile.minimumCustomFormatScore,
        }
      : DelayProfileInput.parse({ tags: [] }),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveDelayProfile();
  const remove = useDeleteDelayProfile();
  const isDefault = profile !== null && isDefaultDelayProfile(profile);
  const set = <K extends keyof DelayProfileInput>(k: K, v: DelayProfileInput[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const tagError = !isDefault && draft.tags.length === 0 ? t('settings.profiles.delayProfiles.onlyTheDefaultProfileMay') : undefined;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size={560}
        title={profile ? t('settings.profiles.delayProfiles.editDelayProfile') : t('settings.profiles.delayProfiles.addDelayProfile')}
        footer={
          <EditorFooter
            onCancel={onClose}
            saving={save.isPending}
            onSave={() => {
              if (tagError) return;
              save.mutate({ id: profile?.id, body: draft }, { onSuccess: onClose });
            }}
            onDelete={profile && !isDefault ? () => setConfirmDelete(true) : undefined}
            deleteLabel={t('settings.profiles.delayProfiles.deleteDelayProfile')}
          />
        }
      >
        <div className="al-profile-editor">
          <Field label={t('settings.profiles.delayProfiles.preferredProtocol')}>
            <Select
              value={draft.preferredProtocol}
              onChange={(e) => set('preferredProtocol', e.currentTarget.value === 'torrent' ? 'torrent' : 'usenet')}
              options={[
                { value: 'usenet', label: t('settings.profiles.delayProfiles.preferUsenet') },
                { value: 'torrent', label: t('settings.profiles.delayProfiles.preferTorrent') },
              ]}
            />
          </Field>
          <Field label={t('settings.profiles.delayProfiles.usenetDelayMinutes')}>
            <Input type="number" mono min={0} value={draft.usenetDelayMinutes} onChange={(e) => set('usenetDelayMinutes', Math.max(0, Number(e.currentTarget.value) || 0))} />
          </Field>
          <Field label={t('settings.profiles.delayProfiles.torrentDelayMinutes')}>
            <Input type="number" mono min={0} value={draft.torrentDelayMinutes} onChange={(e) => set('torrentDelayMinutes', Math.max(0, Number(e.currentTarget.value) || 0))} />
          </Field>
          <Toggle
            checked={draft.bypassIfHighestQuality}
            label={t('settings.profiles.delayProfiles.bypassIfHighestQualityGrab')}
            onChange={(e) => set('bypassIfHighestQuality', e.currentTarget.checked)}
          />
          <Toggle
            checked={draft.bypassIfAboveCustomFormatScore}
            label={t('settings.profiles.delayProfiles.bypassIfAboveCustomFormat')}
            onChange={(e) => set('bypassIfAboveCustomFormatScore', e.currentTarget.checked)}
          />
          {draft.bypassIfAboveCustomFormatScore ? (
            <Field label={t('settings.profiles.delayProfiles.minimumCustomFormatScore')}>
              <Input type="number" mono value={draft.minimumCustomFormatScore} onChange={(e) => set('minimumCustomFormatScore', Number(e.currentTarget.value) || 0)} />
            </Field>
          ) : null}
          {isDefault ? (
            <p className="al-muted">{t('settings.profiles.delayProfiles.thisIsTheDefaultProfile')}</p>
          ) : (
            <Field label={t('common.tags')} error={tagError}>
              <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />
            </Field>
          )}
          <SaveError error={save.error} />
        </div>
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title={t('settings.profiles.delayProfiles.deleteThisDelayProfile')}
          confirmLabel={t('settings.profiles.delayProfiles.deleteDelayProfile')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>{t('settings.profiles.delayProfiles.itemsWithItsTagsFall')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function DelayProfilesSection() {
  const list = useDelayProfileList();
  const reorder = useReorderDelayProfile();
  const tagLabels = useTagLabels();
  const [editing, setEditing] = useState<DelayProfile | 'new' | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const sorted = [...(list.data ?? [])].sort((a, b) => a.order - b.order);
  // The default (untagged) profile cannot be deleted, so it is not selectable.
  const deletable = sorted.filter((p) => !isDefaultDelayProfile(p));
  const selection = useSelection(deletable.map((p) => p.id));

  const move = (index: number, direction: 'up' | 'down') => {
    const req = delayReorderRequest(sorted, index, direction);
    if (req) reorder.mutate(req);
  };

  const onDrop = (index: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'));
    const req = Number.isInteger(from) ? delayDropRequest(sorted, from, index) : null;
    if (req) reorder.mutate(req);
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <SettingsSection
      label={t('settings.profiles.delayProfiles.delayProfiles')}
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          {t('settings.profiles.delayProfiles.addDelayProfile')}
        </Button>
      }
    >
      <p className="al-caption">{t('settings.profiles.delayProfiles.theFirstProfileWhoseTags')}</p>
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title={t('settings.profiles.delayProfiles.couldntLoadDelayProfiles')} onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <div className="al-table-wrap">
          <table className="al-table al-delay-table">
            <caption className="al-sr-only">{t('settings.profiles.delayProfiles.delayProfiles')}</caption>
            <thead>
              <tr>
                <th scope="col" className="al-table__check">
                  <Checkbox
                    aria-label={t('arclight.table.selectAllRows')}
                    checked={selection.all}
                    indeterminate={selection.some}
                    disabled={deletable.length === 0}
                    onChange={selection.toggleAll}
                  />
                </th>
                <th scope="col" style={{ width: 28 }}>
                  <span className="al-sr-only">{t('settings.profiles.delayProfiles.order')}</span>
                </th>
                <th scope="col">{t('common.protocol')}</th>
                <th scope="col">{t('settings.profiles.delayProfiles.usenetDelay')}</th>
                <th scope="col">{t('settings.profiles.delayProfiles.torrentDelay')}</th>
                <th scope="col">{t('settings.profiles.delayProfiles.bypass')}</th>
                <th scope="col">{t('common.tags')}</th>
                <th scope="col" className="al-th--right">
                  <span className="al-sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => {
                const pinned = isDefaultDelayProfile(p);
                return (
                  <tr
                    key={p.id}
                    data-testid="delay-row"
                    className={cx(dragOver === i && 'is-over')}
                    draggable={!pinned}
                    onDragStart={(e) => {
                      setDragFrom(i);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(i));
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(i);
                    }}
                    onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
                    onDrop={onDrop(i)}
                    onDragEnd={() => {
                      setDragFrom(null);
                      setDragOver(null);
                    }}
                  >
                    <td className="al-table__check">
                      {pinned ? null : (
                        <Checkbox
                          aria-label={t('components.bulkActions.selectName', { name: tagLabels(p.tags).join(', ') || String(p.id) })}
                          checked={selection.has(p.id)}
                          onChange={() => selection.toggle(p.id)}
                        />
                      )}
                    </td>
                    <td>
                      <span className="al-qlist__handle" aria-hidden="true">
                        {pinned ? '' : '⋮⋮'}
                      </span>
                    </td>
                    <td>{p.preferredProtocol === 'usenet' ? t('settings.profiles.delayProfiles.preferUsenet') : t('settings.profiles.delayProfiles.preferTorrent')}</td>
                    <td className="al-td--mono">{minutesLabel(p.usenetDelayMinutes)}</td>
                    <td className="al-td--mono">{minutesLabel(p.torrentDelayMinutes)}</td>
                    <td>
                      <span className="al-chip-row">
                        {p.bypassIfHighestQuality ? <Chip tone="neutral">{t('settings.profiles.delayProfiles.highestQuality')}</Chip> : null}
                        {p.bypassIfAboveCustomFormatScore ? (
                          <Chip tone="neutral">
                            {t('settings.profiles.delayProfiles.score')} <span className="al-num">{p.minimumCustomFormatScore}</span>
                          </Chip>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <span className="al-chip-row">
                        {pinned ? (
                          <Chip tone="muted" dot="none">
                            {t('settings.profiles.delayProfiles.default')}
                          </Chip>
                        ) : (
                          tagLabels(p.tags).map((item) => <Tag key={item}>{item}</Tag>)
                        )}
                      </span>
                    </td>
                    <td className="al-td--right">
                      <span className="al-row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="al-qlist__move"
                          aria-label={t('settings.profiles.delayProfiles.moveUp')}
                          disabled={!delayReorderRequest(sorted, i, 'up') || reorder.isPending}
                          onClick={() => move(i, 'up')}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="al-qlist__move"
                          aria-label={t('settings.profiles.delayProfiles.moveDown')}
                          disabled={!delayReorderRequest(sorted, i, 'down') || reorder.isPending}
                          onClick={() => move(i, 'down')}
                        >
                          ↓
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                          {t('common.edit')}
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ResourceBulkBar resource="delayprofile" selection={selection} allKeys={deletable.map((p) => p.id)} />
      {editing ? (
        <DelayProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsSection>
  );
}
