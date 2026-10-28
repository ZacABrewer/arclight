import { useEffect, useMemo, useState } from 'react';
import { MUSICBRAINZ_DEFAULT_BASE_URL, type MusicMetadataSettingsResponse, type MusicMetadataSettingsUpdate } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Button, ErrorBlock, Skeleton } from '../../../arclight/index.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldErrors, FormValues } from '../../../components/forms/types.js';
import { isMasked } from '../../../components/forms/values.js';
import { useToast } from '../../../components/toast.js';
import { useFeatures, useMusicMetadataSettings, useSaveMusicMetadataSettings } from '../../../hooks/music.js';
import { countChanges } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import { t } from '../../../i18n/index.js';

export const MUSIC_METADATA_FIELDS: FieldDefinition[] = [
  {
    name: 'baseUrl',
    get label() {
      return t('music.settings.musicBrainzUrl');
    },
    type: 'text',
    required: true,
    placeholder: MUSICBRAINZ_DEFAULT_BASE_URL,
    get helpText() {
      return t('music.settings.musicBrainzUrlHelp');
    },
  },
  {
    name: 'contactEmail',
    get label() {
      return t('music.settings.contactEmail');
    },
    type: 'text',
    get helpText() {
      return t('music.settings.contactEmailHelp');
    },
  },
  {
    name: 'rateLimitPerSecond',
    get label() {
      return t('music.settings.rateLimit');
    },
    type: 'number',
    min: 0.1,
    max: 50,
    get unit() {
      return t('music.settings.perSecond');
    },
    get helpText() {
      return t('music.settings.rateLimitHelp');
    },
  },
  {
    name: 'fanartApiKey',
    get label() {
      return t('music.settings.fanartKey');
    },
    type: 'password',
    get helpText() {
      return t('music.settings.fanartKeyHelp');
    },
  },
  {
    name: 'preferredCountries',
    get label() {
      return t('music.settings.preferredCountries');
    },
    type: 'text',
    placeholder: 'XW, US, GB',
    get helpText() {
      return t('music.settings.preferredCountriesHelp');
    },
  },
  {
    name: 'preferredFormats',
    get label() {
      return t('music.settings.preferredFormats');
    },
    type: 'text',
    placeholder: 'Digital Media, CD',
    get helpText() {
      return t('music.settings.preferredFormatsHelp');
    },
  },
];

const list = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function musicMetadataValues(data: MusicMetadataSettingsResponse): FormValues {
  return {
    baseUrl: data.baseUrl,
    contactEmail: data.contactEmail ?? '',
    rateLimitPerSecond: data.rateLimitPerSecond,
    fanartApiKey: data.fanartApiKey ?? '',
    preferredCountries: data.preferredCountries.join(', '),
    preferredFormats: data.preferredFormats.join(', '),
  };
}

/** Form values -> PUT body: the mask keeps the stored Fanart key, an emptied field clears it. */
export function toMusicMetadataUpdate(values: FormValues): MusicMetadataSettingsUpdate {
  const update: MusicMetadataSettingsUpdate = {
    baseUrl: String(values.baseUrl ?? '').trim() || MUSICBRAINZ_DEFAULT_BASE_URL,
    contactEmail: String(values.contactEmail ?? '').trim() || null,
    rateLimitPerSecond: Number(values.rateLimitPerSecond),
    preferredCountries: list(values.preferredCountries).map((c) => c.toUpperCase()),
    preferredFormats: list(values.preferredFormats),
  };
  const key = values.fanartApiKey;
  if (!isMasked(key)) update.fanartApiKey = typeof key === 'string' && key.trim() ? key.trim() : null;
  return update;
}

export function musicMetadataErrors(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  try {
    const url = new URL(String(values.baseUrl ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') errors.baseUrl = t('music.settings.useAnHttpUrl');
  } catch {
    errors.baseUrl = t('music.settings.useAnHttpUrl');
  }
  const email = String(values.contactEmail ?? '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.contactEmail = t('music.settings.useAnEmail');
  const rate = Number(values.rateLimitPerSecond);
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 50) errors.rateLimitPerSecond = t('music.settings.rateRange');
  if (list(values.preferredCountries).some((c) => c.length !== 2)) errors.preferredCountries = t('settings.general.useATwoLetterCode');
  return errors;
}

/** Settings → General → Music metadata (MusicBrainz, Fanart.tv, edition preferences); its own Save. */
export function MusicMetadataSection() {
  const features = useFeatures();
  if (!features.music) return null;
  return <MusicMetadataForm />;
}

function MusicMetadataForm() {
  const settings = useMusicMetadataSettings();
  const save = useSaveMusicMetadataSettings();
  const toast = useToast();
  const saved = useMemo(() => (settings.data ? musicMetadataValues(settings.data) : null), [settings.data]);
  const [draft, setDraft] = useState<FormValues | null>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const errors = draft ? musicMetadataErrors(draft) : {};
  const invalid = Object.keys(errors).length > 0;
  const changes = draft && saved ? countChanges(saved, draft) : 0;

  return (
    <SettingsSection
      label={t('music.settings.musicMetadata')}
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
            onClick={() => draft && save.mutate(toMusicMetadataUpdate(draft), { onSuccess: () => toast.push({ tone: 'ok', title: t('music.settings.metadataSaved') }) })}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      {settings.isPending ? (
        <Skeleton lines={4} />
      ) : settings.isError ? (
        <ErrorBlock title={t('music.settings.couldNotLoadMetadata')} onRetry={() => void settings.refetch()}>
          {errorMessage(settings.error)}
        </ErrorBlock>
      ) : draft ? (
        <SchemaForm fields={MUSIC_METADATA_FIELDS} values={draft} onChange={setDraft} errors={errors} inline />
      ) : null}
    </SettingsSection>
  );
}
