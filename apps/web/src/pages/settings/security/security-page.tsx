import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PASSWORD_MIN_LENGTH, type AuthMethod, type AuthSettings, type SessionRecord, type User, type UserRole } from '@arclight/shared';
import { authApi, securityApi, usersApi } from '../../../api/auth.js';
import { errorMessage } from '../../../api/client.js';
import { useAuth } from '../../../auth/auth-context.js';
import { authKeys } from '../../../auth/guard.js';
import { Button, Chip, ErrorBlock, Field, FormRow, FormSection, Input, Modal, Select, Skeleton, Table, Toggle, buttonClass, type Column } from '../../../arclight/index.js';
import { ConfirmDialog } from '../../../components/forms/confirm-dialog.js';
import { useInvalidatingMutation } from '../../../hooks/settings-keys.js';
import { formatDateTime, relativeTime } from '../../../lib/format.js';
import { SettingsPage, useDraft } from '../settings-layout.js';
import { EditorFooter, SaveError, SettingsSection } from '../shared.js';
import { ApiKeyControls, useSecuritySettings } from './api-key.js';
import './security.css';

const METHOD_OPTIONS = [
  { value: 'forms', label: 'Login page' },
  { value: 'basic', label: 'Browser prompt (HTTP Basic)' },
  { value: 'none', label: 'None on the local network' },
];

/** Mono timestamp: relative text, full date on hover. */
function When({ iso, empty = 'Never' }: { iso: string | null | undefined; empty?: string }) {
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
    errorTitle: 'Could not save security settings',
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
      <SettingsSection label="Authentication">
        <ErrorBlock title="Could not load security settings" onRetry={() => void query.refetch()}>
          {errorMessage(query.error)}
        </ErrorBlock>
      </SettingsSection>
    );
  }
  if (!value) {
    return (
      <SettingsSection label="Authentication">
        <Skeleton lines={3} />
      </SettingsSection>
    );
  }
  const set = (patch: Partial<AuthSettings>) => draft.set((d) => (d ? { ...d, ...patch } : d));
  return (
    <FormSection label="Authentication">
      <FormRow label="Method" htmlFor={`${ids}-method`} caption="How people sign in from a browser. The API key always works for apps.">
        <Select
          id={`${ids}-method`}
          className="al-select--fit"
          value={value.method}
          options={METHOD_OPTIONS}
          onChange={(e) => set({ method: e.currentTarget.value as AuthMethod })}
        />
      </FormRow>
      <FormRow label="Require for local addresses" captionInline caption="Off: requests from this machine and the private network (192.168.x, 10.x, ...) skip sign-in.">
        <Toggle aria-label="Require for local addresses" checked={value.requireForLocal} onChange={(e) => set({ requireForLocal: e.currentTarget.checked })} />
      </FormRow>
      <FormRow label="Session length (days)" htmlFor={`${ids}-days`} caption="Sign-ins last this long (1-365)." error={daysValid ? undefined : 'Enter 1 to 365 days'}>
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

interface UserDraft {
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  password: string;
}

export function validateUserDraft(d: UserDraft, isNew: boolean): string | null {
  if (d.username.trim().length < 2) return 'Username needs at least 2 characters.';
  if (!/^[A-Za-z0-9._@-]+$/.test(d.username.trim())) return 'Username: letters, digits and . _ @ - only.';
  if ((isNew || d.password) && d.password.length < PASSWORD_MIN_LENGTH) return `Password needs at least ${PASSWORD_MIN_LENGTH} characters.`;
  return null;
}

function UserEditor({ user, mode, onClose }: { user: User | null; mode: 'edit' | 'password'; onClose: () => void }) {
  const [draft, setDraft] = useState<UserDraft>({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'user',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = useInvalidatingMutation(
    async (d: UserDraft) => {
      if (!user) {
        return usersApi.create({
          username: d.username.trim(),
          password: d.password,
          role: d.role,
          ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}),
          ...(d.email.trim() ? { email: d.email.trim() } : {}),
        });
      }
      if (mode === 'password') return usersApi.update(user.id, { password: d.password });
      return usersApi.update(user.id, {
        username: d.username.trim(),
        role: d.role,
        displayName: d.displayName.trim() || null,
        email: d.email.trim() || null,
      });
    },
    [authKeys.users, authKeys.me],
    { silent: true },
  );

  const submit = () => {
    const problem =
      mode === 'password' ? (draft.password.length < PASSWORD_MIN_LENGTH ? `Password needs at least ${PASSWORD_MIN_LENGTH} characters.` : null) : validateUserDraft(draft, !user);
    setError(problem);
    if (!problem) save.mutate(draft, { onSuccess: onClose });
  };
  const set = (k: keyof UserDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.currentTarget.value });

  return (
    <Modal
      open
      size={560}
      onClose={onClose}
      title={mode === 'password' ? `Reset password for ${user?.username}` : user ? `Edit ${user.username}` : 'Add user'}
      footer={<EditorFooter onCancel={onClose} onSave={submit} saving={save.isPending} saveLabel={mode === 'password' ? 'Reset password' : 'Save'} />}
    >
      <div className="al-editor-stack">
        {mode === 'edit' ? (
          <>
            <Field label="Username">
              <Input value={draft.username} onChange={set('username')} autoComplete="off" />
            </Field>
            <Field label="Display name">
              <Input value={draft.displayName} onChange={set('displayName')} />
            </Field>
            <Field label="Email">
              <Input type="email" value={draft.email} onChange={set('email')} />
            </Field>
            <Field label="Role" hint="Admins manage settings and users; users can browse and request.">
              <Select
                value={draft.role}
                onChange={set('role')}
                options={[
                  { value: 'user', label: 'User' },
                  { value: 'admin', label: 'Admin' },
                ]}
              />
            </Field>
          </>
        ) : null}
        {mode === 'password' || !user ? (
          <Field label={user ? 'New password' : 'Password'} hint={user ? 'Signs the user out everywhere.' : `At least ${PASSWORD_MIN_LENGTH} characters.`}>
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
      header: 'Username',
      sortValue: (u) => u.username,
      cell: (u) => (
        <>
          {u.username}
          {u.id === me?.id ? <span className="al-you">(you)</span> : null}
        </>
      ),
    },
    { key: 'name', header: 'Name', cell: (u) => u.displayName ?? '', muted: true },
    { key: 'email', header: 'Email', cell: (u) => u.email ?? '', mono: true },
    {
      key: 'role',
      header: 'Role',
      sortValue: (u) => u.role,
      cell: (u) => (u.role === 'admin' ? <Chip tone="accent">Admin</Chip> : <Chip tone="neutral">User</Chip>),
    },
    { key: 'last', header: 'Last sign-in', sortValue: (u) => u.lastLoginAt ?? null, cell: (u) => <When iso={u.lastLoginAt} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (u) => (
        <span className="al-row-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing({ user: u, mode: 'edit' })} aria-label={`Edit ${u.username}`}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing({ user: u, mode: 'password' })} aria-label={`Reset password for ${u.username}`}>
            Reset password
          </Button>
          <Button size="sm" variant="danger" disabled={u.id === me?.id} onClick={() => setDeleting(u)} aria-label={`Delete ${u.username}`}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <SettingsSection
      label="Users"
      {...(users.data ? { count: users.data.length } : {})}
      action={
        <div className="al-section-actions">
          <Link to="/settings/users" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Permissions and quotas
          </Link>
          <Button size="sm" variant="secondary" onClick={() => setEditing({ user: null, mode: 'edit' })}>
            Add user
          </Button>
        </div>
      }
    >
      {users.isError ? (
        <ErrorBlock title="Could not load users" onRetry={() => void users.refetch()}>
          {errorMessage(users.error)}
        </ErrorBlock>
      ) : (
        <Table caption="Users" density="dense" columns={columns} rows={users.data} loading={users.isPending} rowKey={(u) => u.id} sortable empty="No users." />
      )}
      {editing ? <UserEditor key={`${editing.user?.id ?? 'new'}-${editing.mode}`} user={editing.user} mode={editing.mode} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.username ?? ''}?`}
        confirmLabel="Delete user"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
        describeError={(err) => errorMessage(err)}
      >
        Their sessions end immediately.
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
      header: 'Device',
      cell: (s) => (
        <>
          <span className="al-ua" title={s.userAgent}>
            {s.userAgent ?? 'Unknown browser'}
          </span>
          {s.current ? <Chip tone="accent">This session</Chip> : null}
        </>
      ),
    },
    { key: 'ip', header: 'IP address', cell: (s) => s.ip ?? '—', mono: true },
    { key: 'created', header: 'Signed in', sortValue: (s) => s.createdAt, cell: (s) => <When iso={s.createdAt} /> },
    { key: 'seen', header: 'Last seen', sortValue: (s) => s.lastSeenAt, cell: (s) => <When iso={s.lastSeenAt} /> },
    { key: 'expires', header: 'Expires', sortValue: (s) => s.expiresAt, cell: (s) => <When iso={s.expiresAt} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (s) => (
        <Button size="sm" variant="danger" disabled={s.current} onClick={() => setRevoking(s)} aria-label={`Revoke session from ${s.ip ?? 'unknown address'}`}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <SettingsSection label="Sessions" {...(sessions.data ? { count: sessions.data.length } : {})}>
      {sessions.isError ? (
        <ErrorBlock title="Could not load sessions" onRetry={() => void sessions.refetch()}>
          {errorMessage(sessions.error)}
        </ErrorBlock>
      ) : (
        <Table
          caption="Your sessions"
          density="dense"
          columns={columns}
          rows={sessions.data}
          loading={sessions.isPending}
          rowKey={(s) => s.id}
          sortable
          defaultSort={{ key: 'seen', direction: 'desc' }}
          empty="No other sessions."
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke session?"
        confirmLabel="Revoke session"
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id);
          setRevoking(null);
        }}
      >
        The browser at <span className="al-num">{revoking?.ip ?? 'an unknown address'}</span> is signed out on its next request.
      </ConfirmDialog>
    </SettingsSection>
  );
}

export function SecurityPage() {
  const auth = useAuthSettingsForm();
  return (
    <SettingsPage
      title="Security"
      description="How people sign in, who has an account, active sessions and the API key."
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
      <SettingsSection label="API keys">
        <FormRow label="Admin API key" htmlFor="security-api-key" caption="Apps and scripts send this as the X-Api-Key header (or ?apikey=). It grants admin access.">
          <ApiKeyControls id="security-api-key" />
        </FormRow>
      </SettingsSection>
      <UsersSection />
      <SessionsSection />
    </SettingsPage>
  );
}
