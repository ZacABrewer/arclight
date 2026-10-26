import { useEffect, useState } from 'react';
import {
  MinimumAvailability,
  MonitorOption,
  SeriesType,
  type Request4kDefaults,
  type RequestsSettings,
  type RequestTypeDefaults,
} from '@arclight/shared';
import { Button } from '../../../components/button.js';
import { Card } from '../../../components/card.js';
import { ErrorView } from '../../../components/error-boundary.js';
import { FormField, Select, Toggle } from '../../../components/form.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { Page } from '../../../components/page.js';
import { LoadingBlock } from '../../../components/spinner.js';
import { useToast } from '../../../components/toast.js';
import { PermissionsMatrix, QuotaFields } from '../../../features/requests/user-editors.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { useRequestsSettings, useSaveRequestsSettings } from '../../../hooks/requests.js';
import { MINIMUM_AVAILABILITY_LABELS, MONITOR_OPTION_LABELS, SERIES_TYPE_LABELS } from '../../library/add-form.js';
import { SaveError } from '../shared.js';
import { OverrideRulesCard } from './override-rules-card.js';
import { SlidersCard } from './sliders-card.js';

export function RequestsSettingsPage() {
  return (
    <Page title="Requests" subtitle="Defaults for new requests, discover sliders and override rules">
      <div className="stack">
        <RequestsSettingsForm />
        <SlidersCard />
        <OverrideRulesCard />
      </div>
    </Page>
  );
}

export function RequestsSettingsForm() {
  const query = useRequestsSettings();
  const save = useSaveRequestsSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<RequestsSettings | null>(null);
  useEffect(() => {
    if (query.data && !draft) setDraft(query.data);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (!draft) return <LoadingBlock />;
  const set = <K extends keyof RequestsSettings>(key: K, value: RequestsSettings[K]) => setDraft({ ...draft, [key]: value });

  const submit = () =>
    save.mutate(draft, {
      onSuccess: (res) => {
        setDraft(res);
        toast.push({ tone: 'ok', title: 'Request settings saved' });
      },
    });

  return (
    <>
      <div className="grid">
        <TypeDefaultsCard title="Movie defaults" mediaType="movie" value={draft.movie} onChange={(v) => set('movie', v)} />
        <TypeDefaultsCard title="Series defaults" mediaType="series" value={draft.series} onChange={(v) => set('series', v)} />
        <FourKCard title="4K movies" mediaType="movie" value={draft.movie4k} onChange={(v) => set('movie4k', v)} />
        <FourKCard title="4K series" mediaType="series" value={draft.series4k} onChange={(v) => set('series4k', v)} />
      </div>
      <Card title="Approval and behaviour">
        <h3 className="section-title">Auto-approve everyone’s requests</h3>
        <div className="check-grid">
          {(
            [
              ['movie', 'Movies'],
              ['series', 'Series'],
              ['movie4k', '4K movies'],
              ['series4k', '4K series'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="check">
              <input
                type="checkbox"
                aria-label={`Auto-approve all ${label}`}
                checked={draft.autoApprove[k]}
                onChange={(e) => set('autoApprove', { ...draft.autoApprove, [k]: e.currentTarget.checked })}
              />
              {label}
            </label>
          ))}
        </div>
        <h3 className="section-title">Requests</h3>
        <FormField label="Allow partial series requests" inline hint="Off: a series request always covers every season.">
          <Toggle aria-label="Allow partial series requests" checked={draft.partialRequestsEnabled} onChange={(e) => set('partialRequestsEnabled', e.currentTarget.checked)} />
        </FormField>
        <FormField label="Allow requesting specials" inline>
          <Toggle aria-label="Allow requesting specials" checked={draft.enableSpecialEpisodes} onChange={(e) => set('enableSpecialEpisodes', e.currentTarget.checked)} />
        </FormField>
        <FormField label="Hide available titles in Discover" inline>
          <Toggle aria-label="Hide available titles" checked={draft.hideAvailable} onChange={(e) => set('hideAvailable', e.currentTarget.checked)} />
        </FormField>
        <FormField label="Hide requested titles in Discover" inline>
          <Toggle aria-label="Hide requested titles" checked={draft.hideRequested} onChange={(e) => set('hideRequested', e.currentTarget.checked)} />
        </FormField>
      </Card>
      <Card title="Default quotas">
        <QuotaFields value={draft.defaultQuotas} onChange={(v) => set('defaultQuotas', v)} blankHint="Blank: no quota" />
      </Card>
      <Card title="Default permissions for new users">
        <PermissionsMatrix value={draft.defaultPermissions} onChange={(v) => set('defaultPermissions', v)} lockAdmin />
      </Card>
      <SaveError error={save.error} />
      <div className="row">
        <Button variant="primary" loading={save.isPending} onClick={submit}>
          Save request settings
        </Button>
      </div>
    </>
  );
}

function RootFolderSelect({ mediaType, value, onChange, label }: { mediaType: 'movie' | 'series'; value: string | null; onChange: (v: string | null) => void; label: string }) {
  const folders = useRootFolders();
  return (
    <FormField label="Root folder">
      <Select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value || null)}>
        <option value="">First root folder</option>
        {(folders.data ?? [])
          .filter((f) => f.mediaType === mediaType)
          .map((f) => (
            <option key={f.id} value={f.path}>
              {f.path}
            </option>
          ))}
        {value && !(folders.data ?? []).some((f) => f.path === value) ? <option value={value}>{value}</option> : null}
      </Select>
    </FormField>
  );
}

function ProfileSelect({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const profiles = useQualityProfiles();
  return (
    <FormField label="Quality profile">
      <Select aria-label={label} value={value === null ? '' : String(value)} onChange={(e) => onChange(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
        <option value="">First profile</option>
        {(profiles.data ?? []).map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.name}
          </option>
        ))}
      </Select>
    </FormField>
  );
}

function TypeDefaultsCard({ title, mediaType, value, onChange }: { title: string; mediaType: 'movie' | 'series'; value: RequestTypeDefaults; onChange: (v: RequestTypeDefaults) => void }) {
  const set = <K extends keyof RequestTypeDefaults>(k: K, v: RequestTypeDefaults[K]) => onChange({ ...value, [k]: v });
  return (
    <Card title={title}>
      <RootFolderSelect mediaType={mediaType} label={`${title} root folder`} value={value.rootFolderPath} onChange={(v) => set('rootFolderPath', v)} />
      <ProfileSelect label={`${title} quality profile`} value={value.qualityProfileId} onChange={(v) => set('qualityProfileId', v)} />
      <FormField label="Tags">
        <TagPicker value={value.tags} onChange={(v) => set('tags', v)} />
      </FormField>
      {mediaType === 'movie' ? (
        <FormField label="Minimum availability">
          <Select
            value={value.minimumAvailability}
            onChange={(e) => set('minimumAvailability', e.currentTarget.value as MinimumAvailability)}
            options={MinimumAvailability.options.map((o) => ({ value: o, label: MINIMUM_AVAILABILITY_LABELS[o] }))}
          />
        </FormField>
      ) : (
        <>
          <FormField label="Monitor" hint="Requested seasons are always monitored; this applies to the rest.">
            <Select
              value={value.monitorOption}
              onChange={(e) => set('monitorOption', e.currentTarget.value as MonitorOption)}
              options={MonitorOption.options.map((o) => ({ value: o, label: MONITOR_OPTION_LABELS[o] }))}
            />
          </FormField>
          <FormField label="Monitor new seasons">
            <Select
              value={value.monitorNewItems}
              onChange={(e) => set('monitorNewItems', e.currentTarget.value as 'all' | 'none')}
              options={[
                { value: 'none', label: 'No' },
                { value: 'all', label: 'Yes' },
              ]}
            />
          </FormField>
          <FormField label="Series type">
            <Select
              value={value.seriesType}
              onChange={(e) => set('seriesType', e.currentTarget.value as SeriesType)}
              options={SeriesType.options.map((o) => ({ value: o, label: SERIES_TYPE_LABELS[o] }))}
            />
          </FormField>
          <FormField label="Season folders" inline>
            <Toggle checked={value.seasonFolder} onChange={(e) => set('seasonFolder', e.currentTarget.checked)} />
          </FormField>
        </>
      )}
      <FormField label="Search on add" inline>
        <Toggle aria-label={`${title} search on add`} checked={value.searchOnAdd} onChange={(e) => set('searchOnAdd', e.currentTarget.checked)} />
      </FormField>
    </Card>
  );
}

function FourKCard({ title, mediaType, value, onChange }: { title: string; mediaType: 'movie' | 'series'; value: Request4kDefaults; onChange: (v: Request4kDefaults) => void }) {
  const set = <K extends keyof Request4kDefaults>(k: K, v: Request4kDefaults[K]) => onChange({ ...value, [k]: v });
  return (
    <Card title={title}>
      <FormField label="Enable 4K requests" inline>
        <Toggle aria-label={`Enable ${title}`} checked={value.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormField>
      {value.enabled ? (
        <>
          <RootFolderSelect mediaType={mediaType} label={`${title} root folder`} value={value.rootFolderPath} onChange={(v) => set('rootFolderPath', v)} />
          <ProfileSelect label={`${title} quality profile`} value={value.qualityProfileId} onChange={(v) => set('qualityProfileId', v)} />
          <FormField label="Tags">
            <TagPicker value={value.tags} onChange={(v) => set('tags', v)} />
          </FormField>
        </>
      ) : (
        <p className="muted small">4K requests use their own root folder and profile so both versions can live side by side.</p>
      )}
    </Card>
  );
}
