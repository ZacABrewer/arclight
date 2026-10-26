import { useId } from 'react';
import { CrossSeedSettings, type DownloadClientResource, type Indexer } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, FormRow, FormSection, Input, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { MultiSelect } from '../../../components/multi-select.js';
import { PathInput } from '../../../components/path-picker/path-input.js';
import { useCrossSeedSettings, useSaveCrossSeedSettings } from '../../../hooks/cross-seed.js';
import { useDownloadClientList } from '../../../hooks/download-clients.js';
import { useIndexerList } from '../../../hooks/indexers.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { t } from '../../../i18n/index.js';

// Settings -> Cross-seed: GET/PUT /settings/crossseed (contract CrossSeedSettings). Number
// inputs are kept as text so they can be empty while typing; the body is validated with the
// shared schema before Save is enabled.

export interface CrossSeedDraft {
  enabled: boolean;
  indexerIds: number[];
  sizeTolerancePercent: string;
  onImport: boolean;
  schedule: string;
  excludeTags: number[];
  /** '' = first enabled client. */
  downloadClientId: string;
  category: string;
  linkDir: string;
  searchIntervalDays: string;
  maxPerRun: string;
}

export function toCrossSeedDraft(s: CrossSeedSettings): CrossSeedDraft {
  return {
    enabled: s.enabled,
    indexerIds: [...s.indexerIds],
    sizeTolerancePercent: String(s.sizeTolerancePercent),
    onImport: s.onImport,
    schedule: s.schedule,
    excludeTags: [...s.excludeTags],
    downloadClientId: s.downloadClientId === null ? '' : String(s.downloadClientId),
    category: s.category,
    linkDir: s.linkDir,
    searchIntervalDays: String(s.searchIntervalDays),
    maxPerRun: String(s.maxPerRun),
  };
}

const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

function fieldLabel(key: string): string {
  switch (key) {
    case 'sizeTolerancePercent':
      return t('settings.crossSeed.sizeTolerance');
    case 'schedule':
      return t('settings.crossSeed.schedule');
    case 'searchIntervalDays':
      return t('settings.crossSeed.searchInterval');
    case 'maxPerRun':
      return t('settings.crossSeed.maxPerRun');
    default:
      return key;
  }
}

/** Draft -> PUT body, or the first problem as a sentence. */
export function toCrossSeedBody(d: CrossSeedDraft): { ok: true; body: CrossSeedSettings } | { ok: false; error: string; field: string } {
  const parsed = CrossSeedSettings.safeParse({
    enabled: d.enabled,
    indexerIds: d.indexerIds,
    sizeTolerancePercent: num(d.sizeTolerancePercent),
    onImport: d.onImport,
    schedule: d.schedule,
    excludeTags: d.excludeTags,
    downloadClientId: d.downloadClientId === '' ? null : Number(d.downloadClientId),
    category: d.category,
    linkDir: d.linkDir,
    searchIntervalDays: num(d.searchIntervalDays),
    maxPerRun: num(d.maxPerRun),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  return { ok: false, field, error: t('settings.crossSeed.checkField', { field: fieldLabel(field) }) };
}

/** Torrent indexers only: cross-seeding never searches usenet. */
export function torrentIndexers(indexers: readonly Indexer[] | undefined) {
  return (indexers ?? []).filter((i) => i.protocol === 'torrent').map((i) => ({ value: i.id, label: i.name }));
}

/** Clients that can seed a cross-seed: the built-in engine and qBittorrent. */
export function seedingClients(clients: readonly DownloadClientResource[] | undefined) {
  return (clients ?? []).filter((c) => c.implementation === 'builtin' || c.implementation === 'qbittorrent');
}

function CrossSeedForm({ data }: { data: CrossSeedSettings }) {
  const draft = useDraft(toCrossSeedDraft(data));
  const d = draft.value;
  const save = useSaveCrossSeedSettings();
  const indexers = useIndexerList();
  const clients = useDownloadClientList();
  const set = <K extends keyof CrossSeedDraft>(key: K, value: CrossSeedDraft[K]) => draft.set((prev) => ({ ...prev, [key]: value }));
  const result = toCrossSeedBody(d);
  const invalid = result.ok ? null : result.field;
  const ids = {
    tolerance: useId(),
    schedule: useId(),
    client: useId(),
    category: useId(),
    linkDir: useId(),
    interval: useId(),
    max: useId(),
    tags: useId(),
  };

  return (
    <SettingsPage
      title={t('nav.crossSeed')}
      description={t('settings.crossSeed.description')}
      save={{
        count: draft.changes,
        onSave: () => {
          if (result.ok) save.mutate(result.body);
        },
        onDiscard: draft.discard,
        saving: save.isPending,
        disabled: !result.ok,
        label: result.ok ? undefined : result.error,
      }}
    >
      <form aria-label={t('settings.crossSeed.formLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 30 }} onSubmit={(e) => e.preventDefault()}>
        <FormSection label={t('settings.crossSeed.searching')}>
          <FormRow label={t('settings.crossSeed.enable')} caption={t('settings.crossSeed.enableCaption')} captionInline>
            <Toggle aria-label={t('settings.crossSeed.enable')} checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          </FormRow>
          <FormRow label={t('settings.crossSeed.onImport')} caption={t('settings.crossSeed.onImportCaption')} captionInline>
            <Toggle aria-label={t('settings.crossSeed.onImport')} checked={d.onImport} onChange={(e) => set('onImport', e.currentTarget.checked)} />
          </FormRow>
          <FormRow label={t('common.indexers')} caption={t('settings.crossSeed.indexersCaption')}>
            <MultiSelect
              label={t('common.indexers')}
              options={torrentIndexers(indexers.data)}
              value={d.indexerIds}
              onChange={(v) => set('indexerIds', v)}
              emptyLabel={t('settings.crossSeed.everyTorrentIndexer')}
            />
          </FormRow>
          <FormRow label={t('settings.crossSeed.sizeTolerance')} htmlFor={ids.tolerance} caption={t('settings.crossSeed.sizeToleranceCaption')}>
            <Input
              id={ids.tolerance}
              type="number"
              inputMode="decimal"
              mono
              className="al-input--num"
              end="%"
              min={0}
              max={10}
              step="0.1"
              invalid={invalid === 'sizeTolerancePercent'}
              value={d.sizeTolerancePercent}
              onChange={(e) => set('sizeTolerancePercent', e.currentTarget.value)}
            />
          </FormRow>
          <FormRow label={t('settings.crossSeed.excludeTags')} htmlFor={ids.tags} caption={t('settings.crossSeed.excludeTagsCaption')}>
            <TagPicker id={ids.tags} value={d.excludeTags} onChange={(v) => set('excludeTags', v)} />
          </FormRow>
        </FormSection>
        <FormSection label={t('settings.crossSeed.scheduleSection')}>
          <FormRow label={t('settings.crossSeed.schedule')} htmlFor={ids.schedule} caption={t('settings.crossSeed.scheduleCaption')}>
            <Input id={ids.schedule} mono spellCheck={false} invalid={invalid === 'schedule'} value={d.schedule} onChange={(e) => set('schedule', e.currentTarget.value)} />
          </FormRow>
          <FormRow label={t('settings.crossSeed.searchInterval')} htmlFor={ids.interval} caption={t('settings.crossSeed.searchIntervalCaption')}>
            <Input
              id={ids.interval}
              type="number"
              mono
              className="al-input--num"
              end={t('settings.crossSeed.days')}
              min={1}
              invalid={invalid === 'searchIntervalDays'}
              value={d.searchIntervalDays}
              onChange={(e) => set('searchIntervalDays', e.currentTarget.value)}
            />
          </FormRow>
          <FormRow label={t('settings.crossSeed.maxPerRun')} htmlFor={ids.max} caption={t('settings.crossSeed.maxPerRunCaption')}>
            <Input
              id={ids.max}
              type="number"
              mono
              className="al-input--num"
              min={1}
              invalid={invalid === 'maxPerRun'}
              value={d.maxPerRun}
              onChange={(e) => set('maxPerRun', e.currentTarget.value)}
            />
          </FormRow>
        </FormSection>
        <FormSection label={t('settings.crossSeed.seeding')}>
          <FormRow label={t('settings.crossSeed.downloadClient')} htmlFor={ids.client} caption={t('settings.crossSeed.downloadClientCaption')}>
            <Select
              id={ids.client}
              value={d.downloadClientId}
              onChange={(e) => set('downloadClientId', e.currentTarget.value)}
              options={[
                { value: '', label: t('settings.crossSeed.firstEnabledClient') },
                ...seedingClients(clients.data).map((c) => ({ value: String(c.id), label: c.name })),
              ]}
            />
          </FormRow>
          <FormRow label={t('settings.crossSeed.category')} htmlFor={ids.category} caption={t('settings.crossSeed.categoryCaption')}>
            <Input id={ids.category} mono value={d.category} onChange={(e) => set('category', e.currentTarget.value)} />
          </FormRow>
          <FormRow label={t('settings.crossSeed.linkFolder')} htmlFor={ids.linkDir} caption={t('settings.crossSeed.linkFolderCaption')}>
            <PathInput
              id={ids.linkDir}
              aria-label={t('settings.crossSeed.linkFolder')}
              placeholder={t('settings.crossSeed.linkFolderPlaceholder')}
              value={d.linkDir}
              onChange={(v) => set('linkDir', v)}
            />
          </FormRow>
        </FormSection>
      </form>
    </SettingsPage>
  );
}

export function CrossSeedSettingsPage() {
  const settings = useCrossSeedSettings();
  if (!settings.data) {
    return (
      <SettingsPage title={t('nav.crossSeed')}>
        {settings.isError ? (
          <ErrorBlock title={t('settings.crossSeed.couldNotLoad')} onRetry={() => void settings.refetch()}>
            {errorMessage(settings.error)}
          </ErrorBlock>
        ) : (
          <Skeleton lines={8} />
        )}
      </SettingsPage>
    );
  }
  return <CrossSeedForm data={settings.data} />;
}
