import { useState } from 'react';
import { DelayProfileInput, type DelayProfile } from '@media-tron/shared';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { TagPicker, useTagLabels } from '../../../components/forms/tag-picker.js';
import { Modal } from '../../../components/modal.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useDelayProfileList, useDeleteDelayProfile, useReorderDelayProfile, useSaveDelayProfile } from '../../../hooks/profiles.js';
import { EditorFooter, SaveError, minutesLabel } from '../shared.js';
import { delayReorderRequest, isDefaultDelayProfile } from './quality-profile-model.js';

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
  const save = useSaveDelayProfile();
  const remove = useDeleteDelayProfile();
  const isDefault = profile !== null && isDefaultDelayProfile(profile);
  const set = <K extends keyof DelayProfileInput>(k: K, v: DelayProfileInput[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const tagError = !isDefault && draft.tags.length === 0 ? 'Only the default profile may be untagged' : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title={profile ? 'Edit delay profile' : 'Add delay profile'}
      footer={
        <EditorFooter
          onCancel={onClose}
          saving={save.isPending}
          onSave={() => {
            if (tagError) return;
            save.mutate({ id: profile?.id, body: draft }, { onSuccess: onClose });
          }}
          onDelete={profile && !isDefault ? () => remove.mutate(profile.id, { onSuccess: onClose }) : undefined}
        />
      }
    >
      <FormField label="Preferred protocol">
        <Select
          value={draft.preferredProtocol}
          onChange={(e) => set('preferredProtocol', e.currentTarget.value === 'torrent' ? 'torrent' : 'usenet')}
          options={[
            { value: 'usenet', label: 'Prefer Usenet' },
            { value: 'torrent', label: 'Prefer Torrent' },
          ]}
        />
      </FormField>
      <FormField label="Usenet delay (minutes)">
        <Input type="number" min={0} value={draft.usenetDelayMinutes} onChange={(e) => set('usenetDelayMinutes', Math.max(0, Number(e.currentTarget.value) || 0))} />
      </FormField>
      <FormField label="Torrent delay (minutes)">
        <Input type="number" min={0} value={draft.torrentDelayMinutes} onChange={(e) => set('torrentDelayMinutes', Math.max(0, Number(e.currentTarget.value) || 0))} />
      </FormField>
      <FormField label="Bypass if highest quality" hint="Grab at once when the release is the profile's best quality.">
        <Toggle checked={draft.bypassIfHighestQuality} onChange={(e) => set('bypassIfHighestQuality', e.currentTarget.checked)} />
      </FormField>
      <FormField label="Bypass if above custom format score">
        <Toggle
          checked={draft.bypassIfAboveCustomFormatScore}
          onChange={(e) => set('bypassIfAboveCustomFormatScore', e.currentTarget.checked)}
        />
      </FormField>
      {draft.bypassIfAboveCustomFormatScore ? (
        <FormField label="Minimum custom format score">
          <Input
            type="number"
            value={draft.minimumCustomFormatScore}
            onChange={(e) => set('minimumCustomFormatScore', Number(e.currentTarget.value) || 0)}
          />
        </FormField>
      ) : null}
      {isDefault ? (
        <p className="muted">This is the default profile: it applies to everything without a more specific tag match and stays untagged.</p>
      ) : (
        <FormField label="Tags" error={tagError}>
          <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />
        </FormField>
      )}
      <SaveError error={save.error} />
    </Modal>
  );
}

export function DelayProfilesSection() {
  const list = useDelayProfileList();
  const reorder = useReorderDelayProfile();
  const tagLabels = useTagLabels();
  const [editing, setEditing] = useState<DelayProfile | 'new' | null>(null);
  const sorted = [...(list.data ?? [])].sort((a, b) => a.order - b.order);

  const move = (index: number, direction: 'up' | 'down') => {
    const req = delayReorderRequest(sorted, index, direction);
    if (req) reorder.mutate(req);
  };

  return (
    <Card
      title="Delay profiles"
      flush
      actions={
        <Button size="sm" onClick={() => setEditing('new')}>
          Add
        </Button>
      }
    >
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorView error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Protocol</th>
                <th>Usenet delay</th>
                <th>Torrent delay</th>
                <th>Bypass</th>
                <th>Tags</th>
                <th className="align-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={p.id}>
                  <td>{p.preferredProtocol === 'usenet' ? 'Prefer Usenet' : 'Prefer Torrent'}</td>
                  <td>{minutesLabel(p.usenetDelayMinutes)}</td>
                  <td>{minutesLabel(p.torrentDelayMinutes)}</td>
                  <td>
                    {p.bypassIfHighestQuality ? <Badge tone="info">highest quality</Badge> : null}{' '}
                    {p.bypassIfAboveCustomFormatScore ? <Badge tone="info">score ≥ {p.minimumCustomFormatScore}</Badge> : null}
                  </td>
                  <td>{isDefaultDelayProfile(p) ? <Badge>default</Badge> : tagLabels(p.tags).join(', ')}</td>
                  <td className="align-right nowrap">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Move up"
                      disabled={!delayReorderRequest(sorted, i, 'up') || reorder.isPending}
                      onClick={() => move(i, 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Move down"
                      disabled={!delayReorderRequest(sorted, i, 'down') || reorder.isPending}
                      onClick={() => move(i, 'down')}
                    >
                      ↓
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <DelayProfileEditor
          key={editing === 'new' ? 'new' : editing.id}
          profile={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}
