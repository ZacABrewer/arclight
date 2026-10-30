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
import { Button, Checkbox, ErrorBlock, FormRow, FormSection, Input, Select, Skeleton, Toggle } from '../../../arclight/index.js';
import { TagPicker } from '../../../components/forms/tag-picker.js';
import { useToast } from '../../../components/toast.js';
import { PermissionsMatrix, QuotaFields } from '../../../features/requests/user-editors.js';
import { useQualityProfiles, useRootFolders } from '../../../hooks/library.js';
import { useRequestsSettings, useSaveRequestsSettings, useSendDigest } from '../../../hooks/requests.js';
import { MINIMUM_AVAILABILITY_LABELS, MONITOR_OPTION_LABELS, SERIES_TYPE_LABELS } from '../../library/add-form.js';
import { SettingsPage, useDraft, type Draft } from '../settings-layout.js';
import { SaveError, SettingsSection } from '../shared.js';
import { AudioDefaultsCard } from './audio-defaults-card.js';
import { OverrideRulesCard } from './override-rules-card.js';
import { SlidersCard } from './sliders-card.js';
import { ApprovalPolicySections, PublicPortalSection, policyErrors } from './approval-policies.js';
import './requests-settings.css';
import { t } from '../../../i18n/index.js';

/** Draft + save wiring for the requests settings form (GET/PUT /settings/requests). */
export function useRequestsSettingsForm() {
  const query = useRequestsSettings();
  const save = useSaveRequestsSettings();
  const toast = useToast();
  const draft = useDraft<RequestsSettings | null>(query.data ?? null);
  const submit = () => {
    if (!draft.value) return;
    save.mutate(draft.value, {
      onSuccess: () => toast.push({ tone: 'ok', title: t('settings.requests.settings.requestSettingsSaved') }),
    });
  };
  return { query, save, draft, submit };
}

export function RequestsSettingsPage() {
  const form = useRequestsSettingsForm();
  return (
    <SettingsPage
      title={t('common.requests')}
      description={t('settings.requests.settings.defaultsForNewRequestsDiscover')}
      save={{
        count: form.draft.changes,
        onSave: form.submit,
        onDiscard: form.draft.discard,
        saving: form.save.isPending,
        disabled: form.draft.value ? policyErrors(form.draft.value).length > 0 : false,
      }}
    >
      <RequestsSettingsForm form={form} />
      <AudioDefaultsCard />
      <SlidersCard />
      <OverrideRulesCard />
    </SettingsPage>
  );
}

export function RequestsSettingsForm({ form }: { form: ReturnType<typeof useRequestsSettingsForm> }) {
  const { query, draft, save } = form;
  if (query.isError) {
    return (
      <ErrorBlock title={t('settings.requests.settings.couldNotLoadRequestSettings')} onRetry={() => void query.refetch()}>
        {errorMessage(query.error)}
      </ErrorBlock>
    );
  }
  if (!draft.value) return <Skeleton lines={6} />;
  return <SettingsFields draft={draft as Draft<RequestsSettings>} error={save.error} />;
}

/** "09:00" for the digest hour select. */
export function digestHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** An application URL is optional; when set it must be an absolute http(s) URL. */
export function applicationUrlError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : t('common.useHttpAddress');
  } catch {
    return t('settings.requests.enterFullAddress');
  }
}

const DIGEST_HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: digestHourLabel(h) }));

function NotificationLinks({ value, set }: { value: RequestsSettings; set: <K extends keyof RequestsSettings>(key: K, v: RequestsSettings[K]) => void }) {
  const ids = { url: useId(), hour: useId() };
  const digest = useSendDigest();
  const toast = useToast();
  const urlError = applicationUrlError(value.applicationUrl);
  return (
    <FormSection label={t('common.notifications')}>
      <FormRow
        label={t('settings.requests.settings.applicationUrl')}
        htmlFor={ids.url}
        error={urlError ?? undefined}
        caption={t('settings.requests.settings.publicAddressOfArclightNotifications')}
      >
        <Input id={ids.url} mono spellCheck={false} placeholder="https://arclight.example.com" invalid={urlError !== null} value={value.applicationUrl} onChange={(e) => set('applicationUrl', e.currentTarget.value)} />
      </FormRow>
      <FormRow label={t('settings.requests.settings.dailyDigest')} captionInline caption={t('settings.requests.settings.oneNotificationADayListing')}>
        <Toggle aria-label={t('settings.requests.settings.dailyDigest')} checked={value.digestEnabled} onChange={(e) => set('digestEnabled', e.currentTarget.checked)} />
      </FormRow>
      <FormRow label={t('settings.requests.settings.digestTime')} htmlFor={ids.hour} caption={t('settings.requests.settings.serverLocalTime')}>
        <Select id={ids.hour} disabled={!value.digestEnabled} value={String(value.digestHour)} onChange={(e) => set('digestHour', Number(e.currentTarget.value))} options={DIGEST_HOURS} />
      </FormRow>
      <FormRow label={t('settings.requests.settings.sendNow')}>
        <Button
          size="sm"
          variant="secondary"
          loading={digest.isPending}
          onClick={() =>
            digest.mutate(undefined, {
              onSuccess: (r) =>
                toast.push(
                  r.sent
                    ? { tone: 'ok', title: t('settings.requests.settings.digestSent'), message: t('settings.requests.settings.pendingrequestsPendingRequestsOpenissuesOpen', { pendingRequests: r.pendingRequests, openIssues: r.openIssues }) }
                    : { tone: 'info', title: t('settings.requests.settings.nothingToSend'), message: t('settings.requests.settings.noPendingRequestsOrOpen') },
                ),
            })
          }
        >
          {t('settings.requests.settings.sendDigestNow')}
        </Button>
      </FormRow>
    </FormSection>
  );
}

/** Auto-approve toggles: permission key and the message key of its label. */
const AUTO_APPROVE = [
  ['movie', 'common.movies'],
  ['series', 'common.series'],
  ['movie4k', 'settings.requests.movies4k'],
  ['series4k', 'settings.requests.series4k'],
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
      <TypeDefaults title={t('settings.requests.settings.movieDefaults')} mediaType="movie" value={value.movie} onChange={(v) => set('movie', v)} />
      <TypeDefaults title={t('settings.requests.settings.seriesDefaults')} mediaType="series" value={value.series} onChange={(v) => set('series', v)} />
      <FourK title={t('settings.requests.settings.n4kMovies')} mediaType="movie" value={value.movie4k} onChange={(v) => set('movie4k', v)} />
      <FourK title={t('settings.requests.settings.n4kSeries')} mediaType="series" value={value.series4k} onChange={(v) => set('series4k', v)} />
      <FormSection label={t('settings.requests.settings.approval')}>
        <FormRow label={t('settings.requests.settings.autoApproveEveryonesRequests')}>
          <div className="al-check-grid" role="group" aria-label={t('settings.requests.settings.autoApprove')}>
            {AUTO_APPROVE.map(([k, labelKey]) => ({ k, label: t(labelKey) })).map(({ k, label }) => (
              <Checkbox
                key={k}
                label={label}
                aria-label={t('settings.requests.settings.autoApproveAllLabel', { label })}
                checked={value.autoApprove[k]}
                onChange={(e) => set('autoApprove', { ...value.autoApprove, [k]: e.currentTarget.checked })}
              />
            ))}
          </div>
        </FormRow>
        <FormRow label={t('settings.requests.settings.autoApproveLanguageRequests')} caption={t('settings.requests.settings.autoApproveLanguageRequestsCaption')}>
          <div className="al-check-grid" role="group" aria-label={t('settings.requests.settings.autoApproveLanguageRequests')}>
            <Checkbox
              label={t('settings.requests.settings.subtitleRequests')}
              aria-label={t('settings.requests.settings.autoApproveSubtitleRequests')}
              checked={value.autoApproveSubtitleRequests}
              onChange={(e) => set('autoApproveSubtitleRequests', e.currentTarget.checked)}
            />
            <Checkbox
              label={t('settings.requests.settings.audioLanguageRequests')}
              aria-label={t('settings.requests.settings.autoApproveAudioRequests')}
              checked={value.autoApproveAudioRequests}
              onChange={(e) => set('autoApproveAudioRequests', e.currentTarget.checked)}
            />
          </div>
        </FormRow>
      </FormSection>
      <FormSection label={t('common.requests')}>
        {toggleRow(t('settings.requests.allowPartialSeriesRequests'), 'partialRequestsEnabled', t('settings.requests.allowPartialSeriesRequests'), t('settings.requests.allowPartialSeriesRequestsCaption'))}
        {toggleRow(t('settings.requests.allowRequestingSpecials'), 'enableSpecialEpisodes', t('settings.requests.allowRequestingSpecials'))}
        {toggleRow(t('settings.requests.hideAvailableTitlesInDiscover'), 'hideAvailable', t('settings.requests.hideAvailableTitles'))}
        {toggleRow(t('settings.requests.hideRequestedTitlesInDiscover'), 'hideRequested', t('settings.requests.hideRequestedTitles'))}
      </FormSection>
      <ApprovalPolicySections value={value} set={set} />
      <PublicPortalSection value={value.publicPortal} onChange={(v) => set('publicPortal', v)} />
      <NotificationLinks value={value} set={set} />
      <SettingsSection label={t('settings.requests.settings.defaultQuotas')}>
        <div className="al-requests-embed">
          <QuotaFields value={value.defaultQuotas} onChange={(v) => set('defaultQuotas', v)} blankHint={t('settings.requests.settings.blankNoQuota')} />
        </div>
      </SettingsSection>
      <SettingsSection label={t('settings.requests.settings.defaultPermissionsForNewUsers')}>
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
      <option value="">{t('settings.requests.settings.firstRootFolder')}</option>
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
      <option value="">{t('settings.requests.settings.firstProfile')}</option>
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
      <FormRow label={t('common.rootFolder')} htmlFor={`${ids}-root`}>
        <RootFolderSelect id={`${ids}-root`} mediaType={mediaType} label={t('settings.requests.settings.titleRootFolder', { title })} value={value.rootFolderPath} onChange={(v) => set('rootFolderPath', v)} />
      </FormRow>
      <FormRow label={t('common.qualityProfile')} htmlFor={`${ids}-profile`}>
        <ProfileSelect id={`${ids}-profile`} label={t('settings.requests.settings.titleQualityProfile', { title })} value={value.qualityProfileId} onChange={(v) => set('qualityProfileId', v)} />
      </FormRow>
      <FormRow label={t('common.tags')}>
        <TagPicker value={value.tags} onChange={(v) => set('tags', v)} />
      </FormRow>
      {mediaType === 'movie' ? (
        <FormRow label={t('common.minimumAvailability')} htmlFor={`${ids}-avail`}>
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
          <FormRow label={t('common.monitor')} htmlFor={`${ids}-monitor`} caption={t('settings.requests.settings.requestedSeasonsAreAlwaysMonitored')}>
            <Select
              id={`${ids}-monitor`}
              className="al-select--fit"
              value={value.monitorOption}
              onChange={(e) => set('monitorOption', e.currentTarget.value as MonitorOption)}
              options={MonitorOption.options.map((o) => ({ value: o, label: MONITOR_OPTION_LABELS[o] }))}
            />
          </FormRow>
          <FormRow label={t('settings.requests.settings.monitorNewSeasons')} htmlFor={`${ids}-new`}>
            <Select
              id={`${ids}-new`}
              className="al-select--fit"
              value={value.monitorNewItems}
              onChange={(e) => set('monitorNewItems', e.currentTarget.value as 'all' | 'none')}
              options={[
                { value: 'none', label: t('settings.requests.settings.no') },
                { value: 'all', label: t('settings.requests.settings.yes') },
              ]}
            />
          </FormRow>
          <FormRow label={t('common.seriesType')} htmlFor={`${ids}-type`}>
            <Select
              id={`${ids}-type`}
              className="al-select--fit"
              value={value.seriesType}
              onChange={(e) => set('seriesType', e.currentTarget.value as SeriesType)}
              options={SeriesType.options.map((o) => ({ value: o, label: SERIES_TYPE_LABELS[o] }))}
            />
          </FormRow>
          <FormRow label={t('common.seasonFolders')} captionInline>
            <Toggle aria-label={t('settings.requests.settings.titleSeasonFolders', { title })} checked={value.seasonFolder} onChange={(e) => set('seasonFolder', e.currentTarget.checked)} />
          </FormRow>
        </>
      )}
      <FormRow label={t('common.searchOnAdd')} captionInline>
        <Toggle aria-label={t('settings.requests.settings.titleSearchOnAdd', { title })} checked={value.searchOnAdd} onChange={(e) => set('searchOnAdd', e.currentTarget.checked)} />
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
        label={t('settings.requests.settings.enable4kRequests')}
        captionInline
        caption={value.enabled ? undefined : t('settings.requests.settings.n4kRequestsUseTheirOwn')}
      >
        <Toggle aria-label={t('settings.requests.settings.enableTitle', { title })} checked={value.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
      </FormRow>
      {value.enabled ? (
        <>
          <FormRow label={t('common.rootFolder')} htmlFor={`${ids}-root`}>
            <RootFolderSelect id={`${ids}-root`} mediaType={mediaType} label={t('settings.requests.settings.titleRootFolder', { title })} value={value.rootFolderPath} onChange={(v) => set('rootFolderPath', v)} />
          </FormRow>
          <FormRow label={t('common.qualityProfile')} htmlFor={`${ids}-profile`}>
            <ProfileSelect id={`${ids}-profile`} label={t('settings.requests.settings.titleQualityProfile', { title })} value={value.qualityProfileId} onChange={(v) => set('qualityProfileId', v)} />
          </FormRow>
          <FormRow label={t('common.tags')}>
            <TagPicker value={value.tags} onChange={(v) => set('tags', v)} />
          </FormRow>
        </>
      ) : null}
    </FormSection>
  );
}
