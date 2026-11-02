import { useId, useState } from 'react';
import type { SoulseekDownload, SoulseekDownloadStatus, SoulseekSettingsResponse, SoulseekSettingsUpdate } from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { soulseekApi } from '../../../api/soulseek.js';
import { Banner, Button, Chip, ErrorBlock, FormRow, Input, Meter, Select, Skeleton, Table, Toggle, type ChipTone, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { TestButton, type TestOutcome } from '../../../components/forms/test-result.js';
import { formatBytes } from '../../../components/media/format.js';
import { useFeatures } from '../../../hooks/music.js';
import { useRemoveSoulseekDownload, useSaveSoulseekSettings, useSoulseekDownloads, useSoulseekSettings } from '../../../hooks/soulseek.js';
import { PendingApiNotice, SaveError, SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

// Soulseek through the user's own slskd instance: an optional music source (GET/PUT
// /settings/soulseek, POST /soulseek/test, GET/DELETE /soulseek/downloads). Shown only while
// music is on; the api answers 404 MUSIC_DISABLED otherwise.

type Draft = SoulseekSettingsResponse;

function toDraft(s: SoulseekSettingsResponse): Draft {
  return { ...s };
}

/** Only the fields that differ from what is stored. */
export function soulseekChanges(stored: SoulseekSettingsResponse, draft: Draft): SoulseekSettingsUpdate {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as Array<keyof Draft>) if (draft[key] !== stored[key]) out[key] = draft[key];
  return out as SoulseekSettingsUpdate;
}

export function SoulseekSection() {
  const features = useFeatures();
  if (!features.ready || !features.music) return null;
  return <SoulseekSettingsBlock />;
}

function SoulseekSettingsBlock() {
  const settings = useSoulseekSettings();
  const label = t('soulseek.title');
  if (settings.isPending)
    return (
      <SettingsSection label={label}>
        <Skeleton lines={3} />
      </SettingsSection>
    );
  if (settings.isError)
    return (
      <SettingsSection label={label}>
        {settings.error instanceof ApiError && settings.error.status === 404 ? (
          <PendingApiNotice what={label} />
        ) : (
          <ErrorBlock title={t('soulseek.couldntLoad')} onRetry={() => void settings.refetch()}>
            {errorMessage(settings.error)}
          </ErrorBlock>
        )}
      </SettingsSection>
    );
  return <SoulseekForm key={JSON.stringify(settings.data)} stored={settings.data} />;
}

function SoulseekForm({ stored }: { stored: SoulseekSettingsResponse }) {
  const id = useId();
  const save = useSaveSoulseekSettings();
  const [d, setDraft] = useState<Draft>(() => toDraft(stored));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const changes = soulseekChanges(stored, d);
  const dirty = Object.keys(changes).length > 0;
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Math.round(Number(v)) : fallback);

  const test = async (): Promise<TestOutcome> => {
    const r = await soulseekApi.test(d);
    const message = r.version ? `${r.message} (slskd ${r.version})` : r.message;
    return { ok: r.ok, message, warnings: r.ok && !r.loggedIn ? [t('soulseek.notLoggedIn')] : [], errors: [] };
  };

  return (
    <SettingsSection label={t('soulseek.title')}>
      <p className="al-caption">{t('soulseek.intro')}</p>
      <FormRow label={t('soulseek.enable')} caption={t('soulseek.enableCaption')} captionInline>
        <Toggle aria-label={t('soulseek.enable')} checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('soulseek.host')} htmlFor={`${id}-host`} caption={t('soulseek.hostCaption')}>
        <Input id={`${id}-host`} mono placeholder="slskd" value={d.host} onChange={(e) => set('host', e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t('soulseek.port')} htmlFor={`${id}-port`}>
        <Input id={`${id}-port`} mono type="number" min={1} max={65535} value={String(d.port)} onChange={(e) => set('port', num(e.currentTarget.value, d.port))} />
      </FormRow>
      <FormRow label={t('soulseek.useSsl')} captionInline>
        <Toggle aria-label={t('soulseek.useSsl')} checked={d.useSsl} onChange={(e) => set('useSsl', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('soulseek.urlBase')} htmlFor={`${id}-base`} caption={t('soulseek.urlBaseCaption')}>
        <Input id={`${id}-base`} mono value={d.urlBase} onChange={(e) => set('urlBase', e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t('soulseek.apiKey')} htmlFor={`${id}-key`} caption={t('soulseek.apiKeyCaption')}>
        <Input id={`${id}-key`} mono type="password" autoComplete="off" value={d.apiKey} onChange={(e) => set('apiKey', e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t('soulseek.downloadsPath')} htmlFor={`${id}-path`} caption={t('soulseek.downloadsPathCaption')}>
        <Input id={`${id}-path`} mono placeholder="/downloads/slskd" value={d.downloadsPath} onChange={(e) => set('downloadsPath', e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t('soulseek.importMode')} htmlFor={`${id}-mode`} caption={t('soulseek.importModeCaption')}>
        <Select
          id={`${id}-mode`}
          value={d.importMode}
          options={[
            { value: 'copy', label: t('soulseek.importModeCopy') },
            { value: 'move', label: t('soulseek.importModeMove') },
          ]}
          onChange={(e) => set('importMode', e.currentTarget.value as Draft['importMode'])}
        />
      </FormRow>
      <FormRow label={t('soulseek.searchTimeout')} htmlFor={`${id}-timeout`}>
        <Input
          id={`${id}-timeout`}
          mono
          type="number"
          min={5}
          max={120}
          end="s"
          value={String(d.searchTimeoutSeconds)}
          onChange={(e) => set('searchTimeoutSeconds', num(e.currentTarget.value, d.searchTimeoutSeconds))}
        />
      </FormRow>
      <FormRow label={t('soulseek.maxPeerQueue')} htmlFor={`${id}-queue`} caption={t('soulseek.maxPeerQueueCaption')}>
        <Input id={`${id}-queue`} mono type="number" min={0} value={String(d.maxPeerQueue)} onChange={(e) => set('maxPeerQueue', num(e.currentTarget.value, d.maxPeerQueue))} />
      </FormRow>
      <FormRow label={t('soulseek.stalledHours')} htmlFor={`${id}-stall`} caption={t('soulseek.stalledHoursCaption')}>
        <Input id={`${id}-stall`} mono type="number" min={1} max={168} end="h" value={String(d.stalledHours)} onChange={(e) => set('stalledHours', num(e.currentTarget.value, d.stalledHours))} />
      </FormRow>
      <FormRow label={t('soulseek.autoSearch')} caption={t('soulseek.autoSearchCaption')} captionInline>
        <Toggle aria-label={t('soulseek.autoSearch')} checked={d.autoSearch} onChange={(e) => set('autoSearch', e.currentTarget.checked)} />
      </FormRow>
      {d.enabled && !d.downloadsPath ? <Banner tone="warn">{t('soulseek.noDownloadsPath')}</Banner> : null}
      <SaveError error={save.error} />
      <div className="al-dc-soulseek__actions">
        <TestButton onTest={test} label={t('common.test')} disabled={!d.host} />
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(changes)}>
          {t('common.save')}
        </Button>
      </div>
      {stored.enabled ? <SoulseekDownloads /> : null}
    </SettingsSection>
  );
}

const STATUS_TONE: Record<SoulseekDownloadStatus, ChipTone> = {
  queued: 'neutral',
  downloading: 'accent',
  importing: 'accent',
  imported: 'default',
  failed: 'danger',
  cancelled: 'muted',
};

export function soulseekStatusLabel(status: SoulseekDownloadStatus): string {
  return t(`soulseek.status.${status}`);
}

export function SoulseekDownloads() {
  const downloads = useSoulseekDownloads();
  const remove = useRemoveSoulseekDownload();
  const [removing, setRemoving] = useState<SoulseekDownload | null>(null);
  const columns: Column<SoulseekDownload>[] = [
    {
      key: 'album',
      header: t('soulseek.album'),
      sortValue: (r) => `${r.artistName} ${r.albumTitle}`,
      cell: (r) => (
        <span>
          {r.artistName} – {r.albumTitle}
          {r.message ? <span className="al-caption al-dc-soulseek__message">{r.message}</span> : null}
        </span>
      ),
    },
    { key: 'peer', header: t('soulseek.peer'), sortValue: (r) => r.username, cell: (r) => r.username, mono: true, muted: true },
    { key: 'quality', header: t('common.quality'), cell: (r) => r.qualityName ?? '—', muted: true },
    { key: 'size', header: t('common.size'), sortValue: (r) => r.totalSize, cell: (r) => formatBytes(r.totalSize), mono: true, align: 'right' },
    {
      key: 'status',
      header: t('common.status'),
      sortValue: (r) => r.status,
      cell: (r) =>
        r.status === 'downloading' ? (
          <Meter value={Math.round(r.progress * 100)} live label={soulseekStatusLabel(r.status)} valueText={`${Math.round(r.progress * 100)}%`} />
        ) : (
          <Chip tone={STATUS_TONE[r.status]}>{soulseekStatusLabel(r.status)}</Chip>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setRemoving(r)} aria-label={t('soulseek.removeDownload', { title: r.albumTitle })}>
          {t('common.remove')}
        </Button>
      ),
    },
  ];
  return (
    <div className="al-dc-soulseek__downloads">
      <h3 className="al-label">{t('soulseek.downloads')}</h3>
      {downloads.isError ? (
        <ErrorBlock title={t('soulseek.couldntLoadDownloads')} onRetry={() => void downloads.refetch()}>
          {errorMessage(downloads.error)}
        </ErrorBlock>
      ) : (
        <Table
          columns={columns}
          rows={downloads.data}
          rowKey={(r) => r.id}
          loading={downloads.isPending}
          density="dense"
          caption={t('soulseek.downloads')}
          empty={t('soulseek.noDownloads')}
        />
      )}
      {removing ? (
        <ConfirmDialog
          open
          title={t('soulseek.removeTitle')}
          confirmLabel={t('common.remove')}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await remove.mutateAsync(removing.id);
            setRemoving(null);
          }}
        >
          {t('soulseek.removeBody', { title: removing.albumTitle })}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
