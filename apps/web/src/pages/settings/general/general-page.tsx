import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { MetadataSettingsResponse, MetadataSettingsUpdate } from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { ErrorBlock, FormRow, FormSection, KeyValue, Skeleton, buttonClass } from '../../../arclight/index.js';
import { SchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FieldErrors, FormValues } from '../../../components/forms/types.js';
import { isMasked, validateFields } from '../../../components/forms/values.js';
import { useMetadataSettings, useSaveMetadataSettings } from '../../../hooks/settings.js';
import { useSystemStatus } from '../../../hooks/system.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { SettingsSection } from '../shared.js';
import { ApiKeyControls } from '../security/api-key.js';
import '../security/security.css';
import { UiPreferencesSection } from './ui-preferences-section.js';
import { ThemesSection } from './themes-section.js';
import { ConfigAsCodeSection } from './config-as-code.js';
import { FeaturesSection } from './features-section.js';
import { MusicMetadataSection } from './music-metadata-section.js';
import { AudiobookMetadataSection } from './audiobook-metadata-section.js';
import { isSectionManaged, managedSectionKeys, useManagedKeys } from '../../../hooks/config.js';
import { t } from '../../../i18n/index.js';

export const METADATA_FIELDS: FieldDefinition[] = [
  {
    name: 'tmdbApiKey',
    get label() {
      return t('settings.general.tmdbApiKey');
    },
    type: 'password',
    get helpText() {
      return t('settings.general.yourTmdbV3ApiKey');
    },
  },
  { name: 'language', get label() { return t('settings.general.metadataLanguage'); }, type: 'text', required: true, placeholder: 'en-US', get helpText() { return t('settings.general.bcp47TagEG'); } },
  { name: 'region', get label() { return t('settings.general.region'); }, type: 'text', required: true, get placeholder() { return t('settings.general.us'); }, get helpText() { return t('settings.general.twoLetterCountryCodeUsed'); } },
];

/** Form values -> PUT body: the mask keeps the stored key, an emptied field clears it. */
export function toMetadataUpdate(values: FormValues): MetadataSettingsUpdate {
  const key = values.tmdbApiKey;
  const update: MetadataSettingsUpdate = {
    language: String(values.language ?? '').trim(),
    region: String(values.region ?? '').trim().toUpperCase(),
  };
  if (isMasked(key)) return update; // omitted = keep
  update.tmdbApiKey = typeof key === 'string' && key.trim() ? key.trim() : null;
  return update;
}

function metadataValues(data: MetadataSettingsResponse | undefined): FormValues | null {
  return data ? { tmdbApiKey: data.tmdbApiKey ?? '', language: data.language, region: data.region } : null;
}

/** Field errors for the metadata form: required fields plus the two-letter region. */
export function metadataErrors(values: FormValues): FieldErrors {
  const errors = validateFields(METADATA_FIELDS, values);
  const region = String(values.region ?? '').trim();
  if (region && region.length !== 2) errors.region = t('settings.general.useATwoLetterCode');
  return errors;
}

export function GeneralPage() {
  const metadata = useMetadataSettings();
  const save = useSaveMetadataSettings();
  const status = useSystemStatus();
  const managed = useManagedKeys();
  const [origin] = useState(() => (typeof location === 'undefined' ? '' : location.host));
  const saved = useMemo(() => metadataValues(metadata.data), [metadata.data]);
  const draft = useDraft<FormValues | null>(saved);
  const [touched, setTouched] = useState(false);
  const errors = draft.value ? metadataErrors(draft.value) : {};
  const invalid = Object.keys(errors).length > 0;

  const onSave = () => {
    setTouched(true);
    if (!draft.value || invalid) return;
    save.mutate(toMetadataUpdate(draft.value));
  };

  return (
    <SettingsPage
      title={t('common.general')}
      description={t('settings.general.metadataSourceHostDetailsAnd')}
      save={{
        count: draft.changes,
        onSave,
        onDiscard: () => {
          setTouched(false);
          draft.discard();
        },
        saving: save.isPending,
        disabled: invalid,
      }}
    >
      <SettingsSection label={t('settings.general.metadata')} managed={isSectionManaged(managed.data, 'metadata')} managedKeys={managedSectionKeys(managed.data, 'metadata')}>
        {metadata.isPending ? (
          <Skeleton lines={3} />
        ) : metadata.isError ? (
          <ErrorBlock title={t('settings.general.couldNotLoadMetadataSettings')} onRetry={() => void metadata.refetch()}>
            {errorMessage(metadata.error)}
          </ErrorBlock>
        ) : draft.value ? (
          <SchemaForm
            fields={METADATA_FIELDS}
            values={draft.value}
            onChange={(next) => draft.set(next)}
            // Region shape errors show while typing; "required" only after a save attempt.
            errors={touched ? errors : errors.region ? { region: errors.region } : {}}
            inline
          />
        ) : null}
      </SettingsSection>

      <FeaturesSection />

      <MusicMetadataSection />
      <AudiobookMetadataSection />

      <SettingsSection label={t('common.host')}>
        <KeyValue
          items={[
            { label: t('common.address'), value: origin || '—' },
            { label: t('common.port'), value: t('settings.general.setWithTheArclightPort'), mono: false },
            { label: t('settings.general.logLevel'), value: t('settings.general.setWithTheArclightLog'), mono: false },
            { label: t('settings.general.configFolder'), value: status.data?.paths.config ?? '—' },
            { label: t('common.version'), value: status.data?.version ?? '—' },
          ]}
        />
      </SettingsSection>

      <FormSection label={t('common.apiKey')}>
        <FormRow label={t('common.apiKey')} htmlFor="general-api-key" caption={t('settings.general.appsAndScriptsSendThis')}>
          <ApiKeyControls id="general-api-key" />
        </FormRow>
      </FormSection>

      <UiPreferencesSection />

      <ThemesSection />

      <ConfigAsCodeSection />

      <FormSection label={t('common.backups')}>
        <FormRow label={t('settings.general.databaseBackups')} caption={t('settings.general.createDownloadAndRestoreBackups')}>
          <div>
            <Link to="/system/backup" className={buttonClass({ variant: 'secondary' })}>
              {t('settings.general.openBackups')}
            </Link>
          </div>
        </FormRow>
      </FormSection>
    </SettingsPage>
  );
}
