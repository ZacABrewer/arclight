import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission, SignInSettings, type NewUserPolicy, type RequestsSettings, type UserQuota } from '@arclight/shared';
import { signInApi } from '../../api/auth.js';
import { requestsSettingsApi } from '../../api/requests.js';
import { errorMessage } from '../../api/client.js';
import { Checkbox, ErrorBlock, FormRow, FormSection, Input, RadioGroup, Skeleton, Toggle } from '../../arclight/index.js';
import { requestKeys } from '../../hooks/request-keys.js';
import { t } from '../../i18n/index.js';

// "User defaults": how people other than admins sign in, what a new account may request, its
// quotas, and its app access (always the request portal). Used by the setup wizard's step of the
// same name and by Settings > Users. Sign-in lives in its own settings section (/settings/signin);
// permissions and quotas are the existing request defaults (Settings > Requests), not a copy.

export const signInKeys = { settings: ['settings', 'signin'] as const };

/** The request-permission switches the defaults form offers. */
export interface DefaultRequestFlags {
  movies: boolean;
  series: boolean;
  fourK: boolean;
  autoApprove: boolean;
  issues: boolean;
}

const has = (bits: number, flag: number) => (bits & flag) === flag;

export function flagsFromPermissions(bits: number): DefaultRequestFlags {
  return {
    movies: has(bits, Permission.REQUEST) || has(bits, Permission.REQUEST_MOVIE),
    series: has(bits, Permission.REQUEST) || has(bits, Permission.REQUEST_TV),
    fourK: has(bits, Permission.REQUEST_4K),
    autoApprove: has(bits, Permission.AUTO_APPROVE),
    issues: has(bits, Permission.CREATE_ISSUES),
  };
}

/** Applies the switches to a permission bitfield, keeping every other bit (never ADMIN). */
export function permissionsFromFlags(flags: DefaultRequestFlags, bits: number): number {
  let out = bits & ~(Permission.ADMIN | Permission.REQUEST | Permission.REQUEST_MOVIE | Permission.REQUEST_TV | Permission.REQUEST_4K | Permission.AUTO_APPROVE | Permission.CREATE_ISSUES);
  if (flags.movies && flags.series) out |= Permission.REQUEST;
  else if (flags.movies) out |= Permission.REQUEST_MOVIE;
  else if (flags.series) out |= Permission.REQUEST_TV;
  if (flags.fourK) out |= Permission.REQUEST_4K;
  if (flags.autoApprove) out |= Permission.AUTO_APPROVE;
  if (flags.issues) out |= Permission.CREATE_ISSUES;
  return out;
}

/** "" ⇄ null (unlimited); anything else a whole number ≥ 0 (NaN marks it invalid). */
export function parseLimit(text: string): number | null {
  const v = text.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

export interface UserDefaultsDraft {
  signIn: SignInSettings;
  flags: DefaultRequestFlags;
  quota: Record<keyof UserQuota, string>;
}

const quotaText = (q: UserQuota): UserDefaultsDraft['quota'] => ({
  movieLimit: q.movieLimit === null ? '' : String(q.movieLimit),
  movieDays: q.movieDays === null ? '' : String(q.movieDays),
  tvLimit: q.tvLimit === null ? '' : String(q.tvLimit),
  tvDays: q.tvDays === null ? '' : String(q.tvDays),
});

export function quotaFromText(q: UserDefaultsDraft['quota']): UserQuota | null {
  const out = { movieLimit: parseLimit(q.movieLimit), movieDays: parseLimit(q.movieDays), tvLimit: parseLimit(q.tvLimit), tvDays: parseLimit(q.tvDays) };
  return Object.values(out).some((v) => v !== null && Number.isNaN(v)) ? null : out;
}

/** Loads both settings sections and saves them together. */
export function useUserDefaults() {
  const qc = useQueryClient();
  const signIn = useQuery({ queryKey: signInKeys.settings, queryFn: signInApi.get, retry: false });
  const requests = useQuery({ queryKey: requestKeys.settings, queryFn: requestsSettingsApi.get, retry: false });
  const [draft, setDraft] = useState<UserDefaultsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (draft === null && signIn.data && requests.data) {
      setDraft({ signIn: signIn.data, flags: flagsFromPermissions(requests.data.defaultPermissions), quota: quotaText(requests.data.defaultQuotas) });
    }
  }, [draft, signIn.data, requests.data]);

  /** Saves; true on success. */
  const save = async (): Promise<boolean> => {
    if (!draft || !requests.data) return false;
    const quotas = quotaFromText(draft.quota);
    if (!quotas) {
      setError(t('userDefaults.quotaInvalid'));
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      await signInApi.update(SignInSettings.parse(draft.signIn));
      const next: RequestsSettings = { ...requests.data, defaultPermissions: permissionsFromFlags(draft.flags, requests.data.defaultPermissions), defaultQuotas: quotas };
      await requestsSettingsApi.update(next);
      await Promise.all([qc.invalidateQueries({ queryKey: signInKeys.settings }), qc.invalidateQueries({ queryKey: requestKeys.settings })]);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const loadError = signIn.error ?? requests.error;
  return { draft, setDraft, save, saving, error, loadError, retry: () => void Promise.all([signIn.refetch(), requests.refetch()]) };
}

export function UserDefaultsFields({ state }: { state: ReturnType<typeof useUserDefaults> }) {
  const ids = useId();
  const { draft, setDraft, loadError, retry } = state;
  if (loadError) {
    return (
      <ErrorBlock title={t('userDefaults.couldNotLoad')} onRetry={retry}>
        {errorMessage(loadError)}
      </ErrorBlock>
    );
  }
  if (!draft) return <Skeleton lines={6} />;
  const setSignIn = (patch: Partial<SignInSettings>) => setDraft({ ...draft, signIn: { ...draft.signIn, ...patch } });
  const setFlag = (k: keyof DefaultRequestFlags) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, flags: { ...draft.flags, [k]: e.currentTarget.checked } });
  const setQuota = (k: keyof UserQuota) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, quota: { ...draft.quota, [k]: e.currentTarget.value } });
  const quotaInput = (k: keyof UserQuota, label: string) => (
    <Input
      id={`${ids}-${k}`}
      aria-label={label}
      type="number"
      mono
      min={0}
      className="al-input--num"
      placeholder={t('userDefaults.unlimited')}
      invalid={Number.isNaN(parseLimit(draft.quota[k]))}
      value={draft.quota[k]}
      onChange={setQuota(k)}
    />
  );

  return (
    <div className="al-editor-stack" data-testid="user-defaults">
      <FormSection label={t('userDefaults.signInLabel')}>
        <p className="al-caption" style={{ margin: 0 }}>
          {t('userDefaults.adminsAlwaysLocal')}
        </p>
        <FormRow label={t('userDefaults.localAccounts')} captionInline caption={t('userDefaults.localAccountsCaption')}>
          <Toggle aria-label={t('userDefaults.localAccounts')} checked={draft.signIn.local} onChange={(e) => setSignIn({ local: e.currentTarget.checked })} />
        </FormRow>
        <FormRow label={t('common.jellyfin')} captionInline caption={t('userDefaults.mediaServerCaption')}>
          <Toggle aria-label={t('common.jellyfin')} checked={draft.signIn.jellyfin} onChange={(e) => setSignIn({ jellyfin: e.currentTarget.checked })} />
        </FormRow>
        <FormRow label={t('common.emby')} captionInline caption={t('userDefaults.mediaServerCaption')}>
          <Toggle aria-label={t('common.emby')} checked={draft.signIn.emby} onChange={(e) => setSignIn({ emby: e.currentTarget.checked })} />
        </FormRow>
        <FormRow label={t('common.plex')} captionInline caption={t('userDefaults.mediaServerCaption')}>
          <Toggle aria-label={t('common.plex')} checked={draft.signIn.plex} onChange={(e) => setSignIn({ plex: e.currentTarget.checked })} />
        </FormRow>
        <RadioGroup<NewUserPolicy>
          legend={t('userDefaults.newUsers')}
          value={draft.signIn.newUsers}
          onChange={(newUsers) => setSignIn({ newUsers })}
          options={[
            { value: 'automatic', label: t('userDefaults.newUsersAutomatic'), hint: t('userDefaults.newUsersAutomaticHint') },
            { value: 'invite', label: t('userDefaults.newUsersInvite'), hint: t('userDefaults.newUsersInviteHint') },
          ]}
        />
      </FormSection>
      <FormSection label={t('userDefaults.permissionsLabel')}>
        <p className="al-caption" style={{ margin: 0 }}>
          {t('userDefaults.permissionsLead')}
        </p>
        <Checkbox label={t('userDefaults.requestMovies')} checked={draft.flags.movies} onChange={setFlag('movies')} />
        <Checkbox label={t('userDefaults.requestSeries')} checked={draft.flags.series} onChange={setFlag('series')} />
        <Checkbox label={t('userDefaults.request4k')} checked={draft.flags.fourK} onChange={setFlag('fourK')} />
        <Checkbox label={t('userDefaults.reportIssues')} checked={draft.flags.issues} onChange={setFlag('issues')} />
        <Checkbox label={t('userDefaults.autoApprove')} hint={t('userDefaults.autoApproveHint')} checked={draft.flags.autoApprove} onChange={setFlag('autoApprove')} />
      </FormSection>
      <FormSection label={t('userDefaults.quotasLabel')}>
        <p className="al-caption" style={{ margin: 0 }}>
          {t('userDefaults.quotasLead')}
        </p>
        <FormRow label={t('userDefaults.movieQuota')} htmlFor={`${ids}-movieLimit`}>
          <span className="mk-row" style={{ gap: 8, alignItems: 'center' }}>
            {quotaInput('movieLimit', t('userDefaults.movieLimit'))}
            <span className="al-caption">{t('userDefaults.everyDays')}</span>
            {quotaInput('movieDays', t('userDefaults.movieDays'))}
          </span>
        </FormRow>
        <FormRow label={t('userDefaults.seriesQuota')} htmlFor={`${ids}-tvLimit`}>
          <span className="mk-row" style={{ gap: 8, alignItems: 'center' }}>
            {quotaInput('tvLimit', t('userDefaults.seriesLimit'))}
            <span className="al-caption">{t('userDefaults.everyDays')}</span>
            {quotaInput('tvDays', t('userDefaults.seriesDays'))}
          </span>
        </FormRow>
      </FormSection>
      <FormSection label={t('userDefaults.appAccessLabel')}>
        <p className="al-caption" style={{ margin: 0 }}>
          {t('userDefaults.appAccessLead')}
        </p>
      </FormSection>
      {state.error ? (
        <p className="al-inline-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
