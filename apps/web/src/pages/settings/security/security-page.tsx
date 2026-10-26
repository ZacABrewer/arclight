import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { APP_AREAS, PASSWORD_MIN_LENGTH, type AppArea, type AuthMethod, type AuthSettings, type SessionRecord, type User, type UserRole } from '@arclight/shared';
import { authApi, securityApi, usersApi } from '../../../api/auth.js';
import { errorMessage } from '../../../api/client.js';
import { useAuth } from '../../../auth/auth-context.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, Checkbox, Chip, ErrorBlock, Field, FormRow, FormSection, Input, Modal, RadioGroup, Select, Skeleton, Table, Toggle, buttonClass, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { EditorFooter, SaveError, SettingsSection } from '../shared.js';
import { ApiKeyControls, useSecuritySettings } from './api-key.js';
import './security.css';
import { t } from '../../../i18n/index.js';

const METHOD_OPTIONS = [
  { value: 'forms', get label() { return t('settings.security.loginPage'); } },
  { value: 'basic', get label() { return t('settings.security.browserPromptHttpBasic'); } },
  { value: 'none', get label() { return t('settings.security.noneOnTheLocalNetwork'); } },
];

/** Mono timestamp: relative text, full date on hover. */
function When({ iso, empty = t('common.never') }: { iso: string | null | undefined; empty?: string }) {
  if (!iso) return <span className="al-muted">{empty}</span>;
  return (
    <time className="al-num" dateTime={iso} title={formatDateTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

function useAuthSettingsForm() {
  const query = useSecuritySettings();
  const save = useInvalidatingMutation((body: AuthSettings) => securityApi.update(body), [authKeys.security, authKeys.status], {
    errorTitle: t('settings.security.couldNotSaveSecuritySettings'),
  });
  const saved = useMemo<AuthSettings | null>(
    () => (query.data ? { method: query.data.method, requireForLocal: query.data.requireForLocal, sessionDays: query.data.sessionDays } : null),
    [query.data],
  );
  const draft = useDraft<AuthSettings | null>(saved);
  const days = draft.value?.sessionDays ?? 30;
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 365;
  return { query, save, draft, daysValid };
}

function AuthSettingsSection({ form }: { form: ReturnType<typeof useAuthSettingsForm> }) {
  const { query, draft, daysValid } = form;
  const ids = useId();
  const value = draft.value;
  if (query.isError) {
    return (
      <SettingsSection label={t('settings.security.authentication')}>
        <ErrorBlock title={t('settings.security.couldNotLoadSecuritySettings')} onRetry={() => void query.refetch()}>
          {errorMessage(query.error)}
        </ErrorBlock>
      </SettingsSection>
    );
  }
  if (!value) {
    return (
      <SettingsSection label={t('settings.security.authentication')}>
        <Skeleton lines={3} />
      </SettingsSection>
    );
  }
  const set = (patch: Partial<AuthSettings>) => draft.set((d) => (d ? { ...d, ...patch } : d));
  return (
    <FormSection label={t('settings.security.authentication')}>
      <FormRow label={t('settings.security.method')} htmlFor={`${ids}-method`} caption={t('settings.security.howPeopleSignInFrom')}>
        <Select
          id={`${ids}-method`}
          className="al-select--fit"
          value={value.method}
          options={METHOD_OPTIONS}
          onChange={(e) => set({ method: e.currentTarget.value as AuthMethod })}
        />
      </FormRow>
      <FormRow label={t('settings.security.requireForLocalAddresses')} captionInline caption={t('settings.security.offRequestsFromThisMachine')}>
        <Toggle aria-label={t('settings.security.requireForLocalAddresses')} checked={value.requireForLocal} onChange={(e) => set({ requireForLocal: e.currentTarget.checked })} />
      </FormRow>
      <FormRow label={t('settings.security.sessionLengthDays')} htmlFor={`${ids}-days`} caption={t('settings.security.signInsLastThisLong')} error={daysValid ? undefined : t('settings.security.enter1To365Days')}>
        <Input
          id={`${ids}-days`}
          type="number"
          mono
          min={1}
          max={365}
          className="al-input--num"
          invalid={!daysValid}
          value={Number.isFinite(value.sessionDays) ? String(value.sessionDays) : ''}
          onChange={(e) => set({ sessionDays: Number(e.currentTarget.value) })}
        />
      </FormRow>
    </FormSection>
  );
}

export interface UserDraft {
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  password: string;
  /** Non-admins: 'portal' (request portal only) or 'app' (plus the checked areas, read-only). */
  access: 'portal' | 'app';
  areas: AppArea[];
}

/**
 * Making someone admin needs a local password: admins sign in with it (never through a media
 * server). True when the editor must ask for one.
 */
export function promotionNeedsPassword(user: Pick<User, 'role' | 'localPassword'> | null, d: Pick<UserDraft, 'role'>): boolean {
  return user !== null && d.role === 'admin' && user.role !== 'admin' && user.localPassword === false;
}

export function validateUserDraft(d: UserDraft, isNew: boolean, user: Pick<User, 'role' | 'localPassword'> | null = null): string | null {
  if (d.username.trim().length < 2) return t('settings.security.usernameNeedsAtLeast2');
  if (!/^[A-Za-z0-9._@-]+$/.test(d.username.trim())) return t('settings.security.usernameLettersDigitsAndOnly');
  if (promotionNeedsPassword(user, d) && !d.password) return t('settings.security.promotionNeedsPassword');
  if ((isNew || d.password) && d.password.length < PASSWORD_MIN_LENGTH) return t('settings.security.passwordNeedsAtLeastPassword', { PASSWORD_MIN_LENGTH });
  if (d.role === 'user' && d.access === 'app' && d.areas.length === 0) return t('settings.security.pickAnArea');
  return null;
}

/** The app access to store for a draft ([] = request portal only; admins have everything). */
export function appAccessOfDraft(d: Pick<UserDraft, 'role' | 'access' | 'areas'>): AppArea[] {
  if (d.role === 'admin' || d.access === 'portal') return [];
  return APP_AREAS.filter((a) => d.areas.includes(a));
}

const AREA_LABEL: Record<AppArea, () => string> = {
  library: () => t('common.library'),
  calendar: () => t('common.calendar'),
  activity: () => t('common.activity'),
  wanted: () => t('common.wanted'),
};

/** Short "App access" text for the users table. */
export function appAccessSummary(user: Pick<User, 'role' | 'appAccess'>): string {
  if (user.role === 'admin') return t('settings.security.accessEverything');
  const areas = user.appAccess ?? [];
  if (areas.length === 0) return t('settings.security.accessPortalOnly');
  return t('settings.security.accessPortalPlus', { areas: areas.map((a) => AREA_LABEL[a]()).join(', ') });
}

function UserEditor({ user, mode, onClose }: { user: User | null; mode: 'edit' | 'password'; onClose: () => void }) {
  const [draft, setDraft] = useState<UserDraft>({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'user',
    password: '',
    access: (user?.appAccess?.length ?? 0) > 0 ? 'app' : 'portal',
    areas: [...(user?.appAccess ?? [])],
  });
  const [error, setError] = useState<string | null>(null);
  const save = useInvalidatingMutation(
    async (d: UserDraft) => {
      if (!user) {
        return usersApi.create({
          username: d.username.trim(),
          password: d.password,
          role: d.role,
          appAccess: appAccessOfDraft(d),
          ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}),
          ...(d.email.trim() ? { email: d.email.trim() } : {}),
        });
      }
      if (mode === 'password') return usersApi.update(user.id, { password: d.password });
      return usersApi.update(user.id, {
        username: d.username.trim(),
        role: d.role,
        appAccess: appAccessOfDraft(d),
        ...(d.password ? { password: d.password } : {}),
        displayName: d.displayName.trim() || null,
        email: d.email.trim() || null,
      });
    },
    [authKeys.users, authKeys.me],
    { silent: true },
  );

  const submit = () => {
    const problem =
      mode === 'password' ? (draft.password.length < PASSWORD_MIN_LENGTH ? t('settings.security.passwordNeedsAtLeastPassword', { PASSWORD_MIN_LENGTH }) : null) : validateUserDraft(draft, !user, user);
    setError(problem);
    if (!problem) save.mutate(draft, { onSuccess: onClose });
  };
  const set = (k: keyof UserDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.currentTarget.value });

  return (
    <Modal
      open
      size={560}
      onClose={onClose}
      title={mode === 'password' ? t('settings.security.resetPasswordForUsername', { username: user?.username }) : user ? t('settings.security.editUsername', { username: user.username }) : t('settings.security.addUser')}
      footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} saveLabel={mode === 'password' ? t('settings.security.resetPassword') : t('common.save')} />}
    >
      <div className="al-editor-stack">
        {mode === 'edit' ? (
          <>
            <Field label={t('common.username')}>
              <Input value={draft.username} onChange={set('username')} autoComplete="off" />
            </Field>
            <Field label={t('settings.security.displayName')}>
              <Input value={draft.displayName} onChange={set('displayName')} />
            </Field>
            <Field label={t('common.email')}>
              <Input type="email" value={draft.email} onChange={set('email')} />
            </Field>
            <Field label={t('common.role')} hint={t('settings.security.roleHint')}>
              <Select
                value={draft.role}
                onChange={set('role')}
                options={[
                  { value: 'user', label: t('common.user') },
                  { value: 'admin', label: t('common.admin') },
                ]}
              />
            </Field>
            {draft.role === 'user' ? (
              <>
                <RadioGroup<'portal' | 'app'>
                  legend={t('settings.security.appAccess')}
                  value={draft.access}
                  onChange={(access) => setDraft({ ...draft, access })}
                  options={[
                    { value: 'portal', label: t('settings.security.accessPortal'), hint: t('settings.security.accessPortalHint') },
                    { value: 'app', label: t('settings.security.accessApp'), hint: t('settings.security.accessAppHint') },
                  ]}
                />
                {draft.access === 'app' ? (
                  <fieldset className="al-radio-group" aria-label={t('settings.security.appAreas')}>
                    {APP_AREAS.map((area) => (
                      <Checkbox
                        key={area}
                        label={AREA_LABEL[area]()}
                        checked={draft.areas.includes(area)}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setDraft({ ...draft, areas: on ? [...draft.areas, area] : draft.areas.filter((a) => a !== area) });
                        }}
                      />
                    ))}
                  </fieldset>
                ) : null}
              </>
            ) : null}
            {promotionNeedsPassword(user, draft) ? (
              <Field label={t('settings.security.newPassword')} hint={t('settings.security.promotionPasswordHint')}>
                <Input type="password" autoComplete="new-password" value={draft.password} onChange={set('password')} />
              </Field>
            ) : null}
          </>
        ) : null}
        {mode === 'password' || !user ? (
          <Field label={user ? t('settings.security.newPassword') : t('common.password')} hint={user ? t('settings.security.signsTheUserOutEverywhere') : t('settings.security.atLeastPasswordMinLength', { PASSWORD_MIN_LENGTH })}>
            <Input type="password" autoComplete="new-password" value={draft.password} onChange={set('password')} />
          </Field>
        ) : null}
        {error ? (
          <p className="al-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <SaveError error={save.error} />
      </div>
    </Modal>
  );
}

function UsersSection() {
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: authKeys.users, queryFn: usersApi.list });
  const remove = useInvalidatingMutation((id: number) => usersApi.remove(id), [authKeys.users], { silent: true });
  const [editing, setEditing] = useState<{ user: User | null; mode: 'edit' | 'password' } | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const columns: Array<Column<User>> = [
    {
      key: 'username',
      header: t('common.username'),
      sortValue: (u) => u.username,
      cell: (u) => (
        <>
          {u.username}
          {u.id === me?.id ? <span className="al-you">{t('settings.security.you')}</span> : null}
        </>
      ),
    },
    { key: 'name', header: t('common.name'), cell: (u) => u.displayName ?? '', muted: true },
    { key: 'email', header: t('common.email'), cell: (u) => u.email ?? '', mono: true },
    {
      key: 'role',
      header: t('common.role'),
      sortValue: (u) => u.role,
      cell: (u) => (u.role === 'admin' ? <Chip tone="accent">{t('common.admin')}</Chip> : <Chip tone="neutral">{t('common.user')}</Chip>),
    },
    { key: 'access', header: t('settings.security.appAccess'), cell: (u) => appAccessSummary(u), muted: true },
    { key: 'last', header: t('settings.security.lastSignIn'), sortValue: (u) => u.lastLoginAt ?? null, cell: (u) => <When iso={u.lastLoginAt} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (u) => (
        <span className="al-row-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing({ user: u, mode: 'edit' })} aria-label={t('settings.security.editUsername', { username: u.username })}>
            {t('common.edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing({ user: u, mode: 'password' })} aria-label={t('settings.security.resetPasswordForUsername', { username: u.username })}>
            {t('settings.security.resetPassword')}
          </Button>
          <Button size="sm" variant="danger" disabled={u.id === me?.id} onClick={() => setDeleting(u)} aria-label={t('settings.security.deleteUsername', { username: u.username })}>
            {t('common.delete')}
          </Button>
        </span>
      ),
    },
  ];

  return (
    <SettingsSection
      label={t('common.users')}
      {...(users.data ? { count: users.data.length } : {})}
      action={
        <div className="al-section-actions">
          <Link to="/settings/users" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            {t('settings.security.permissionsAndQuotas')}
          </Link>
          <Button size="sm" variant="secondary" onClick={() => setEditing({ user: null, mode: 'edit' })}>
            {t('settings.security.addUser')}
          </Button>
        </div>
      }
    >
      {users.isError ? (
        <ErrorBlock title={t('settings.security.couldNotLoadUsers')} onRetry={() => void users.refetch()}>
          {errorMessage(users.error)}
        </ErrorBlock>
      ) : (
        <Table caption={t('common.users')} density="dense" columns={columns} rows={users.data} loading={users.isPending} rowKey={(u) => u.id} sortable empty={t('settings.security.noUsers')} />
      )}
      {editing ? <UserEditor key={`${editing.user?.id ?? 'new'}-${editing.mode}`} user={editing.user} mode={editing.mode} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.security.deleteValue', { value: deleting?.username ?? '' })}
        confirmLabel={t('settings.security.deleteUser')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
        describeError={(err) => errorMessage(err)}
      >
        {t('settings.security.theirSessionsEndImmediately')}
      </ConfirmDialog>
    </SettingsSection>
  );
}

function SessionsSection() {
  const sessions = useQuery({ queryKey: authKeys.sessions, queryFn: authApi.sessions, retry: false });
  const revoke = useInvalidatingMutation((id: number) => authApi.revokeSession(id), [authKeys.sessions], { silent: true });
  const [revoking, setRevoking] = useState<SessionRecord | null>(null);

  const columns: Array<Column<SessionRecord>> = [
    {
      key: 'device',
      header: t('settings.security.device'),
      cell: (s) => (
        <>
          <span className="al-ua" title={s.userAgent}>
            {s.userAgent ?? t('settings.security.unknownBrowser')}
          </span>
          {s.current ? <Chip tone="accent">{t('settings.security.thisSession')}</Chip> : null}
        </>
      ),
    },
    { key: 'ip', header: t('settings.security.ipAddress'), cell: (s) => s.ip ?? '—', mono: true },
    { key: 'created', header: t('settings.security.signedIn'), sortValue: (s) => s.createdAt, cell: (s) => <When iso={s.createdAt} /> },
    { key: 'seen', header: t('settings.security.lastSeen'), sortValue: (s) => s.lastSeenAt, cell: (s) => <When iso={s.lastSeenAt} /> },
    { key: 'expires', header: t('settings.security.expires'), sortValue: (s) => s.expiresAt, cell: (s) => <When iso={s.expiresAt} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (s) => (
        <Button size="sm" variant="danger" disabled={s.current} onClick={() => setRevoking(s)} aria-label={t('settings.security.revokeSessionFromValue', { value: s.ip ?? 'unknown address' })}>
          {t('settings.security.revoke')}
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection label={t('settings.security.sessions')} {...(sessions.data ? { count: sessions.data.length } : {})}>
      {sessions.isError ? (
        <ErrorBlock title={t('settings.security.couldNotLoadSessions')} onRetry={() => void sessions.refetch()}>
          {errorMessage(sessions.error)}
        </ErrorBlock>
      ) : (
        <Table
          caption={t('settings.security.yourSessions')}
          density="dense"
          columns={columns}
          rows={sessions.data}
          loading={sessions.isPending}
          rowKey={(s) => s.id}
          sortable
          defaultSort={{ key: 'seen', direction: 'desc' }}
          empty={t('settings.security.noOtherSessions')}
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={t('settings.security.revokeSession')}
        confirmLabel={t('settings.security.revokeSession2')}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id);
          setRevoking(null);
        }}
      >
        {t('settings.security.theBrowserAt')} <span className="al-num">{revoking?.ip ?? t('settings.security.anUnknownAddress')}</span> {t('settings.security.isSignedOutOnIts')}
      </ConfirmDialog>
    </SettingsSection>
  );
}

export function SecurityPage() {
  const auth = useAuthSettingsForm();
  return (
    <SettingsPage
      title={t('common.security')}
      description={t('settings.security.howPeopleSignInWho')}
      save={{
        count: auth.draft.changes,
        onDiscard: auth.draft.discard,
        onSave: () => {
          if (auth.draft.value && auth.daysValid) auth.save.mutate(auth.draft.value);
        },
        saving: auth.save.isPending,
        disabled: !auth.daysValid,
      }}
    >
      <AuthSettingsSection form={auth} />
      <SettingsSection label={t('settings.security.apiKeys')}>
        <FormRow label={t('settings.security.adminApiKey')} htmlFor="security-api-key" caption={t('settings.security.appsAndScriptsSendThis')}>
          <ApiKeyControls id="security-api-key" />
        </FormRow>
      </SettingsSection>
      <UsersSection />
      <SessionsSection />
    </SettingsPage>
  );
}
