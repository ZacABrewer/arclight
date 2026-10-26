import { useEffect, useState } from 'react';
import type { MetadataSettingsResponse, MetadataSettingsUpdate } from '@media-tron/shared';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { EmptyState } from '../../../components/empty-state.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { SchemaForm, useSchemaForm } from '../../../components/forms/schema-form.js';
import type { FieldDefinition, FormValues } from '../../../components/forms/types.js';
import { isMasked } from '../../../components/forms/values.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useMetadataSettings, useSaveMetadataSettings } from '../../../hooks/settings.js';
import { useSystemStatus } from '../../../hooks/system.js';

export const METADATA_FIELDS: FieldDefinition[] = [
  {
    name: 'tmdbApiKey',
    label: 'TMDB API key',
    type: 'password',
    helpText: 'Your TMDB v3 API key. Leave empty to use the MEDIATRON_TMDB_API_KEY environment variable.',
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

function MetadataForm({ data }: { data: MetadataSettingsResponse }) {
  const form = useSchemaForm(METADATA_FIELDS, { ...data, tmdbApiKey: data.tmdbApiKey ?? '' });
  const save = useSaveMetadataSettings();
  const { reset } = form;
  useEffect(() => reset({ ...data, tmdbApiKey: data.tmdbApiKey ?? '' }), [data, reset]);
  const regionError = form.values.region && String(form.values.region).trim().length !== 2 ? 'Use a two-letter code' : undefined;
  return (
    <>
      <SchemaForm
        fields={METADATA_FIELDS}
        values={form.values}
        onChange={form.setValues}
        errors={regionError ? { ...form.errors, region: regionError } : form.errors}
        inline
      />
      <Button variant="primary" loading={save.isPending} onClick={() => form.validate() && !regionError && save.mutate(toMetadataUpdate(form.values))}>
        Save
      </Button>
    </>
  );
}

export function GeneralPage() {
  const metadata = useMetadataSettings();
  const status = useSystemStatus();
  const [origin] = useState(() => (typeof location === 'undefined' ? '' : location.host));

  return (
    <Page title="General">
      <div className="stack">
        <Card title="Metadata (TMDB)">
          {metadata.isPending ? (
            <LoadingBlock />
          ) : metadata.isError ? (
            <ErrorView error={metadata.error} onRetry={() => void metadata.refetch()} />
          ) : (
            <MetadataForm data={metadata.data} />
          )}
        </Card>
        <Card title="Host">
          <dl className="fields">
            <div className="fields-row">
              <dt>Address</dt>
              <dd>
                <code>{origin}</code>
              </dd>
            </div>
            <div className="fields-row">
              <dt>Port</dt>
              <dd>Set with the MEDIATRON_PORT environment variable.</dd>
            </div>
            <div className="fields-row">
              <dt>Log level</dt>
              <dd className="muted">Not exposed by the api yet (set MEDIATRON_LOG_LEVEL).</dd>
            </div>
            <div className="fields-row">
              <dt>Config folder</dt>
              <dd>{status.data ? <code>{status.data.paths.config}</code> : '—'}</dd>
            </div>
            <div className="fields-row">
              <dt>Version</dt>
              <dd>{status.data?.version ?? '—'}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Backups">
          <EmptyState title="Backups are coming soon">
            <p className="muted">Scheduled database backups and restore will live here.</p>
          </EmptyState>
        </Card>
      </div>
    </Page>
  );
}
