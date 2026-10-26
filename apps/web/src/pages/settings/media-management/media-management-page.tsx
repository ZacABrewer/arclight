import { useEffect, useState, type ReactNode } from 'react';
import {
  ColonReplacement,
  MultiEpisodeStyle,
  NAMING_DEFAULTS,
  type MediaType,
  type NamingConfig,
  type NamingSample,
  type NamingSamples,
} from '@media-tron/shared';
import { ApiError } from '../../../api/client.js';
import { MEDIA_MANAGEMENT_DEFAULTS, FILE_DATE_MODES, type MediaManagementSettings } from '../../../api/settings.js';
import { Badge } from '../../../components/badge.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { EmptyState } from '../../../components/empty-state.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Input, Select, Toggle } from '../../../components/form.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useRootFolders } from '../../../hooks/library.js';
import {
  useAddRootFolder,
  useDeleteRootFolder,
  useMediaManagementSettings,
  useNamingConfig,
  useNamingSamples,
  useSaveMediaManagementSettings,
  useSaveNamingConfig,
} from '../../../hooks/settings.js';
import { formatBytes } from '../../activity/activity-shared.js';
import { PendingApiNotice, SaveError } from '../shared.js';

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

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

const FORMATS: Array<{ key: FormatKey; label: string; samples: Array<keyof NamingSamples>; group: 'series' | 'movie' }> = [
  { key: 'standardEpisodeFormat', label: 'Standard episode format', samples: ['singleEpisode', 'multiEpisode'], group: 'series' },
  { key: 'dailyEpisodeFormat', label: 'Daily episode format', samples: ['dailyEpisode'], group: 'series' },
  { key: 'animeEpisodeFormat', label: 'Anime episode format', samples: ['animeEpisode', 'animeMultiEpisode'], group: 'series' },
  { key: 'seriesFolderFormat', label: 'Series folder format', samples: ['seriesFolder'], group: 'series' },
  { key: 'seasonFolderFormat', label: 'Season folder format', samples: ['seasonFolder'], group: 'series' },
  { key: 'specialsFolderFormat', label: 'Specials folder format', samples: ['specialsFolder'], group: 'series' },
  { key: 'movieFormat', label: 'Movie format', samples: ['movie'], group: 'movie' },
  { key: 'movieFolderFormat', label: 'Movie folder format', samples: ['movieFolder'], group: 'movie' },
];

function Sample({ sample }: { sample: NamingSample | undefined }) {
  if (!sample) return null;
  if (sample.error) return <span className="text-error">{sample.error}</span>;
  return <code className="naming-sample">{sample.value ?? '—'}</code>;
}

function NamingCard() {
  const config = useNamingConfig();
  const save = useSaveNamingConfig();
  const [draft, setDraft] = useState<NamingConfig>(NAMING_DEFAULTS);
  useEffect(() => {
    if (config.data) setDraft(config.data);
  }, [config.data]);
  const debounced = useDebounced(draft);
  const samples = useNamingSamples(config.isPending ? undefined : debounced);
  const set = <K extends keyof NamingConfig>(k: K, v: NamingConfig[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const pending = isNotFound(config.error);

  const formatRow = (f: (typeof FORMATS)[number]): ReactNode => (
    <FormField
      key={f.key}
      inline
      label={f.label}
      hint={
        <span className="naming-samples">
          {f.samples.map((s) => (
            <Sample key={s} sample={samples.data?.[s]} />
          ))}
        </span>
      }
    >
      <Input className="input-mono input-wide" value={draft[f.key]} onChange={(e) => set(f.key, e.currentTarget.value)} />
    </FormField>
  );

  return (
    <Card
      title="Episode & movie naming"
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...NAMING_DEFAULTS, renameEpisodes: draft.renameEpisodes, renameMovies: draft.renameMovies })}>
            Reset formats
          </Button>
          <Button size="sm" variant="primary" loading={save.isPending} disabled={pending} onClick={() => save.mutate(draft)}>
            Save naming
          </Button>
        </>
      }
    >
      {config.isPending ? <LoadingBlock /> : null}
      {pending ? <PendingApiNotice what="naming settings" /> : config.isError ? <ErrorView error={config.error} /> : null}
      <FormField inline label="Rename episodes" hint="Off keeps the downloaded file name.">
        <Toggle checked={draft.renameEpisodes} onChange={(e) => set('renameEpisodes', e.currentTarget.checked)} />
      </FormField>
      <FormField inline label="Rename movies">
        <Toggle checked={draft.renameMovies} onChange={(e) => set('renameMovies', e.currentTarget.checked)} />
      </FormField>
      <FormField inline label="Replace illegal characters" hint="Off removes them instead.">
        <Toggle checked={draft.replaceIllegalCharacters} onChange={(e) => set('replaceIllegalCharacters', e.currentTarget.checked)} />
      </FormField>
      <FormField inline label="Colon replacement">
        <Select
          value={draft.colonReplacement}
          onChange={(e) => set('colonReplacement', ColonReplacement.parse(e.currentTarget.value))}
          options={ColonReplacement.options.map((o) => ({ value: o, label: COLON_LABELS[o] }))}
        />
      </FormField>
      {draft.colonReplacement === 'custom' ? (
        <FormField inline label="Custom colon replacement">
          <Input value={draft.customColonReplacement ?? ''} onChange={(e) => set('customColonReplacement', e.currentTarget.value)} />
        </FormField>
      ) : null}
      <FormField inline label="Multi-episode style">
        <Select
          value={draft.multiEpisodeStyle}
          onChange={(e) => set('multiEpisodeStyle', MultiEpisodeStyle.parse(e.currentTarget.value))}
          options={MultiEpisodeStyle.options.map((o) => ({ value: o, label: MULTI_LABELS[o] }))}
        />
      </FormField>
      <h3 className="section-title">Series</h3>
      {FORMATS.filter((f) => f.group === 'series').map(formatRow)}
      <h3 className="section-title">Movies</h3>
      {FORMATS.filter((f) => f.group === 'movie').map(formatRow)}
      {samples.isError && !isNotFound(samples.error) ? <SaveError error={samples.error} /> : null}
      <SaveError error={save.error} />
    </Card>
  );
}

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
  { name: 'skipFreeSpaceCheck', label: 'Skip free space check', type: 'checkbox', advanced: true },
  { name: 'minimumFreeSpaceMb', label: 'Minimum free space', type: 'number', unit: 'MB', min: 0, advanced: true, helpText: 'Refuse to import when less than this would be left.' },
  { name: 'useHardlinks', label: 'Use hardlinks instead of copy', type: 'checkbox', advanced: true, helpText: 'Hardlink torrents that are still seeding instead of copying them.' },
  { name: 'importExtraFiles', label: 'Import extra files', type: 'checkbox', helpText: 'Import matching extra files (subtitles, nfo, …).' },
  { name: 'extraFileExtensions', label: 'Extra file extensions', type: 'text', placeholder: 'srt,nfo', helpText: 'Comma-separated list of extensions to import.' },
  { name: 'downloadPropersAndRepacks', label: 'Propers and repacks', type: 'select', options: PROPERS },
];

export const FILE_FIELDS: FieldDefinition[] = [
  { name: 'createEmptySeriesFolders', label: 'Create empty series folders', type: 'checkbox', helpText: 'Create missing series folders during disk scan.' },
  { name: 'deleteEmptyFolders', label: 'Delete empty folders', type: 'checkbox', helpText: 'Remove empty series/season folders during disk scan.' },
  { name: 'enableMediaInfo', label: 'Analyse video files', type: 'checkbox', advanced: true, helpText: 'Read resolution, codecs and runtime from files.' },
  { name: 'rescanAfterRefresh', label: 'Rescan folder after refresh', type: 'select', options: ALWAYS_OPTIONS, advanced: true },
  { name: 'fileDateMode', label: 'Change file date', type: 'select', options: FILE_DATE_MODES, advanced: true },
  { name: 'recycleBinPath', label: 'Recycling bin', type: 'text', placeholder: '/data/.recycle', helpText: 'Deleted files go here instead of being removed.' },
  { name: 'recycleBinCleanupDays', label: 'Recycling bin cleanup', type: 'number', unit: 'days', min: 0, advanced: true, helpText: '0 disables automatic cleanup.' },
  { name: 'setPermissions', label: 'Set permissions', type: 'checkbox', advanced: true, helpText: 'Apply chmod/chown to imported files and folders (Linux).' },
  { name: 'chmodFolder', label: 'chmod folder', type: 'text', advanced: true, placeholder: '755' },
  { name: 'chownGroup', label: 'chown group', type: 'text', advanced: true },
];

function MediaManagementCard() {
  const settings = useMediaManagementSettings();
  const save = useSaveMediaManagementSettings();
  const [draft, setDraft] = useState<FormValues>(MEDIA_MANAGEMENT_DEFAULTS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  const pending = isNotFound(settings.error);

  return (
    <Card
      title="Importing & file management"
      actions={
        <Button size="sm" variant="primary" loading={save.isPending} disabled={pending} onClick={() => save.mutate(draft as MediaManagementSettings)}>
          Save
        </Button>
      }
    >
      {settings.isPending ? <LoadingBlock /> : null}
      {pending ? <PendingApiNotice what="media management settings" /> : settings.isError ? <ErrorView error={settings.error} /> : null}
      <h3 className="section-title">Importing</h3>
      <SchemaForm fields={IMPORT_FIELDS} values={draft} onChange={setDraft} inline showAdvanced={showAdvanced} onShowAdvancedChange={setShowAdvanced} />
      <h3 className="section-title">File management</h3>
      <SchemaForm fields={FILE_FIELDS} values={draft} onChange={setDraft} inline showAdvanced={showAdvanced} onShowAdvancedChange={setShowAdvanced} />
    </Card>
  );
}

function RootFoldersCard() {
  const folders = useRootFolders();
  const add = useAddRootFolder();
  const remove = useDeleteRootFolder();
  const [path, setPath] = useState('');
  const [mediaType, setMediaType] = useState<MediaType>('series');

  return (
    <Card title="Root folders" flush>
      {folders.isPending ? (
        <LoadingBlock />
      ) : folders.isError ? (
        <ErrorView error={folders.error} onRetry={() => void folders.refetch()} />
      ) : folders.data.length === 0 ? (
        <EmptyState title="No root folders">Add the folders your series and movies live in.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Type</th>
                <th className="align-right">Free space</th>
                <th className="align-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {folders.data.map((f) => (
                <tr key={f.id}>
                  <td>
                    <code>{f.path}</code> {f.accessible ? null : <Badge tone="error">inaccessible</Badge>}
                  </td>
                  <td>{f.mediaType === 'series' ? 'Series' : 'Movies'}</td>
                  <td className="align-right">{formatBytes(f.freeSpaceBytes)}</td>
                  <td className="align-right">
                    <Button size="sm" variant="danger" onClick={() => remove.mutate(f.id)} loading={remove.isPending && remove.variables === f.id}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* TODO(contract): there is no /filesystem browse route yet; switch this to a path picker when it lands. */}
      <form
        className="row card-footer-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) add.mutate({ path: path.trim(), mediaType }, { onSuccess: () => setPath('') });
        }}
      >
        <Input aria-label="Root folder path" placeholder="/data/media/tv" value={path} onChange={(e) => setPath(e.currentTarget.value)} />
        <Select
          aria-label="Media type"
          value={mediaType}
          onChange={(e) => setMediaType(e.currentTarget.value === 'movie' ? 'movie' : 'series')}
          options={[
            { value: 'series', label: 'Series' },
            { value: 'movie', label: 'Movies' },
          ]}
        />
        <Button type="submit" loading={add.isPending} disabled={!path.trim()}>
          Add root folder
        </Button>
      </form>
      <div className="card-footer-form">
        <SaveError error={add.error} />
      </div>
    </Card>
  );
}

export function MediaManagementPage() {
  return (
    <Page title="Media Management">
      <div className="stack">
        <NamingCard />
        <MediaManagementCard />
        <RootFoldersCard />
      </div>
    </Page>
  );
}
