import { useEffect, useMemo, useState } from 'react';
import { SUBTITLE_PROVIDER_IDS, type SubtitleSettings } from '@arclight/shared';
import { ApiError } from '../../../api/client.js';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { Select } from '../../../components/form.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldRendererProps, FieldRenderers, FormValues } from '../../../components/forms/types.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useToast } from '../../../components/toast.js';
import { useLanguageProfiles, useSaveSubtitleSettings, useSubtitleLanguages, useSubtitleSettings } from '../../../hooks/subtitles.js';
import { PendingApiNotice } from '../shared.js';
import { LanguageProfilesCard } from './language-profiles-card.js';
import { ProvidersCard } from './providers-card.js';

const DAY_MS = 24 * 3600 * 1000;

export const POST_PROCESSING_PLACEHOLDERS = [
  'directory',
  'episode',
  'episode_name',
  'subtitles',
  'subtitles_language',
  'subtitles_language_code2',
  'subtitles_language_code3',
  'score',
  'provider',
  'subtitle_id',
  'series_id',
  'episode_id',
] as const;

const PERCENT = { type: 'number', min: 0, max: 100, unit: '%' } as const;

export const GENERAL_FIELDS: FieldDefinition[] = [
  { name: 'defaultSeriesProfileId', label: 'Default series profile', type: 'select', helpText: 'Given to new series when the add request names none.' },
  { name: 'defaultMovieProfileId', label: 'Default movie profile', type: 'select', helpText: 'Given to new movies when the add request names none.' },
  { name: 'search.batchSize', label: 'Search batch size', type: 'number', min: 1, max: 1000, helpText: 'Items searched per wanted-subtitles run (every 15 minutes).' },
  { name: 'search.searchOnImport', label: 'Search on import', type: 'checkbox' },
  { name: 'search.onlyMonitored', label: 'Only monitored', type: 'checkbox', helpText: 'Automatic searches skip unmonitored items.' },
  { name: 'search.adaptiveSearching', label: 'Adaptive searching', type: 'checkbox', helpText: 'Search less often for items that keep failing.' },
  { name: 'search.adaptiveDelayMs', label: 'Adaptive delay', type: 'number', min: 0, unit: 'days', scale: DAY_MS, helpText: 'Search every run for this long after the first attempt.' },
  { name: 'search.adaptiveDeltaMs', label: 'Adaptive interval', type: 'number', min: 0, unit: 'days', scale: DAY_MS, helpText: 'Afterwards, search once per this interval.' },
  { name: 'search.useSceneName', label: 'Use scene name', type: 'checkbox', advanced: true },
  { name: 'search.concurrentProviders', label: 'Query providers concurrently', type: 'checkbox', advanced: true },
  { name: 'minimumScore.series', label: 'Minimum score (episodes)', ...PERCENT },
  { name: 'minimumScore.movie', label: 'Minimum score (movies)', ...PERCENT },
  { name: 'upgrade.enabled', label: 'Upgrade subtitles', type: 'checkbox' },
  { name: 'upgrade.windowDays', label: 'Upgrade window', type: 'number', min: 0, max: 30, unit: 'days' },
  { name: 'upgrade.includeManual', label: 'Upgrade manual downloads', type: 'checkbox' },
  {
    name: 'embedded.mode',
    label: 'Embedded subtitles',
    type: 'select',
    options: [
      { value: 'present', label: 'Count as present' },
      { value: 'ignore', label: 'Ignore' },
      { value: 'extract', label: 'Extract text tracks to files' },
    ],
  },
  { name: 'embedded.ignorePgs', label: 'Ignore PGS', type: 'checkbox' },
  { name: 'embedded.ignoreVobsub', label: 'Ignore VobSub', type: 'checkbox' },
  { name: 'embedded.ignoreAss', label: 'Ignore ASS', type: 'checkbox' },
  { name: 'embedded.undefinedLanguage', label: 'Undefined track language', type: 'select', helpText: 'Language assumed for embedded tracks tagged "und".' },
  { name: 'embedded.ffprobePath', label: 'ffprobe path', type: 'text', advanced: true },
  { name: 'embedded.ffmpegPath', label: 'ffmpeg path', type: 'text', advanced: true },
  {
    name: 'naming.hiExtension',
    label: 'Hearing-impaired suffix',
    type: 'select',
    options: [
      { value: 'hi', label: '.hi' },
      { value: 'cc', label: '.cc' },
      { value: 'sdh', label: '.sdh' },
    ],
  },
  { name: 'naming.singleLanguage', label: 'Single language', type: 'checkbox', helpText: 'Omit the language from file names (one-language profiles only).' },
  {
    name: 'naming.folder',
    label: 'Subtitle folder',
    type: 'select',
    options: [
      { value: 'current', label: 'Next to the video' },
      { value: 'relative', label: 'Subfolder of the video folder' },
      { value: 'absolute', label: 'Absolute folder' },
    ],
  },
  { name: 'naming.folderPath', label: 'Folder path', type: 'text', helpText: 'Subfolder name or absolute folder, for the two folder modes above.' },
  { name: 'naming.utf8Encode', label: 'Encode as UTF-8', type: 'checkbox' },
  { name: 'hearingImpaired.detectFromContent', label: 'Detect HI from content', type: 'checkbox', helpText: 'Bracketed cues or music symbols mark a subtitle HI.' },
  { name: 'notifyManualActions', label: 'Notify on manual actions', type: 'checkbox', helpText: 'Send notifications for manual downloads and uploads too.' },
];

export const SYNC_FIELDS: FieldDefinition[] = [
  { name: 'sync.enabled', label: 'Sync subtitles', type: 'checkbox', helpText: 'Align downloaded subtitles to the audio.' },
  {
    name: 'sync.tool',
    label: 'Sync tool',
    type: 'select',
    options: [
      { value: 'ffsubsync', label: 'ffsubsync' },
      { value: 'alass', label: 'alass' },
    ],
  },
  { name: 'sync.binaryPath', label: 'Binary path', type: 'text', helpText: 'Empty uses the tool name from PATH.' },
  { name: 'sync.maxOffsetSeconds', label: 'Max offset', type: 'number', min: 1, max: 3600, unit: 's' },
  { name: 'sync.gss', label: 'Golden-section search', type: 'checkbox' },
  { name: 'sync.noFixFramerate', label: 'Do not fix framerate', type: 'checkbox' },
  { name: 'sync.useThresholdSeries', label: 'Only sync episodes below a score', type: 'checkbox' },
  { name: 'sync.thresholdSeries', label: 'Episode threshold', ...PERCENT },
  { name: 'sync.useThresholdMovie', label: 'Only sync movies below a score', type: 'checkbox' },
  { name: 'sync.thresholdMovie', label: 'Movie threshold', ...PERCENT },
  {
    name: 'sync.blacklistedProviders',
    label: 'Never sync subtitles from',
    type: 'multiSelect',
    options: SUBTITLE_PROVIDER_IDS.map((id) => ({ value: id, label: id })),
  },
  { name: 'sync.timeoutMs', label: 'Sync timeout', type: 'number', min: 1, unit: 's', scale: 1000 },
];

export const POST_PROCESSING_FIELDS: FieldDefinition[] = [
  { name: 'postProcessing.enabled', label: 'Run post-processing', type: 'checkbox' },
  { name: 'postProcessing.command', label: 'Command', type: 'text', placeholder: '/scripts/notify.sh "{{subtitles}}" {{subtitles_language}}' },
  { name: 'postProcessing.useThresholdSeries', label: 'Only for episodes below a score', type: 'checkbox' },
  { name: 'postProcessing.thresholdSeries', label: 'Episode threshold', ...PERCENT },
  { name: 'postProcessing.useThresholdMovie', label: 'Only for movies below a score', type: 'checkbox' },
  { name: 'postProcessing.thresholdMovie', label: 'Movie threshold', ...PERCENT },
  { name: 'postProcessing.timeoutMs', label: 'Timeout', type: 'number', min: 1, unit: 's', scale: 1000 },
];

/** A select over nullable values: '' is null. */
function nullableSelect(options: Array<{ value: string; label: string }>, noneLabel: string, numeric: boolean) {
  return function NullableSelect({ id, value, onChange }: FieldRendererProps) {
    const current = value === null || value === undefined ? '' : String(value);
    const list = current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options;
    return (
      <Select id={id} value={current} onChange={(e) => onChange(e.currentTarget.value === '' ? null : numeric ? Number(e.currentTarget.value) : e.currentTarget.value)}>
        <option value="">{noneLabel}</option>
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  };
}

export function SubtitleSettingsPage() {
  const settings = useSubtitleSettings();
  const profiles = useLanguageProfiles();
  const languages = useSubtitleLanguages();
  const save = useSaveSubtitleSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<SubtitleSettings | null>(null);
  const pending = settings.error instanceof ApiError && settings.error.status === 404;

  useEffect(() => {
    if (settings.data && draft === null) setDraft(structuredClone(settings.data));
  }, [settings.data, draft]);

  const renderers = useMemo<FieldRenderers>(() => {
    const profileOptions = (profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name }));
    const languageOptions = (languages.data ?? []).map((l) => ({ value: l.code, label: l.name }));
    return {
      defaultSeriesProfileId: nullableSelect(profileOptions, 'None', true),
      defaultMovieProfileId: nullableSelect(profileOptions, 'None', true),
      'embedded.undefinedLanguage': nullableSelect(languageOptions, 'Skip undefined tracks', false),
    };
  }, [profiles.data, languages.data]);

  const dirty = draft !== null && settings.data !== undefined && JSON.stringify(draft) !== JSON.stringify(settings.data);
  const onChange = (next: FormValues) => setDraft(next as unknown as SubtitleSettings);
  const values = draft as unknown as FormValues;

  const actions = (
    <>
      <Button variant="ghost" disabled={!dirty} onClick={() => settings.data && setDraft(structuredClone(settings.data))}>
        Discard
      </Button>
      <Button
        variant="primary"
        disabled={!dirty}
        loading={save.isPending}
        onClick={() =>
          draft &&
          save.mutate(draft, {
            onSuccess: (saved) => {
              setDraft(structuredClone(saved));
              toast.push({ tone: 'ok', title: 'Subtitle settings saved' });
            },
          })
        }
      >
        Save
      </Button>
    </>
  );

  return (
    <Page title="Subtitles" subtitle="Language profiles, providers and how subtitles are searched, named and processed." actions={draft ? actions : undefined}>
      <LanguageProfilesCard />
      {settings.isPending ? (
        <LoadingBlock />
      ) : pending ? (
        <PendingApiNotice what="subtitle settings" />
      ) : settings.isError ? (
        <ErrorView error={settings.error} onRetry={() => void settings.refetch()} />
      ) : draft ? (
        <>
          <ProvidersCard providers={draft.providers} onChange={(providers) => setDraft({ ...draft, providers })} />
          <Card title="General">
            <SchemaForm fields={GENERAL_FIELDS} values={values} onChange={onChange} renderers={renderers} inline />
          </Card>
          <Card title="Sync">
            <SchemaForm fields={SYNC_FIELDS} values={values} onChange={onChange} inline />
          </Card>
          <Card title="Post-processing">
            <SchemaForm fields={POST_PROCESSING_FIELDS} values={values} onChange={onChange} inline />
            <div className="field-hint sub-placeholders">
              Placeholders:{' '}
              {POST_PROCESSING_PLACEHOLDERS.map((p) => (
                <code key={p}>{`{{${p}}}`}</code>
              ))}
            </div>
          </Card>
        </>
      ) : (
        <LoadingBlock />
      )}
    </Page>
  );
}
