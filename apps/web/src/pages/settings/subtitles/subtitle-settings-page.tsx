import { useMemo, useState } from 'react';
import { SUBTITLE_PROVIDER_IDS, type SubtitleSettings } from '@arclight/shared';
import { ApiError, errorMessage } from '../../../api/client.js';
import { ErrorBlock, Select, Skeleton } from '../../../arclight/index.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldRendererProps, FieldRenderers, FormValues } from '../../../components/forms/types.js';
import { useToast } from '../../../components/toast.js';
import { useLanguageProfiles, useSaveSubtitleSettings, useSubtitleLanguages, useSubtitleSettings } from '../../../hooks/subtitles.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { PendingApiNotice, SettingsSection } from '../shared.js';
import { LanguageProfilesCard } from './language-profiles-card.js';
import { ProvidersCard } from './providers-card.js';
import { WhisperStatusCard } from './whisper-status-card.js';
import './subtitle-settings.css';
import { t } from '../../../i18n/index.js';

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
  { name: 'defaultSeriesProfileId', get label() { return t('settings.subtitles.subtitleSettings.defaultSeriesProfile'); }, type: 'select', get helpText() { return t('settings.subtitles.subtitleSettings.givenToNewSeriesWhen'); } },
  { name: 'defaultMovieProfileId', get label() { return t('settings.subtitles.subtitleSettings.defaultMovieProfile'); }, type: 'select', get helpText() { return t('settings.subtitles.subtitleSettings.givenToNewMoviesWhen'); } },
  { name: 'search.batchSize', get label() { return t('settings.subtitles.subtitleSettings.searchBatchSize'); }, type: 'number', min: 1, max: 1000, get helpText() { return t('settings.subtitles.subtitleSettings.itemsSearchedPerWantedSubtitles'); } },
  { name: 'search.searchOnImport', get label() { return t('settings.subtitles.subtitleSettings.searchOnImport'); }, type: 'checkbox' },
  { name: 'search.onlyMonitored', get label() { return t('settings.subtitles.subtitleSettings.onlyMonitored'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.subtitleSettings.automaticSearchesSkipUnmonitoredItems'); } },
  { name: 'search.adaptiveSearching', get label() { return t('settings.subtitles.subtitleSettings.adaptiveSearching'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.subtitleSettings.searchLessOftenForItems'); } },
  { name: 'search.adaptiveDelayMs', get label() { return t('settings.subtitles.subtitleSettings.adaptiveDelay'); }, type: 'number', min: 0, unit: 'days', scale: DAY_MS, get helpText() { return t('settings.subtitles.subtitleSettings.searchEveryRunForThis'); } },
  { name: 'search.adaptiveDeltaMs', get label() { return t('settings.subtitles.subtitleSettings.adaptiveInterval'); }, type: 'number', min: 0, unit: 'days', scale: DAY_MS, get helpText() { return t('settings.subtitles.subtitleSettings.afterwardsSearchOncePerThis'); } },
  { name: 'search.useSceneName', get label() { return t('settings.subtitles.subtitleSettings.useSceneName'); }, type: 'checkbox', advanced: true },
  { name: 'search.concurrentProviders', get label() { return t('settings.subtitles.subtitleSettings.queryProvidersConcurrently'); }, type: 'checkbox', advanced: true },
  { name: 'minimumScore.series', get label() { return t('settings.subtitles.subtitleSettings.minimumScoreEpisodes'); }, ...PERCENT },
  { name: 'minimumScore.movie', get label() { return t('settings.subtitles.subtitleSettings.minimumScoreMovies'); }, ...PERCENT },
  { name: 'upgrade.enabled', get label() { return t('settings.subtitles.subtitleSettings.upgradeSubtitles'); }, type: 'checkbox' },
  { name: 'upgrade.windowDays', get label() { return t('settings.subtitles.subtitleSettings.upgradeWindow'); }, type: 'number', min: 0, max: 30, unit: 'days' },
  { name: 'upgrade.includeManual', get label() { return t('settings.subtitles.subtitleSettings.upgradeManualDownloads'); }, type: 'checkbox' },
  {
    name: 'embedded.mode',
    get label() {
      return t('settings.subtitles.subtitleSettings.embeddedSubtitles');
    },
    type: 'select',
    options: [
      { value: 'present', get label() { return t('settings.subtitles.subtitleSettings.countAsPresent'); } },
      { value: 'ignore', get label() { return t('settings.subtitles.subtitleSettings.ignore'); } },
      { value: 'extract', get label() { return t('settings.subtitles.subtitleSettings.extractTextTracksToFiles'); } },
    ],
  },
  { name: 'embedded.ignorePgs', get label() { return t('settings.subtitles.subtitleSettings.ignorePgs'); }, type: 'checkbox' },
  { name: 'embedded.ignoreVobsub', get label() { return t('settings.subtitles.subtitleSettings.ignoreVobsub'); }, type: 'checkbox' },
  { name: 'embedded.ignoreAss', get label() { return t('settings.subtitles.subtitleSettings.ignoreAss'); }, type: 'checkbox' },
  { name: 'embedded.undefinedLanguage', get label() { return t('settings.subtitles.subtitleSettings.undefinedTrackLanguage'); }, type: 'select', get helpText() { return t('settings.subtitles.subtitleSettings.languageAssumedForEmbeddedTracks'); } },
  { name: 'embedded.ffprobePath', get label() { return t('settings.subtitles.subtitleSettings.ffprobePath'); }, type: 'text', advanced: true },
  { name: 'embedded.ffmpegPath', get label() { return t('settings.subtitles.subtitleSettings.ffmpegPath'); }, type: 'text', advanced: true },
  {
    name: 'naming.hiExtension',
    get label() {
      return t('settings.subtitles.subtitleSettings.hearingImpairedSuffix');
    },
    type: 'select',
    options: [
      { value: 'hi', get label() { return t('settings.subtitles.subtitleSettings.hi'); } },
      { value: 'cc', get label() { return t('settings.subtitles.subtitleSettings.cc'); } },
      { value: 'sdh', get label() { return t('settings.subtitles.subtitleSettings.sdh'); } },
    ],
  },
  { name: 'naming.singleLanguage', get label() { return t('settings.subtitles.subtitleSettings.singleLanguage'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.subtitleSettings.omitTheLanguageFromFile'); } },
  {
    name: 'naming.folder',
    get label() {
      return t('settings.subtitles.subtitleSettings.subtitleFolder');
    },
    type: 'select',
    options: [
      { value: 'current', get label() { return t('settings.subtitles.subtitleSettings.nextToTheVideo'); } },
      { value: 'relative', get label() { return t('settings.subtitles.subtitleSettings.subfolderOfTheVideoFolder'); } },
      { value: 'absolute', get label() { return t('settings.subtitles.subtitleSettings.absoluteFolder'); } },
    ],
  },
  { name: 'naming.folderPath', get label() { return t('common.folderPath'); }, type: 'text', get helpText() { return t('settings.subtitles.subtitleSettings.subfolderNameOrAbsoluteFolder'); } },
  { name: 'naming.utf8Encode', get label() { return t('settings.subtitles.subtitleSettings.encodeAsUtf8'); }, type: 'checkbox' },
  { name: 'hearingImpaired.detectFromContent', get label() { return t('settings.subtitles.subtitleSettings.detectHiFromContent'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.subtitleSettings.bracketedCuesOrMusicSymbols'); } },
  { name: 'notifyManualActions', get label() { return t('settings.subtitles.subtitleSettings.notifyOnManualActions'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.subtitleSettings.sendNotificationsForManualDownloads'); } },
];

export const SYNC_FIELDS: FieldDefinition[] = [
  { name: 'sync.enabled', get label() { return t('settings.subtitles.subtitleSettings.syncSubtitles'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.subtitleSettings.alignDownloadedSubtitlesToThe'); } },
  {
    name: 'sync.tool',
    get label() {
      return t('settings.subtitles.subtitleSettings.syncTool');
    },
    type: 'select',
    options: [
      { value: 'ffsubsync', get label() { return t('settings.subtitles.subtitleSettings.ffsubsync'); } },
      { value: 'alass', get label() { return t('settings.subtitles.subtitleSettings.alass'); } },
    ],
  },
  { name: 'sync.binaryPath', get label() { return t('settings.subtitles.subtitleSettings.binaryPath'); }, type: 'text', get helpText() { return t('settings.subtitles.subtitleSettings.emptyUsesTheToolName'); } },
  { name: 'sync.maxOffsetSeconds', get label() { return t('settings.subtitles.subtitleSettings.maxOffset'); }, type: 'number', min: 1, max: 3600, unit: 's' },
  { name: 'sync.gss', get label() { return t('settings.subtitles.subtitleSettings.goldenSectionSearch'); }, type: 'checkbox' },
  { name: 'sync.noFixFramerate', get label() { return t('settings.subtitles.subtitleSettings.doNotFixFramerate'); }, type: 'checkbox' },
  { name: 'sync.useThresholdSeries', get label() { return t('settings.subtitles.subtitleSettings.onlySyncEpisodesBelowA'); }, type: 'checkbox' },
  { name: 'sync.thresholdSeries', get label() { return t('settings.subtitles.subtitleSettings.episodeThreshold'); }, ...PERCENT },
  { name: 'sync.useThresholdMovie', get label() { return t('settings.subtitles.subtitleSettings.onlySyncMoviesBelowA'); }, type: 'checkbox' },
  { name: 'sync.thresholdMovie', get label() { return t('settings.subtitles.subtitleSettings.movieThreshold'); }, ...PERCENT },
  {
    name: 'sync.blacklistedProviders',
    get label() {
      return t('settings.subtitles.subtitleSettings.neverSyncSubtitlesFrom');
    },
    type: 'multiSelect',
    options: SUBTITLE_PROVIDER_IDS.map((id) => ({ value: id, label: id })),
  },
  { name: 'sync.timeoutMs', get label() { return t('settings.subtitles.subtitleSettings.syncTimeout'); }, type: 'number', min: 1, unit: 's', scale: 1000 },
];

/** Sync-quality scoring (subtitles.sync.autoCheck ... checkBatchSize). */
export const SYNC_CHECK_FIELDS: FieldDefinition[] = [
  { name: 'sync.autoCheck', get label() { return t('settings.subtitles.syncCheck.autoCheck'); }, type: 'checkbox', get helpText() { return t('settings.subtitles.syncCheck.autoCheckHelp'); } },
  {
    name: 'sync.checkMethod',
    get label() {
      return t('settings.subtitles.syncCheck.checkMethod');
    },
    type: 'select',
    options: [
      { value: 'builtin', get label() { return t('settings.subtitles.syncCheck.methodBuiltin'); } },
      { value: 'tool', get label() { return t('settings.subtitles.syncCheck.methodTool'); } },
    ],
  },
  {
    name: 'sync.audioDetector',
    get label() {
      return t('settings.subtitles.syncCheck.audioDetector');
    },
    type: 'select',
    advanced: true,
    get helpText() {
      return t('settings.subtitles.syncCheck.audioDetectorHelp');
    },
    options: [
      { value: 'silencedetect', label: 'silencedetect' },
      { value: 'ebur128', label: 'ebur128' },
    ],
  },
  { name: 'sync.checkWindowMinutes', get label() { return t('settings.subtitles.syncCheck.checkWindow'); }, type: 'number', min: 1, max: 60, unit: 'min', get helpText() { return t('settings.subtitles.syncCheck.checkWindowHelp'); } },
  { name: 'sync.autoFixBelow', get label() { return t('settings.subtitles.syncCheck.autoFixBelow'); }, type: 'number', min: 0, max: 100, get helpText() { return t('settings.subtitles.syncCheck.autoFixBelowHelp'); } },
  { name: 'sync.autoRetryProviderBelow', get label() { return t('settings.subtitles.syncCheck.autoRetryProviderBelow'); }, type: 'number', min: 0, max: 100, get helpText() { return t('settings.subtitles.syncCheck.autoRetryProviderBelowHelp'); } },
  { name: 'sync.maxProviderRetries', get label() { return t('settings.subtitles.syncCheck.maxProviderRetries'); }, type: 'number', min: 0, max: 10 },
  { name: 'sync.checkBatchSize', get label() { return t('settings.subtitles.syncCheck.checkBatchSize'); }, type: 'number', min: 1, max: 500, advanced: true, get helpText() { return t('settings.subtitles.syncCheck.checkBatchSizeHelp'); } },
];

export const POST_PROCESSING_FIELDS: FieldDefinition[] = [
  { name: 'postProcessing.enabled', get label() { return t('settings.subtitles.subtitleSettings.runPostProcessing'); }, type: 'checkbox' },
  { name: 'postProcessing.command', get label() { return t('settings.subtitles.subtitleSettings.command'); }, type: 'text', get placeholder() { return t('settings.subtitles.subtitleSettings.scriptsNotifyShSubtitlesSubtitles'); } },
  { name: 'postProcessing.useThresholdSeries', get label() { return t('settings.subtitles.subtitleSettings.onlyForEpisodesBelowA'); }, type: 'checkbox' },
  { name: 'postProcessing.thresholdSeries', get label() { return t('settings.subtitles.subtitleSettings.episodeThreshold'); }, ...PERCENT },
  { name: 'postProcessing.useThresholdMovie', get label() { return t('settings.subtitles.subtitleSettings.onlyForMoviesBelowA'); }, type: 'checkbox' },
  { name: 'postProcessing.thresholdMovie', get label() { return t('settings.subtitles.subtitleSettings.movieThreshold'); }, ...PERCENT },
  { name: 'postProcessing.timeoutMs', get label() { return t('settings.subtitles.subtitleSettings.timeout'); }, type: 'number', min: 1, unit: 's', scale: 1000 },
];

/** A select over nullable values: '' is null. */
function nullableSelect(options: Array<{ value: string; label: string }>, noneLabel: string, numeric: boolean) {
  return function NullableSelect({ id, value, onChange }: FieldRendererProps) {
    const current = value === null || value === undefined ? '' : String(value);
    const list = current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options;
    return (
      <Select id={id} className="al-select--fit" value={current} onChange={(e) => onChange(e.currentTarget.value === '' ? null : numeric ? Number(e.currentTarget.value) : e.currentTarget.value)}>
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
  const draft = useDraft<SubtitleSettings | null>(settings.data ?? null);
  const [advanced, setAdvanced] = useState(false);
  const pending = settings.error instanceof ApiError && settings.error.status === 404;

  const renderers = useMemo<FieldRenderers>(() => {
    const profileOptions = (profiles.data ?? []).map((p) => ({ value: String(p.id), label: p.name }));
    const languageOptions = (languages.data ?? []).map((l) => ({ value: l.code, label: l.name }));
    return {
      defaultSeriesProfileId: nullableSelect(profileOptions, t('common.none'), true),
      defaultMovieProfileId: nullableSelect(profileOptions, t('common.none'), true),
      'embedded.undefinedLanguage': nullableSelect(languageOptions, t('settings.subtitles.skipUndefinedTracks'), false),
    };
  }, [profiles.data, languages.data]);

  const value = draft.value;
  const onChange = (next: FormValues) => draft.set(next as unknown as SubtitleSettings);
  const values = value as unknown as FormValues;

  const onSave = () => {
    if (!value) return;
    save.mutate(value, { onSuccess: () => toast.push({ tone: 'ok', title: t('settings.subtitles.subtitleSettings.subtitleSettingsSaved') }) });
  };

  return (
    <SettingsPage
      title={t('common.subtitles')}
      description={t('settings.subtitles.subtitleSettings.languageProfilesProvidersAndHow')}
      advanced={{ value: advanced, onChange: setAdvanced }}
      save={{ count: draft.changes, onSave, onDiscard: draft.discard, saving: save.isPending }}
    >
      <LanguageProfilesCard />
      {settings.isPending ? (
        <Skeleton lines={6} />
      ) : pending ? (
        <PendingApiNotice what={t('settings.subtitles.subtitleSettings.subtitleSettings')} />
      ) : settings.isError ? (
        <ErrorBlock title={t('settings.subtitles.subtitleSettings.couldNotLoadSubtitleSettings')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : value ? (
        <>
          <ProvidersCard providers={value.providers} showAdvanced={advanced} onChange={(providers) => draft.set((d) => (d ? { ...d, providers } : d))} />
          <WhisperStatusCard />
          <SettingsSection label={t('common.general')}>
            <SchemaForm fields={GENERAL_FIELDS} values={values} onChange={onChange} renderers={renderers} showAdvanced={advanced} inline />
          </SettingsSection>
          <SettingsSection label={t('settings.subtitles.subtitleSettings.sync')}>
            <SchemaForm fields={SYNC_FIELDS} values={values} onChange={onChange} showAdvanced={advanced} inline />
          </SettingsSection>
          <SettingsSection label={t('settings.subtitles.syncCheck.section')}>
            <SchemaForm fields={SYNC_CHECK_FIELDS} values={values} onChange={onChange} showAdvanced={advanced} inline />
          </SettingsSection>
          <SettingsSection label={t('settings.subtitles.subtitleSettings.postProcessing')}>
            <SchemaForm fields={POST_PROCESSING_FIELDS} values={values} onChange={onChange} showAdvanced={advanced} inline />
            <div className="al-placeholders">
              {t('settings.subtitles.subtitleSettings.placeholders')}
              {POST_PROCESSING_PLACEHOLDERS.map((p) => (
                <code key={p}>{`{{${p}}}`}</code>
              ))}
            </div>
          </SettingsSection>
        </>
      ) : (
        <Skeleton lines={6} />
      )}
    </SettingsPage>
  );
}
