import { useState, type DragEvent } from 'react';
import { DelayProfileInput, type DelayProfile } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, Chip, ErrorBlock, Field, Input, Modal, Select, Skeleton, Tag, Toggle, cx } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TagPicker, useTagLabels } from '../../../components/forms/tag-picker.js';
import { useDelayProfileList, useDeleteDelayProfile, useReorderDelayProfile, useSaveDelayProfile } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError, SettingsSection, minutesLabel } from '../shared.js';
import { delayDropRequest, delayReorderRequest, isDefaultDelayProfile } from './quality-profile-model.js';
import './profiles.css';

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
  const tagError = !isDefault && draft.tags.length === 0 ? 'Only the default profile may be untagged' : undefined;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size={560}
        title={profile ? 'Edit delay profile' : 'Add delay profile'}
        footer={
          <EditorFooter
            onCancel={onClose}
            saving={save.isPending}
            onSave={() => {
              if (tagError) return;
              save.mutate({ id: profile?.id, body: draft }, { onSuccess: onClose });
            }}
            onDelete={profile && !isDefault ? () => setConfirmDelete(true) : undefined}
            deleteLabel="Delete delay profile"
          />
        }
      >
        <div className="al-profile-editor">
          <Field label="Preferred protocol">
            <Select
              value={draft.preferredProtocol}
              onChange={(e) => set('preferredProtocol', e.currentTarget.value === 'torrent' ? 'torrent' : 'usenet')}
              options={[
                { value: 'usenet', label: 'Prefer Usenet' },
                { value: 'torrent', label: 'Prefer Torrent' },
              ]}
            />
          </Field>
          <Field label="Usenet delay (minutes)">
            <Input type="number" mono min={0} value={draft.usenetDelayMinutes} onChange={(e) => set('usenetDelayMinutes', Math.max(0, Number(e.currentTarget.value) || 0))} />
          </Field>
          <Field label="Torrent delay (minutes)">
            <Input type="number" mono min={0} value={draft.torrentDelayMinutes} onChange={(e) => set('torrentDelayMinutes', Math.max(0, Number(e.currentTarget.value) || 0))} />
          </Field>
          <Toggle
            checked={draft.bypassIfHighestQuality}
            label="Bypass if highest quality: grab at once when the release is the profile's best quality"
            onChange={(e) => set('bypassIfHighestQuality', e.currentTarget.checked)}
          />
          <Toggle
            checked={draft.bypassIfAboveCustomFormatScore}
            label="Bypass if above custom format score"
            onChange={(e) => set('bypassIfAboveCustomFormatScore', e.currentTarget.checked)}
          />
          {draft.bypassIfAboveCustomFormatScore ? (
            <Field label="Minimum custom format score">
              <Input type="number" mono value={draft.minimumCustomFormatScore} onChange={(e) => set('minimumCustomFormatScore', Number(e.currentTarget.value) || 0)} />
            </Field>
          ) : null}
          {isDefault ? (
            <p className="al-muted">This is the default profile. It applies to everything without a more specific tag match and stays untagged.</p>
          ) : (
            <Field label="Tags" error={tagError}>
              <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />
            </Field>
          )}
          <SaveError error={save.error} />
        </div>
      </Modal>
      {profile ? (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete this delay profile?"
          confirmLabel="Delete delay profile"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await remove.mutateAsync(profile.id);
            setConfirmDelete(false);
            onClose();
          }}
        >
          <p>Items with its tags fall back to the next matching profile.</p>
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
      label="Delay profiles"
      {...(list.data ? { count: list.data.length } : {})}
      action={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          Add delay profile
        </Button>
      }
    >
      <p className="al-caption">The first profile whose tags match is used. Drag rows or use the move buttons to change the order.</p>
      {list.isPending ? (
        <Skeleton lines={3} />
      ) : list.isError ? (
        <ErrorBlock title="Couldn't load delay profiles" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <div className="al-table-wrap">
          <table className="al-table al-delay-table">
            <caption className="al-sr-only">Delay profiles</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: 28 }}>
                  <span className="al-sr-only">Order</span>
                </th>
                <th scope="col">Protocol</th>
                <th scope="col">Usenet delay</th>
                <th scope="col">Torrent delay</th>
                <th scope="col">Bypass</th>
                <th scope="col">Tags</th>
                <th scope="col" className="al-th--right">
                  <span className="al-sr-only">Actions</span>
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
                    <td>
                      <span className="al-qlist__handle" aria-hidden="true">
                        {pinned ? '' : '⋮⋮'}
                      </span>
                    </td>
                    <td>{p.preferredProtocol === 'usenet' ? 'Prefer Usenet' : 'Prefer Torrent'}</td>
                    <td className="al-td--mono">{minutesLabel(p.usenetDelayMinutes)}</td>
                    <td className="al-td--mono">{minutesLabel(p.torrentDelayMinutes)}</td>
                    <td>
                      <span className="al-chip-row">
                        {p.bypassIfHighestQuality ? <Chip tone="neutral">Highest quality</Chip> : null}
                        {p.bypassIfAboveCustomFormatScore ? (
                          <Chip tone="neutral">
                            Score ≥ <span className="al-num">{p.minimumCustomFormatScore}</span>
                          </Chip>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <span className="al-chip-row">
                        {pinned ? (
                          <Chip tone="muted" dot="none">
                            Default
                          </Chip>
                        ) : (
                          tagLabels(p.tags).map((t) => <Tag key={t}>{t}</Tag>)
                        )}
                      </span>
                    </td>
                    <td className="al-td--right">
                      <span className="al-row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="al-qlist__move"
                          aria-label="Move up"
                          disabled={!delayReorderRequest(sorted, i, 'up') || reorder.isPending}
                          onClick={() => move(i, 'up')}
                        >
                          ↑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="al-qlist__move"
                          aria-label="Move down"
                          disabled={!delayReorderRequest(sorted, i, 'down') || reorder.isPending}
                          onClick={() => move(i, 'down')}
                        >
                          ↓
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                          Edit
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
      {editing ? (
        <DelayProfileEditor key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </SettingsSection>
  );
}
