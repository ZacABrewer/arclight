import { useEffect, useState } from 'react';
import {
  ContentRestrictions,
  MOVIE_CERTIFICATIONS,
  PERMISSION_INFO,
  Permission,
  REQUEST_SECRET_MASK,
  TV_CERTIFICATIONS,
  UserApprovalPolicy,
  type MovieCertification,
  type TvCertification,
  type PermissionInfo,
  type QuotaInfo,
  type UserNotificationTestResult,
  type UserNotificationTypes,
  type UserQuota,
  type UserRequestSettings,
} from '@arclight/shared';
import { errorMessage } from '../../api/client.js';
import { Button, Checkbox, Chip, Field, Input, KeyValue, SectionLabel, Select, Skeleton, Toggle } from '../../arclight/index.js';
import { ErrorView } from '../../components/error-boundary.js';
import { useToast } from '../../components/toast.js';
import {
  useSetUserPermissions,
  useSetUserPolicy,
  useSetUserQuota,
  useSetUserRequestSettings,
  useTestUserNotifications,
  useUserPermissions,
  useUserQuota,
  useUserRequestSettings,
} from '../../hooks/requests.js';
import { SaveError } from '../../pages/settings/shared.js';
import './requests.css';
import './policy.css';
import { t } from '../../i18n/index.js';

// ---------------------------------------------------------------------------------------
// Permissions matrix
// ---------------------------------------------------------------------------------------

export const PERMISSION_GROUP_LABELS: Record<PermissionInfo['group'], string> = {
  get admin() {
    return t('features.requests.userEditors.administration');
  },
  get request() {
    return t('features.requests.userEditors.requesting');
  },
  get autoApprove() {
    return t('features.requests.userEditors.autoApprove');
  },
  get autoRequest() {
    return t('features.requests.userEditors.autoRequestWatchlistSync');
  },
  get issues() {
    return t('common.issues');
  },
  get view() {
    return t('features.requests.userEditors.visibility');
  },
};

/** Set or clear one permission bit. */
export function togglePermission(value: number, bit: number, on: boolean): number {
  return on ? value | bit : value & ~bit;
}

/** PERMISSION_INFO grouped by `group`, in first-seen order. */
export function groupedPermissions(): Array<[PermissionInfo['group'], PermissionInfo[]]> {
  const groups = new Map<PermissionInfo['group'], PermissionInfo[]>();
  for (const info of PERMISSION_INFO) {
    const list = groups.get(info.group) ?? [];
    list.push(info);
    groups.set(info.group, list);
  }
  return [...groups.entries()];
}

export function PermissionsMatrix({
  value,
  onChange,
  lockAdmin = false,
  disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  /** The ADMIN bit follows the role and cannot be toggled here. */
  lockAdmin?: boolean;
  disabled?: boolean;
}) {
  const isAdmin = (value & Permission.ADMIN) !== 0;
  return (
    <div data-testid="permissions-matrix">
      {groupedPermissions().map(([group, items]) => (
        <fieldset key={group} className="req-group">
          <legend className="al-label">{PERMISSION_GROUP_LABELS[group]}</legend>
          <div className="req-check-grid">
            {items.map((p) => {
              const locked = disabled || (lockAdmin && p.value === Permission.ADMIN);
              return (
                <Checkbox
                  key={p.name}
                  label={p.label}
                  hint={p.description}
                  aria-label={p.label}
                  checked={(value & p.value) === p.value}
                  disabled={locked}
                  onChange={(e) => onChange(togglePermission(value, p.value, e.currentTarget.checked))}
                />
              );
            })}
          </div>
        </fieldset>
      ))}
      {isAdmin ? <p className="al-muted">{t('features.requests.userEditors.adminPassesEveryCheckThe')}</p> : null}
    </div>
  );
}

export function UserPermissionsEditor({ userId, lockAdmin = true }: { userId: number; lockAdmin?: boolean }) {
  const query = useUserPermissions(userId);
  const save = useSetUserPermissions(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.permissions);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (draft === null) return <Skeleton lines={4} />;
  return (
    <div className="req-stack">
      <PermissionsMatrix value={draft} onChange={setDraft} lockAdmin={lockAdmin} />
      <SaveError error={save.error} />
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: (res) => {
                setDraft(res.permissions);
                toast.push({ tone: 'ok', title: t('features.requests.userEditors.permissionsSaved') });
              },
            })
          }
        >
          {t('features.requests.userEditors.savePermissions')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Content caps and the per-user approval override (PUT /user/:id/permissions)
// ---------------------------------------------------------------------------------------

/** "12.5" → 12.5; blank or junk → null (inherit / off). */
export function parseOptionalGb(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "Movies up to PG-13 · Series up to TV-PG · Adult titles hidden", or "No caps". */
export function capsSummary(c: ContentRestrictions): string {
  const parts = [
    c.maxCertification.movie ? t('features.requests.userEditors.capMovies', { cert: c.maxCertification.movie }) : null,
    c.maxCertification.tv ? t('features.requests.userEditors.capSeries', { cert: c.maxCertification.tv }) : null,
    c.hideAdultContent ? t('features.requests.userEditors.adultHidden') : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : t('features.requests.userEditors.noCaps');
}

function autoApproveLabel(v: UserApprovalPolicy['autoApprove']): string {
  if (v === 'always') return t('features.requests.userEditors.overrideAlways');
  if (v === 'never') return t('features.requests.userEditors.overrideNever');
  return t('features.requests.userEditors.overrideInherit');
}

interface PolicyDraft {
  caps: ContentRestrictions;
  policy: UserApprovalPolicy;
}

function policyDraftOf(data: { contentRestrictions?: unknown; approvalPolicy?: unknown }): PolicyDraft {
  return { caps: ContentRestrictions.parse(data.contentRestrictions ?? {}), policy: UserApprovalPolicy.parse(data.approvalPolicy ?? {}) };
}

/**
 * Content caps (certification limits, hide adult) and the approval-policy override for one
 * user. `readOnly` shows them as facts (Profile: users cannot change their own caps).
 */
export function UserPolicyEditor({ userId, readOnly = false }: { userId: number; readOnly?: boolean }) {
  const query = useUserPermissions(userId);
  const save = useSetUserPolicy(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(policyDraftOf(query.data));
  }, [query.data, draft]);

  if (query.isError) return readOnly ? <p className="al-caption">{t('features.requests.userEditors.capsUnavailable')}</p> : <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data || draft === null) return <Skeleton lines={4} />;
  const { caps, policy } = draft;
  const permissions = query.data.permissions;

  if (readOnly) {
    return (
      <KeyValue
        items={[
          { label: t('features.requests.userEditors.contentCaps'), value: capsSummary(caps), mono: false },
          { label: t('features.requests.userEditors.autoApproval'), value: autoApproveLabel(policy.autoApprove), mono: false },
          ...(policy.budgetExempt ? [{ label: t('features.requests.userEditors.budgets'), value: t('features.requests.userEditors.budgetExemptShort'), mono: false }] : []),
        ]}
      />
    );
  }

  const setCaps = (patch: Partial<ContentRestrictions>) => setDraft({ ...draft, caps: { ...caps, ...patch } });
  const setPolicy = (patch: Partial<UserApprovalPolicy>) => setDraft({ ...draft, policy: { ...policy, ...patch } });
  const none = { value: '', label: t('features.requests.userEditors.noCap') };

  return (
    <div className="req-stack" data-testid="user-policy-editor">
      <SectionLabel>{t('features.requests.userEditors.contentCaps')}</SectionLabel>
      <div className="req-fields-2">
        <Field label={t('features.requests.userEditors.maxMovieRating')} hint={t('features.requests.userEditors.maxMovieRatingHint')}>
          <Select
            aria-label={t('features.requests.userEditors.maxMovieRating')}
            value={caps.maxCertification.movie ?? ''}
            onChange={(e) => setCaps({ maxCertification: { ...caps.maxCertification, movie: (e.currentTarget.value || null) as MovieCertification | null } })}
            options={[none, ...MOVIE_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
          />
        </Field>
        <Field label={t('features.requests.userEditors.maxSeriesRating')} hint={t('features.requests.userEditors.maxSeriesRatingHint')}>
          <Select
            aria-label={t('features.requests.userEditors.maxSeriesRating')}
            value={caps.maxCertification.tv ?? ''}
            onChange={(e) => setCaps({ maxCertification: { ...caps.maxCertification, tv: (e.currentTarget.value || null) as TvCertification | null } })}
            options={[none, ...TV_CERTIFICATIONS.map((c) => ({ value: c, label: c }))]}
          />
        </Field>
      </div>
      <Field label={t('features.requests.userEditors.hideAdult')} inline hint={t('features.requests.userEditors.hideAdultHint')}>
        <Toggle aria-label={t('features.requests.userEditors.hideAdult')} checked={caps.hideAdultContent} onChange={(e) => setCaps({ hideAdultContent: e.currentTarget.checked })} />
      </Field>

      <SectionLabel>{t('features.requests.userEditors.approvalOverride')}</SectionLabel>
      <div className="req-fields-2">
        <Field label={t('features.requests.userEditors.autoApproval')} hint={t('features.requests.userEditors.autoApprovalHint')}>
          <Select
            aria-label={t('features.requests.userEditors.autoApproval')}
            value={policy.autoApprove}
            onChange={(e) => setPolicy({ autoApprove: e.currentTarget.value as UserApprovalPolicy['autoApprove'] })}
            options={(['inherit', 'always', 'never'] as const).map((v) => ({ value: v, label: autoApproveLabel(v) }))}
          />
        </Field>
        <Field label={t('features.requests.userEditors.sizeLimitOverride')} hint={t('features.requests.userEditors.sizeLimitOverrideHint')}>
          <Input
            type="number"
            min={0}
            step="any"
            mono
            end="GB"
            aria-label={t('features.requests.userEditors.sizeLimitOverride')}
            value={policy.autoApproveIfSizeBelowGb ?? ''}
            onChange={(e) => setPolicy({ autoApproveIfSizeBelowGb: parseOptionalGb(e.currentTarget.value) })}
          />
        </Field>
      </div>
      <Field label={t('features.requests.userEditors.budgetExempt')} inline hint={t('features.requests.userEditors.budgetExemptHint')}>
        <Toggle aria-label={t('features.requests.userEditors.budgetExempt')} checked={policy.budgetExempt} onChange={(e) => setPolicy({ budgetExempt: e.currentTarget.checked })} />
      </Field>
      <SaveError error={save.error} />
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { permissions, contentRestrictions: caps, approvalPolicy: policy },
              {
                onSuccess: (res) => {
                  setDraft(policyDraftOf({ contentRestrictions: res.contentRestrictions ?? caps, approvalPolicy: res.approvalPolicy ?? policy }));
                  toast.push({ tone: 'ok', title: t('features.requests.userEditors.capsSaved') });
                },
              },
            )
          }
        >
          {t('features.requests.userEditors.saveCaps')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------------------

const numOrNull = (raw: string): number | null => {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

/** Four number inputs; blank means null (global default on a user, "no quota" globally). */
export function QuotaFields({ value, onChange, blankHint }: { value: UserQuota; onChange: (next: UserQuota) => void; blankHint: string }) {
  const field = (key: keyof UserQuota, label: string) => (
    <Field label={label} hint={blankHint}>
      <Input
        type="number"
        min={0}
        aria-label={label}
        value={value[key] ?? ''}
        onChange={(e) => onChange({ ...value, [key]: numOrNull(e.currentTarget.value) })}
      />
    </Field>
  );
  return (
    <div className="req-stack">
      <div className="req-fields-2">
        {field('movieLimit', t('features.requests.userEditors.movieRequestLimit'))}
        {field('movieDays', t('features.requests.userEditors.movieWindowDays'))}
      </div>
      <div className="req-fields-2">
        {field('tvLimit', t('features.requests.userEditors.seriesRequestLimit'))}
        {field('tvDays', t('features.requests.userEditors.seriesWindowDays'))}
      </div>
    </div>
  );
}

export function quotaSummary(info: QuotaInfo): string {
  if (!info.limit) return t('features.requests.userEditors.usedUsedUnlimited', { used: info.used });
  const window = info.days ? ` per ${info.days} days` : ' in total';
  return t('features.requests.userEditors.usedOfLimitWindowValue', { used: info.used, limit: info.limit, window, value: info.remaining ?? 0 });
}

export function UserQuotaEditor({ userId }: { userId: number }) {
  const query = useUserQuota(userId);
  const save = useSetUserQuota(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<UserQuota | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.overrides);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data || draft === null) return <Skeleton lines={4} />;
  const { effective, status, exempt } = query.data;
  return (
    <div className="req-stack" data-testid="quota-editor">
      {exempt ? (
        <p className="al-notice" role="status">
          {t('features.requests.userEditors.thisUserManagesUsersOr')}
        </p>
      ) : null}
      <QuotaFields value={draft} onChange={setDraft} blankHint={t('features.requests.userEditors.blankUseTheGlobalDefault')} />
      <div className="req-fields-2">
        <div>
          <SectionLabel>{t('common.movies')}</SectionLabel>
          <p className="req-usage" data-testid="quota-movie">
            {t('features.requests.userEditors.effectiveValueQuotasummary', { value: effective.movieLimit ? t('features.requests.userEditors.movielimitPerValueDays', { movieLimit: effective.movieLimit, value: effective.movieDays ?? '∞' }) : t('features.requests.userEditors.unlimited'), quotaSummary: quotaSummary(status.movie) })}
            {status.movie.restricted ? <Chip tone="danger">{t('features.requests.userEditors.limitReached')}</Chip> : null}
          </p>
        </div>
        <div>
          <SectionLabel>{t('common.series')}</SectionLabel>
          <p className="req-usage" data-testid="quota-series">
            {t('features.requests.userEditors.effectiveValueQuotasummary', { value: effective.tvLimit ? t('features.requests.userEditors.tvlimitPerValueDays', { tvLimit: effective.tvLimit, value: effective.tvDays ?? '∞' }) : t('features.requests.userEditors.unlimited'), quotaSummary: quotaSummary(status.series) })}
            {status.series.restricted ? <Chip tone="danger">{t('features.requests.userEditors.limitReached')}</Chip> : null}
          </p>
        </div>
      </div>
      <SaveError error={save.error} />
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: (res) => {
                setDraft(res.overrides);
                toast.push({ tone: 'ok', title: t('features.requests.userEditors.quotaSaved') });
              },
            })
          }
        >
          {t('features.requests.userEditors.saveQuota')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Personal notification agents, Plex token, watchlist sync
// ---------------------------------------------------------------------------------------

const TYPE_LABELS: Record<keyof UserNotificationTypes, string> = {
  get requestApproved() {
    return t('common.requestApproved');
  },
  get requestDeclined() {
    return t('features.requests.userEditors.requestDeclined');
  },
  get requestAvailable() {
    return t('features.requests.userEditors.requestAvailable');
  },
  get requestPending() {
    return t('features.requests.userEditors.requestPendingApprovalManagers');
  },
  get issueCreated() {
    return t('features.requests.userEditors.issueReportedManagers');
  },
  get issueUpdated() {
    return t('features.requests.userEditors.issueUpdated');
  },
};

export function UserRequestSettingsForm({ userId }: { userId: number }) {
  const query = useUserRequestSettings(userId);
  const save = useSetUserRequestSettings(userId);
  const test = useTestUserNotifications(userId);
  const toast = useToast();
  const [draft, setDraft] = useState<UserRequestSettings | null>(null);
  const [testResult, setTestResult] = useState<UserNotificationTestResult | null>(null);
  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data);
  }, [query.data, draft]);

  if (query.isError) return <ErrorView error={query.error} onRetry={() => void query.refetch()} />;
  if (draft === null) return <Skeleton lines={4} />;
  const n = draft.notifications;
  const setN = (patch: Partial<UserRequestSettings['notifications']>) => setDraft({ ...draft, notifications: { ...n, ...patch } });

  return (
    <div className="req-stack" data-testid="request-settings-form">
      <SectionLabel>{t('features.requests.userEditors.discord')}</SectionLabel>
      <Field label={t('common.enabled')} inline>
        <Toggle aria-label={t('features.requests.userEditors.discordEnabled')} checked={n.discordEnabled} onChange={(e) => setN({ discordEnabled: e.currentTarget.checked })} />
      </Field>
      <Field label={t('features.requests.userEditors.webhookUrl')} hint={t('features.requests.userEditors.aWebhookIntoAPrivate')}>
        <Input
          value={n.discordWebhookUrl ?? ''}
          onChange={(e) => setN(optionalText('discordWebhookUrl', e.currentTarget.value))}
          placeholder="https://discord.com/api/webhooks/…"
        />
      </Field>

      <SectionLabel>{t('features.requests.userEditors.telegram')}</SectionLabel>
      <Field label={t('common.enabled')} inline>
        <Toggle aria-label={t('features.requests.userEditors.telegramEnabled')} checked={n.telegramEnabled} onChange={(e) => setN({ telegramEnabled: e.currentTarget.checked })} />
      </Field>
      <Field label={t('features.requests.userEditors.chatId')} hint={t('features.requests.userEditors.usesTheBotOfThe')}>
        <Input value={n.telegramChatId ?? ''} onChange={(e) => setN(optionalText('telegramChatId', e.currentTarget.value))} />
      </Field>
      <Field label={t('features.requests.userEditors.sendSilently')} inline>
        <Toggle checked={n.telegramSendSilently} onChange={(e) => setN({ telegramSendSilently: e.currentTarget.checked })} />
      </Field>

      <SectionLabel>{t('common.email')}</SectionLabel>
      <Field label={t('common.enabled')} inline>
        <Toggle aria-label={t('features.requests.userEditors.emailEnabled')} checked={n.emailEnabled} onChange={(e) => setN({ emailEnabled: e.currentTarget.checked })} />
      </Field>
      <Field label={t('common.address')} hint={t('features.requests.userEditors.blankTheAccountEmail')}>
        <Input type="email" value={n.email ?? ''} onChange={(e) => setN(optionalText('email', e.currentTarget.value))} />
      </Field>

      <SectionLabel>{t('features.requests.userEditors.notifyMeAbout')}</SectionLabel>
      <div className="req-check-grid">
        {(Object.keys(TYPE_LABELS) as Array<keyof UserNotificationTypes>).map((k) => (
          <Checkbox key={k} label={TYPE_LABELS[k]} checked={n.types[k]} onChange={(e) => setN({ types: { ...n.types, [k]: e.currentTarget.checked } })} />
        ))}
      </div>

      <SectionLabel>{t('common.watchlist')}</SectionLabel>
      <Field label={t('features.requests.userEditors.plexToken')} hint={t('features.requests.userEditors.storedMaskedLeaveTheMask')}>
        <Input
          type="password"
          autoComplete="off"
          value={draft.plexToken ?? ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            const { plexToken: _omit, ...rest } = draft;
            void _omit;
            setDraft(v ? { ...rest, plexToken: v } : rest);
          }}
          placeholder={REQUEST_SECRET_MASK}
        />
      </Field>
      <Field label={t('features.requests.userEditors.syncMovies')} inline>
        <Toggle checked={draft.watchlistSyncMovies} onChange={(e) => setDraft({ ...draft, watchlistSyncMovies: e.currentTarget.checked })} />
      </Field>
      <Field label={t('features.requests.userEditors.syncSeries')} inline>
        <Toggle checked={draft.watchlistSyncSeries} onChange={(e) => setDraft({ ...draft, watchlistSyncSeries: e.currentTarget.checked })} />
      </Field>
      <Field label={t('features.requests.userEditors.requestFromWatchlist')} inline hint={t('features.requests.userEditors.titlesAddedToYourPlex')}>
        <Toggle
          aria-label={t('features.requests.userEditors.requestFromWatchlist')}
          checked={draft.autoRequestFromWatchlist}
          onChange={(e) => setDraft({ ...draft, autoRequestFromWatchlist: e.currentTarget.checked })}
        />
      </Field>

      <SaveError error={save.error ?? test.error} />
      {testResult ? (
        <ul className="req-results" aria-label={t('features.requests.userEditors.testResults')}>
          {testResult.results.length === 0 ? <li className="al-muted">{t('features.requests.userEditors.noPersonalAgentIsEnabled')}</li> : null}
          {testResult.results.map((r) => (
            <li key={r.agent} data-ok={r.ok}>
              {r.agent}: {r.ok ? t('features.requests.userEditors.sent') : (r.error ?? t('features.requests.userEditors.failed'))}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="req-actions">
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(draft, {
              onSuccess: (res) => {
                setDraft(res);
                toast.push({ tone: 'ok', title: t('features.requests.userEditors.notificationSettingsSaved') });
              },
            })
          }
        >
          {t('common.save')}
        </Button>
        <Button
          variant="secondary"
          loading={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: setTestResult,
              onError: (err) => toast.error(t('features.requests.userEditors.testFailed'), errorMessage(err)),
            })
          }
        >
          {t('features.requests.userEditors.sendTest')}
        </Button>
      </div>
    </div>
  );
}

/** Patch for an optional string field: blank clears it (undefined is dropped by JSON.stringify). */
function optionalText<K extends 'discordWebhookUrl' | 'telegramChatId' | 'email'>(key: K, raw: string): Partial<UserRequestSettings['notifications']> {
  return raw === '' ? ({ [key]: undefined } as Partial<UserRequestSettings['notifications']>) : ({ [key]: raw } as Partial<UserRequestSettings['notifications']>);
}
