import { useId, useState } from 'react';
import {
  ColonReplacement,
  MultiEpisodeStyle,
  NAMING_DEFAULTS,
  type MediaType,
  type NamingConfig,
  type RootFolder,
} from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { MEDIA_MANAGEMENT_DEFAULTS, FILE_DATE_MODES, type MediaManagementSettings } from '../../../api/settings.js';
import { Button, Chip, ErrorBlock, EmptyState, FormRow, Icon, Input, Meter, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { PathPickerDialog } from '../../../components/path-picker/index.js';
import { useRootFolders } from '../../../hooks/library.js';
import {
  useAddRootFolder,
  useDeleteRootFolder,
  useMediaManagementSettings,
  useNamingConfig,
  useSaveMediaManagementSettings,
  useSaveNamingConfig,
} from '../../../hooks/settings.js';
import { formatSize } from '../../../lib/format.js';
import { SettingsPage, countChanges, useDraft } from '../settings-layout.js';
import { PendingApiNotice, SaveError, SettingsSection } from '../shared.js';
import { previewCaption, type PreviewKind } from './naming-preview.js';
import { VersionNamingSection } from './version-naming.js';
import './media-management.css';
import { t } from '../../../i18n/index.js';

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

const COLON_LABELS: Record<ColonReplacement, string> = {
  get delete() {
    return t('common.delete');
  },
  get dash() {
    return t('settings.mediaManagement.replaceWithDash');
  },
  get spaceDash() {
    return t('settings.mediaManagement.replaceWithSpaceDash');
  },
  get spaceDashSpace() {
    return t('settings.mediaManagement.replaceWithSpaceDashSpace');
  },
  get smart() {
    return t('settings.mediaManagement.smartReplace');
  },
  get custom() {
    return t('common.custom');
  },
};

const MULTI_LABELS: Record<MultiEpisodeStyle, string> = {
  get extend() {
    return t('settings.mediaManagement.extendS01e010203');
  },
  get duplicate() {
    return t('settings.mediaManagement.duplicateS01e01S01e02');
  },
  get repeat() {
    return t('settings.mediaManagement.repeatS01e01e02e03');
  },
  get scene() {
    return t('settings.mediaManagement.sceneS01e01E02E03');
  },
  get range() {
    return t('settings.mediaManagement.rangeS01e0103');
  },
  get prefixedRange() {
    return t('settings.mediaManagement.prefixedRangeS01e01E03');
  },
};

type FormatKey =
  | 'standardEpisodeFormat'
  | 'dailyEpisodeFormat'
  | 'animeEpisodeFormat'
  | 'seriesFolderFormat'
  | 'seasonFolderFormat'
  | 'specialsFolderFormat'
  | 'movieFormat'
  | 'movieFolderFormat';

export interface FormatRowDef {
  key: FormatKey;
  label: string;
  kind: PreviewKind;
  group: 'series' | 'movie';
  advanced?: boolean;
}

export const FORMATS: readonly FormatRowDef[] = [
  { key: 'standardEpisodeFormat', get label() { return t('settings.mediaManagement.standardEpisodeFormat'); }, kind: 'episode', group: 'series' },
  { key: 'dailyEpisodeFormat', get label() { return t('settings.mediaManagement.dailyEpisodeFormat'); }, kind: 'daily', group: 'series', advanced: true },
  { key: 'animeEpisodeFormat', get label() { return t('settings.mediaManagement.animeEpisodeFormat'); }, kind: 'anime', group: 'series', advanced: true },
  { key: 'seriesFolderFormat', get label() { return t('settings.mediaManagement.seriesFolderFormat'); }, kind: 'seriesFolder', group: 'series' },
  { key: 'seasonFolderFormat', get label() { return t('settings.mediaManagement.seasonFolderFormat'); }, kind: 'seasonFolder', group: 'series' },
  { key: 'specialsFolderFormat', get label() { return t('settings.mediaManagement.specialsFolderFormat'); }, kind: 'specialsFolder', group: 'series', advanced: true },
  { key: 'movieFormat', get label() { return t('settings.mediaManagement.movieFormat'); }, kind: 'movie', group: 'movie' },
  { key: 'movieFolderFormat', get label() { return t('settings.mediaManagement.movieFolderFormat'); }, kind: 'movieFolder', group: 'movie' },
];

const PROPERS = [
  { value: 'preferAndUpgrade', get label() { return t('settings.mediaManagement.preferAndUpgrade'); } },
  { value: 'doNotUpgrade', get label() { return t('settings.mediaManagement.doNotUpgradeAutomatically'); } },
  { value: 'doNotPrefer', get label() { return t('settings.mediaManagement.doNotPrefer'); } },
];
const ALWAYS_OPTIONS = [
  { value: 'always', get label() { return t('settings.mediaManagement.always'); } },
  { value: 'afterManual', get label() { return t('settings.mediaManagement.afterManualRefresh'); } },
  { value: 'never', get label() { return t('common.never'); } },
];
const TITLE_REQUIRED = [
  { value: 'always', get label() { return t('settings.mediaManagement.always'); } },
  { value: 'bulkSeasonReleases', get label() { return t('settings.mediaManagement.onlyForBulkSeasonReleases'); } },
  { value: 'never', get label() { return t('common.never'); } },
];

export const IMPORT_FIELDS: FieldDefinition[] = [
  { name: 'episodeTitleRequired', get label() { return t('settings.mediaManagement.episodeTitleRequired'); }, type: 'select', options: TITLE_REQUIRED, get helpText() { return t('settings.mediaManagement.waitForTheEpisodeTitle'); } },
  { name: 'useHardlinks', get label() { return t('settings.mediaManagement.useHardlinksInsteadOfCopy'); }, type: 'checkbox', advanced: true, get helpText() { return t('settings.mediaManagement.hardlinkTorrentsThatAreStill'); } },
  { name: 'importExtraFiles', get label() { return t('settings.mediaManagement.importExtraFiles'); }, type: 'checkbox', get helpText() { return t('settings.mediaManagement.importMatchingExtraFilesSubtitles'); } },
  { name: 'extraFileExtensions', get label() { return t('settings.mediaManagement.extraFileExtensions'); }, type: 'text', placeholder: 'srt,nfo', get helpText() { return t('settings.mediaManagement.commaSeparatedListOfExtensions'); } },
  { name: 'skipFreeSpaceCheck', get label() { return t('settings.mediaManagement.skipFreeSpaceCheck'); }, type: 'checkbox', advanced: true },
  { name: 'minimumFreeSpaceMb', get label() { return t('settings.mediaManagement.minimumFreeSpace'); }, type: 'number', unit: 'MB', min: 0, advanced: true, get helpText() { return t('settings.mediaManagement.refuseToImportWhenLess'); } },
  { name: 'stalledDownloadMinutes', get label() { return t('settings.mediaManagement.stalledDownloadMinutes'); }, type: 'number', unit: 'min', min: 0, max: 1440, get helpText() { return t('settings.mediaManagement.stalledDownloadHelp'); } },
];

export const PROPER_FIELDS: FieldDefinition[] = [
  { name: 'downloadPropersAndRepacks', get label() { return t('settings.mediaManagement.propersAndRepacks'); }, type: 'select', options: PROPERS, get helpText() { return t('settings.mediaManagement.howAProperOrRepack'); } },
];

export const FILE_FIELDS: FieldDefinition[] = [
  { name: 'createEmptySeriesFolders', get label() { return t('settings.mediaManagement.createEmptySeriesFolders'); }, type: 'checkbox', get helpText() { return t('settings.mediaManagement.createMissingSeriesFoldersDuring'); } },
  { name: 'deleteEmptyFolders', get label() { return t('settings.mediaManagement.deleteEmptyFolders'); }, type: 'checkbox', get helpText() { return t('settings.mediaManagement.removeEmptySeriesAndSeason'); } },
  { name: 'enableMediaInfo', get label() { return t('settings.mediaManagement.analyseVideoFiles'); }, type: 'checkbox', advanced: true, get helpText() { return t('settings.mediaManagement.readResolutionCodecsAndRuntime'); } },
  { name: 'rescanAfterRefresh', get label() { return t('settings.mediaManagement.rescanFolderAfterRefresh'); }, type: 'select', options: ALWAYS_OPTIONS, advanced: true },
  { name: 'fileDateMode', get label() { return t('settings.mediaManagement.changeFileDate'); }, type: 'select', options: FILE_DATE_MODES, advanced: true },
  { name: 'recycleBinPath', get label() { return t('settings.mediaManagement.recyclingBin'); }, type: 'text', placeholder: '/data/.recycle', get helpText() { return t('settings.mediaManagement.deletedFilesGoHereInstead'); } },
  { name: 'recycleBinCleanupDays', get label() { return t('settings.mediaManagement.recyclingBinCleanup'); }, type: 'number', unit: 'days', min: 0, advanced: true, get helpText() { return t('settings.mediaManagement.n0TurnsAutomaticCleanupOff'); } },
  { name: 'setPermissions', get label() { return t('settings.mediaManagement.setPermissions'); }, type: 'checkbox', advanced: true, get helpText() { return t('settings.mediaManagement.applyChmodAndChownTo'); } },
  { name: 'chmodFolder', get label() { return t('settings.mediaManagement.chmodFolder'); }, type: 'text', advanced: true, placeholder: '755' },
  { name: 'chownGroup', get label() { return t('settings.mediaManagement.chownGroup'); }, type: 'text', advanced: true },
];

interface MediaDraft {
  naming: NamingConfig;
  settings: MediaManagementSettings;
}

// ---- naming rows -------------------------------------------------------------------------

function FormatRow({ def, value, disabled, onChange }: { def: FormatRowDef; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <FormRow label={def.label} htmlFor={id} caption={<span data-testid={`sample-${def.key}`}>{previewCaption(value, def.kind)}</span>} captionMono>
      <Input id={id} mono value={value} disabled={disabled} spellCheck={false} onChange={(e) => onChange(e.currentTarget.value)} />
    </FormRow>
  );
}

function ToggleRow({ label, caption, checked, disabled, onChange }: { label: string; caption: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id} captionInline>
      <Toggle id={id} checked={checked} disabled={disabled} label={caption} onChange={(e) => onChange(e.currentTarget.checked)} />
    </FormRow>
  );
}

function SelectRow<V extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: V;
  options: Array<{ value: V; label: string }>;
  disabled?: boolean;
  onChange: (v: V) => void;
}) {
  const id = useId();
  return (
    <FormRow label={label} htmlFor={id}>
      <Select id={id} className="al-mm-select" value={value} disabled={disabled} options={options} onChange={(e) => onChange(e.currentTarget.value as V)} />
    </FormRow>
  );
}

function NamingSections({
  value,
  set,
  advanced,
  disabled,
}: {
  value: NamingConfig;
  set: <K extends keyof NamingConfig>(k: K, v: NamingConfig[K]) => void;
  advanced: boolean;
  disabled: boolean;
}) {
  const customId = useId();
  const rows = (group: 'series' | 'movie') =>
    FORMATS.filter((f) => f.group === group && (advanced || !f.advanced)).map((f) => (
      <FormatRow key={f.key} def={f} value={value[f.key]} disabled={disabled} onChange={(v) => set(f.key, v)} />
    ));
  return (
    <>
      <SettingsSection label={t('settings.mediaManagement.episodeNaming')}>
        <div className="al-mm-rows">
          <ToggleRow
            label={t('settings.mediaManagement.renameEpisodes')}
            caption={t('settings.mediaManagement.renameImportedFilesUsingThe')}
            checked={value.renameEpisodes}
            disabled={disabled}
            onChange={(v) => set('renameEpisodes', v)}
          />
          {rows('series')}
          <SelectRow
            label={t('settings.mediaManagement.multiEpisodeStyle')}
            value={value.multiEpisodeStyle}
            disabled={disabled}
            options={MultiEpisodeStyle.options.map((o) => ({ value: o, label: MULTI_LABELS[o] }))}
            onChange={(v) => set('multiEpisodeStyle', MultiEpisodeStyle.parse(v))}
          />
          {advanced ? (
            <>
              <ToggleRow
                label={t('settings.mediaManagement.replaceIllegalCharacters')}
                caption={t('settings.mediaManagement.offRemovesThemInstead')}
                checked={value.replaceIllegalCharacters}
                disabled={disabled}
                onChange={(v) => set('replaceIllegalCharacters', v)}
              />
              <SelectRow
                label={t('settings.mediaManagement.colonReplacement')}
                value={value.colonReplacement}
                disabled={disabled}
                options={ColonReplacement.options.map((o) => ({ value: o, label: COLON_LABELS[o] }))}
                onChange={(v) => set('colonReplacement', ColonReplacement.parse(v))}
              />
              {value.colonReplacement === 'custom' ? (
                <FormRow label={t('settings.mediaManagement.customColonReplacement')} htmlFor={customId}>
                  <Input
                    id={customId}
                    mono
                    className="al-mm-short"
                    value={value.customColonReplacement ?? ''}
                    disabled={disabled}
                    onChange={(e) => set('customColonReplacement', e.currentTarget.value)}
                  />
                </FormRow>
              ) : null}
            </>
          ) : null}
        </div>
      </SettingsSection>
      <SettingsSection label={t('settings.mediaManagement.movieNaming')}>
        <div className="al-mm-rows">
          <ToggleRow
            label={t('settings.mediaManagement.renameMovies')}
            caption={t('settings.mediaManagement.renameImportedFilesUsingThe')}
            checked={value.renameMovies}
            disabled={disabled}
            onChange={(v) => set('renameMovies', v)}
          />
          {rows('movie')}
        </div>
      </SettingsSection>
      <VersionNamingSection value={value} set={set} disabled={disabled} />
    </>
  );
}

// ---- root folders ------------------------------------------------------------------------

/** Below this much free space the meter and value turn orange (needs attention). */
export const LOW_FREE_BYTES = 100 * 1024 ** 3;

export function RootFolderRow({ folder, maxFree, onRemove }: { folder: RootFolder; maxFree: number; onRemove: () => void }) {
  const free = folder.freeSpaceBytes ?? null;
  const low = free !== null && free < LOW_FREE_BYTES;
  // The api reports free space only (no total), so the bar compares the folders with each other.
  const pct = free === null || maxFree <= 0 ? 0 : (free / maxFree) * 100;
  return (
    <li className="al-row-list__row al-root-row" data-testid="root-folder-row">
      <span className="al-root-row__path">
        <span className="al-num al-root-row__path-text">{folder.path}</span>
        {folder.accessible ? null : (
          <Chip tone="danger" dot="none">
            {t('common.notReachable')}
          </Chip>
        )}
      </span>
      <span className="al-root-row__kind">{folder.mediaType === 'series' ? t('common.series') : t('common.movies')}</span>
      <Meter
        value={pct}
        tone={low ? 'warn' : 'default'}
        label={t('settings.mediaManagement.freeSpaceOnPath', { path: folder.path })}
        valueText={<span className="al-num">{free === null ? '—' : t('settings.mediaManagement.sizeFree', { size: formatSize(free) })}</span>}
      />
      <Button variant="danger" size="sm" icon={<Icon name="close" />} aria-label={t('settings.mediaManagement.removePath', { path: folder.path })} onClick={onRemove} className="al-root-row__remove" />
    </li>
  );
}

function RootFoldersSection() {
  const folders = useRootFolders();
  const add = useAddRootFolder();
  const remove = useDeleteRootFolder();
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState<{ path: string; mediaType: MediaType } | null>(null);
  const [removing, setRemoving] = useState<RootFolder | null>(null);
  const kindId = useId();

  const list = folders.data ?? [];
  const maxFree = Math.max(0, ...list.map((f) => f.freeSpaceBytes ?? 0));

  return (
    <SettingsSection
      label={t('common.rootFolders')}
      action={
        <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
          {t('settings.mediaManagement.addRootFolder')}
        </Button>
      }
    >
      {folders.isPending ? (
        <Skeleton lines={2} />
      ) : folders.isError ? (
        <ErrorBlock title={t('settings.mediaManagement.couldntLoadRootFolders')} onRetry={() => void folders.refetch()}>
          {errorMessage(folders.error)}
        </ErrorBlock>
      ) : list.length === 0 && !pending ? (
        <EmptyState title={t('settings.mediaManagement.noRootFoldersYet')}>{t('settings.mediaManagement.addTheFoldersYourSeries')}</EmptyState>
      ) : (
        <ul className="al-row-list al-root-list" aria-label={t('common.rootFolders')}>
          {list.map((f) => (
            <RootFolderRow key={f.id} folder={f} maxFree={maxFree} onRemove={() => setRemoving(f)} />
          ))}
          {pending ? (
            <li className="al-row-list__row al-root-row--pending">
              <span className="al-num al-root-row__path-text">{pending.path}</span>
              <span className="al-root-row__kind">
                <label className="al-sr-only" htmlFor={kindId}>
                  {t('common.mediaType')}
                </label>
                <Select
                  id={kindId}
                  value={pending.mediaType}
                  onChange={(e) => setPending({ ...pending, mediaType: e.currentTarget.value === 'movie' ? 'movie' : 'series' })}
                  options={[
                    { value: 'series', label: t('common.series') },
                    { value: 'movie', label: t('common.movies') },
                  ]}
                />
              </span>
              <span className="al-root-row__pending-actions">
                <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={add.isPending}
                  onClick={() => add.mutate({ path: pending.path, mediaType: pending.mediaType }, { onSuccess: () => setPending(null) })}
                >
                  {t('common.add')}
                </Button>
              </span>
            </li>
          ) : null}
        </ul>
      )}
      <SaveError error={add.error} />
      <PathPickerDialog
        open={picking}
        title={t('common.chooseARootFolder')}
        onClose={() => setPicking(false)}
        onSelect={(path) => {
          setPicking(false);
          setPending({ path, mediaType: 'series' });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={removing ? t('settings.mediaManagement.removePath2', { path: removing.path }) : t('settings.mediaManagement.removeRootFolder')}
        confirmLabel={t('settings.mediaManagement.removeRootFolder2')}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.id);
          setRemoving(null);
        }}
      >
        <p>{t('settings.mediaManagement.arclightStopsUsingThisFolder')}</p>
      </ConfirmDialog>
    </SettingsSection>
  );
}

// ---- page --------------------------------------------------------------------------------

export function MediaManagementPage() {
  const naming = useNamingConfig();
  const settings = useMediaManagementSettings();
  const saveNaming = useSaveNamingConfig();
  const saveSettings = useSaveMediaManagementSettings();
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  const saved: MediaDraft = { naming: naming.data ?? NAMING_DEFAULTS, settings: settings.data ?? MEDIA_MANAGEMENT_DEFAULTS };
  const draft = useDraft(saved);
  const namingMissing = isNotFound(naming.error);
  const settingsMissing = isNotFound(settings.error);
  const namingReady = naming.isSuccess;
  const settingsReady = settings.isSuccess;

  const setNaming = <K extends keyof NamingConfig>(k: K, v: NamingConfig[K]) => draft.set((d) => ({ ...d, naming: { ...d.naming, [k]: v } }));
  const setSettings = (values: FormValues) => draft.set((d) => ({ ...d, settings: values as MediaManagementSettings }));

  const onSave = async () => {
    setSaving(true);
    try {
      const jobs: Promise<unknown>[] = [];
      if (namingReady && countChanges(saved.naming, draft.value.naming) > 0) jobs.push(saveNaming.mutateAsync(draft.value.naming));
      if (settingsReady && countChanges(saved.settings, draft.value.settings) > 0) jobs.push(saveSettings.mutateAsync(draft.value.settings));
      await Promise.all(jobs);
    } catch {
      // The mutation hooks toast the error; the bar stays so the user can retry or discard.
    } finally {
      setSaving(false);
    }
  };

  const settingsBody = (fields: FieldDefinition[]) => (
    <SchemaForm fields={fields} values={draft.value.settings} onChange={setSettings} inline showAdvanced={advanced} onShowAdvancedChange={setAdvanced} />
  );

  return (
    <SettingsPage
      title={t('common.mediaManagement')}
      advanced={{ value: advanced, onChange: setAdvanced }}
      save={{ count: draft.changes, onSave: () => void onSave(), onDiscard: draft.discard, saving }}
    >
      {naming.isPending ? <Skeleton lines={4} /> : null}
      {namingMissing ? (
        <PendingApiNotice what={t('settings.mediaManagement.namingSettings')} />
      ) : naming.isError ? (
        <ErrorBlock title={t('settings.mediaManagement.couldntLoadNamingSettings')} onRetry={() => void naming.refetch()}>
          {errorMessage(naming.error)}
        </ErrorBlock>
      ) : null}
      {namingReady ? <NamingSections value={draft.value.naming} set={setNaming} advanced={advanced} disabled={saving} /> : null}

      <RootFoldersSection />

      {settings.isPending ? <Skeleton lines={4} /> : null}
      {settingsMissing ? (
        <PendingApiNotice what={t('settings.mediaManagement.mediaManagementSettings')} />
      ) : settings.isError ? (
        <ErrorBlock title={t('settings.mediaManagement.couldntLoadMediaManagementSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : null}
      {settingsReady ? (
        <>
          <SettingsSection label={t('settings.mediaManagement.fileManagement')}>{settingsBody(FILE_FIELDS)}</SettingsSection>
          <SettingsSection label={t('status.importing')}>{settingsBody(IMPORT_FIELDS)}</SettingsSection>
          <SettingsSection label={t('settings.mediaManagement.propers')}>{settingsBody(PROPER_FIELDS)}</SettingsSection>
        </>
      ) : null}
    </SettingsPage>
  );
}
