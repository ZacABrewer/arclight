import { useEffect, useMemo, useState } from 'react';
import {
  AUDIBLE_REGION_TLD,
  AUDNEXUS_DEFAULT_BASE_URL,
  AudibleRegion,
  type AudiobookMetadataSettingsResponse,
  type AudiobookMetadataSettingsUpdate,
} from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, Skeleton } from '../../../arclight/index.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldErrors, FormValues } from '../../../components/forms/types.js';
import { useToast } from '../../../components/toast.js';
import { useAudiobookMetadataSettings, useSaveAudiobookMetadataSettings } from '../../../hooks/audiobooks.js';
import { useFeatures } from '../../../hooks/music.js';
import { countChanges } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

/** "United States (audible.com)". */
export const audibleRegionLabel = (region: AudibleRegion) =>
  t('audiobooks.settings.regionLabel', { country: t('audiobooks.settings.regionName', { region }), domain: `audible.${AUDIBLE_REGION_TLD[region]}` });

const rateField = (name: string, labelKey: string): FieldDefinition => ({
  name,
  get label() {
    return t(labelKey);
  },
  type: 'number',
  min: 0.1,
  max: 20,
  get unit() {
    return t('music.settings.perSecond');
  },
});

export const AUDIOBOOK_METADATA_FIELDS: FieldDefinition[] = [
  {
    name: 'audibleRegion',
    get label() {
      return t('audiobooks.settings.audibleRegion');
    },
    type: 'select',
    get options() {
      return AudibleRegion.options.map((r) => ({ value: r, label: audibleRegionLabel(r) }));
    },
    get helpText() {
      return t('audiobooks.settings.audibleRegionHelp');
    },
  },
  {
    name: 'audnexusBaseUrl',
    get label() {
      return t('audiobooks.settings.audnexusUrl');
    },
    type: 'text',
    required: true,
    placeholder: AUDNEXUS_DEFAULT_BASE_URL,
    get helpText() {
      return t('audiobooks.settings.audnexusUrlHelp');
    },
  },
  {
    name: 'openLibraryFallback',
    get label() {
      return t('audiobooks.settings.openLibraryFallback');
    },
    type: 'checkbox',
    get helpText() {
      return t('audiobooks.settings.openLibraryFallbackHelp');
    },
  },
  {
    name: 'languages',
    get label() {
      return t('audiobooks.settings.languages');
    },
    type: 'text',
    placeholder: 'english, german',
    get helpText() {
      return t('audiobooks.settings.languagesHelp');
    },
  },
  rateField('audnexusRateLimitPerSecond', 'audiobooks.settings.audnexusRate'),
  rateField('audibleRateLimitPerSecond', 'audiobooks.settings.audibleRate'),
  rateField('openLibraryRateLimitPerSecond', 'audiobooks.settings.openLibraryRate'),
];

const list = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

export function audiobookMetadataValues(data: AudiobookMetadataSettingsResponse): FormValues {
  return {
    audibleRegion: data.audibleRegion,
    audnexusBaseUrl: data.audnexusBaseUrl,
    openLibraryFallback: data.openLibraryFallback,
    languages: data.languages.join(', '),
    audnexusRateLimitPerSecond: data.audnexusRateLimitPerSecond,
    audibleRateLimitPerSecond: data.audibleRateLimitPerSecond,
    openLibraryRateLimitPerSecond: data.openLibraryRateLimitPerSecond,
  };
}

/** Form values -> PUT body (every field; the api merges onto the stored section). */
export function toAudiobookMetadataUpdate(values: FormValues): AudiobookMetadataSettingsUpdate {
  const region = AudibleRegion.safeParse(values.audibleRegion);
  return {
    ...(region.success ? { audibleRegion: region.data } : {}),
    audnexusBaseUrl: String(values.audnexusBaseUrl ?? '').trim() || AUDNEXUS_DEFAULT_BASE_URL,
    openLibraryFallback: values.openLibraryFallback === true,
    languages: list(values.languages),
    audnexusRateLimitPerSecond: Number(values.audnexusRateLimitPerSecond),
    audibleRateLimitPerSecond: Number(values.audibleRateLimitPerSecond),
    openLibraryRateLimitPerSecond: Number(values.openLibraryRateLimitPerSecond),
  };
}

export function audiobookMetadataErrors(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  try {
    const url = new URL(String(values.audnexusBaseUrl ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') errors.audnexusBaseUrl = t('music.settings.useAnHttpUrl');
  } catch {
    errors.audnexusBaseUrl = t('music.settings.useAnHttpUrl');
  }
  for (const k of ['audnexusRateLimitPerSecond', 'audibleRateLimitPerSecond', 'openLibraryRateLimitPerSecond']) {
    const rate = Number(values[k]);
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 20) errors[k] = t('audiobooks.settings.rateRange');
  }
  return errors;
}

/** Settings → General → Audiobook metadata (Audible region, Audnexus, OpenLibrary); its own Save. */
export function AudiobookMetadataSection() {
  const features = useFeatures();
  if (!features.audiobooks) return null;
  return <AudiobookMetadataForm />;
}

function AudiobookMetadataForm() {
  const settings = useAudiobookMetadataSettings();
  const save = useSaveAudiobookMetadataSettings();
  const toast = useToast();
  const saved = useMemo(() => (settings.data ? audiobookMetadataValues(settings.data) : null), [settings.data]);
  const [draft, setDraft] = useState<FormValues | null>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const errors = draft ? audiobookMetadataErrors(draft) : {};
  const invalid = Object.keys(errors).length > 0;
  const changes = draft && saved ? countChanges(saved, draft) : 0;

  return (
    <SettingsSection
      label={t('audiobooks.settings.audiobookMetadata')}
      action={
        <div className="mk-row">
          {changes > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              {t('common.discard')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={changes === 0 || invalid}
            loading={save.isPending}
            onClick={() =>
              draft && save.mutate(toAudiobookMetadataUpdate(draft), { onSuccess: () => toast.push({ tone: 'ok', title: t('audiobooks.settings.metadataSaved') }) })
            }
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      {settings.isPending ? (
        <Skeleton lines={4} />
      ) : settings.isError ? (
        <ErrorBlock title={t('audiobooks.settings.couldNotLoadMetadata')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : draft ? (
        <SchemaForm fields={AUDIOBOOK_METADATA_FIELDS} values={draft} onChange={setDraft} errors={errors} inline />
      ) : null}
    </SettingsSection>
  );
}
