import { useId, useState } from 'react';
import { MediaServerTagSync, type MediaServerConnectionKind, type MediaServerInputRaw, type MediaServerResource, type TagSyncChange, type TagSyncPreview } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { tagSyncApi } from '../../../api/tag-sync.js';
import { Button, FormRow, Input, Modal, Segmented, Table, Tag, Toggle, type Column } from '../../../arclight/index.js';
import { MultiSelect } from '../../../components/multi-select.js';
import { useToast } from '../../../components/toast.js';
import { useTags } from '../../../hooks/library.js';
import { useRunTagSync, useTagSyncStatus } from '../../../hooks/tag-sync.js';
import { t } from '../../../i18n/index.js';
import { formatDateTime } from '../../../lib/ui-preferences.js';

// Settings → Media servers → (Jellyfin, Emby or Plex server) → Sync tags: Arclight's tags written
// to the matching movies and series on that server (tag-sync module, /mediaserver/:id/tag-sync).
// Preview and Sync now work on the saved settings, so they show for saved servers only.

/** What to do with the tags Arclight added when sync is turned off (D10). */
export type TagSyncOffAction = 'remove' | 'keep';

type TagSyncDraft = NonNullable<MediaServerInputRaw['tagSync']>;

/** Kinds whose items carry tags. */
export function supportsTagSync(kind: MediaServerConnectionKind): boolean {
  return kind === 'jellyfin' || kind === 'emby' || kind === 'plex';
}

/** The text written for a tag: the prefix, then the label (as the api writes it). */
export function tagSyncLabel(prefix: string, tag: string): string {
  return `${prefix.trim()}${tag}`.trim();
}

/** The status line under the buttons. */
export function TagSyncStatusLine({ serverId }: { serverId: string }) {
  const status = useTagSyncStatus(serverId);
  const st = status.data;
  if (status.isError) return <p className="al-caption al-ms-sync__error">{errorMessage(status.error)}</p>;
  if (!st) return null;
  let text: string;
  if (st.running) text = t('settings.mediaServers.tagSync.running');
  else if (st.lastError) text = t('settings.mediaServers.tagSync.error', { reason: st.lastError });
  else if (st.lastRunAt) text = t('settings.mediaServers.tagSync.lastRun', { when: formatDateTime(st.lastRunAt), changed: st.lastChanged });
  else text = t('settings.mediaServers.tagSync.never');
  return (
    <p className={st.lastError && !st.running ? 'al-caption al-ms-sync__error' : 'al-caption'} role="status">
      {text}
    </p>
  );
}

export function TagSyncSection({
  server,
  kind,
  value,
  onChange,
  onOffAction,
}: {
  /** The saved server (null while adding one). */
  server: MediaServerResource | null;
  kind: MediaServerConnectionKind;
  value: TagSyncDraft | undefined;
  onChange: (next: TagSyncDraft) => void;
  /** Remove or Keep, chosen when turning off a sync that was saved on; applied after saving. */
  onOffAction: (action: TagSyncOffAction | null) => void;
}) {
  const sync = MediaServerTagSync.parse(value ?? {});
  const tags = useTags();
  const toast = useToast();
  const prefixId = useId();
  const [confirmOff, setConfirmOff] = useState(false);
  const [preview, setPreview] = useState<TagSyncPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const run = useRunTagSync(server?.id ?? '');
  const set = (patch: Partial<MediaServerTagSync>) => onChange({ ...sync, ...patch });
  const savedOn = server?.tagSync?.enabled === true;
  const options = (tags.data ?? []).map((tag) => ({ value: tag.id, label: tag.label }));
  const sample = (sync.mode === 'selected' ? options.find((o) => sync.tagIds.includes(o.value)) : undefined) ?? options[0];

  const toggle = (on: boolean) => {
    if (!on && savedOn) {
      setConfirmOff(true);
      return;
    }
    onOffAction(null);
    set({ enabled: on });
  };
  const chooseOff = (action: TagSyncOffAction) => {
    setConfirmOff(false);
    onOffAction(action);
    set({ enabled: false });
  };
  const openPreview = async () => {
    if (!server) return;
    setPreviewing(true);
    try {
      setPreview(await tagSyncApi.preview(server.id));
    } catch (err) {
      toast.push({ tone: 'error', title: t('settings.mediaServers.tagSync.failed'), message: errorMessage(err) });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <section className="al-ms-tagsync" aria-label={t('settings.mediaServers.tagSync.title')}>
      <h3 className="al-ms-tagsync__title">{t('settings.mediaServers.tagSync.title')}</h3>
      <p className="al-caption">{t('settings.mediaServers.tagSync.desc')}</p>
      <FormRow label={t('settings.mediaServers.tagSync.enabled')} caption={kind === 'plex' ? t('settings.mediaServers.tagSync.plexNote') : undefined} captionInline>
        <Toggle aria-label={t('settings.mediaServers.tagSync.enabled')} checked={sync.enabled} onChange={(e) => toggle(e.currentTarget.checked)} />
      </FormRow>
      {sync.enabled ? (
        <>
          <FormRow label={t('settings.mediaServers.tagSync.mode')}>
            <Segmented
              aria-label={t('settings.mediaServers.tagSync.mode')}
              variant="soft"
              value={sync.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: 'all', label: t('settings.mediaServers.tagSync.all') },
                { value: 'selected', label: t('settings.mediaServers.tagSync.selected') },
              ]}
            />
          </FormRow>
          {sync.mode === 'selected' ? (
            <FormRow label={t('settings.mediaServers.tagSync.pick')}>
              <MultiSelect label={t('settings.mediaServers.tagSync.pick')} emptyLabel={t('common.none')} options={options} value={sync.tagIds} onChange={(tagIds) => set({ tagIds })} />
            </FormRow>
          ) : null}
          <FormRow
            label={t('settings.mediaServers.tagSync.prefix')}
            htmlFor={prefixId}
            captionMono
            caption={sample ? t('settings.mediaServers.tagSync.prefixExample', { tag: sample.label, label: tagSyncLabel(sync.prefix, sample.label) }) : undefined}
          >
            <Input id={prefixId} mono spellCheck={false} maxLength={24} value={value?.prefix ?? ''} onChange={(e) => set({ prefix: e.currentTarget.value.replace(/[,;]/g, '') })} />
          </FormRow>
          <FormRow label={t('settings.mediaServers.tagSync.lock')} caption={t('settings.mediaServers.tagSync.lockDesc')} captionInline>
            <Toggle aria-label={t('settings.mediaServers.tagSync.lock')} checked={sync.lockTags} onChange={(e) => set({ lockTags: e.currentTarget.checked })} />
          </FormRow>
        </>
      ) : null}
      {server && savedOn ? (
        <>
          <div className="al-ms-sync__actions">
            <Button size="sm" variant="secondary" loading={previewing} onClick={() => void openPreview()}>
              {t('settings.mediaServers.tagSync.preview')}
            </Button>
            <Button size="sm" variant="ghost" loading={run.isPending} onClick={() => run.mutate(undefined)}>
              {t('settings.mediaServers.tagSync.run')}
            </Button>
          </div>
          <TagSyncStatusLine serverId={server.id} />
        </>
      ) : null}
      {preview ? <TagSyncPreviewDialog preview={preview} onClose={() => setPreview(null)} /> : null}
      <Modal
        open={confirmOff}
        size="sm"
        onClose={() => setConfirmOff(false)}
        title={t('settings.mediaServers.tagSync.offTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => chooseOff('keep')}>
              {t('settings.mediaServers.tagSync.offKeep')}
            </Button>
            <Button variant="danger" onClick={() => chooseOff('remove')}>
              {t('settings.mediaServers.tagSync.offRemove')}
            </Button>
          </>
        }
      />
    </section>
  );
}

function TagSyncPreviewDialog({ preview, onClose }: { preview: TagSyncPreview; onClose: () => void }) {
  const labels = (list: string[]) => (
    <span className="al-ms-chips">
      {list.map((l) => (
        <Tag key={l}>{l}</Tag>
      ))}
    </span>
  );
  const columns: Column<TagSyncChange>[] = [
    { key: 'title', header: t('settings.mediaServers.tagSync.titleColumn'), cell: (c) => c.title, sortValue: (c) => c.title.toLowerCase() },
    { key: 'add', header: t('settings.mediaServers.tagSync.add'), cell: (c) => labels(c.add) },
    { key: 'remove', header: t('settings.mediaServers.tagSync.remove'), cell: (c) => labels(c.remove) },
  ];
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={t('settings.mediaServers.tagSync.previewTitle')}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <p className="al-caption">{t('settings.mediaServers.tagSync.counts', { changes: preview.totalChanges, unmatched: preview.unmatched })}</p>
      {preview.totalChanges === 0 ? (
        <p>{t('settings.mediaServers.tagSync.none')}</p>
      ) : (
        <div className="al-ms-table">
          <Table caption={t('settings.mediaServers.tagSync.previewTitle')} columns={columns} rows={preview.changes} rowKey={(c) => c.remoteItemId} />
        </div>
      )}
      {preview.truncated ? <p className="al-caption">{t('settings.mediaServers.tagSync.truncated', { count: preview.changes.length })}</p> : null}
    </Modal>
  );
}
