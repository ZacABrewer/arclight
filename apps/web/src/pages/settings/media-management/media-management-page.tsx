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
import './media-management.css';

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

const COLON_LABELS: Record<ColonReplacement, string> = {
  delete: 'Delete',
  dash: 'Replace with dash',
  spaceDash: 'Replace with space dash',
  spaceDashSpace: 'Replace with space dash space',
  smart: 'Smart replace',
  custom: 'Custom',
};

const MULTI_LABELS: Record<MultiEpisodeStyle, string> = {
  extend: 'Extend (S01E01-02-03)',
  duplicate: 'Duplicate (S01E01.S01E02)',
  repeat: 'Repeat (S01E01E02E03)',
  scene: 'Scene (S01E01-E02-E03)',
  range: 'Range (S01E01-03)',
  prefixedRange: 'Prefixed range (S01E01-E03)',
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
  { key: 'standardEpisodeFormat', label: 'Standard episode format', kind: 'episode', group: 'series' },
  { key: 'dailyEpisodeFormat', label: 'Daily episode format', kind: 'daily', group: 'series', advanced: true },
  { key: 'animeEpisodeFormat', label: 'Anime episode format', kind: 'anime', group: 'series', advanced: true },
  { key: 'seriesFolderFormat', label: 'Series folder format', kind: 'seriesFolder', group: 'series' },
  { key: 'seasonFolderFormat', label: 'Season folder format', kind: 'seasonFolder', group: 'series' },
  { key: 'specialsFolderFormat', label: 'Specials folder format', kind: 'specialsFolder', group: 'series', advanced: true },
  { key: 'movieFormat', label: 'Movie format', kind: 'movie', group: 'movie' },
  { key: 'movieFolderFormat', label: 'Movie folder format', kind: 'movieFolder', group: 'movie' },
];

const PROPERS = [
  { value: 'preferAndUpgrade', label: 'Prefer and upgrade' },
  { value: 'doNotUpgrade', label: 'Do not upgrade automatically' },
  { value: 'doNotPrefer', label: 'Do not prefer' },
];
const ALWAYS_OPTIONS = [
  { value: 'always', label: 'Always' },
  { value: 'afterManual', label: 'After manual refresh' },
  { value: 'never', label: 'Never' },
];
const TITLE_REQUIRED = [
  { value: 'always', label: 'Always' },
  { value: 'bulkSeasonReleases', label: 'Only for bulk season releases' },
  { value: 'never', label: 'Never' },
];

export const IMPORT_FIELDS: FieldDefinition[] = [
  { name: 'episodeTitleRequired', label: 'Episode title required', type: 'select', options: TITLE_REQUIRED, helpText: 'Wait for the episode title before importing when the format uses it.' },
  { name: 'useHardlinks', label: 'Use hardlinks instead of copy', type: 'checkbox', advanced: true, helpText: 'Hardlink torrents that are still seeding instead of copying them.' },
  { name: 'importExtraFiles', label: 'Import extra files', type: 'checkbox', helpText: 'Import matching extra files (subtitles, nfo, …).' },
  { name: 'extraFileExtensions', label: 'Extra file extensions', type: 'text', placeholder: 'srt,nfo', helpText: 'Comma-separated list of extensions to import.' },
  { name: 'skipFreeSpaceCheck', label: 'Skip free space check', type: 'checkbox', advanced: true },
  { name: 'minimumFreeSpaceMb', label: 'Minimum free space', type: 'number', unit: 'MB', min: 0, advanced: true, helpText: 'Refuse to import when less than this would be left.' },
];

export const PROPER_FIELDS: FieldDefinition[] = [
  { name: 'downloadPropersAndRepacks', label: 'Propers and repacks', type: 'select', options: PROPERS, helpText: 'How a proper or repack of a file you already have is treated.' },
];

export const FILE_FIELDS: FieldDefinition[] = [
  { name: 'createEmptySeriesFolders', label: 'Create empty series folders', type: 'checkbox', helpText: 'Create missing series folders during disk scan.' },
  { name: 'deleteEmptyFolders', label: 'Delete empty folders', type: 'checkbox', helpText: 'Remove empty series and season folders during disk scan.' },
  { name: 'enableMediaInfo', label: 'Analyse video files', type: 'checkbox', advanced: true, helpText: 'Read resolution, codecs and runtime from files.' },
  { name: 'rescanAfterRefresh', label: 'Rescan folder after refresh', type: 'select', options: ALWAYS_OPTIONS, advanced: true },
  { name: 'fileDateMode', label: 'Change file date', type: 'select', options: FILE_DATE_MODES, advanced: true },
  { name: 'recycleBinPath', label: 'Recycling bin', type: 'text', placeholder: '/data/.recycle', helpText: 'Deleted files go here instead of being removed.' },
  { name: 'recycleBinCleanupDays', label: 'Recycling bin cleanup', type: 'number', unit: 'days', min: 0, advanced: true, helpText: '0 turns automatic cleanup off.' },
  { name: 'setPermissions', label: 'Set permissions', type: 'checkbox', advanced: true, helpText: 'Apply chmod and chown to imported files and folders (Linux).' },
  { name: 'chmodFolder', label: 'chmod folder', type: 'text', advanced: true, placeholder: '755' },
  { name: 'chownGroup', label: 'chown group', type: 'text', advanced: true },
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
      <SettingsSection label="Episode naming">
        <div className="al-mm-rows">
          <ToggleRow
            label="Rename episodes"
            caption="Rename imported files using the format below"
            checked={value.renameEpisodes}
            disabled={disabled}
            onChange={(v) => set('renameEpisodes', v)}
          />
          {rows('series')}
          <SelectRow
            label="Multi-episode style"
            value={value.multiEpisodeStyle}
            disabled={disabled}
            options={MultiEpisodeStyle.options.map((o) => ({ value: o, label: MULTI_LABELS[o] }))}
            onChange={(v) => set('multiEpisodeStyle', MultiEpisodeStyle.parse(v))}
          />
          {advanced ? (
            <>
              <ToggleRow
                label="Replace illegal characters"
                caption="Off removes them instead"
                checked={value.replaceIllegalCharacters}
                disabled={disabled}
                onChange={(v) => set('replaceIllegalCharacters', v)}
              />
              <SelectRow
                label="Colon replacement"
                value={value.colonReplacement}
                disabled={disabled}
                options={ColonReplacement.options.map((o) => ({ value: o, label: COLON_LABELS[o] }))}
                onChange={(v) => set('colonReplacement', ColonReplacement.parse(v))}
              />
              {value.colonReplacement === 'custom' ? (
                <FormRow label="Custom colon replacement" htmlFor={customId}>
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
      <SettingsSection label="Movie naming">
        <div className="al-mm-rows">
          <ToggleRow
            label="Rename movies"
            caption="Rename imported files using the format below"
            checked={value.renameMovies}
            disabled={disabled}
            onChange={(v) => set('renameMovies', v)}
          />
          {rows('movie')}
        </div>
      </SettingsSection>
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
            Not reachable
          </Chip>
        )}
      </span>
      <span className="al-root-row__kind">{folder.mediaType === 'series' ? 'Series' : 'Movies'}</span>
      <Meter
        value={pct}
        tone={low ? 'warn' : 'default'}
        label={`Free space on ${folder.path}`}
        valueText={<span className="al-num">{free === null ? '—' : `${formatSize(free)} free`}</span>}
      />
      <Button variant="danger" size="sm" icon={<Icon name="close" />} aria-label={`Remove ${folder.path}`} onClick={onRemove} className="al-root-row__remove" />
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
      label="Root folders"
      action={
        <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
          Add root folder
        </Button>
      }
    >
      {folders.isPending ? (
        <Skeleton lines={2} />
      ) : folders.isError ? (
        <ErrorBlock title="Couldn't load root folders" onRetry={() => void folders.refetch()}>
          {errorMessage(folders.error)}
        </ErrorBlock>
      ) : list.length === 0 && !pending ? (
        <EmptyState title="No root folders yet">Add the folders your series and movies live in.</EmptyState>
      ) : (
        <ul className="al-row-list al-root-list" aria-label="Root folders">
          {list.map((f) => (
            <RootFolderRow key={f.id} folder={f} maxFree={maxFree} onRemove={() => setRemoving(f)} />
          ))}
          {pending ? (
            <li className="al-row-list__row al-root-row--pending">
              <span className="al-num al-root-row__path-text">{pending.path}</span>
              <span className="al-root-row__kind">
                <label className="al-sr-only" htmlFor={kindId}>
                  Media type
                </label>
                <Select
                  id={kindId}
                  value={pending.mediaType}
                  onChange={(e) => setPending({ ...pending, mediaType: e.currentTarget.value === 'movie' ? 'movie' : 'series' })}
                  options={[
                    { value: 'series', label: 'Series' },
                    { value: 'movie', label: 'Movies' },
                  ]}
                />
              </span>
              <span className="al-root-row__pending-actions">
                <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={add.isPending}
                  onClick={() => add.mutate({ path: pending.path, mediaType: pending.mediaType }, { onSuccess: () => setPending(null) })}
                >
                  Add
                </Button>
              </span>
            </li>
          ) : null}
        </ul>
      )}
      <SaveError error={add.error} />
      <PathPickerDialog
        open={picking}
        title="Choose a root folder"
        onClose={() => setPicking(false)}
        onSelect={(path) => {
          setPicking(false);
          setPending({ path, mediaType: 'series' });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove ${removing.path}?` : 'Remove root folder?'}
        confirmLabel="Remove root folder"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.id);
          setRemoving(null);
        }}
      >
        <p>Arclight stops using this folder. Files on disk are not touched.</p>
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
      title="Media management"
      advanced={{ value: advanced, onChange: setAdvanced }}
      save={{ count: draft.changes, onSave: () => void onSave(), onDiscard: draft.discard, saving }}
    >
      {naming.isPending ? <Skeleton lines={4} /> : null}
      {namingMissing ? (
        <PendingApiNotice what="naming settings" />
      ) : naming.isError ? (
        <ErrorBlock title="Couldn't load naming settings" onRetry={() => void naming.refetch()}>
          {errorMessage(naming.error)}
        </ErrorBlock>
      ) : null}
      {namingReady ? <NamingSections value={draft.value.naming} set={setNaming} advanced={advanced} disabled={saving} /> : null}

      <RootFoldersSection />

      {settings.isPending ? <Skeleton lines={4} /> : null}
      {settingsMissing ? (
        <PendingApiNotice what="media management settings" />
      ) : settings.isError ? (
        <ErrorBlock title="Couldn't load media management settings" onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : null}
      {settingsReady ? (
        <>
          <SettingsSection label="File management">{settingsBody(FILE_FIELDS)}</SettingsSection>
          <SettingsSection label="Importing">{settingsBody(IMPORT_FIELDS)}</SettingsSection>
          <SettingsSection label="Propers">{settingsBody(PROPER_FIELDS)}</SettingsSection>
        </>
      ) : null}
    </SettingsPage>
  );
}
