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

export const METADATA_FIELDS: FieldDefinition[] = [
  {
    name: 'tmdbApiKey',
    label: 'TMDB API key',
    type: 'password',
    helpText: 'Your TMDB v3 API key. Leave empty to use the ARCLIGHT_TMDB_API_KEY environment variable.',
  },
  { name: 'language', label: 'Metadata language', type: 'text', required: true, placeholder: 'en-US', helpText: 'BCP-47 tag, e.g. en-US, fr-FR.' },
  { name: 'region', label: 'Region', type: 'text', required: true, placeholder: 'US', helpText: 'Two-letter country code used for release dates and certifications.' },
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
  if (region && region.length !== 2) errors.region = 'Use a two-letter code';
  return errors;
}

export function GeneralPage() {
  const metadata = useMetadataSettings();
  const save = useSaveMetadataSettings();
  const status = useSystemStatus();
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
      title="General"
      description="Metadata source, host details and the API key apps use to reach Arclight."
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
      <SettingsSection label="Metadata">
        {metadata.isPending ? (
          <Skeleton lines={3} />
        ) : metadata.isError ? (
          <ErrorBlock title="Could not load metadata settings" onRetry={() => void metadata.refetch()}>
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

      <SettingsSection label="Host">
        <KeyValue
          items={[
            { label: 'Address', value: origin || '—' },
            { label: 'Port', value: 'Set with the ARCLIGHT_PORT environment variable', mono: false },
            { label: 'Log level', value: 'Set with the ARCLIGHT_LOG_LEVEL environment variable', mono: false },
            { label: 'Config folder', value: status.data?.paths.config ?? '—' },
            { label: 'Version', value: status.data?.version ?? '—' },
          ]}
        />
      </SettingsSection>

      <FormSection label="API key">
        <FormRow label="API key" htmlFor="general-api-key" caption="Apps and scripts send this as the X-Api-Key header (or ?apikey=). It grants admin access.">
          <ApiKeyControls id="general-api-key" />
        </FormRow>
      </FormSection>

      <SettingsSection label="Interface">
        <p className="al-caption">Interface preferences arrive in a later release.</p>
      </SettingsSection>

      <FormSection label="Backups">
        <FormRow label="Database backups" caption="Create, download and restore backups on the System pages.">
          <div>
            <Link to="/system/backup" className={buttonClass({ variant: 'secondary' })}>
              Open backups
            </Link>
          </div>
        </FormRow>
      </FormSection>
    </SettingsPage>
  );
}
