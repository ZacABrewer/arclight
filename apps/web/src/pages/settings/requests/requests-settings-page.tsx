import { useId } from 'react';
import {
  MinimumAvailability,
  MonitorOption,
  SeriesType,
  type Request4kDefaults,
  type RequestsSettings,
  type RequestTypeDefaults,
} from '@arclight/shared';
import { errorMessage } from '../../../api/client.js';
import { Checkbox, ErrorBlock, FormRow, FormSection, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { useToast } from '../../../components/toast.js';
import { PermissionsMatrix, QuotaFields } from '../../../features/requests/user-editors.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { useRequestsSettings, useSaveRequestsSettings } from '../../../hooks/requests.js';
import { MINIMUM_AVAILABILITY_LABELS, MONITOR_OPTION_LABELS, SERIES_TYPE_LABELS } from '../../library/add-form.js';
import { SettingsPage, useDraft, type Draft } from '../settings-layout.js';
import { SaveError, SettingsSection } from '../shared.js';
import { OverrideRulesCard } from './override-rules-card.js';
import { SlidersCard } from './sliders-card.js';
import './requests-settings.css';

/** Draft + save wiring for the requests settings form (GET/PUT /settings/requests). */
export function useRequestsSettingsForm() {
  const query = useRequestsSettings();
  const save = useSaveRequestsSettings();
  const toast = useToast();
  const draft = useDraft<RequestsSettings | null>(query.data ?? null);
  const submit = () => {
    if (!draft.value) return;
    save.mutate(draft.value, {
      onSuccess: () => toast.push({ tone: 'ok', title: 'Request settings saved' }),
    });
  };
  return { query, save, draft, submit };
}

export function RequestsSettingsPage() {
  const form = useRequestsSettingsForm();
  return (
    <SettingsPage
      title="Requests"
      description="Defaults for new requests, discover sliders and override rules."
      save={{ count: form.draft.changes, onSave: form.submit, onDiscard: form.draft.discard, saving: form.save.isPending }}
    >
      <RequestsSettingsForm form={form} />
      <SlidersCard />
      <OverrideRulesCard />
    </SettingsPage>
  );
}

export function RequestsSettingsForm({ form }: { form: ReturnType<typeof useRequestsSettingsForm> }) {
  const { query, draft, save } = form;
  if (query.isError) {
    return (
      <ErrorBlock title="Could not load request settings" onRetry={() => void query.refetch()}>
        {errorMessage(query.error)}
      </ErrorBlock>
    );
  }
  if (!draft.value) return <Skeleton lines={6} />;
  return <SettingsFields draft={draft as Draft<RequestsSettings>} error={save.error} />;
}

const AUTO_APPROVE = [
  ['movie', 'Movies'],
  ['series', 'Series'],
  ['movie4k', '4K movies'],
  ['series4k', '4K series'],
] as const;

function SettingsFields({ draft, error }: { draft: Draft<RequestsSettings>; error: unknown }) {
  const value = draft.value;
  const set = <K extends keyof RequestsSettings>(key: K, v: RequestsSettings[K]) => draft.set((d) => ({ ...d, [key]: v }));
  const toggleRow = (label: string, key: 'partialRequestsEnabled' | 'enableSpecialEpisodes' | 'hideAvailable' | 'hideRequested', aria: string, caption?: string) => (
    <FormRow label={label} captionInline caption={caption}>
      <Toggle aria-label={aria} checked={value[key]} onChange={(e) => set(key, e.currentTarget.checked)} />
    </FormRow>
  );

  return (
    <>
      <TypeDefaults title="Movie defaults" mediaType="movie" value={value.movie} onChange={(v) => set('movie', v)} />
      <TypeDefaults title="Series defaults" mediaType="series" value={value.series} onChange={(v) => set('series', v)} />
      <FourK title="4K movies" mediaType="movie" value={value.movie4k} onChange={(v) => set('movie4k', v)} />
      <FourK title="4K series" mediaType="series" value={value.series4k} onChange={(v) => set('series4k', v)} />
      <FormSection label="Approval">
        <FormRow label="Auto-approve everyone’s requests">
          <div className="al-check-grid" role="group" aria-label="Auto-approve">
            {AUTO_APPROVE.map(([k, label]) => (
              <Checkbox
                key={k}
                label={label}
                aria-label={`Auto-approve all ${label}`}
                checked={value.autoApprove[k]}
                onChange={(e) => set('autoApprove', { ...value.autoApprove, [k]: e.currentTarget.checked })}
              />
            ))}
          </div>
        </FormRow>
      </FormSection>
      <FormSection label="Requests">
        {toggleRow('Allow partial series requests', 'partialRequestsEnabled', 'Allow partial series requests', 'Off: a series request always covers every season.')}
        {toggleRow('Allow requesting specials', 'enableSpecialEpisodes', 'Allow requesting specials')}
        {toggleRow('Hide available titles in Discover', 'hideAvailable', 'Hide available titles')}
        {toggleRow('Hide requested titles in Discover', 'hideRequested', 'Hide requested titles')}
      </FormSection>
      <SettingsSection label="Default quotas">
        <div className="al-requests-embed">
          <QuotaFields value={value.defaultQuotas} onChange={(v) => set('defaultQuotas', v)} blankHint="Blank: no quota" />
        </div>
      </SettingsSection>
      <SettingsSection label="Default permissions for new users">
        <div className="al-requests-embed">
          <PermissionsMatrix value={value.defaultPermissions} onChange={(v) => set('defaultPermissions', v)} lockAdmin />
        </div>
      </SettingsSection>
      <SaveError error={error} />
    </>
  );
}

function RootFolderSelect({ id, mediaType, value, onChange, label }: { id: string; mediaType: 'movie' | 'series'; value: string | null; onChange: (v: string | null) => void; label: string }) {
  const folders = useRootFolders();
  return (
    <Select id={id} className="al-select--fit al-mono" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value || null)}>
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
  );
}

function ProfileSelect({ id, value, onChange, label }: { id: string; value: number | null; onChange: (v: number | null) => void; label: string }) {
  const profiles = useQualityProfiles();
  return (
    <Select
      id={id}
      className="al-select--fit"
      aria-label={label}
      value={value === null ? '' : String(value)}
      onChange={(e) => onChange(e.currentTarget.value ? Number(e.currentTarget.value) : null)}
    >
      <option value="">First profile</option>
      {(profiles.data ?? []).map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

function TypeDefaults({ title, mediaType, value, onChange }: { title: string; mediaType: 'movie' | 'series'; value: RequestTypeDefaults; onChange: (v: RequestTypeDefaults) => void }) {
  const ids = useId();
  const set = <K extends keyof RequestTypeDefaults>(k: K, v: RequestTypeDefaults[K]) => onChange({ ...value, [k]: v });
  return (
    <FormSection label={title}>
      <FormRow label="Root folder" htmlFor={`${ids}-root`}>
        <RootFolderSelect id={`${ids}-root`} mediaType={mediaType} label={`${title} root folder`} value={value.rootFolderPath} onChange={(v) => set('rootFolderPath', v)} />
      </FormRow>
      <FormRow label="Quality profile" htmlFor={`${ids}-profile`}>
        <ProfileSelect id={`${ids}-profile`} label={`${title} quality profile`} value={value.qualityProfileId} onChange={(v) => set('qualityProfileId', v)} />
      </FormRow>
      <FormRow label="Tags">
        <TagPicker value={value.tags} onChange={(v) => set('tags', v)} />
      </FormRow>
      {mediaType === 'movie' ? (
        <FormRow label="Minimum availability" htmlFor={`${ids}-avail`}>
          <Select
            id={`${ids}-avail`}
            className="al-select--fit"
            value={value.minimumAvailability}
            onChange={(e) => set('minimumAvailability', e.currentTarget.value as MinimumAvailability)}
            options={MinimumAvailability.options.map((o) => ({ value: o, label: MINIMUM_AVAILABILITY_LABELS[o] }))}
          />
        </FormRow>
      ) : (
        <>
          <FormRow label="Monitor" htmlFor={`${ids}-monitor`} caption="Requested seasons are always monitored; this applies to the rest.">
            <Select
              id={`${ids}-monitor`}
              className="al-select--fit"
              value={value.monitorOption}
              onChange={(e) => set('monitorOption', e.currentTarget.value as MonitorOption)}
              options={MonitorOption.options.map((o) => ({ value: o, label: MONITOR_OPTION_LABELS[o] }))}
            />
          </FormRow>
          <FormRow label="Monitor new seasons" htmlFor={`${ids}-new`}>
            <Select
              id={`${ids}-new`}
              className="al-select--fit"
              value={value.monitorNewItems}
              onChange={(e) => set('monitorNewItems', e.currentTarget.value as 'all' | 'none')}
              options={[
                { value: 'none', label: 'No' },
                { value: 'all', label: 'Yes' },
              ]}
            />
          </FormRow>
          <FormRow label="Series type" htmlFor={`${ids}-type`}>
            <Select
              id={`${ids}-type`}
              className="al-select--fit"
              value={value.seriesType}
              onChange={(e) => set('seriesType', e.currentTarget.value as SeriesType)}
              options={SeriesType.options.map((o) => ({ value: o, label: SERIES_TYPE_LABELS[o] }))}
            />
          </FormRow>
          <FormRow label="Season folders" captionInline>
            <Toggle aria-label={`${title} season folders`} checked={value.seasonFolder} onChange={(e) => set('seasonFolder', e.currentTarget.checked)} />
          </FormRow>
        </>
      )}
      <FormRow label="Search on add" captionInline>
        <Toggle aria-label={`${title} search on add`} checked={value.searchOnAdd} onChange={(e) => set('searchOnAdd', e.currentTarget.checked)} />
      </FormRow>
    </FormSection>
  );
}

function FourK({ title, mediaType, value, onChange }: { title: string; mediaType: 'movie' | 'series'; value: Request4kDefaults; onChange: (v: Request4kDefaults) => void }) {
  const ids = useId();
  const set = <K extends keyof Request4kDefaults>(k: K, v: Request4kDefaults[K]) => onChange({ ...value, [k]: v });
  return (
    <FormSection label={title}>
      <FormRow
        label="Enable 4K requests"
        captionInline
        caption={value.enabled ? undefined : '4K requests use their own root folder and profile so both versions can live side by side.'}
      >
        <Toggle aria-label={`Enable ${title}`} checked={value.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormRow>
      {value.enabled ? (
        <>
          <FormRow label="Root folder" htmlFor={`${ids}-root`}>
            <RootFolderSelect id={`${ids}-root`} mediaType={mediaType} label={`${title} root folder`} value={value.rootFolderPath} onChange={(v) => set('rootFolderPath', v)} />
          </FormRow>
          <FormRow label="Quality profile" htmlFor={`${ids}-profile`}>
            <ProfileSelect id={`${ids}-profile`} label={`${title} quality profile`} value={value.qualityProfileId} onChange={(v) => set('qualityProfileId', v)} />
          </FormRow>
          <FormRow label="Tags">
            <TagPicker value={value.tags} onChange={(v) => set('tags', v)} />
          </FormRow>
        </>
      ) : null}
    </FormSection>
  );
}
